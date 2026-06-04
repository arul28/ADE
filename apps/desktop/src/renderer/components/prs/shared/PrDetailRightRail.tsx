import { memo } from "react";
import { Group, Panel } from "react-resizable-panels";

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
import type { LaneSummary } from "../../../../shared/types";
import { COLORS } from "../../lanes/laneDesignTokens";
import { ResizeGutter } from "../../ui/ResizeGutter";
import { PrDetailMergeRail } from "./PrDetailMergeRail";
import { PrDetailRightMetadataRail, type ReviewerRequest } from "./PrDetailRightMetadataRail";
import type { PrReviewEvent } from "./PrReviewSubmitModal";

const MERGE_OPEN_DEFAULT_PX = 220;
const MERGE_OPEN_MIN_PX = 168;

export type PrDetailRightRailProps = {
  pr: PrWithConflicts;
  detail: PrDetail | null;
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  comments: PrComment[];
  participants: PrUser[];
  mergeMethod: MergeMethod;
  actionBusy: boolean;
  lane: LaneSummary | null;
  onOpenManageLane?: () => void;
  showReviewerEditor: boolean;
  setShowReviewerEditor: (value: boolean) => void;
  reviewerInput: string;
  setReviewerInput: (value: string) => void;
  showLabelEditor: boolean;
  setShowLabelEditor: (value: boolean) => void;
  labelInput: string;
  setLabelInput: (value: string) => void;
  onMerge: (method: MergeMethod, options?: { bypassRules?: boolean }) => void;
  onRequestReviewers: (request: ReviewerRequest) => void;
  onSetLabels: (labels: string[]) => void;
  onDeleteBranch?: () => void;
  deleteBranchBusy?: boolean;
  onClose?: () => void;
  onReopen?: () => void;
  onSubmitReview: (event: PrReviewEvent, body: string) => void;
};

export const PrDetailRightRail = memo(function PrDetailRightRail(props: PrDetailRightRailProps) {
  const isTerminal = props.pr.state === "merged" || props.pr.state === "closed";

  if (isTerminal) {
    return (
      <div data-testid="pr-detail-right-rail" className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          <PrDetailRightMetadataRail {...props} />
        </div>
        <div
          aria-hidden
          className="shrink-0"
          style={{ height: 1, background: COLORS.border }}
        />
        <PrDetailMergeRail
          pr={props.pr}
          status={props.status}
          checks={props.checks}
          reviews={props.reviews}
          mergeMethod={props.mergeMethod}
          actionBusy={props.actionBusy}
          onMerge={props.onMerge}
          onDeleteBranch={props.onDeleteBranch}
          deleteBranchBusy={props.deleteBranchBusy}
          onOpenManageLane={props.onOpenManageLane}
          onReopen={props.onReopen}
        />
      </div>
    );
  }

  return (
    <div data-testid="pr-detail-right-rail" className="h-full min-h-0 w-full overflow-hidden">
      <Group orientation="vertical" className="h-full min-h-0">
        <Panel id="pr-detail-right-metadata" minSize="24%" className="min-h-0">
          <PrDetailRightMetadataRail {...props} />
        </Panel>
        <ResizeGutter orientation="horizontal" thin narrow />
        <Panel
          id="pr-detail-right-merge"
          defaultSize={MERGE_OPEN_DEFAULT_PX}
          minSize={MERGE_OPEN_MIN_PX}
          className="min-h-0"
        >
          <PrDetailMergeRail
            pr={props.pr}
            status={props.status}
            checks={props.checks}
            reviews={props.reviews}
            mergeMethod={props.mergeMethod}
            actionBusy={props.actionBusy}
            onMerge={props.onMerge}
            onDeleteBranch={props.onDeleteBranch}
            deleteBranchBusy={props.deleteBranchBusy}
            onOpenManageLane={props.onOpenManageLane}
            onClose={props.onClose}
            onReopen={props.onReopen}
          />
        </Panel>
      </Group>
    </div>
  );
});

export default PrDetailRightRail;
