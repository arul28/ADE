import fs from "node:fs";
import path from "node:path";
import { githubRepoRefFromRemoteUrl } from "../../../shared/githubRemote";

/**
 * The project's `origin` URL read straight from its git config files, with no
 * process started. For synchronous paths (a chat's environment is built
 * synchronously) that cannot wait for `git remote get-url`. Handles a linked
 * worktree (`.git` file, `commondir`) and `config.worktree`.
 */

function readOriginUrlFromConfig(configPath: string): string | null {
  try {
    // Reading a FIFO here would freeze the whole process.
    if (!fs.statSync(configPath, { throwIfNoEntry: false })?.isFile()) return null;
    const raw = fs.readFileSync(configPath, "utf8");
    let inOriginSection = false;
    for (const line of raw.split(/\r?\n/)) {
      const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (section) {
        inOriginSection = /^remote\s+"origin"$/i.test(section[1]?.trim() ?? "");
        continue;
      }
      if (!inOriginSection) continue;
      const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (url?.[1]?.trim()) return url[1].trim();
    }
    return null;
  } catch {
    return null;
  }
}

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
  return (
    readOriginUrlFromConfig(path.join(gitDir, "config.worktree")) ??
    readOriginUrlFromConfig(path.join(commonGitDir, "config")) ??
    readOriginUrlFromConfig(path.join(gitDir, "config"))
  );
}

/** The GitHub owner of the project's `origin`, from its git config alone; null when it does not say. */
export function peekGithubRepoOwnerFromGitConfig(projectRoot: string): string | null {
  const originUrl = readOriginUrlFromGitConfig(projectRoot);
  return originUrl ? githubRepoRefFromRemoteUrl(originUrl)?.owner ?? null : null;
}
