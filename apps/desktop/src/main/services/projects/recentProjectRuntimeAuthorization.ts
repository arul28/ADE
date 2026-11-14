import fs from "node:fs";
import path from "node:path";
import { gitRemoteIdentity, isSameGitRepository } from "../github/githubSshAlias";
import { readGitConfigOriginUrl } from "./recentProjectSummary";
import type { RecentProjectSummary } from "../../../shared/types";

function runtimeRootKey(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * A local runtime root a window may reach beyond the ones it shows: a local
 * project of the same repository as the window's binding (local or another
 * machine's). It is one of this app's recent projects, or else a project this
 * machine's ADE has registered (`findRegisteredProject`): a chat's work copy
 * here, made for a chat on another machine, lives in such a project, which
 * this window never opened. Either way the root must exist here and carry the
 * same git origin, so a window still reaches only its own repository.
 */
export function authorizeRecentProjectRuntimeRoot(args: {
  requestedRootPath: string;
  activeGitOriginUrl: string | null | undefined;
  /** The active origin came from another machine's binding, not this disk. */
  activeOriginIsPeer?: boolean;
  localRecentProjects: RecentProjectSummary[];
  /** This machine's registered ADE project at exactly that root, when there is one. */
  findRegisteredProject?: (rootPath: string) => { rootPath: string; gitOriginUrl: string | null } | null;
}): string | null {
  const requestedKey = runtimeRootKey(args.requestedRootPath);
  const recent = args.localRecentProjects.find((entry) =>
    entry.kind !== "remote" &&
    entry.exists &&
    runtimeRootKey(entry.rootPath) === requestedKey
  );
  const candidate = recent
    ? { rootPath: recent.rootPath, gitOriginUrl: recent.gitOriginUrl ?? null }
    : registeredCandidate(args.requestedRootPath, requestedKey, args.findRegisteredProject);
  if (!candidate) return null;
  const candidateOrigin = candidate.gitOriginUrl ?? readGitConfigOriginUrl(candidate.rootPath);
  const requestedIdentity = gitRemoteIdentity(candidateOrigin);
  if (!requestedIdentity) return null;
  if (args.activeOriginIsPeer) {
    // Another machine's alias belongs to its ssh config, so it never resolves
    // here. The raw origin on disk still matches an older peer that sends the
    // same alias as written.
    const localOrigin = readGitConfigOriginUrl(candidate.rootPath) ?? candidateOrigin;
    return isSameGitRepository(localOrigin, args.activeGitOriginUrl) ? candidate.rootPath : null;
  }
  return requestedIdentity === gitRemoteIdentity(args.activeGitOriginUrl) ? candidate.rootPath : null;
}

function registeredCandidate(
  requestedRootPath: string,
  requestedKey: string,
  findRegisteredProject: ((rootPath: string) => { rootPath: string; gitOriginUrl: string | null } | null) | undefined,
): { rootPath: string; gitOriginUrl: string | null } | null {
  if (!findRegisteredProject) return null;
  let registered: { rootPath: string; gitOriginUrl: string | null } | null = null;
  try {
    registered = findRegisteredProject(requestedRootPath);
  } catch {
    return null;
  }
  if (!registered || runtimeRootKey(registered.rootPath) !== requestedKey) return null;
  return fs.existsSync(registered.rootPath) ? registered : null;
}
