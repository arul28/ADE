/**
 * When two spellings of a path compare without case. No node imports, so the
 * renderer and the main process share one rule.
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
 * The path rules a path's own spelling implies, for a path that may belong to
 * another machine: `win32` for a drive letter (`C:`, `C:\x`, `C:/x`) or a UNC
 * root (`\\server\share`, `//server/share`), `posix` for anything else. Only
 * Windows produces those shapes; a POSIX path says nothing about whether its
 * volume folds case, so it gets the non-folding flavor.
 */
export function pathFlavorOf(value: string): "win32" | "posix" {
  return /^[a-zA-Z]:(?:[\\/]|$)/.test(value) || /^[\\/]{2}[^\\/]/.test(value) ? "win32" : "posix";
}
