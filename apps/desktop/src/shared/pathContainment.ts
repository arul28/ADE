import path from "node:path";

/**
 * The LEXICAL answer to "is this path inside that directory", and to "are these
 * the same directory".
 *
 * Lexical means string arithmetic only: normalize, fold case where the platform
 * folds, require a separator at the boundary. Nothing here touches a disk, so
 * the answer depends only on the arguments and a test can assert any platform
 * from any host.
 *
 * Two neighbours answer nearby questions and are deliberately NOT merged here:
 *
 *  - `main/services/shared/pathCompare.ts` answers the same two questions for
 *    callers that need a `Map`/`Set` key. It re-exports
 *    {@link stripExtendedLengthPrefix} from this module so a prefixed Windows
 *    path and its plain spelling compare equal in both helpers.
 *  - `main/services/shared/utils.ts`'s `resolvePathWithinRoot` answers
 *    containment CANONICALLY: it resolves symlinks and walks the directory
 *    chain, so it can refuse a path whose name looks contained while the link
 *    behind it points elsewhere. It touches the filesystem and it stays.
 *
 * The rule of thumb: a check that must survive a symlink belongs in
 * `resolvePathWithinRoot`; a pure comparison of two names belongs here.
 *
 * It lives in `shared/` because both the desktop main process and the ade-cli
 * package need it; the CLI already imports across that boundary.
 */

/**
 * The platform whose path rules apply.
 *
 * `"posix"` is the flavor, not an OS: it selects POSIX path grammar and
 * case-sensitive comparison. A real `NodeJS.Platform` selects both the grammar
 * and the case rule for that OS, which is what a caller comparing paths on the
 * machine it is running on wants.
 */
export type ContainmentPlatform = NodeJS.Platform | "posix";

/** Windows path grammar for win32, POSIX grammar everywhere else. */
export function pathApiFor(platform: ContainmentPlatform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * Whether comparison folds case on this platform.
 *
 * `win32` and `darwin` yes, everything else no. Windows path components are
 * case-insensitive, and macOS volumes are case-insensitive by default, so
 * `~/.ADE` and `~/.ade` are one directory on both. Linux is case-sensitive, so
 * folding there would make two different directories compare equal.
 *
 * The bare flavor `"posix"` does NOT fold. That is deliberate and it is the
 * difference between the two kinds of caller:
 *
 *  - A guard that REFUSES a path (is this inside ADE's own state directory?)
 *    must fold, because a missed fold skips the refusal while the OS opens the
 *    very same folder. Those callers pass a real platform.
 *  - A containment check that GRANTS a path (is this write inside the host's
 *    sandboxRoot?) must not fold on an assumption it cannot verify. A
 *    case-sensitive APFS volume exists, and folding there would admit a write
 *    the host never approved. Those callers pass the flavor, so an unfolded
 *    mismatch falls through to the policy's fallback — a prompt, not a grant.
 */
export function foldsCase(platform: ContainmentPlatform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * Drop Windows' extended-length (`\\?\`) prefix from a path.
 *
 * The prefix opts a path out of Win32 path parsing, so tools that open long
 * paths record it verbatim. Codex does exactly that: most cwd-bearing rows in
 * a real `~/.codex/state_5.sqlite` are `\\?\C:\...`. Node's path parser treats
 * `\\?\C:\` as a UNC root, so a lexical compare against `C:\...` answers
 * "different directory" and a refusal that must not miss, misses.
 *
 * `\\?\UNC\server\share` folds back to `\\server\share`. Non-win32 input is
 * returned untouched: `\\?\` is a legal POSIX filename. Call this at the
 * boundary, before normalize / relative / root checks, and do not reintroduce
 * the prefix.
 */
export function stripExtendedLengthPrefix(
  input: string | null | undefined,
  platform: ContainmentPlatform = process.platform,
): string {
  if (!input) return input ?? "";
  if (platform !== "win32") return input;
  if (input.startsWith("\\\\?\\UNC\\")) return `\\\\${input.slice(8)}`;
  if (input.startsWith("\\\\?\\")) return input.slice(4);
  return input;
}

/** Trailing separators removed, so `C:\` and `C:` name the same place. */
export function trimTrailingSeparators(value: string, api: path.PlatformPath): string {
  if (value.length <= 1) return value;
  let end = value.length;
  while (end > 1 && (value[end - 1] === api.sep || value[end - 1] === "/")) end -= 1;
  return value.slice(0, end);
}

function comparable(value: string, platform: ContainmentPlatform): string {
  const api = pathApiFor(platform);
  const stripped = stripExtendedLengthPrefix(value, platform);
  const trimmed = trimTrailingSeparators(api.normalize(stripped), api);
  return foldsCase(platform) ? trimmed.toLowerCase() : trimmed;
}

/**
 * Resolve a target for comparison, or null when it cannot be resolved.
 *
 * An absolute target resolves to itself. A RELATIVE target resolves against
 * `base`, which is the working directory whatever produced the path would
 * resolve it against — never against the root. Joining a relative path to the
 * root made it inside the root by construction: a write of `config.json` was
 * judged as `<root>/config.json` and allowed, while the tool wrote
 * `<cwd>/config.json` somewhere else entirely.
 *
 * With no usable `base` a relative target names no directory this module can
 * identify, so it resolves to null and the caller treats it as not contained.
 */
function resolveTarget(
  target: string,
  platform: ContainmentPlatform,
  base: string | null | undefined,
): string | null {
  const api = pathApiFor(platform);
  if (api.isAbsolute(target)) return api.normalize(target);
  const trimmedBase = typeof base === "string" ? base.trim() : "";
  if (trimmedBase.length === 0 || !api.isAbsolute(trimmedBase)) return null;
  return api.normalize(api.join(api.normalize(trimmedBase), target));
}

/**
 * True when `target` is `root` itself or lives under it.
 *
 * A separator is required at the boundary, so `/srv/data-old` is not inside
 * `/srv/data`. See {@link foldsCase} for the case rule and
 * {@link ContainmentPlatform} for what `platform` selects.
 */
export function pathIsWithinRoot(
  root: string,
  target: string,
  platform: ContainmentPlatform = process.platform,
  base?: string | null,
): boolean {
  const api = pathApiFor(platform);
  const resolved = resolveTarget(target, platform, base);
  if (resolved === null) return false;
  const a = comparable(root, platform);
  const b = comparable(resolved, platform);
  if (a === b) return true;
  return b.startsWith(a.endsWith(api.sep) ? a : `${a}${api.sep}`);
}

/**
 * True when two paths name the same place on the given platform.
 *
 * Named for the platform argument because `pathCompare.ts` exports a
 * `pathsEqual` of its own that answers the same question after stripping
 * Windows' `\\?\` prefix; two functions spelled alike in one app is how a
 * caller picks the wrong one.
 *
 * Not `===`: the case fold and the trailing-separator trim are load-bearing,
 * and writing this as mutual containment (`A inside B && B inside A`) makes a
 * reader run an argument to recover an intent that "equal" states directly.
 */
export function samePathOnPlatform(
  left: string,
  right: string,
  platform: ContainmentPlatform = process.platform,
): boolean {
  return comparable(left, platform) === comparable(right, platform);
}
