// The Pi lease child loads this file through Node's strip-types loader
// (`piSessionLease.ts` imports `pathCompare.ts` by explicit source
// extension). Extensionless specifiers fail that load with empty stdout and
// exit 1, which is the CI failure this comment exists to prevent.
// @ts-expect-error TS5097: the strip-types child loader requires the source extension.
import { foldsCase, pathApiFor, stripExtendedLengthPrefix } from "../../../shared/pathContainment.ts";

export { stripExtendedLengthPrefix };

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
 * tested for `win32`, `darwin`, and `linux` from any host. Case folding and
 * path grammar come from {@link foldsCase} and {@link pathApiFor} in
 * `pathContainment.ts` — one rule, two call sites.
 */

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
  const api = pathApiFor(platform);
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
  return foldsCase(platform) ? resolved.toLowerCase() : resolved;
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
  return foldsCase(platform) ? value.toLowerCase() : value;
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
  const api = pathApiFor(platform);
  const candidateKey = pathKey(candidate, platform);
  const parentKey = pathKey(parent, platform);
  if (candidateKey === parentKey) return true;
  const prefix = parentKey.endsWith(api.sep) ? parentKey : `${parentKey}${api.sep}`;
  return candidateKey.startsWith(prefix);
}
