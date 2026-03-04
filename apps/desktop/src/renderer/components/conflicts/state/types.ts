import type {
  BatchAssessmentResult,
  ConflictExternalResolverRunSummary,
  ConflictOverlap,
  ConflictProposal,
  ConflictProposalPreview,
  GitConflictState,
  MultiMergeMode,
  PrWithConflicts,
  RebaseSuggestion,
  SuggestResolverTargetResult
} from "../../../../shared/types";

// ---- View types ----

export type ViewMode = "summary" | "matrix";
export type LaneStatusFilter = "conflict" | "at-risk" | "clean" | "unknown" | null;
export type ActiveTab = "merge-one" | "merge-multiple";
export type LaneListView = "by-lane" | "by-pr";
export type ResolverModalPhase = "configure" | "preparing" | "running" | "done";

// ---- Merge plan ----

export type MergePlanState = {
  targetLaneId: string;
  sourceLaneIds: string[];
  cursor: number;
  activeMerge?: { targetLaneId: string; sourceLaneId: string } | null;
};

// ---- State shape ----

export type ConflictsState = {
  // Tab
  activeTab: ActiveTab;

  // Lane selection
  selectedLaneId: string | null;
  selectedPair: { laneAId: string; laneBId: string } | null;
  laneListView: LaneListView;

  // Batch assessment
  batch: BatchAssessmentResult | null;
  overlaps: ConflictOverlap[];
  loading: boolean;
  progress: { completedPairs: number; totalPairs: number } | null;
  error: string | null;

  // View
  viewMode: ViewMode;
  statusFilter: LaneStatusFilter;

  // Git conflict state
  gitConflict: GitConflictState | null;
  gitConflictBusy: boolean;
  gitConflictError: string | null;

  // Rebase
  rebaseSuggestions: RebaseSuggestion[];

  // Proposals
  proposals: ConflictProposal[];
  proposalBusy: boolean;
  proposalError: string | null;
  proposalPeerLaneId: string | null;
  proposalPreview: ConflictProposalPreview | null;
  prepareBusy: boolean;
  prepareError: string | null;
  sendBusy: boolean;
  sendError: string | null;
  applyMode: "unstaged" | "staged" | "commit";
  commitMessage: string;

  // External resolver
  externalRuns: ConflictExternalResolverRunSummary[];
  externalBusy: "codex" | "claude" | null;
  externalError: string | null;
  lastExternalRun: ConflictExternalResolverRunSummary | null;
  externalCommitBusyRunId: string | null;
  externalCommitInfo: string | null;
  externalCommitError: string | null;

  // Resolver modal
  resolverModalOpen: boolean;
  resolverModalPhase: ResolverModalPhase;
  resolverCwdLaneId: string | null;

  // ADE AI worktree suggestion
  resolverTargetSuggestion: SuggestResolverTargetResult | null;
  resolverTargetSuggestionLoading: boolean;
  resolverWorktreeChoice: "source" | "target";

  // Continue/abort
  continueBusy: boolean;
  continueError: string | null;
  abortOpen: boolean;
  abortConfirm: string;
  abortBusy: boolean;
  abortError: string | null;

  // Merge plan (one-by-one)
  mergePlan: MergePlanState | null;
  mergePlanBusy: boolean;
  mergePlanError: string | null;
  mergeConfirmOpen: boolean;
  pendingMerge: { targetLaneId: string; sourceLaneId: string } | null;

  // Integration lane
  integrationBaseLaneId: string;
  integrationName: string;
  integrationBusy: boolean;
  integrationError: string | null;
  integrationLaneId: string | null;

  // Multi-merge (new)
  multiMergeMode: MultiMergeMode;
  multiMergeTargetLaneId: string | null;
  multiMergeSourceLaneIds: string[];
  multiMergeIntegrationName: string;

  // PR list (for "By PR" view)
  prsWithConflicts: PrWithConflicts[];
  prsLoading: boolean;
};

// ---- Actions ----

export type ConflictsAction =
  | { type: "SET_ACTIVE_TAB"; tab: ActiveTab }
  | { type: "SET_SELECTED_LANE"; laneId: string | null }
  | { type: "SET_SELECTED_PAIR"; pair: { laneAId: string; laneBId: string } | null }
  | { type: "SET_LANE_LIST_VIEW"; view: LaneListView }
  | { type: "SET_BATCH"; batch: BatchAssessmentResult }
  | { type: "SET_OVERLAPS"; overlaps: ConflictOverlap[] }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_PROGRESS"; progress: { completedPairs: number; totalPairs: number } | null }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "SET_VIEW_MODE"; mode: ViewMode }
  | { type: "SET_STATUS_FILTER"; filter: LaneStatusFilter }
  | { type: "SET_GIT_CONFLICT"; state: GitConflictState | null }
  | { type: "SET_GIT_CONFLICT_BUSY"; busy: boolean }
  | { type: "SET_GIT_CONFLICT_ERROR"; error: string | null }
  | { type: "SET_REBASE_SUGGESTIONS"; suggestions: RebaseSuggestion[] }
  | { type: "SET_PROPOSALS"; proposals: ConflictProposal[] }
  | { type: "SET_PROPOSAL_BUSY"; busy: boolean }
  | { type: "SET_PROPOSAL_ERROR"; error: string | null }
  | { type: "SET_PROPOSAL_PEER_LANE_ID"; laneId: string | null }
  | { type: "SET_PROPOSAL_PREVIEW"; preview: ConflictProposalPreview | null }
  | { type: "SET_PREPARE_BUSY"; busy: boolean }
  | { type: "SET_PREPARE_ERROR"; error: string | null }
  | { type: "SET_SEND_BUSY"; busy: boolean }
  | { type: "SET_SEND_ERROR"; error: string | null }
  | { type: "SET_APPLY_MODE"; mode: "unstaged" | "staged" | "commit" }
  | { type: "SET_COMMIT_MESSAGE"; message: string }
  | { type: "SET_EXTERNAL_RUNS"; runs: ConflictExternalResolverRunSummary[] }
  | { type: "SET_EXTERNAL_BUSY"; busy: "codex" | "claude" | null }
  | { type: "SET_EXTERNAL_ERROR"; error: string | null }
  | { type: "SET_LAST_EXTERNAL_RUN"; run: ConflictExternalResolverRunSummary | null }
  | { type: "SET_EXTERNAL_COMMIT_BUSY"; runId: string | null }
  | { type: "SET_EXTERNAL_COMMIT_INFO"; info: string | null }
  | { type: "SET_EXTERNAL_COMMIT_ERROR"; error: string | null }
  | { type: "SET_RESOLVER_MODAL_OPEN"; open: boolean }
  | { type: "SET_RESOLVER_MODAL_PHASE"; phase: ResolverModalPhase }
  | { type: "SET_RESOLVER_CWD_LANE_ID"; laneId: string | null }
  | { type: "SET_RESOLVER_TARGET_SUGGESTION"; suggestion: SuggestResolverTargetResult | null }
  | { type: "SET_RESOLVER_TARGET_SUGGESTION_LOADING"; loading: boolean }
  | { type: "SET_RESOLVER_WORKTREE_CHOICE"; choice: "source" | "target" }
  | { type: "SET_CONTINUE_BUSY"; busy: boolean }
  | { type: "SET_CONTINUE_ERROR"; error: string | null }
  | { type: "SET_ABORT_OPEN"; open: boolean }
  | { type: "SET_ABORT_CONFIRM"; text: string }
  | { type: "SET_ABORT_BUSY"; busy: boolean }
  | { type: "SET_ABORT_ERROR"; error: string | null }
  | { type: "SET_MERGE_PLAN"; plan: MergePlanState | null }
  | { type: "SET_MERGE_PLAN_BUSY"; busy: boolean }
  | { type: "SET_MERGE_PLAN_ERROR"; error: string | null }
  | { type: "SET_MERGE_CONFIRM_OPEN"; open: boolean }
  | { type: "SET_PENDING_MERGE"; merge: { targetLaneId: string; sourceLaneId: string } | null }
  | { type: "SET_INTEGRATION_BASE_LANE_ID"; laneId: string }
  | { type: "SET_INTEGRATION_NAME"; name: string }
  | { type: "SET_INTEGRATION_BUSY"; busy: boolean }
  | { type: "SET_INTEGRATION_ERROR"; error: string | null }
  | { type: "SET_INTEGRATION_LANE_ID"; laneId: string | null }
  | { type: "SET_MULTI_MERGE_MODE"; mode: MultiMergeMode }
  | { type: "SET_MULTI_MERGE_TARGET"; laneId: string | null }
  | { type: "SET_MULTI_MERGE_SOURCES"; laneIds: string[] }
  | { type: "SET_MULTI_MERGE_INTEGRATION_NAME"; name: string }
  | { type: "SET_PRS_WITH_CONFLICTS"; prs: PrWithConflicts[] }
  | { type: "SET_PRS_LOADING"; loading: boolean }
  | { type: "RESET_RESOLVER_STATE" }
  | { type: "RESET_PROPOSAL_STATE" };

// ---- Initial state ----

export const initialConflictsState: ConflictsState = {
  activeTab: "merge-one",
  selectedLaneId: null,
  selectedPair: null,
  laneListView: "by-lane",
  batch: null,
  overlaps: [],
  loading: false,
  progress: null,
  error: null,
  viewMode: "summary",
  statusFilter: null,
  gitConflict: null,
  gitConflictBusy: false,
  gitConflictError: null,
  rebaseSuggestions: [],
  proposals: [],
  proposalBusy: false,
  proposalError: null,
  proposalPeerLaneId: null,
  proposalPreview: null,
  prepareBusy: false,
  prepareError: null,
  sendBusy: false,
  sendError: null,
  applyMode: "staged",
  commitMessage: "Resolve conflicts (ADE)",
  externalRuns: [],
  externalBusy: null,
  externalError: null,
  lastExternalRun: null,
  externalCommitBusyRunId: null,
  externalCommitInfo: null,
  externalCommitError: null,
  resolverModalOpen: false,
  resolverModalPhase: "configure",
  resolverCwdLaneId: null,
  resolverTargetSuggestion: null,
  resolverTargetSuggestionLoading: false,
  resolverWorktreeChoice: "target",
  continueBusy: false,
  continueError: null,
  abortOpen: false,
  abortConfirm: "",
  abortBusy: false,
  abortError: null,
  mergePlan: null,
  mergePlanBusy: false,
  mergePlanError: null,
  mergeConfirmOpen: false,
  pendingMerge: null,
  integrationBaseLaneId: "",
  integrationName: "Integration lane",
  integrationBusy: false,
  integrationError: null,
  integrationLaneId: null,
  multiMergeMode: "queue",
  multiMergeTargetLaneId: null,
  multiMergeSourceLaneIds: [],
  multiMergeIntegrationName: "integration",
  prsWithConflicts: [],
  prsLoading: false,
};
