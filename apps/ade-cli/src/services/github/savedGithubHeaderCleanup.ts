import { execFile } from "node:child_process";

/**
 * Removes the GitHub sign-in header that older ADE clones saved in a
 * project's `.git/config` (C4).
 *
 * Before C4, a clone ran `git clone -c http.extraheader=AUTHORIZATION: basic …`,
 * and `git clone -c` keeps that setting in the new clone's local config. So
 * the token stayed in the file, readable by anything that reads the repository.
 * ADE now passes the header per command. This takes the old saved copies out
 * of the projects on an ADE Cloud computer, where ADE made every clone. Only
 * an `AUTHORIZATION: basic` value on an `http.*extraheader` key is removed;
 * other headers a person set are left alone.
 */

/** `AUTHORIZATION: basic `, any case, as a POSIX ERE for `git config --unset-all <key> <value-regex>`. */
const SAVED_HEADER_VALUE_REGEX = "^[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]:[[:space:]]*[Bb][Aa][Ss][Ii][Cc][[:space:]]";
const SAVED_HEADER_VALUE = /^authorization:\s*basic\s/i;

type GitAnswer = { code: number; stdout: string };
type RunGit = (cwd: string, args: string[]) => Promise<GitAnswer>;

const runGitFile: RunGit = (cwd, args) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? Number((error as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });

export async function removeSavedGithubHeaders(
  roots: readonly string[],
  deps: {
    logger: { info: (event: string, meta?: Record<string, unknown>) => void; warn: (event: string, meta?: Record<string, unknown>) => void };
    runGit?: RunGit;
  },
): Promise<number> {
  const runGit = deps.runGit ?? runGitFile;
  let cleaned = 0;
  for (const root of roots) {
    try {
      // Exit 1 is "no such key": nothing saved there.
      const listed = await runGit(root, ["config", "--local", "--get-regexp", "^http\\..*extraheader$"]);
      if (listed.code !== 0) continue;
      const keys = new Set<string>();
      for (const line of listed.stdout.split("\n")) {
        const space = line.indexOf(" ");
        if (space <= 0) continue;
        if (SAVED_HEADER_VALUE.test(line.slice(space + 1))) keys.add(line.slice(0, space));
      }
      for (const key of keys) {
        const removed = await runGit(root, ["config", "--local", "--unset-all", key, SAVED_HEADER_VALUE_REGEX]);
        if (removed.code === 0) cleaned += 1;
        else deps.logger.warn("github.saved_header_cleanup_failed", { key, code: removed.code });
      }
    } catch (error) {
      deps.logger.warn("github.saved_header_cleanup_failed", { error: error instanceof Error ? error.name : "unknown" });
    }
  }
  if (cleaned > 0) deps.logger.info("github.saved_header_cleanup", { removed: cleaned, projects: roots.length });
  return cleaned;
}
