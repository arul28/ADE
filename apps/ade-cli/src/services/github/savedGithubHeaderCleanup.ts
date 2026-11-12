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
 * Only ADE's own header is removed: an `AUTHORIZATION: basic` value on the
 * `http.https://github.com/.extraheader` key (the only key ADE wrote) whose
 * credential is `x-access-token:<token>`. A header a person set (another
 * host's token, a different user) stays. Logs never carry a value.
 */

const AUTH_BASIC = /^\s*authorization:\s*basic\s+(\S+)\s*$/i;
/** The key `git clone -c` saved, as a POSIX ERE for `git config --get-regexp`. */
const SAVED_KEY_REGEX = "^http\\.https://github\\.com/\\.extraheader$";
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

/**
 * A POSIX ERE for `git config --unset-all <key> <value-regex>` that matches
 * every header `isSavedAdeGithubHeader` accepts, and nothing that carries the
 * token: `x-access-token:` is 15 bytes, so its base64 is always the same 20
 * characters. The token never goes on the git command line, where another
 * user of the computer could read it from the process list.
 */
const SAVED_VALUE_REGEX = `^[[:space:]]*[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]:[[:space:]]*[Bb][Aa][Ss][Ii][Cc][[:space:]]+${
  Buffer.from(ADE_CREDENTIAL_PREFIX, "utf8").toString("base64")
}`;

/** A path that is not there. Any other error (EIO, EACCES) can pass, so the run fails and is tried again. */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function statOrNull(file: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/**
 * The repository's local config file, or null when `root` is in no Git
 * checkout. Like Git, looks in `root` and then its parents for `.git` (a
 * project can be a folder inside a repository), follows a `.git` file
 * (`gitdir:`) and a linked worktree's `commondir`, with Windows and POSIX
 * paths alike. Async: a project on a stalled drive must not block the brain.
 */
async function localConfigPath(root: string): Promise<string | null> {
  let dir = path.resolve(root);
  let gitDir: string | null = null;
  for (;;) {
    const dotGit = path.join(dir, ".git");
    const stat = await statOrNull(dotGit);
    if (stat?.isDirectory()) {
      gitDir = dotGit;
      break;
    }
    if (stat?.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec((await readOrNull(dotGit)) ?? "");
      if (!pointer) return null;
      gitDir = path.resolve(dir, pointer[1]!);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  // Not a linked worktree when there is no `commondir`: the config is in gitDir itself.
  const common = ((await readOrNull(path.join(gitDir, "commondir"))) ?? "").trim();
  if (common) gitDir = path.resolve(gitDir, common);
  return path.join(gitDir, "config");
}

/** A cheap look at the file before any git process: most projects have no extraheader at all. */
async function mayHoldSavedHeader(root: string): Promise<boolean> {
  const file = await localConfigPath(root);
  if (!file) return false;
  // No config file: nothing saved. A read that fails otherwise throws, and
  // the run counts as failed.
  return /extraheader/i.test((await readOrNull(file)) ?? "");
}

type ProjectCleanup = "none" | "removed" | "failed";

async function cleanProject(root: string, runGit: RunGit, logger: CleanupLogger): Promise<ProjectCleanup> {
  try {
    if (!(await mayHoldSavedHeader(root))) return "none";
    const listed = await runGit(root, ["config", "--local", "--get-regexp", SAVED_KEY_REGEX]);
    // Exit 1 is "no such key": nothing saved there. Any other failure
    // (a config git cannot read, a lock) is reported and tried again later.
    if (listed.code === 1) return "none";
    if (listed.code !== 0) {
      logger.warn("github.saved_header_cleanup_failed", { step: "list", code: listed.code });
      return "failed";
    }
    const savedKeys = new Set<string>();
    for (const line of listed.stdout.split(/\r?\n/)) {
      const space = line.indexOf(" ");
      if (space <= 0) continue;
      if (isSavedAdeGithubHeader(line.slice(space + 1))) savedKeys.add(line.slice(0, space));
    }
    if (savedKeys.size === 0) return "none";
    const removedKeys = new Set<string>();
    let failed = false;
    for (const key of savedKeys) {
      const removed = await runGit(root, ["config", "--local", "--unset-all", key, SAVED_VALUE_REGEX]);
      if (removed.code === 0) removedKeys.add(key);
      else {
        failed = true;
        logger.warn("github.saved_header_cleanup_failed", { step: "remove", key, code: removed.code });
      }
    }
    if (removedKeys.size > 0) {
      // One line per project, never the value: the token is gone from the
      // file, but GitHub may still accept it until it expires or is revoked.
      logger.warn("github.saved_header_removed", { keys: [...removedKeys] });
    }
    return failed ? "failed" : removedKeys.size > 0 ? "removed" : "none";
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    logger.warn("github.saved_header_cleanup_failed", {
      error: error instanceof Error ? error.name : "unknown",
      ...(typeof code === "string" ? { code } : {}),
    });
    return "failed";
  }
}

/**
 * Removes ADE's saved GitHub header from each project's local Git config.
 * Returns how many projects had one removed. Never throws.
 */
export async function removeSavedGithubHeaders(
  roots: readonly string[],
  deps: { logger: CleanupLogger; runGit?: RunGit },
): Promise<number> {
  const runGit = deps.runGit ?? runGitDefault;
  let cleaned = 0;
  for (const root of roots) {
    if ((await cleanProject(root, runGit, deps.logger)) === "removed") cleaned += 1;
  }
  return cleaned;
}

/** Tries per project and brain process: a lock or a slow drive can fail one, not every open. */
const SWEEP_ATTEMPTS = 3;

/**
 * Runs the clean-up for each project once per brain process, off the
 * caller's path. A failed run is tried again on a later open, up to
 * `SWEEP_ATTEMPTS` times. For the brain's project-open hook.
 */
export function createSavedGithubHeaderSweep(deps: { logger: CleanupLogger; runGit?: RunGit }): (root: string) => void {
  const runGit = deps.runGit ?? runGitDefault;
  // Projects that need no more runs (clean, or out of tries), and the ones running now.
  const done = new Set<string>();
  const running = new Set<string>();
  const attempts = new Map<string, number>();
  return (root) => {
    const key = path.resolve(root);
    if (done.has(key) || running.has(key)) return;
    running.add(key);
    const timer = setTimeout(() => {
      void cleanProject(root, runGit, deps.logger).then((outcome) => {
        running.delete(key);
        const tries = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, tries);
        if (outcome !== "failed" || tries >= SWEEP_ATTEMPTS) done.add(key);
      });
    }, 0);
    (timer as { unref?: () => void }).unref?.();
  };
}
