import type { ConflictsState, ConflictsAction } from "./types";
import { initialConflictsState } from "./types";

export function conflictsReducer(state: ConflictsState, action: ConflictsAction): ConflictsState {
  switch (action.type) {
    case "SET_ACTIVE_TAB":
      return { ...state, activeTab: action.tab };
    case "SET_SELECTED_LANE":
      return { ...state, selectedLaneId: action.laneId };
    case "SET_SELECTED_PAIR":
      return { ...state, selectedPair: action.pair };
    case "SET_LANE_LIST_VIEW":
      return { ...state, laneListView: action.view };
    case "SET_BATCH":
      return { ...state, batch: action.batch };
    case "SET_OVERLAPS":
      return { ...state, overlaps: action.overlaps };
    case "SET_LOADING":
      return { ...state, loading: action.loading };
    case "SET_PROGRESS":
      return { ...state, progress: action.progress };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "SET_VIEW_MODE":
      return { ...state, viewMode: action.mode };
    case "SET_STATUS_FILTER":
      return { ...state, statusFilter: action.filter };
    case "SET_GIT_CONFLICT":
      return { ...state, gitConflict: action.state };
    case "SET_GIT_CONFLICT_BUSY":
      return { ...state, gitConflictBusy: action.busy };
    case "SET_GIT_CONFLICT_ERROR":
      return { ...state, gitConflictError: action.error };
    case "SET_RESTACK_SUGGESTIONS":
      return { ...state, restackSuggestions: action.suggestions };
    case "SET_PROPOSALS":
      return { ...state, proposals: action.proposals };
    case "SET_PROPOSAL_BUSY":
      return { ...state, proposalBusy: action.busy };
    case "SET_PROPOSAL_ERROR":
      return { ...state, proposalError: action.error };
    case "SET_PROPOSAL_PEER_LANE_ID":
      return { ...state, proposalPeerLaneId: action.laneId };
    case "SET_PROPOSAL_PREVIEW":
      return { ...state, proposalPreview: action.preview };
    case "SET_PREPARE_BUSY":
      return { ...state, prepareBusy: action.busy };
    case "SET_PREPARE_ERROR":
      return { ...state, prepareError: action.error };
    case "SET_SEND_BUSY":
      return { ...state, sendBusy: action.busy };
    case "SET_SEND_ERROR":
      return { ...state, sendError: action.error };
    case "SET_APPLY_MODE":
      return { ...state, applyMode: action.mode };
    case "SET_COMMIT_MESSAGE":
      return { ...state, commitMessage: action.message };
    case "SET_EXTERNAL_RUNS":
      return { ...state, externalRuns: action.runs };
    case "SET_EXTERNAL_BUSY":
      return { ...state, externalBusy: action.busy };
    case "SET_EXTERNAL_ERROR":
      return { ...state, externalError: action.error };
    case "SET_LAST_EXTERNAL_RUN":
      return { ...state, lastExternalRun: action.run };
    case "SET_EXTERNAL_COMMIT_BUSY":
      return { ...state, externalCommitBusyRunId: action.runId };
    case "SET_EXTERNAL_COMMIT_INFO":
      return { ...state, externalCommitInfo: action.info };
    case "SET_EXTERNAL_COMMIT_ERROR":
      return { ...state, externalCommitError: action.error };
    case "SET_RESOLVER_MODAL_OPEN":
      return { ...state, resolverModalOpen: action.open };
    case "SET_RESOLVER_MODAL_PHASE":
      return { ...state, resolverModalPhase: action.phase };
    case "SET_RESOLVER_CWD_LANE_ID":
      return { ...state, resolverCwdLaneId: action.laneId };
    case "SET_RESOLVER_TARGET_SUGGESTION":
      return { ...state, resolverTargetSuggestion: action.suggestion };
    case "SET_RESOLVER_TARGET_SUGGESTION_LOADING":
      return { ...state, resolverTargetSuggestionLoading: action.loading };
    case "SET_RESOLVER_WORKTREE_CHOICE":
      return { ...state, resolverWorktreeChoice: action.choice };
    case "SET_CONTINUE_BUSY":
      return { ...state, continueBusy: action.busy };
    case "SET_CONTINUE_ERROR":
      return { ...state, continueError: action.error };
    case "SET_ABORT_OPEN":
      return { ...state, abortOpen: action.open };
    case "SET_ABORT_CONFIRM":
      return { ...state, abortConfirm: action.text };
    case "SET_ABORT_BUSY":
      return { ...state, abortBusy: action.busy };
    case "SET_ABORT_ERROR":
      return { ...state, abortError: action.error };
    case "SET_MERGE_PLAN":
      return { ...state, mergePlan: action.plan };
    case "SET_MERGE_PLAN_BUSY":
      return { ...state, mergePlanBusy: action.busy };
    case "SET_MERGE_PLAN_ERROR":
      return { ...state, mergePlanError: action.error };
    case "SET_MERGE_CONFIRM_OPEN":
      return { ...state, mergeConfirmOpen: action.open };
    case "SET_PENDING_MERGE":
      return { ...state, pendingMerge: action.merge };
    case "SET_INTEGRATION_BASE_LANE_ID":
      return { ...state, integrationBaseLaneId: action.laneId };
    case "SET_INTEGRATION_NAME":
      return { ...state, integrationName: action.name };
    case "SET_INTEGRATION_BUSY":
      return { ...state, integrationBusy: action.busy };
    case "SET_INTEGRATION_ERROR":
      return { ...state, integrationError: action.error };
    case "SET_INTEGRATION_LANE_ID":
      return { ...state, integrationLaneId: action.laneId };
    case "SET_MULTI_MERGE_MODE":
      return { ...state, multiMergeMode: action.mode };
    case "SET_MULTI_MERGE_TARGET":
      return { ...state, multiMergeTargetLaneId: action.laneId };
    case "SET_MULTI_MERGE_SOURCES":
      return { ...state, multiMergeSourceLaneIds: action.laneIds };
    case "SET_MULTI_MERGE_INTEGRATION_NAME":
      return { ...state, multiMergeIntegrationName: action.name };
    case "SET_PRS_WITH_CONFLICTS":
      return { ...state, prsWithConflicts: action.prs };
    case "SET_PRS_LOADING":
      return { ...state, prsLoading: action.loading };
    case "RESET_RESOLVER_STATE":
      return {
        ...state,
        resolverModalOpen: false,
        resolverModalPhase: "configure",
        resolverCwdLaneId: null,
        resolverTargetSuggestion: null,
        resolverTargetSuggestionLoading: false,
        externalBusy: null,
        externalError: null,
      };
    case "RESET_PROPOSAL_STATE":
      return {
        ...state,
        proposalPreview: null,
        prepareBusy: false,
        prepareError: null,
        sendBusy: false,
        sendError: null,
        proposalError: null,
      };
    default:
      return state;
  }
}
