import path from "node:path";
import { gitRemoteIdentity } from "../github/githubSshAlias";
import type { RecentProjectSummary } from "../../../shared/types";

function runtimeRootKey(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function authorizeRecentProjectRuntimeRoot(args: {
  requestedRootPath: string;
  activeGitOriginUrl: string | null | undefined;
  localRecentProjects: RecentProjectSummary[];
}): string | null {
  const requestedKey = runtimeRootKey(args.requestedRootPath);
  const recent = args.localRecentProjects.find((entry) =>
    entry.kind !== "remote" &&
    entry.exists &&
    runtimeRootKey(entry.rootPath) === requestedKey
  );
  const requestedIdentity = gitRemoteIdentity(recent?.gitOriginUrl);
  const activeIdentity = gitRemoteIdentity(args.activeGitOriginUrl);
  return recent && requestedIdentity && requestedIdentity === activeIdentity
    ? recent.rootPath
    : null;
}
