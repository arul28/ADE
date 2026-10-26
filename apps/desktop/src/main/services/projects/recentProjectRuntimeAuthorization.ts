import path from "node:path";
import { gitRemoteIdentity, isSameGitRepository } from "../github/githubSshAlias";
import { readGitConfigOriginUrl } from "./recentProjectSummary";
import type { RecentProjectSummary } from "../../../shared/types";

function runtimeRootKey(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function authorizeRecentProjectRuntimeRoot(args: {
  requestedRootPath: string;
  activeGitOriginUrl: string | null | undefined;
  /** The active origin came from another machine's binding, not this disk. */
  activeOriginIsPeer?: boolean;
  localRecentProjects: RecentProjectSummary[];
}): string | null {
  const requestedKey = runtimeRootKey(args.requestedRootPath);
  const recent = args.localRecentProjects.find((entry) =>
    entry.kind !== "remote" &&
    entry.exists &&
    runtimeRootKey(entry.rootPath) === requestedKey
  );
  if (!recent) return null;
  const requestedIdentity = gitRemoteIdentity(recent.gitOriginUrl);
  if (!requestedIdentity) return null;
  if (args.activeOriginIsPeer) {
    // Another machine's alias belongs to its ssh config, so it never resolves
    // here. The raw origin on disk still matches an older peer that sends the
    // same alias as written.
    const localOrigin = readGitConfigOriginUrl(recent.rootPath) ?? recent.gitOriginUrl;
    return isSameGitRepository(localOrigin, args.activeGitOriginUrl) ? recent.rootPath : null;
  }
  return requestedIdentity === gitRemoteIdentity(args.activeGitOriginUrl) ? recent.rootPath : null;
}
