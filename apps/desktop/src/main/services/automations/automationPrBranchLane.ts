/**
 * The lane for `execution.laneMode: "pr-branch"`: a lane on the trigger PR's own
 * head branch, so the agent's commits land on the PR.
 *
 * It reuses the lane already linked to the PR, so a second event for the same
 * PR runs where the first one did. Otherwise it imports the branch as a new
 * lane through `prService.createLaneFromPrBranch`, the same path as the PRs
 * tab. It never falls back to another lane: an archived linked lane or a
 * blocked import is an error the run reports.
 */

import { runGit } from "../git/git";
import type {
  AutomationTriggerPrContext,
  CreateLaneFromPrBranchArgs,
  CreateLaneFromPrBranchPreflightResult,
  CreateLaneFromPrBranchResult,
} from "../../../shared/types";

/** The two PR-service calls a `pr-branch` run needs. */
export type AutomationPrLaneService = {
  preflightCreateLaneFromPrBranch(args: CreateLaneFromPrBranchArgs): Promise<CreateLaneFromPrBranchPreflightResult>;
  createLaneFromPrBranch(args: CreateLaneFromPrBranchArgs): Promise<CreateLaneFromPrBranchResult>;
};

export type PrBranchLane = { id: string; name: string; branchRef?: string | null };

function branchName(ref: string | null | undefined): string {
  return (ref ?? "").trim().replace(/^refs\/heads\//, "");
}

export async function resolvePrBranchLane(args: {
  pr: AutomationTriggerPrContext | null | undefined;
  /** A lane the trigger already names (a local `git.pr_*` event carries one but no PR context). */
  triggerLane: PrBranchLane | null;
  /** Rendered from the rule's naming preset or template; empty keeps the PR service's default name. */
  laneName: string;
  prService: AutomationPrLaneService | null;
  listActiveLanes: () => Promise<PrBranchLane[]>;
  /**
   * Bring a reused lane up to the PR's current head (a bot may have pushed or
   * rebased since the lane was opened). Throws when it cannot do so safely.
   */
  advanceLaneToPrHead: (lane: PrBranchLane, prNumber: number) => Promise<void>;
}): Promise<PrBranchLane> {
  const { pr, prService } = args;
  if (!pr?.number) {
    if (args.triggerLane) return args.triggerLane;
    throw new Error("This automation runs in the PR's branch, but the trigger has no pull request.");
  }
  if (!prService) throw new Error("The pull request service is unavailable, so ADE cannot open the PR's branch.");
  const [repoOwner, repoName] = (pr.repo ?? "").split("/");
  const locator: CreateLaneFromPrBranchArgs = pr.url
    ? { prUrlOrNumber: pr.url }
    : repoOwner && repoName
      ? { repoOwner, repoName, githubPrNumber: pr.number }
      : { prUrlOrNumber: String(pr.number) };
  const request: CreateLaneFromPrBranchArgs = { ...locator, ...(args.laneName ? { laneName: args.laneName } : {}) };

  const findLinkedLane = async (): Promise<PrBranchLane | null> => {
    const { preflight } = await prService.preflightCreateLaneFromPrBranch(request);
    const block = preflight.blockingConflict;
    if (block?.code !== "already_mapped" || !block.laneId) {
      if (!preflight.canCreate) throw new Error(block?.message || `PR #${pr.number} cannot be opened as a lane.`);
      return null;
    }
    const lane = (await args.listActiveLanes()).find((entry) => entry.id === block.laneId);
    if (!lane) throw new Error(`${block.message} That lane is archived, so ADE will not run in it.`);
    // A PR can be linked to a lane on another branch (PRs tab "link to lane").
    // Running there would push the PR's work to the wrong branch.
    const headBranch = preflight.headBranch?.trim();
    if (headBranch && branchName(lane.branchRef) !== headBranch) {
      throw new Error(`PR #${pr.number} is linked to lane '${lane.name}', which is not on the PR's branch '${headBranch}'.`);
    }
    return lane;
  };

  const linked = await findLinkedLane();
  if (linked) {
    await args.advanceLaneToPrHead(linked, pr.number);
    return linked;
  }
  try {
    // A freshly imported lane is already at the PR's head.
    return (await prService.createLaneFromPrBranch(request)).lane;
  } catch (error) {
    // Another event for the same PR may have imported it a moment ago.
    const raced = await findLinkedLane().catch(() => null);
    if (raced) return raced;
    throw error;
  }
}

/**
 * Fast-forward a lane's worktree to the PR's current head. `pull/<n>/head`
 * names the PR's head on GitHub for a same-repo or a fork PR alike. Never
 * discards work: uncommitted changes or a lane that has diverged from the PR
 * fail the run with a reason instead.
 */
export async function advanceLaneToPrHead(worktreePath: string, laneName: string, prNumber: number): Promise<void> {
  const fetch = await runGit(["fetch", "--no-tags", "origin", `pull/${prNumber}/head`], { cwd: worktreePath, timeoutMs: 60_000 });
  if (fetch.exitCode !== 0) {
    throw new Error(`Could not fetch PR #${prNumber} into lane '${laneName}': ${fetch.stderr.trim() || "git fetch failed"}.`);
  }
  const status = await runGit(["status", "--porcelain"], { cwd: worktreePath, timeoutMs: 15_000 });
  if (status.exitCode !== 0 || status.stdout.trim()) {
    throw new Error(`Lane '${laneName}' has uncommitted changes, so ADE will not move it to PR #${prNumber}'s latest commit.`);
  }
  const merge = await runGit(["merge", "--ff-only", "FETCH_HEAD"], { cwd: worktreePath, timeoutMs: 30_000 });
  if (merge.exitCode !== 0) {
    throw new Error(`Lane '${laneName}' has diverged from PR #${prNumber}'s branch, so ADE will not run in it.`);
  }
}
