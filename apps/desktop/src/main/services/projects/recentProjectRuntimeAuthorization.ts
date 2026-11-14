import fs from "node:fs";
import path from "node:path";
import { gitRemoteIdentity, isSameGitRepository } from "../github/githubSshAlias";
import { readGitConfigOriginUrl } from "./recentProjectSummary";
import type { RecentProjectSummary } from "../../../shared/types";

/** A local checkout a window may reach: its root and the origin something recorded for it. */
type RuntimeRootCandidate = { rootPath: string; gitOriginUrl: string | null };

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
  findRegisteredProject?: (rootPath: string) => RuntimeRootCandidate | null;
  /** Hears a registry read that failed (the root is then refused). */
  logger?: { warn(event: string, data?: Record<string, unknown>): void };
}): string | null {
  const requestedKey = runtimeRootKey(args.requestedRootPath);
  const recent = args.localRecentProjects.find((entry) =>
    entry.kind !== "remote" &&
    entry.exists &&
    runtimeRootKey(entry.rootPath) === requestedKey
  );
  const candidate = recent
    ? { rootPath: recent.rootPath, gitOriginUrl: recent.gitOriginUrl ?? null }
    : registeredCandidate(args.requestedRootPath, requestedKey, args.findRegisteredProject, args.logger);
  if (!candidate) return null;
  // The origin on disk now, over the one recorded: a checkout whose origin
  // changed since must not pass as the old repository.
  const candidateOrigin = readGitConfigOriginUrl(candidate.rootPath) ?? candidate.gitOriginUrl;
  const requestedIdentity = gitRemoteIdentity(candidateOrigin);
  if (!requestedIdentity) return null;
  if (args.activeOriginIsPeer) {
    // Another machine's alias belongs to its ssh config, so it never resolves
    // here. The raw origin on disk still matches an older peer that sends the
    // same alias as written.
    return isSameGitRepository(candidateOrigin, args.activeGitOriginUrl) ? candidate.rootPath : null;
  }
  return requestedIdentity === gitRemoteIdentity(args.activeGitOriginUrl) ? candidate.rootPath : null;
}

function registeredCandidate(
  requestedRootPath: string,
  requestedKey: string,
  findRegisteredProject: ((rootPath: string) => RuntimeRootCandidate | null) | undefined,
  logger: { warn(event: string, data?: Record<string, unknown>): void } | undefined,
): RuntimeRootCandidate | null {
  if (!findRegisteredProject) return null;
  let registered: RuntimeRootCandidate | null = null;
  try {
    registered = findRegisteredProject(requestedRootPath);
  } catch (error) {
    // Refused, as with no registered project: the window reaches only what it can prove.
    logger?.warn("project.runtime_root_registry_read_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (!registered || runtimeRootKey(registered.rootPath) !== requestedKey) return null;
  return fs.existsSync(registered.rootPath) ? registered : null;
}
