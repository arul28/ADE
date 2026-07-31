import { runGit, runGitOrThrow } from "../git/git";
import { normalizeBranchName } from "./utils";

export async function fetchRemoteTrackingBranch(args: {
  projectRoot: string;
  targetBranch: string | null | undefined;
}): Promise<boolean> {
  const branch = normalizeBranchName(String(args.targetBranch ?? "").trim());
  if (!branch) return false;
  try {
    await runGitOrThrow(
      ["fetch", "--prune", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { cwd: args.projectRoot, timeoutMs: 120_000 },
    );
    return true;
  } catch {
    await runGit(["fetch", "--prune", "origin"], {
      cwd: args.projectRoot,
      timeoutMs: 120_000,
    });
    return false;
  }
}
