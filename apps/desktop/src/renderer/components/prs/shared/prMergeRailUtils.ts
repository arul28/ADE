import type {
  MergeMethod,
  PrCheck,
  PrComment,
  PrDetail,
  PrReview,
  PrStatus,
  PrUser,
  PrWithConflicts,
} from "../../../../shared/types/prs";
import { summarizeChecks } from "./prCheckList";

export type MergeBlocker = {
  id: string;
  label: string;
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
  if (status && status.behindBaseBy > 0) {
    blockers.push({
      id: "behind",
      label: `The head branch is ${status.behindBaseBy} commit${status.behindBaseBy === 1 ? "" : "s"} behind the base branch.`,
    });
  }

  const checkSummary = summarizeChecks(checks);
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

export function deriveParticipants(args: {
  detail: PrDetail | null;
  reviews: PrReview[];
  comments: PrComment[];
}): PrUser[] {
  const byLogin = new Map<string, PrUser>();
  const add = (user: { login?: string | null; avatarUrl?: string | null } | null | undefined) => {
    const login = user?.login?.trim();
    if (!login) return;
    if (!byLogin.has(login)) {
      byLogin.set(login, { login, avatarUrl: user?.avatarUrl ?? null });
    }
  };

  add(args.detail?.author);
  for (const assignee of args.detail?.assignees ?? []) add(assignee);
  for (const reviewer of args.detail?.requestedReviewers ?? []) add(reviewer);
  for (const review of args.reviews) add({ login: review.reviewer, avatarUrl: review.reviewerAvatarUrl });
  for (const comment of args.comments) add({ login: comment.author, avatarUrl: comment.authorAvatarUrl });

  return [...byLogin.values()].sort((a, b) => a.login.localeCompare(b.login));
}

export function canAttemptMerge(args: {
  pr: PrWithConflicts;
  status: PrStatus | null;
  bypassRules: boolean;
}): boolean {
  if (args.pr.state !== "open" && args.pr.state !== "draft") return false;
  if (args.status?.mergeConflicts) return false;
  if (args.bypassRules) return Boolean(args.status);
  return Boolean(args.status?.isMergeable);
}
