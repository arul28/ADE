import path from "node:path";

/**
 * Filesystem path comparison that respects the platform's case rules.
 *
 * Windows and macOS both resolve paths case-insensitively by default, so
 * comparing them with `===` or `startsWith` produces false negatives that fail
 * silently — the lookup just misses and the caller sees "no match" rather than
 * an error. The usual trigger is drive-letter case: Node hands back `C:\Users`
 * from `path.resolve` while an external tool wrote `c:\users` into its own
 * state file, and the two never compare equal.
 *
 * Linux is genuinely case-sensitive, so the folding has to be platform-aware
 * rather than unconditional. `platform` is injectable so the contract can be
 * tested for `win32`, `darwin`, and `linux` from any host.
 */

/** Platforms whose filesystems resolve paths case-insensitively by default. */
function isCaseInsensitivePlatform(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * Drop Windows' extended-length (`\\?\`) prefix from a path.
 *
 * The prefix opts a path out of Win32 path parsing — MAX_PATH, `.`/`..`
 * collapsing, separator translation — so tools that open long paths hand it to
 * the OS and then record whatever they were given. Codex does exactly that:
 * 116 of the 117 cwd-bearing rows in a real `~/.codex/state_5.sqlite` are
 * `\\?\C:\...`.
 *
 * Node's own path parser does not understand the prefix. `\\?\C:\` looks like a
 * UNC root (`\\server\share`), so `path.relative("C:\\repo", "\\\\?\\C:\\repo")`
 * returns `\\?\C:` rather than `""` and every containment check answers
 * "outside". `fs.realpathSync` is no rescue: it returns the prefix verbatim.
 *
 * So the prefix has to come off at the boundary — wherever a provider-recorded
 * path enters ADE — and never be reintroduced. `\\?\UNC\server\share` is the
 * escaped spelling of `\\server\share` and folds back to it; everything else
 * loses four characters. Non-Windows input is returned untouched, since `\\?\`
 * is a legal (if bizarre) POSIX filename.
 */
export function stripExtendedLengthPrefix(
  input: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!input) return input ?? "";
  if (platform !== "win32") return input;
  if (input.startsWith("\\\\?\\UNC\\")) return `\\\\${input.slice(8)}`;
  if (input.startsWith("\\\\?\\")) return input.slice(4);
  return input;
}

/**
 * Canonical key for a filesystem path, safe to use in `===`, `Map`, and `Set`.
 *
 * Normalizes separators to the platform's own, collapses `.`/`..`, strips any
 * trailing separator (except a root's), and folds case where the platform is
 * case-insensitive. Never use the result for display — it is a comparison key.
 *
 * Deliberately does NOT call `resolve`: that would consult `process.cwd()`,
 * making the result depend on the host rather than only on the inputs, which
 * defeats the injectable `platform` parameter. Callers comparing possibly
 * relative paths should `path.resolve` them first.
 */
export function pathKey(input: string, platform: NodeJS.Platform = process.platform): string {
  if (!input) return "";
  const api = platform === "win32" ? path.win32 : path.posix;
  // Windows accepts both separators; normalize before resolving so a path that
  // mixes them collapses to one form. The `\\?\` strip runs first so a path that
  // slipped past a boundary strip still keys the same as its plain spelling —
  // `path.normalize` would otherwise preserve the prefix and read it as a UNC
  // root, which is precisely the miss this key exists to prevent.
  const unified = platform === "win32" ? stripExtendedLengthPrefix(input, platform).replace(/\//g, "\\") : input;
  let resolved = api.normalize(unified);
  // Keep a trailing separator only when the path IS its own root ("C:\", "/",
  // "\\server\share\"). Compared with `===` rather than `endsWith` because the
  // question is identity, not suffix — a UNC root is several characters longer
  // than a drive root and the suffix reading invites a false match.
  if (resolved.length > 1 && resolved.endsWith(api.sep) && api.parse(resolved).root !== resolved) {
    resolved = resolved.slice(0, -1);
  }
  return isCaseInsensitivePlatform(platform) ? resolved.toLowerCase() : resolved;
}

/**
 * Case-fold a path-*derived* identifier for comparison, without path
 * normalization. Use this for values that encode a path but are no longer one —
 * Claude's `projectKey` directory names, cache keys, slugs. Folding follows the
 * same platform rule as {@link pathKey}, because the identifier inherits the
 * case-sensitivity of the path it came from.
 */
export function pathComparisonKey(value: string, platform: NodeJS.Platform = process.platform): string {
  if (!value) return "";
  return isCaseInsensitivePlatform(platform) ? value.toLowerCase() : value;
}

/** True when both paths address the same location on this platform. */
export function pathsEqual(
  a: string | null | undefined,
  b: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!a || !b) return false;
  return pathKey(a, platform) === pathKey(b, platform);
}

/**
 * True when `candidate` is `parent` itself or sits underneath it.
 *
 * Compares whole segments, so `C:\project-old` is correctly rejected as a child
 * of `C:\project` — the bug a bare `startsWith` introduces.
 */
export function isPathInside(
  candidate: string | null | undefined,
  parent: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!candidate || !parent) return false;
  const api = platform === "win32" ? path.win32 : path.posix;
  const candidateKey = pathKey(candidate, platform);
  const parentKey = pathKey(parent, platform);
  if (candidateKey === parentKey) return true;
  const prefix = parentKey.endsWith(api.sep) ? parentKey : `${parentKey}${api.sep}`;
  return candidateKey.startsWith(prefix);
}
