import type {
  MergeMethod,
  MergeStateStatus,
  PrChecksStatus,
  PrReviewDecision,
  PrState,
} from "./types/prs";
import { normalizeGithubLogin } from "./prBotIdentity";

/**
 * The one next step for a PR: what the Merge card leads with, what the TUI
 * summary says, and what iOS shows in its merge bar. It guides and never gates:
 * "Merge anyway" stays available unless GitHub itself would refuse the merge
 * (conflicts, a draft, or protection rules without admin rights).
 */

export type PrNextStepKind =
  | "merged"
  | "closed"
  | "draft"
  | "computing"
  | "conflicts"
  | "behind"
  | "checks_failing"
  | "changes_requested"
  | "auto_merge_armed"
  | "checks_pending"
  | "review_required"
  | "rules_blocked"
  | "ready";

export type PrNextStepAction =
  | "delete_branch"
  | "reopen"
  | "ready_for_review"
  | "resolve_conflicts"
  | "update_branch"
  | "fix_checks"
  | "rerun_checks"
  | "address_feedback"
  | "enable_auto_merge"
  | "disable_auto_merge"
  | "request_review"
  | "fix_threads"
  | "merge";

export type PrNextStepTone = "success" | "danger" | "warning" | "info" | "neutral" | "merged";

export type PrRequirementChipId = "conflicts" | "up_to_date" | "checks" | "review" | "threads";
export type PrRequirementChipState = "pass" | "fail" | "pending" | "neutral";

export type PrRequirementChip = {
  id: PrRequirementChipId;
  state: PrRequirementChipState;
  label: string;
};

export type PrNextStepInput = {
  state: PrState;
  /** Null when no live merge box was read (older runtime, unmapped PR). */
  mergeStateStatus: MergeStateStatus | null;
  mergeConflicts: boolean;
  behindBaseBy: number | null;
  mergeabilityComputing: boolean;
  /** Canonical rollup (ADE-135): `not_run` means nothing verified the commit. */
  checksStatus: PrChecksStatus | null;
  checks: { failing: number; pending: number; passing: number };
  reviewDecision: PrReviewDecision | undefined;
  approvalsCount: number | null;
  requiredApprovals: number | null;
  /** Logins that requested changes and have not re-reviewed. */
  changesRequestedBy: string[];
  unresolvedThreads: number;
  canBypass: boolean;
  /** Undefined when the runtime did not report the repo setting. */
  autoMergeAllowed: boolean | undefined;
  autoMergeEnabled: boolean;
  autoMergeMethod: MergeMethod | null;
  baseBranch: string;
};

export type PrMergeAnyway = {
  /** Show the "Merge anyway" control (always true for an open, non-draft PR). */
  visible: boolean;
  /** GitHub would refuse: the control shows disabled with `blockedReason`. */
  blocked: boolean;
  blockedReason: string | null;
  /** Admin override of protection rules (`bypassRules: true`). */
  bypass: boolean;
  /** Plain list of what merging now skips, for the confirm step. */
  skips: string[];
};

export type PrNextStep = {
  kind: PrNextStepKind;
  tone: PrNextStepTone;
  headline: string;
  detail: string | null;
  primary: PrNextStepAction | null;
  secondary: PrNextStepAction | null;
  mergeAnyway: PrMergeAnyway;
  chips: PrRequirementChip[];
};

/** The slice of a next step a lane summary carries (TUI, lane lists). */
export type PrLaneNextStep = Pick<PrNextStep, "kind" | "headline" | "tone">;

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/**
 * GitHub answers `unknown` while it computes mergeability. That is no answer,
 * so it counts the same as no live merge box.
 */
function hasLiveMergeBox(input: PrNextStepInput): boolean {
  return input.mergeStateStatus !== null && input.mergeStateStatus !== "unknown";
}

function buildChips(input: PrNextStepInput, hasConflicts: boolean, behind: boolean): PrRequirementChip[] {
  const chips: PrRequirementChip[] = [];
  const liveBox = hasLiveMergeBox(input);
  if (liveBox || input.mergeConflicts) {
    chips.push(hasConflicts
      ? { id: "conflicts", state: "fail", label: "Conflicts" }
      : { id: "conflicts", state: "pass", label: "No conflicts" });
  }
  if (liveBox || input.behindBaseBy != null) {
    chips.push(behind
      ? { id: "up_to_date", state: "fail", label: input.behindBaseBy ? `${input.behindBaseBy} behind` : "Behind" }
      : { id: "up_to_date", state: "pass", label: "Up to date" });
  }
  const { failing, pending, passing } = input.checks;
  if (input.checksStatus === "not_run") {
    chips.push({ id: "checks", state: "neutral", label: "No CI ran" });
  } else if (failing > 0) {
    chips.push({ id: "checks", state: "fail", label: plural(failing, "failing check") });
  } else if (pending > 0) {
    chips.push({ id: "checks", state: "pending", label: plural(pending, "check") + " running" });
  } else if (passing > 0) {
    chips.push({ id: "checks", state: "pass", label: "Checks pass" });
  }
  if (input.changesRequestedBy.length > 0 || input.reviewDecision === "changes_requested") {
    chips.push({ id: "review", state: "fail", label: "Changes requested" });
  } else if (input.reviewDecision === "review_required") {
    const need = input.requiredApprovals;
    chips.push({
      id: "review",
      state: "fail",
      label: need != null ? `${input.approvalsCount ?? 0} of ${need} approvals` : "Review required",
    });
  } else if (input.reviewDecision === "approved") {
    chips.push({ id: "review", state: "pass", label: "Approved" });
  } else {
    chips.push({ id: "review", state: "neutral", label: "No review needed" });
  }
  if (input.unresolvedThreads > 0) {
    chips.push({ id: "threads", state: "pending", label: plural(input.unresolvedThreads, "open thread") });
  }
  return chips;
}

function buildSkips(input: PrNextStepInput, behind: boolean): string[] {
  const skips: string[] = [];
  if (input.checks.failing > 0) skips.push(plural(input.checks.failing, "failing check"));
  if (input.checks.pending > 0) skips.push(plural(input.checks.pending, "running check"));
  if (input.checksStatus === "not_run") skips.push("no CI has run on this commit");
  if (input.changesRequestedBy.length > 0 || input.reviewDecision === "changes_requested") {
    skips.push("requested changes");
  } else if (input.reviewDecision === "review_required") {
    const need = input.requiredApprovals;
    const missing = need != null ? Math.max(need - (input.approvalsCount ?? 0), 1) : 1;
    skips.push(plural(missing, "required approval"));
  }
  if (input.unresolvedThreads > 0) skips.push(plural(input.unresolvedThreads, "open thread"));
  if (behind) skips.push(input.behindBaseBy ? `${plural(input.behindBaseBy, "commit")} behind ${input.baseBranch}` : `behind ${input.baseBranch}`);
  return skips;
}

const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  squash: "squash",
  merge: "merge commit",
  rebase: "rebase",
};

export function resolvePrNextStep(input: PrNextStepInput): PrNextStep {
  const hasConflicts = input.mergeStateStatus === "dirty" || input.mergeConflicts;
  const behind = input.mergeStateStatus === "behind" || (input.behindBaseBy ?? 0) > 0;
  const chips = buildChips(input, hasConflicts, behind);
  const skips = buildSkips(input, behind);
  const hidden: PrMergeAnyway = { visible: false, blocked: false, blockedReason: null, bypass: false, skips: [] };

  if (input.state === "merged") {
    return { kind: "merged", tone: "merged", headline: `Merged into ${input.baseBranch}`, detail: null, primary: "delete_branch", secondary: null, mergeAnyway: hidden, chips: [] };
  }
  if (input.state === "closed") {
    return { kind: "closed", tone: "neutral", headline: "Closed without merging", detail: null, primary: "reopen", secondary: null, mergeAnyway: hidden, chips: [] };
  }

  // GitHub refuses these outright, so "Merge anyway" shows but is disabled.
  // `behind` is GitHub saying the base requires an up-to-date branch.
  const protectionBlocks = input.mergeStateStatus === "blocked" || input.mergeStateStatus === "behind";
  const mergeAnyway: PrMergeAnyway = {
    visible: true,
    blocked: false,
    blockedReason: null,
    bypass: protectionBlocks && input.canBypass,
    skips,
  };
  if (input.state === "draft" || input.mergeStateStatus === "draft") {
    return {
      kind: "draft", tone: "neutral", headline: "Draft, not ready for review",
      detail: "Mark it ready when the work is done.",
      primary: "ready_for_review", secondary: null,
      mergeAnyway: { ...mergeAnyway, blocked: true, blockedReason: "GitHub cannot merge a draft. Mark it ready first." },
      chips,
    };
  }
  if (hasConflicts) {
    return {
      kind: "conflicts", tone: "danger", headline: `Conflicts with ${input.baseBranch}`,
      detail: "Resolve them before GitHub can merge.",
      primary: "resolve_conflicts", secondary: null,
      mergeAnyway: { ...mergeAnyway, blocked: true, blockedReason: "GitHub cannot merge while there are conflicts.", bypass: false },
      chips,
    };
  }
  if (protectionBlocks && !input.canBypass) {
    mergeAnyway.blocked = true;
    mergeAnyway.blockedReason = input.mergeStateStatus === "behind"
      ? `The base branch requires this PR to be up to date with ${input.baseBranch}. Update the branch first.`
      : "Branch rules block this merge. A repository admin can bypass them.";
  }
  if (input.mergeabilityComputing && !hasLiveMergeBox(input)) {
    return { kind: "computing", tone: "info", headline: "GitHub is checking mergeability", detail: null, primary: null, secondary: null, mergeAnyway, chips };
  }
  if (behind) {
    return {
      kind: "behind", tone: "warning",
      headline: input.behindBaseBy ? `${plural(input.behindBaseBy, "commit")} behind ${input.baseBranch}` : `Behind ${input.baseBranch}`,
      detail: "Update the branch so checks run on the latest base.",
      primary: "update_branch", secondary: null, mergeAnyway, chips,
    };
  }
  if (input.checks.failing > 0) {
    return {
      kind: "checks_failing", tone: "danger", headline: plural(input.checks.failing, "check") + " failing",
      detail: null, primary: "fix_checks", secondary: "rerun_checks", mergeAnyway, chips,
    };
  }
  if (input.changesRequestedBy.length > 0 || input.reviewDecision === "changes_requested") {
    const who = input.changesRequestedBy.slice(0, 2).join(", ");
    return {
      kind: "changes_requested", tone: "warning", headline: "Changes requested",
      detail: who ? `By ${who}` : null,
      primary: "address_feedback", secondary: null, mergeAnyway, chips,
    };
  }
  if (input.autoMergeEnabled) {
    const method = input.autoMergeMethod ? ` · ${MERGE_METHOD_LABEL[input.autoMergeMethod]}` : "";
    return {
      kind: "auto_merge_armed", tone: "info", headline: `Auto-merge on${method}`,
      detail: "GitHub merges this PR when every requirement passes.",
      primary: null, secondary: "disable_auto_merge", mergeAnyway, chips,
    };
  }
  if (input.checks.pending > 0) {
    return {
      kind: "checks_pending", tone: "info", headline: `Waiting on ${plural(input.checks.pending, "check")}`,
      detail: null,
      primary: input.autoMergeAllowed ? "enable_auto_merge" : null,
      secondary: null, mergeAnyway, chips,
    };
  }
  if (input.reviewDecision === "review_required") {
    const need = input.requiredApprovals;
    return {
      kind: "review_required", tone: "warning",
      headline: need != null ? `Needs ${plural(Math.max(need - (input.approvalsCount ?? 0), 1), "approval")}` : "Review required",
      detail: null, primary: "request_review", secondary: null, mergeAnyway, chips,
    };
  }
  if (input.mergeStateStatus === "blocked") {
    // GitHub says blocked but no signal above explains it: a rule ADE does not
    // read (conversation resolution, signed commits, deployments). Never claim
    // "Ready to merge" over GitHub's own verdict.
    return {
      kind: "rules_blocked", tone: "warning", headline: "Branch rules block the merge",
      detail: input.unresolvedThreads > 0
        ? `${plural(input.unresolvedThreads, "open review thread")} may need to be resolved.`
        : "A rule on the base branch is not met yet.",
      primary: input.unresolvedThreads > 0 ? "fix_threads" : null,
      secondary: null, mergeAnyway, chips,
    };
  }
  return {
    kind: "ready", tone: "success", headline: "Ready to merge",
    detail: input.unresolvedThreads > 0 ? `${plural(input.unresolvedThreads, "review thread")} still open` : null,
    primary: "merge",
    secondary: input.unresolvedThreads > 0 ? "fix_threads" : null,
    // The main button already merges; "Merge anyway" would say the same thing.
    mergeAnyway: { ...mergeAnyway, visible: false },
    chips,
  };
}

type ReviewLike = { reviewer: string; state: "pending" | "approved" | "changes_requested" | "commented" | "dismissed"; submittedAt: string | null };

/** A pending review has no time yet; it sorts first instead of breaking the sort. */
function reviewTime(review: ReviewLike): number {
  const at = Date.parse(review.submittedAt ?? "");
  return Number.isFinite(at) ? at : 0;
}

/**
 * Each reviewer's latest opinion, keyed by normalized login: approve, request
 * changes or a dismissal. Later plain comments do not undo it, and a later
 * dismissal clears an earlier verdict.
 */
export function latestReviewOpinionByLogin(reviews: readonly ReviewLike[]): Map<string, { login: string; state: ReviewLike["state"] }> {
  const latest = new Map<string, { login: string; state: ReviewLike["state"] }>();
  const sorted = reviews
    .filter((review) => review.state !== "commented" && review.state !== "pending")
    .sort((a, b) => reviewTime(a) - reviewTime(b));
  for (const review of sorted) {
    latest.set(normalizeGithubLogin(review.reviewer), { login: review.reviewer, state: review.state });
  }
  return latest;
}

/** Who still has changes requested, by each reviewer's latest opinion. */
export function prChangesRequestedBy(reviews: readonly ReviewLike[]): string[] {
  return [...latestReviewOpinionByLogin(reviews).values()]
    .filter((opinion) => opinion.state === "changes_requested")
    .map((opinion) => opinion.login);
}

/**
 * The next step from a PR's status snapshot — the TUI, iOS and the Merge card
 * read it this way. `fallback` carries the PR row's own values for a status
 * that does not report them.
 */
export function resolvePrNextStepFromStatus(args: {
  state: PrState;
  baseBranch: string;
  status: {
    mergeStateStatus?: MergeStateStatus | null;
    mergeConflicts?: boolean;
    behindBaseBy?: number | null;
    mergeabilityComputing?: boolean;
    checksStatus?: PrChecksStatus | null;
    reviewDecision?: PrReviewDecision;
    approvalsCount?: number | null;
    requiredApprovals?: number | null;
    canBypass?: boolean;
    autoMergeAllowed?: boolean;
    autoMergeEnabled?: boolean;
    autoMergeMethod?: MergeMethod | null;
  } | null;
  checks: { failing: number; pending: number; passing: number };
  reviews: readonly ReviewLike[];
  unresolvedThreads: number;
  fallback?: { mergeConflicts?: boolean | null; behindBaseBy?: number | null; checksStatus?: PrChecksStatus | null };
}): PrNextStep {
  const status = args.status;
  const fallback = args.fallback;
  return resolvePrNextStep({
    state: args.state,
    mergeStateStatus: status?.mergeStateStatus ?? null,
    mergeConflicts: Boolean(status?.mergeConflicts ?? fallback?.mergeConflicts),
    behindBaseBy: status?.behindBaseBy ?? fallback?.behindBaseBy ?? null,
    mergeabilityComputing: Boolean(status?.mergeabilityComputing),
    checksStatus: status?.checksStatus ?? fallback?.checksStatus ?? null,
    checks: args.checks,
    reviewDecision: status?.reviewDecision,
    approvalsCount: status?.approvalsCount ?? null,
    requiredApprovals: status?.requiredApprovals ?? null,
    changesRequestedBy: prChangesRequestedBy(args.reviews),
    unresolvedThreads: args.unresolvedThreads,
    canBypass: Boolean(status?.canBypass),
    autoMergeAllowed: status?.autoMergeAllowed,
    autoMergeEnabled: Boolean(status?.autoMergeEnabled),
    autoMergeMethod: status?.autoMergeMethod ?? null,
    baseBranch: args.baseBranch,
  });
}
