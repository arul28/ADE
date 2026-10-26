import { runGitWithGithubAuthFallback, runGitWithGithubAuthFallbackOrThrow } from "../git/gitTransportAuth";
import { GIT_REMOTE_FETCH_TIMEOUT_MS } from "../git/git";
import { normalizeBranchName } from "./utils";

export async function fetchRemoteTrackingBranch(args: {
  projectRoot: string;
  targetBranch: string | null | undefined;
}): Promise<boolean> {
  const branch = normalizeBranchName(String(args.targetBranch ?? "").trim());
  if (!branch) return false;
  try {
    await runGitWithGithubAuthFallbackOrThrow(
      ["fetch", "--prune", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { cwd: args.projectRoot, timeoutMs: GIT_REMOTE_FETCH_TIMEOUT_MS },
    );
    return true;
  } catch {
    await runGitWithGithubAuthFallback(["fetch", "--prune", "origin"], {
      cwd: args.projectRoot,
      timeoutMs: GIT_REMOTE_FETCH_TIMEOUT_MS,
    });
    return false;
  }
}
