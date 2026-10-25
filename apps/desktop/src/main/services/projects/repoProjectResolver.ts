import fs from "node:fs";
import path from "node:path";

import {
  githubRepoSlugsEqual,
  parseGithubRemoteUrl,
  type GithubRepoSlug,
} from "../../../shared/githubRemote";
import { resolveGithubRemoteRepo } from "../github/githubSshAlias";
import type {
  ProjectFindForRepoArgs,
  ProjectFindForRepoResult,
  RecentProjectSummary,
} from "../../../shared/types";

type OriginCacheEntry = {
  configPath: string;
  mtimeMs: number;
  remoteUrl: string | null;
};

const originCache = new Map<string, OriginCacheEntry>();

function resolveGitDir(rootPath: string): string | null {
  const gitPath = path.join(rootPath, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(gitPath);
  } catch {
    return null;
  }

  if (stat.isDirectory()) return gitPath;
  if (!stat.isFile()) return null;

  try {
    const content = fs.readFileSync(gitPath, "utf8");
    const match = content.match(/^gitdir:\s*(.+)\s*$/im);
    const rawGitDir = match?.[1]?.trim();
    return rawGitDir ? path.resolve(rootPath, rawGitDir) : null;
  } catch {
    return null;
  }
}

function resolveGitConfigPath(rootPath: string): string | null {
  const gitDir = resolveGitDir(rootPath);
  return gitDir ? path.join(gitDir, "config") : null;
}

export function readOriginRemoteUrlFromGitConfig(configText: string): string | null {
  let inOriginRemote = false;

  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      inOriginRemote = /^remote\s+"origin"$/i.test(section[1]?.trim() ?? "");
      continue;
    }

    if (!inOriginRemote) continue;
    const url = line.match(/^url\s*=\s*(.+)$/i);
    if (url) return url[1]?.trim() || null;
  }

  return null;
}

function readOriginRemoteUrl(rootPath: string): string | null {
  const configPath = resolveGitConfigPath(rootPath);
  if (!configPath) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(configPath);
  } catch {
    return null;
  }

  const cached = originCache.get(rootPath);
  if (
    cached
    && cached.configPath === configPath
    && cached.mtimeMs === stat.mtimeMs
  ) {
    return cached.remoteUrl;
  }

  let remoteUrl: string | null = null;
  try {
    remoteUrl = readOriginRemoteUrlFromGitConfig(fs.readFileSync(configPath, "utf8"));
  } catch {
    remoteUrl = null;
  }

  originCache.set(rootPath, { configPath, mtimeMs: stat.mtimeMs, remoteUrl });
  return remoteUrl;
}

export async function findRecentProjectForRepo(
  recentProjects: RecentProjectSummary[],
  repo: ProjectFindForRepoArgs,
): Promise<ProjectFindForRepoResult> {
  const targetSlug: GithubRepoSlug = {
    owner: repo.repoOwner,
    repo: repo.repoName,
  };

  const candidates: Array<{ project: RecentProjectSummary; remoteUrl: string }> = [];
  for (const project of recentProjects) {
    if (project.remote || project.kind === "remote" || project.exists === false) continue;
    const remoteUrl = readOriginRemoteUrl(project.rootPath);
    if (remoteUrl) candidates.push({ project, remoteUrl });
  }

  const match = (project: RecentProjectSummary): ProjectFindForRepoResult => ({
    rootPath: project.rootPath,
    displayName: project.displayName,
  });
  // A plain GitHub origin answers from the file alone. Only when none matches
  // does an SSH-alias origin cost an `ssh -G` lookup.
  for (const { project, remoteUrl } of candidates) {
    if (githubRepoSlugsEqual(parseGithubRemoteUrl(remoteUrl), targetSlug)) return match(project);
  }
  for (const { project, remoteUrl } of candidates) {
    if (parseGithubRemoteUrl(remoteUrl)) continue;
    if (githubRepoSlugsEqual(await resolveGithubRemoteRepo(remoteUrl), targetSlug)) return match(project);
  }

  return null;
}
