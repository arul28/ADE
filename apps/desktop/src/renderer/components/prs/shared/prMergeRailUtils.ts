import type {
  MergeMethod,
  PrCheck,
  PrCommit,
  PrReview,
  PrStatus,
  PrWithConflicts,
} from "../../../../shared/types/prs";
import { summarizeChecks } from "./prCheckList";

export type MergeBlocker = {
  id: string;
  label: string;
};

/** A single requirement row in the GitHub-style merge checklist. */
export type MergeChecklistItem = {
  id: string;
  label: string;
  /** `pass` → green ✓, `fail` → red ✗, `neutral` → muted ● (info / not applicable). */
  state: "pass" | "fail" | "neutral";
  /** Secondary detail line (e.g. "0 of 1 required"). */
  detail?: string;
};

export function mergeMethodLabel(method: MergeMethod): string {
  switch (method) {
    case "squash":
      return "Squash and merge";
    case "rebase":
      return "Rebase and merge";
    default:
      return "Create merge commit";
  }
}

export function mergeMethodShortLabel(method: MergeMethod): string {
  switch (method) {
    case "squash":
      return "Squash";
    case "rebase":
      return "Rebase";
    default:
      return "Merge";
  }
}

export function buildMergeCommandLineInstructions(args: {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  method: MergeMethod;
  bypassRules?: boolean;
}): string {
  const methodFlag = `--${args.method}`;
  const adminFlag = args.bypassRules ? " --admin" : "";
  return `gh pr merge ${args.prNumber} ${methodFlag}${adminFlag} --repo ${args.repoOwner}/${args.repoName}`;
}

export function deriveMergeBlockers(args: {
  pr: PrWithConflicts;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
}): MergeBlocker[] {
  const blockers: MergeBlocker[] = [];
  const { pr, status, checks, reviews } = args;

  if (pr.state === "draft") {
    blockers.push({ id: "draft", label: "This pull request is still a draft." });
  }
  if (pr.state === "closed") {
    blockers.push({ id: "closed", label: "This pull request is closed." });
  }
  if (status?.mergeConflicts) {
    blockers.push({ id: "conflicts", label: "This branch has conflicts that must be resolved." });
  }
  const behindBaseBy = status?.behindBaseBy ?? 0;
  if (behindBaseBy > 0) {
    blockers.push({
      id: "behind",
      label: `The head branch is ${behindBaseBy} commit${behindBaseBy === 1 ? "" : "s"} behind the base branch.`,
    });
  }

  // NOTE: this function has no production caller — only its own test — but it
  // duplicates `buildMergeChecklist`'s checks logic, so it is kept in step with
  // it. Letting the two diverge is how the ADE-135 bug survived in one of them.
  const checkSummary = summarizeChecks(checks);
  const blockersRollup = status?.checksStatus ?? pr.checksStatus;
  if (blockersRollup === "not_run") {
    blockers.push({
      id: "no-ci",
      label: "No CI has run on this commit.",
    });
  }
  if (checkSummary.failing > 0) {
    blockers.push({
      id: "failing-checks",
      label: `${checkSummary.failing} required check${checkSummary.failing === 1 ? "" : "s"} ${checkSummary.failing === 1 ? "is" : "are"} failing.`,
    });
  }
  if (checkSummary.pending > 0) {
    blockers.push({
      id: "pending-checks",
      label: `${checkSummary.pending} required check${checkSummary.pending === 1 ? "" : "s"} ${checkSummary.pending === 1 ? "hasn't" : "haven't"} completed yet.`,
    });
  }

  const changesRequested = reviews.filter((review) => review.state === "changes_requested");
  if (changesRequested.length > 0) {
    const reviewers = [...new Set(changesRequested.map((review) => review.reviewer))].slice(0, 3);
    blockers.push({
      id: "changes-requested",
      label: reviewers.length
        ? `Reviewers requested changes (${reviewers.join(", ")}).`
        : "A reviewer requested changes.",
    });
  }

  if (pr.reviewStatus === "requested" || (status?.reviewStatus === "requested")) {
    blockers.push({ id: "review-requested", label: "At least one approving review is required." });
  }

  if (status && !status.isMergeable && !status.mergeConflicts && blockers.length === 0) {
    blockers.push({ id: "not-mergeable", label: "Merging is blocked by branch protection rules." });
  }

  return blockers;
}

export function isBotLogin(login: string | null | undefined): boolean {
  if (!login) return false;
  const normalized = login.toLowerCase();
  return normalized.endsWith("[bot]") || normalized.endsWith("-bot") || normalized === "github-actions";
}

export function reviewStateForLogin(reviews: PrReview[], login: string): PrReview["state"] | null {
  const matches = reviews.filter((review) => review.reviewer === login);
  if (matches.length === 0) return null;
  const priority: PrReview["state"][] = [
    "changes_requested",
    "approved",
    "commented",
    "dismissed",
    "pending",
  ];
  for (const state of priority) {
    if (matches.some((review) => review.state === state)) return state;
  }
  return matches[matches.length - 1]?.state ?? null;
}

export function canAttemptMerge(args: {
  pr: PrWithConflicts;
  status: PrStatus | null;
  bypassRules: boolean;
}): boolean {
  const { pr, status, bypassRules } = args;
  if (pr.state !== "open") return false;
  const mergeState = status?.mergeStateStatus;
  // Prefer GitHub's merge-box state when the runtime reports it.
  if (mergeState) {
    if (mergeState === "dirty" || mergeState === "draft") return false;
    if (status?.mergeConflicts) return false;
    // Admin bypass can land anything that isn't conflicted/draft, as long as we
    // have a status snapshot to merge against.
    if (bypassRules) return Boolean(status);
    return mergeState === "clean" || mergeState === "has_hooks" || mergeState === "unstable";
  }
  // Fallback to the legacy boolean when mergeStateStatus is absent.
  if (status?.mergeConflicts) return false;
  if (bypassRules) return Boolean(status);
  return Boolean(status?.isMergeable);
}

/**
 * Derives the structured GitHub-style requirement checklist for a PR. Pure and
 * unit-testable; the {@link PrMergeChecklist} component renders the result. Rows
 * are driven primarily by `status.mergeStateStatus` + `reviewDecision`, falling
 * back to checks/reviews/conflict booleans when the merge-box state is absent.
 */
export function buildMergeChecklist(args: {
  pr: PrWithConflicts;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
}): MergeChecklistItem[] {
  const { pr, status, checks, reviews } = args;
  const items: MergeChecklistItem[] = [];
  const mergeState = status?.mergeStateStatus ?? null;
  const blocked = mergeState === "blocked";

  // --- Review requirement ---------------------------------------------------
  const reviewDecision = status?.reviewDecision ?? null;
  const required = status?.requiredApprovals ?? null;
  const approvals = status?.approvalsCount ?? null;
  const changesRequested = reviews.filter((review) => review.state === "changes_requested");
  if (reviewDecision === "changes_requested" || changesRequested.length > 0) {
    const reviewers = [...new Set(changesRequested.map((review) => review.reviewer))].slice(0, 3);
    items.push({
      id: "review",
      label: "Changes requested",
      state: "fail",
      detail: reviewers.length ? `Requested by ${reviewers.join(", ")}` : undefined,
    });
  } else if (reviewDecision === "review_required") {
    items.push({
      id: "review",
      label: "Review required",
      state: "fail",
      detail: required != null ? `${approvals ?? 0} of ${required} required approval${required === 1 ? "" : "s"}` : undefined,
    });
  } else if (reviewDecision === "approved") {
    items.push({
      id: "review",
      label: "Changes approved",
      state: "pass",
      detail: required != null ? `${approvals ?? required} of ${required} required approval${required === 1 ? "" : "s"}` : undefined,
    });
  } else if (reviewDecision == null && (pr.reviewStatus === "requested" || status?.reviewStatus === "requested")) {
    // Older runtimes without reviewDecision: fall back to the summary status.
    items.push({ id: "review", label: "Review required", state: "fail" });
  }

  // --- Checks ---------------------------------------------------------------
  // ADE-135: `summarizeChecks` counts rows and is producer-blind, so on a PR
  // whose only checks are third-party apps (CodeRabbit, Vercel, a comment bot)
  // it reports `passing: 3` and this row said "All 3 checks passed" — the
  // ticket's exact lie, on the surface a reader trusts most. The canonical
  // rollup decides the verdict; the counts are still summarizeChecks' job.
  const summary = summarizeChecks(checks);
  const checksRollup = status?.checksStatus ?? pr.checksStatus;
  if (summary.failing > 0) {
    items.push({
      id: "checks",
      label: `${summary.failing} failing check${summary.failing === 1 ? "" : "s"}`,
      state: "fail",
    });
  } else if (summary.pending > 0) {
    items.push({
      id: "checks",
      label: `${summary.pending} pending check${summary.pending === 1 ? "" : "s"}`,
      state: "neutral",
    });
  } else if (checksRollup === "not_run") {
    items.push({
      id: "checks",
      label: "No CI has run on this commit",
      state: "neutral",
    });
  } else if (summary.passing > 0) {
    items.push({
      id: "checks",
      label: `All ${summary.passing} check${summary.passing === 1 ? "" : "s"} passed`,
      state: "pass",
    });
  }

  // Conflict and base-sync rows are only emitted when we actually have a live
  // status. Without it (e.g. an unmapped GitHub-tab PR with no fetched merge
  // box) we must NOT assert "no conflicts" / "up to date" — that would claim
  // the PR is fine when ADE has no data at all.
  if (status) {
    // --- Conflicts ----------------------------------------------------------
    const hasConflicts = mergeState === "dirty" || Boolean(status.mergeConflicts);
    items.push({
      id: "conflicts",
      label: hasConflicts ? "Conflicts with base branch" : "No conflicts with base branch",
      state: hasConflicts ? "fail" : "pass",
    });

    // --- Up to date with base (carries the inline update-branch button) -----
    // GitHub only reports mergeStateStatus "behind" when the base requires an
    // up-to-date branch, so that case blocks the merge ("fail"). A bare
    // behindBaseBy > 0 (rule off, still mergeable) is informational ("neutral").
    const behind = status.behindBaseBy ?? 0;
    if (mergeState === "behind" || behind > 0) {
      items.push({
        id: "behind",
        label: behind > 0
          ? `${behind} commit${behind === 1 ? "" : "s"} behind base branch`
          : "Out of date with base branch",
        state: mergeState === "behind" ? "fail" : "neutral",
      });
    } else {
      items.push({ id: "behind", label: "Up to date with base branch", state: "pass" });
    }
  }

  // --- Branch protection ----------------------------------------------------
  if (blocked) {
    items.push({
      id: "protected",
      label: "Protected by branch rules",
      state: "neutral",
      detail: status?.canBypass ? "You can bypass as an administrator" : undefined,
    });
  }

  return items;
}

/**
 * Builds GitHub-fidelity default merge commit messages for the dialog editor.
 * - `squash` → title `"<prTitle> (#<n>)"`, body = each commit subject/message.
 * - `merge`  → title `"Merge pull request #<n> from <owner>/<head>"`, body = PR title.
 * - `rebase` → empty (no commit message editor).
 */
export function buildDefaultCommitMessage(args: {
  method: MergeMethod;
  prTitle: string;
  prNumber: number;
  headBranch: string;
  baseBranch: string;
  repoOwner: string;
  commits: PrCommit[];
}): { title: string; body: string } {
  const { method, prTitle, prNumber, headBranch, repoOwner, commits } = args;
  if (method === "rebase") {
    return { title: "", body: "" };
  }
  if (method === "merge") {
    return {
      title: `Merge pull request #${prNumber} from ${repoOwner}/${headBranch}`,
      body: prTitle,
    };
  }
  // squash: concatenate the commit subjects/messages like GitHub does.
  const body = commits
    .map((commit) => {
      const message = (commit.message ?? "").trim();
      // GitHub bullets each commit's full message; collapse trailing blank lines.
      return message ? `* ${message.replace(/\n{3,}/g, "\n\n")}` : null;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
  return {
    title: `${prTitle} (#${prNumber})`,
    body,
  };
}
