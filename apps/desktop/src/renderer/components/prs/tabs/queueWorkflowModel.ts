import type {
  PrChecksStatus,
  PrReviewStatus,
  PrStatus,
  QueueLandingState,
  RebaseNeed,
} from "../../../../shared/types";

export type QueueMemberLike = {
  prId: string;
  laneId: string;
  laneName: string;
  position: number;
  pr: {
    state: "draft" | "open" | "merged" | "closed";
    checksStatus: PrChecksStatus;
    reviewStatus: PrReviewStatus;
    githubPrNumber?: number;
    title?: string;
    headBranch?: string;
    baseBranch?: string;
  } | null;
};

export type QueueGroupLike = {
  landingState: QueueLandingState | null;
  members: QueueMemberLike[];
};

export type QueueMemberSelection = {
  currentIndex: number;
  currentMember: QueueMemberLike | null;
  nextMember: QueueMemberLike | null;
};

export type QueueGuidance = {
  tone: "idle" | "ready" | "warning" | "blocked" | "success";
  title: string;
  description: string;
  primaryAction: "land" | "open_pr" | "rebase" | "none";
  primaryLabel: string | null;
  secondaryAction: "open_pr" | "none";
  secondaryLabel: string | null;
  nextRebaseLaneId: string | null;
};

function hasOpenMembers(members: QueueMemberLike[]): boolean {
  return members.some((member) => member.pr?.state === "open" || member.pr?.state === "draft");
}

export function getQueueWorkflowBucket(group: QueueGroupLike): "active" | "history" {
  if (group.landingState && (group.landingState.state === "completed" || group.landingState.state === "cancelled")) {
    return "history";
  }
  if (hasOpenMembers(group.members)) return "active";
  return "history";
}

export function findQueueMemberSelection(group: QueueGroupLike | null): QueueMemberSelection {
  if (!group || group.members.length === 0) {
    return { currentIndex: -1, currentMember: null, nextMember: null };
  }

  const landingEntries = group.landingState?.entries ?? [];
  if (landingEntries.length > 0) {
    const firstPendingIndex = landingEntries.findIndex((entry) => entry.state !== "landed" && entry.state !== "skipped");
    const resolvedIndex = firstPendingIndex >= 0 ? firstPendingIndex : landingEntries.length - 1;
    const currentMember = group.members[resolvedIndex] ?? null;
    const nextMember = resolvedIndex >= 0 ? (group.members[resolvedIndex + 1] ?? null) : null;
    return { currentIndex: resolvedIndex, currentMember, nextMember };
  }

  const firstOpenIndex = group.members.findIndex((member) => member.pr?.state === "open" || member.pr?.state === "draft");
  const resolvedIndex = firstOpenIndex >= 0 ? firstOpenIndex : 0;
  return {
    currentIndex: resolvedIndex,
    currentMember: group.members[resolvedIndex] ?? null,
    nextMember: group.members[resolvedIndex + 1] ?? null,
  };
}

export function buildManualLandWarnings(args: {
  status: PrStatus | null;
  memberSummary: QueueMemberLike["pr"] | null;
}): string[] {
  const warnings: string[] = [];
  const checksStatus = args.status?.checksStatus ?? args.memberSummary?.checksStatus ?? "none";
  const reviewStatus = args.status?.reviewStatus ?? args.memberSummary?.reviewStatus ?? "none";

  if (checksStatus === "pending") warnings.push("CI is still running for the current PR.");
  if (checksStatus === "failing") warnings.push("CI is failing for the current PR.");
  if (reviewStatus === "requested") warnings.push("Review is still pending on the current PR.");
  if (reviewStatus === "changes_requested") warnings.push("The current PR has requested changes.");
  if (args.status?.mergeConflicts) warnings.push("GitHub reports merge conflicts on the current PR.");
  if (args.status && !args.status.isMergeable && !args.status.mergeConflicts) {
    warnings.push("GitHub has not marked the current PR as mergeable yet. Manual land can still succeed if GitHub allows a bypass merge.");
  }

  return warnings;
}

function describeWaitReason(waitReason: QueueLandingState["waitReason"] | null): string | null {
  switch (waitReason) {
    case "ci":
      return "Queue automation paused because the current PR is waiting on CI.";
    case "review":
      return "Queue automation paused because the current PR still needs review attention.";
    case "merge_conflict":
      return "Queue automation hit merge conflicts and needs operator judgment.";
    case "resolver_failed":
      return "AI conflict resolution did not finish cleanly. Inspect the PR before continuing.";
    case "merge_blocked":
      return "GitHub could not merge the current PR. Inspect the PR state before continuing.";
    case "manual":
      return "Queue automation is waiting for a manual decision.";
    case "canceled":
      return "This queue run was canceled by the operator.";
    default:
      return null;
  }
}

export function buildQueueGuidance(args: {
  group: QueueGroupLike | null;
  currentStatus: PrStatus | null;
  landWarnings: string[];
  lastLandSucceeded: boolean;
  currentRebaseNeed: RebaseNeed | null;
}): QueueGuidance {
  const selection = findQueueMemberSelection(args.group);
  const currentMember = selection.currentMember;

  if (!args.group) {
    return {
      tone: "idle",
      title: "Select a queue",
      description: "Choose a queue group to review its current step and next action.",
      primaryAction: "none",
      primaryLabel: null,
      secondaryAction: "none",
      secondaryLabel: null,
      nextRebaseLaneId: null,
    };
  }

  if (args.group.landingState?.state === "completed") {
    return {
      tone: "success",
      title: "Queue complete",
      description: "All queue members have been landed or skipped.",
      primaryAction: "none",
      primaryLabel: null,
      secondaryAction: "none",
      secondaryLabel: null,
      nextRebaseLaneId: null,
    };
  }

  if (args.lastLandSucceeded && args.currentRebaseNeed) {
    const needsConflictResolution = args.currentRebaseNeed.conflictPredicted;
    return {
      tone: "warning",
      title: needsConflictResolution ? "Rebase the next lane" : "Refresh the next lane",
      description: needsConflictResolution
        ? `${args.currentRebaseNeed.laneName} is ${args.currentRebaseNeed.behindBy} commit${args.currentRebaseNeed.behindBy === 1 ? "" : "s"} behind ${args.currentRebaseNeed.baseBranch}, and conflicts are predicted. Rebase it before landing again.`
        : `${args.currentRebaseNeed.laneName} is ${args.currentRebaseNeed.behindBy} commit${args.currentRebaseNeed.behindBy === 1 ? "" : "s"} behind ${args.currentRebaseNeed.baseBranch}. Rebase it to refresh CI and PR state before landing again.`,
      primaryAction: "rebase",
      primaryLabel: `Open rebase for ${args.currentRebaseNeed.laneName}`,
      secondaryAction: currentMember ? "open_pr" : "none",
      secondaryLabel: currentMember ? "Open current PR view" : null,
      nextRebaseLaneId: args.currentRebaseNeed.laneId,
    };
  }

  const waitReasonDescription = describeWaitReason(args.group.landingState?.waitReason ?? null);
  if (waitReasonDescription) {
    const OPERATOR_WAIT_REASONS = ["manual", "merge_conflict", "resolver_failed", "merge_blocked"] as const;
    const blockedByManual = OPERATOR_WAIT_REASONS.includes(args.group.landingState?.waitReason as typeof OPERATOR_WAIT_REASONS[number]);
    return {
      tone: blockedByManual ? "blocked" : "warning",
      title: blockedByManual ? "Queue blocked on operator action" : "Queue waiting on external status",
      description: waitReasonDescription,
      primaryAction: blockedByManual ? "open_pr" : "land",
      primaryLabel: blockedByManual ? "Open current PR view" : "Land current PR",
      secondaryAction: blockedByManual ? "none" : "open_pr",
      secondaryLabel: blockedByManual ? null : (currentMember ? "Open current PR view" : null),
      nextRebaseLaneId: null,
    };
  }

  if (args.landWarnings.length > 0) {
    return {
      tone: "warning",
      title: "Current PR needs review before landing",
      description: "ADE will warn before merging, but you can still land the current PR manually.",
      primaryAction: "land",
      primaryLabel: "Land current PR",
      secondaryAction: currentMember ? "open_pr" : "none",
      secondaryLabel: currentMember ? "Open current PR view" : null,
      nextRebaseLaneId: null,
    };
  }

  if (currentMember) {
    return {
      tone: "ready",
      title: "Ready to land the current PR",
      description: `Current queue item: ${currentMember.laneName}. Review the PR state, then merge when you're ready.`,
      primaryAction: "land",
      primaryLabel: "Land current PR",
      secondaryAction: "open_pr",
      secondaryLabel: "Open current PR view",
      nextRebaseLaneId: null,
    };
  }

  return {
    tone: "idle",
    title: "Queue is idle",
    description: "No active queue member was found for this group.",
    primaryAction: "none",
    primaryLabel: null,
    secondaryAction: "none",
    secondaryLabel: null,
    nextRebaseLaneId: null,
  };
}
