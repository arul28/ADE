import type {
  ReviewEvidence,
  ReviewFindingAdjudication,
  ReviewFindingClass,
  ReviewPassKey,
  ReviewPublicationState,
} from "./reviewTypes";

type LabelWithTooltip = {
  label: string;
  tooltip: string;
};

export const REVIEW_FINDING_CLASS_LABELS: Record<ReviewFindingClass, LabelWithTooltip> = {
  intent_drift: {
    label: "Goal mismatch",
    tooltip: "The implementation may have drifted from the requested behavior or lane goal.",
  },
  incomplete_rollout: {
    label: "Partial rollout",
    tooltip: "The change may be incomplete across paired files, surfaces, or related code paths.",
  },
  late_stage_regression: {
    label: "Late regression",
    tooltip: "A risky change appeared late in the work, often after a fix or validation pass.",
  },
};

export const REVIEW_PASS_LABELS: Record<ReviewPassKey, string> = {
  "diff-risk": "Diff risk",
  "cross-file-impact": "Cross-file impact",
  "checks-and-tests": "Checks and tests",
  "security-data": "Security and data",
  "ui-regression": "UI regression",
};

export function reviewFindingClassLabel(value: ReviewFindingClass | null | undefined): LabelWithTooltip | null {
  return value ? REVIEW_FINDING_CLASS_LABELS[value] : null;
}

export function reviewEvidenceKindLabel(kind: ReviewEvidence["kind"]): string {
  switch (kind) {
    case "diff_hunk":
      return "Diff excerpt";
    case "file_snapshot":
      return "File snapshot";
    case "tool_signal":
      return "Tool signal";
    case "artifact":
      return "Artifact";
    case "quote":
    default:
      return "Quoted evidence";
  }
}

export function reviewPublicationLabel(args: {
  publicationState: ReviewPublicationState;
  adjudication: ReviewFindingAdjudication | null | undefined;
}): LabelWithTooltip {
  if (args.publicationState === "published") {
    return {
      label: "Published",
      tooltip: "This finding has already been sent to the configured review destination.",
    };
  }
  if (args.adjudication?.publicationEligible) {
    return {
      label: "Strong evidence",
      tooltip: "This finding has enough evidence to post if publishing is enabled; this run kept it local.",
    };
  }
  return {
    label: "Saved locally",
    tooltip: "This finding remains local to ADE and has not been sent anywhere.",
  };
}
