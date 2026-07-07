import fs from "node:fs";
import path from "node:path";

import {
  githubRepoSlugsEqual,
  parseGithubRemoteUrl,
  type GithubRepoSlug,
} from "../../../shared/githubRemote";
import type {
  ProjectFindForRepoArgs,
  ProjectFindForRepoResult,
  RecentProjectSummary,
} from "../../../shared/types";

type OriginCacheEntry = {
  configPath: string;
  mtimeMs: number;
  slug: GithubRepoSlug | null;
};

const originCache = new Map<string, OriginCacheEntry>();

export function clearRepoProjectResolverCacheForTests(): void {
  originCache.clear();
}

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

function readGithubOriginSlug(rootPath: string): GithubRepoSlug | null {
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
    return cached.slug;
  }

  let slug: GithubRepoSlug | null = null;
  try {
    const remoteUrl = readOriginRemoteUrlFromGitConfig(fs.readFileSync(configPath, "utf8"));
    slug = parseGithubRemoteUrl(remoteUrl);
  } catch {
    slug = null;
  }

  originCache.set(rootPath, { configPath, mtimeMs: stat.mtimeMs, slug });
  return slug;
}

export function findRecentProjectForRepo(
  recentProjects: RecentProjectSummary[],
  repo: ProjectFindForRepoArgs,
): ProjectFindForRepoResult {
  const targetSlug: GithubRepoSlug = {
    owner: repo.repoOwner,
    repo: repo.repoName,
  };

  for (const project of recentProjects) {
    if (project.remote || project.kind === "remote" || project.exists === false) continue;
    const slug = readGithubOriginSlug(project.rootPath);
    if (!githubRepoSlugsEqual(slug, targetSlug)) continue;
    return {
      rootPath: project.rootPath,
      displayName: project.displayName,
    };
  }

  return null;
}
