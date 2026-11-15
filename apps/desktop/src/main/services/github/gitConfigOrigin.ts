import fs from "node:fs";
import path from "node:path";
import { githubRepoRefFromRemoteUrl } from "../../../shared/githubRemote";

/**
 * The project's `origin` URL read straight from its git config files, with no
 * process started. For synchronous paths (a chat's environment is built
 * synchronously) that cannot wait for `git remote get-url`. Handles a linked
 * worktree (`.git` file, `commondir`) and `config.worktree`.
 */

/** A git config value: a quoted one without its quotes, an unquoted one up to a comment. */
function gitConfigValue(raw: string): string {
  const quoted = raw.match(/^"((?:[^"\\]|\\.)*)"/);
  if (quoted) return quoted[1]!.replace(/\\(.)/g, "$1").trim();
  return raw.replace(/\s*[#;].*$/, "").trim();
}

/**
 * The first value of `key` in the first matching section of one config file,
 * or null. A key with no `=` is git's shorthand for true.
 */
function readGitConfigValue(
  configPath: string,
  isSection: (name: string) => boolean,
  key: string,
): string | null {
  try {
    // Reading a FIFO here would freeze the whole process.
    if (!fs.statSync(configPath, { throwIfNoEntry: false })?.isFile()) return null;
    const raw = fs.readFileSync(configPath, "utf8");
    const keyLine = new RegExp(`^\\s*${key}\\s*(?:=\\s*(.*?))?\\s*$`, "i");
    let inSection = false;
    for (const line of raw.split(/\r?\n/)) {
      // A section header may carry a trailing comment.
      const section = line.match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/);
      if (section) {
        inSection = isSection(section[1]?.trim() ?? "");
        continue;
      }
      if (!inSection) continue;
      const match = line.match(keyLine);
      if (!match) continue;
      if (match[1] === undefined) return "true";
      const value = gitConfigValue(match[1]);
      if (value) return value;
    }
    return null;
  } catch {
    return null;
  }
}

/** The section name ("remote") is case-insensitive; the subsection ("origin") is not. */
const isOriginRemote = (name: string): boolean => /^[Rr][Ee][Mm][Oo][Tt][Ee]\s+"origin"$/.test(name);

function resolveGitDir(projectRoot: string): string | null {
  try {
    const gitPath = path.join(projectRoot, ".git");
    if (!fs.existsSync(gitPath)) return null;
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return gitPath;
    if (!stat.isFile()) return null;
    const raw = fs.readFileSync(gitPath, "utf8");
    const match = raw.match(/^gitdir:\s*(.+)\s*$/im);
    if (!match?.[1]) return null;
    return path.resolve(projectRoot, match[1].trim());
  } catch {
    return null;
  }
}

function resolveCommonGitDir(gitDir: string): string {
  try {
    const commonDirPath = path.join(gitDir, "commondir");
    if (!fs.existsSync(commonDirPath)) return gitDir;
    const raw = fs.readFileSync(commonDirPath, "utf8").trim();
    if (!raw) return gitDir;
    return path.resolve(gitDir, raw);
  } catch {
    return gitDir;
  }
}

export function readOriginUrlFromGitConfig(projectRoot: string): string | null {
  const gitDir = resolveGitDir(projectRoot);
  if (!gitDir) return null;
  const commonGitDir = resolveCommonGitDir(gitDir);
  // Git reads config.worktree only with extensions.worktreeConfig on.
  const worktreeConfig = readGitConfigValue(
    path.join(commonGitDir, "config"),
    (name) => name.toLowerCase() === "extensions",
    "worktreeConfig",
  );
  const worktreeConfigOn = /^(true|yes|on|1)$/i.test(worktreeConfig ?? "");
  return (
    (worktreeConfigOn ? readGitConfigValue(path.join(gitDir, "config.worktree"), isOriginRemote, "url") : null) ??
    readGitConfigValue(path.join(commonGitDir, "config"), isOriginRemote, "url") ??
    readGitConfigValue(path.join(gitDir, "config"), isOriginRemote, "url")
  );
}

/** The GitHub owner of the project's `origin`, from its git config alone; null when it does not say. */
export function peekGithubRepoOwnerFromGitConfig(projectRoot: string): string | null {
  const originUrl = readOriginUrlFromGitConfig(projectRoot);
  return originUrl ? githubRepoRefFromRemoteUrl(originUrl)?.owner ?? null : null;
}
