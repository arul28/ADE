/**
 * Git's "dubious ownership" refusal (safe.directory, CVE-2022-24765).
 *
 * Git will not run in a repository whose folder belongs to another account.
 * On Windows that is routine: a folder made by an elevated shell, an installer
 * or an SSH session belongs to BUILTIN\Administrators, not to the signed-in
 * user. On macOS and Linux it happens for a folder made with sudo or by
 * another user. Git's own text is a wall of `fatal:` output, so ADE shows the
 * sentence from {@link gitOwnershipMessage} instead.
 *
 * Pure string handling only: the desktop app and the CLI both import it, and
 * nothing here may spawn a process or touch git config. Trusting a folder is
 * the user's decision, made in the desktop open flow.
 */

export type GitOwnershipProblem = {
  /** The folder git refused, exactly as git names it (forward slashes on Windows). */
  path: string;
  /** Who owns the folder, when git says (Git for Windows does; POSIX git does not). */
  owner?: string;
};

// git >= 2.35.3: "fatal: detected dubious ownership in repository at '<path>'"
const DUBIOUS_OWNERSHIP_PATTERN = /dubious ownership in repository at '([^'\r\n]+)'/i;
// git 2.35.2 only: "fatal: unsafe repository ('<path>' is owned by someone else)"
const UNSAFE_REPOSITORY_PATTERN = /unsafe repository \('([^'\r\n]+)' is owned by someone else\)/i;
// The exact value git itself suggests adding. Preferred over the "at" path
// because it is the spelling git will match on (e.g. `%(prefix)/` for a UNC share).
const SUGGESTED_SAFE_DIRECTORY_PATTERN = /git config --global --add safe\.directory ([^\r\n]+)/i;
// Git for Windows: "'<path>' is owned by:\n\tBUILTIN/Administrators (S-1-5-32-544)\nbut the current user is:"
const WINDOWS_OWNER_PATTERN = /is owned by:[ \t]*\r?\n[ \t]*'?([^\r\n]*?)'?[ \t]*\r?\n[ \t]*but the current user is/i;

const WELL_KNOWN_WINDOWS_SIDS: Record<string, string> = {
  "S-1-5-32-544": "BUILTIN\\Administrators",
  "S-1-5-18": "NT AUTHORITY\\SYSTEM",
};

function parseWindowsOwner(output: string): string | undefined {
  const line = output.match(WINDOWS_OWNER_PATTERN)?.[1]?.trim();
  if (!line) return undefined;
  // "BUILTIN/Administrators (S-1-5-32-544)", "(inconvertible) (S-1-…)", or a bare SID.
  const withSid = line.match(/^(.*?)\s*\((S-[\d-]+)\)$/i);
  const bareSid = /^S-[\d-]+$/i.test(line) ? line : undefined;
  const sid = (withSid?.[2] ?? bareSid)?.toUpperCase();
  const name = bareSid ? "" : (withSid?.[1] ?? line).trim();
  if (name && !/^\(?inconvertible\)?$/i.test(name)) {
    // Git for Windows writes DOMAIN/name; Windows people read DOMAIN\name.
    return /^[^/\\\s]+\/[^/\\]+$/.test(name) ? name.replace("/", "\\") : name;
  }
  if (sid) return WELL_KNOWN_WINDOWS_SIDS[sid] ?? sid;
  return undefined;
}

/**
 * Git shell-quotes the path it suggests when it has spaces or `%(prefix)`:
 * `'/Users/a b/repo'`, with an embedded quote written as `'\''`.
 */
function unquoteShellWord(word: string): string {
  if (word.length < 2 || !word.startsWith("'") || !word.endsWith("'")) return word;
  return word.slice(1, -1).replace(/'\\(.)'/g, "$1");
}

/** The folder and (when git says) its owner, or null when `output` is not this refusal. */
export function parseGitOwnershipError(output: string): GitOwnershipProblem | null {
  if (!output) return null;
  const atPath = output.match(DUBIOUS_OWNERSHIP_PATTERN)?.[1] ?? output.match(UNSAFE_REPOSITORY_PATTERN)?.[1];
  if (!atPath) return null;
  const suggested = unquoteShellWord(output.match(SUGGESTED_SAFE_DIRECTORY_PATTERN)?.[1]?.trim() ?? "");
  const owner = parseWindowsOwner(output);
  return { path: suggested || atPath, ...(owner ? { owner } : {}) };
}

/**
 * The `safe.directory` value for a folder: forward slashes (git compares with
 * them on every platform, Windows included), no `/C:/` URL-style prefix, no
 * trailing slash.
 */
export function gitSafeDirectorySpec(repoPath: string): string {
  let spec = repoPath.trim().replace(/\\/g, "/");
  if (/^\/[A-Za-z]:\//.test(spec)) spec = spec.slice(1);
  const trimmed = spec.replace(/\/+$/, "");
  // Keep a drive root ("C:/") and the POSIX root ("/") meaningful.
  if (!trimmed) return spec ? "/" : "";
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
}

/**
 * Whether two `safe.directory` values name the same folder. Windows paths
 * compare case-insensitively, POSIX ones do not.
 */
export function gitSafeDirectorySpecsEqual(left: string, right: string): boolean {
  const a = gitSafeDirectorySpec(left);
  const b = gitSafeDirectorySpec(right);
  const windowsShaped = /^([A-Za-z]:\/|\/\/|%\(prefix\)\/\/)/.test(a) || /^([A-Za-z]:\/|\/\/|%\(prefix\)\/\/)/.test(b);
  return windowsShaped ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** "Git does not trust <folder> because it belongs to <owner>." — the question's premise. */
export function gitOwnershipReason(problem: GitOwnershipProblem): string {
  const who = problem.owner ?? "another user account";
  return `Git does not trust ${problem.path} because it belongs to ${who}, not to you.`;
}

/**
 * Quote one shell argument so the suggested command survives a paste. Windows:
 * double quotes, which PowerShell and cmd both accept (an embedded `"` is
 * doubled; paths cannot contain one anyway). POSIX: single quotes, with the
 * standard `'\''` escape for an embedded `'`.
 */
function quoteShellArg(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The human sentence ADE shows in place of git's refusal, wherever it surfaces. */
export function gitOwnershipMessage(
  problem: GitOwnershipProblem,
  platform: NodeJS.Platform = process.platform,
): string {
  return `${gitOwnershipReason(problem)} Open the folder in ADE to trust it, or run: `
    + `git config --global --add safe.directory ${quoteShellArg(gitSafeDirectorySpec(problem.path), platform)}`;
}
