/**
 * Path to Merge seed prompt.
 *
 * Builds the standing contract handed to the visible watcher chat agent that
 * drives a single PR to merge. The agent — not a TypeScript state machine —
 * owns every judgment: when CI / review are terminal, how to fix failures, how
 * to resolve conflicts, and which merge tactic to use.
 *
 * The merge/wait/fix rules are distilled from `docs/playbooks/ship-lane.md`.
 * A thin main-process scheduler re-prompts this session with
 * {@link buildWatchTurnPrompt} every `pollIntervalSeconds`, because no chat
 * runtime can self-wake.
 */

import type { PrIssueResolutionScope, PrSummary } from "../../../shared/types";

export type PathToMergeSeedInputs = {
  pr: Pick<
    PrSummary,
    "githubPrNumber" | "githubUrl" | "title" | "repoOwner" | "repoName" | "baseBranch" | "headBranch"
  >;
  laneWorktreePath: string;
  /** Which signals gate the merge. `both` is the safest default. */
  gating: PrIssueResolutionScope;
  /** Free-form operator instructions appended verbatim to the contract. */
  additionalInstructions: string | null;
  /** Interval (seconds) the scheduler uses between watch turns; surfaced so the agent paces itself. */
  pollIntervalSeconds: number;
};

export function pathToMergeChatTitle(pr: Pick<PrSummary, "githubPrNumber">): string {
  return `Path to Merge #${pr.githubPrNumber}`;
}

function describeGating(gating: PrIssueResolutionScope): string {
  switch (gating) {
    case "checks":
      return [
        "GATING = CI ONLY.",
        "- The merge is allowed the moment every required CI check is green, regardless of review state.",
        "- You may still push fixes for failing checks, but do NOT block the merge on unresolved review comments or a missing approval.",
      ].join("\n");
    case "comments":
      return [
        "GATING = REVIEW COMMENTS ONLY.",
        "- The merge is allowed once all actionable review threads are resolved and no reviewer is requesting changes.",
        "- Do NOT block the merge on CI being green; address review feedback, then merge.",
      ].join("\n");
    case "both":
    default:
      return [
        "GATING = BOTH (CI + review).",
        "- The merge is allowed only when every required CI check is green AND all actionable review threads are resolved with no changes requested.",
      ].join("\n");
  }
}

export function buildPathToMergeSeedPrompt(inputs: PathToMergeSeedInputs): string {
  const { pr, laneWorktreePath, gating, additionalInstructions, pollIntervalSeconds } = inputs;
  const repo = `${pr.repoOwner}/${pr.repoName}`;
  const minutes = Math.max(1, Math.round(pollIntervalSeconds / 60));

  const sections: string[] = [];

  sections.push(
    [
      `You are the Path to Merge watcher for pull request #${pr.githubPrNumber} in ${repo}.`,
      `PR: ${pr.title}`,
      `URL: ${pr.githubUrl}`,
      `Head branch: ${pr.headBranch}  →  base branch: ${pr.baseBranch}`,
      `Working directory (this PR's lane worktree): ${laneWorktreePath}`,
    ].join("\n"),
  );

  sections.push(
    [
      "## Mission",
      `Drive this PR to a merged state into ${pr.baseBranch}, autonomously, across many turns. You own every decision: whether CI/review are terminal, how to fix failures, how to resolve conflicts, and which merge tactic to use. When the PR is genuinely merged you are done.`,
    ].join("\n"),
  );

  sections.push(
    [
      "## How you run (important)",
      `You cannot sleep or self-schedule. A background scheduler re-prompts you with a short "watch turn" roughly every ${minutes} min (${pollIntervalSeconds}s). Treat each turn as one bounded unit of work:`,
      "1. Re-read ground truth from GitHub via the `gh` CLI (or ADE PR tools) — never trust a stale snapshot. Useful: `gh pr view <N> --json state,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,reviews`, `gh pr checks <N>`, `gh run view <id> --log-failed`, `gh api repos/" + repo + "/pulls/<N>/comments`.",
      "2. Decide the single next action toward merge and do it.",
      "3. End the turn with a one-line status. Do NOT busy-wait inside a turn for CI to finish — end the turn and let the next watch turn re-check.",
    ].join("\n"),
  );

  sections.push(["## Merge gate", describeGating(gating)].join("\n"));

  sections.push(
    [
      "## Fixing failures",
      `- Failing CI: open the failing run's logs, reproduce/diagnose in the worktree (${laneWorktreePath}), make the smallest correct fix, commit, and push the branch. Then end the turn so CI can re-run.`,
      "- Review feedback (when gated on it): address each actionable thread with a real code change or a clear reply, push, and resolve the thread. Ignore pure-noise bot chatter.",
      `- Behind base / merge conflicts: bring ${pr.headBranch} up to date with ${pr.baseBranch} yourself (rebase or merge base in, resolve conflicts, push). Do not park waiting for a human.`,
      "- Stay scoped to this PR's worktree. Never edit files outside it.",
    ].join("\n"),
  );

  sections.push(
    [
      "## Merge tactics (the ladder)",
      "Once the gate above is satisfied AND required CI is green, land the PR:",
      `1. \`gh pr merge ${pr.githubPrNumber} --squash\` (or the repo's allowed method).`,
      `2. If that fails with a base-branch policy block (e.g. "the base branch policy prohibits the merge") and you have admin rights, retry with \`gh pr merge ${pr.githubPrNumber} --squash --admin\`. Use \`--admin\` ONLY to bypass a branch-protection policy on an otherwise-ready PR — never to skip red CI.`,
      `3. If you are not an admin (or \`--admin\` is rejected), arm GitHub's native auto-merge: \`gh pr merge ${pr.githubPrNumber} --squash --auto\`. The PR will land on its own once its required gates clear; report that it is armed and keep watching until GitHub merges it.`,
      "4. NEVER pass `--delete-branch` to `gh pr merge` — it checks out the base branch locally and breaks when it is checked out in another worktree. After the merge succeeds, delete the remote head ref server-side instead:",
      `   \`gh api -X DELETE repos/${repo}/git/refs/heads/${pr.headBranch}\``,
      "If the merge is genuinely impossible (policy block + no admin + auto-merge disabled), stop and leave a short PR comment explaining which reviewer/approval is required, then end the turn without looping.",
    ].join("\n"),
  );

  const extra = additionalInstructions?.trim();
  if (extra) {
    sections.push(["## Additional operator instructions", extra].join("\n"));
  }

  sections.push(
    [
      "## Start now",
      "Take your first turn: read the current PR state, then begin moving it toward merge per the rules above.",
    ].join("\n"),
  );

  return sections.join("\n\n");
}

export function buildWatchTurnPrompt(pr: Pick<PrSummary, "githubPrNumber">): string {
  return [
    `Watch turn for PR #${pr.githubPrNumber}.`,
    "Re-read the PR's current CI, review, conflict, and merge state from GitHub, then take the single next action toward merging it per your standing Path to Merge instructions.",
    "If it is already merged or closed, say so and stop. Keep this turn bounded — do one unit of work and end with a one-line status.",
  ].join(" ");
}
