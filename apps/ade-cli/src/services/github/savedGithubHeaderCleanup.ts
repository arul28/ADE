import fs from "node:fs";
import path from "node:path";
import { runGit as runGitProcess } from "../../../../desktop/src/main/services/git/git";

/**
 * Removes the GitHub sign-in header that older ADE clones saved in a
 * project's `.git/config`.
 *
 * Before the clone fix, a clone ran
 * `git clone -c http.https://github.com/.extraheader=AUTHORIZATION: basic …`,
 * and `git clone -c` keeps that setting in the new clone's local config. So
 * the token stayed in the file, readable by anything that reads the
 * repository. ADE now passes the header per command (gitTransportAuth.ts).
 *
 * Only ADE's own header is removed: an `AUTHORIZATION: basic` value on an
 * `http.*extraheader` key whose credential is `x-access-token:<token>` (the
 * GitHub form ADE wrote). A header a person set (another host's token, a
 * different user) stays. Logs never carry a value.
 */

const AUTH_BASIC = /^\s*authorization:\s*basic\s+(\S+)\s*$/i;
const ADE_CREDENTIAL_PREFIX = "x-access-token:";

type GitAnswer = { code: number; stdout: string };
type RunGit = (cwd: string, args: string[]) => Promise<GitAnswer>;
type CleanupLogger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

const runGitDefault: RunGit = async (cwd, args) => {
  const result = await runGitProcess(args, { cwd, timeoutMs: 15_000, maxOutputBytes: 256 * 1024 });
  return { code: result.exitCode, stdout: result.stdout };
};

/** True for the header ADE saved: basic auth whose credential is `x-access-token:…`. */
export function isSavedAdeGithubHeader(value: string): boolean {
  const match = AUTH_BASIC.exec(value);
  if (!match) return false;
  try {
    return Buffer.from(match[1]!, "base64").toString("utf8").startsWith(ADE_CREDENTIAL_PREFIX);
  } catch {
    return false;
  }
}

/** A POSIX ERE that matches exactly `value`, for `git config --unset-all <key> <value-regex>`. */
function exactValueRegex(value: string): string {
  return `^${value.replace(/[.[\]()*+?{}|^$\\]/g, "\\$&")}$`;
}

/**
 * The repository's local config file, or null when `root` is not a Git
 * checkout. Follows a `.git` file (`gitdir:`) and a linked worktree's
 * `commondir`, with Windows and POSIX paths alike.
 */
function localConfigPath(root: string): string | null {
  const dotGit = path.join(root, ".git");
  let gitDir: string;
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) gitDir = dotGit;
    else {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (!pointer) return null;
      gitDir = path.resolve(root, pointer[1]!);
    }
  } catch {
    return null;
  }
  try {
    const common = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    if (common) gitDir = path.resolve(gitDir, common);
  } catch {
    // Not a linked worktree: the config is in gitDir itself.
  }
  return path.join(gitDir, "config");
}

/** A cheap look at the file before any git process: most projects have no extraheader at all. */
function mayHoldSavedHeader(root: string): boolean {
  const file = localConfigPath(root);
  if (!file) return false;
  try {
    return /extraheader/i.test(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Removes ADE's saved GitHub header from each project's local Git config.
 * Returns how many projects had one. Never throws.
 */
export async function removeSavedGithubHeaders(
  roots: readonly string[],
  deps: { logger: CleanupLogger; runGit?: RunGit },
): Promise<number> {
  const runGit = deps.runGit ?? runGitDefault;
  let cleaned = 0;
  for (const root of roots) {
    try {
      if (!mayHoldSavedHeader(root)) continue;
      // Exit 1 is "no such key": nothing saved there.
      const listed = await runGit(root, ["config", "--local", "--get-regexp", "^http\\..*extraheader$"]);
      if (listed.code !== 0) continue;
      const saved: Array<{ key: string; value: string }> = [];
      for (const line of listed.stdout.split(/\r?\n/)) {
        const space = line.indexOf(" ");
        if (space <= 0) continue;
        const value = line.slice(space + 1);
        if (isSavedAdeGithubHeader(value)) saved.push({ key: line.slice(0, space), value });
      }
      if (saved.length === 0) continue;
      const removedKeys = new Set<string>();
      for (const { key, value } of saved) {
        const removed = await runGit(root, ["config", "--local", "--unset-all", key, exactValueRegex(value)]);
        if (removed.code === 0) removedKeys.add(key);
        else deps.logger.warn("github.saved_header_cleanup_failed", { key, code: removed.code });
      }
      if (removedKeys.size > 0) {
        cleaned += 1;
        // One line per project, never the value: the token is gone from the
        // file, but GitHub may still accept it until it expires or is revoked.
        deps.logger.warn("github.saved_header_removed", { keys: [...removedKeys] });
      }
    } catch (error) {
      deps.logger.warn("github.saved_header_cleanup_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return cleaned;
}

/**
 * Runs the clean-up once per project for this process, off the caller's
 * path. For the brain's project-open hook.
 */
export function createSavedGithubHeaderSweep(deps: { logger: CleanupLogger; runGit?: RunGit }): (root: string) => void {
  const seen = new Set<string>();
  return (root) => {
    const key = path.resolve(root);
    if (seen.has(key)) return;
    seen.add(key);
    const timer = setTimeout(() => {
      void removeSavedGithubHeaders([root], deps);
    }, 0);
    (timer as { unref?: () => void }).unref?.();
  };
}
