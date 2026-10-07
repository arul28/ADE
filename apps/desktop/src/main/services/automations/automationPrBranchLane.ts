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
  if (linked) return linked;
  try {
    return (await prService.createLaneFromPrBranch(request)).lane;
  } catch (error) {
    // Another event for the same PR may have imported it a moment ago.
    const raced = await findLinkedLane().catch(() => null);
    if (raced) return raced;
    throw error;
  }
}
