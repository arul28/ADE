import type { ReviewEvidence, ReviewRunArtifact } from "../../../shared/types";

export type {
  ReviewAnchorState,
  ReviewArtifactType,
  ReviewCompareAgainstTarget,
  ReviewEvidence,
  ReviewEventPayload,
  ReviewFinding,
  ReviewLaunchCommit,
  ReviewLaunchContext,
  ReviewLaunchLane,
  ReviewListRunsArgs,
  ReviewPublicationState,
  ReviewResolvedCompareTarget,
  ReviewRun,
  ReviewRunArtifact,
  ReviewRunBudgetConfig,
  ReviewRunConfig,
  ReviewRunDetail,
  ReviewRunStatus,
  ReviewSelectionMode,
  ReviewSeverity,
  ReviewSeveritySummary,
  ReviewSourcePass,
  ReviewStartRunArgs,
  ReviewTarget,
  ReviewTargetMode,
} from "../../../shared/types";

export type ReviewCompareKind = "default_branch" | "lane";
export type ReviewArtifact = ReviewRunArtifact;
export type ReviewEvidenceEntry = ReviewEvidence;
