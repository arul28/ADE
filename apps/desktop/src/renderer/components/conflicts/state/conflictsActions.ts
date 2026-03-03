import type { Dispatch } from "react";
import type { ConflictsAction } from "./types";
import type {
  PrepareResolverSessionArgs,
} from "../../../../shared/types";

/** Fetch the full batch assessment and populate state */
export async function fetchBatchAssessment(dispatch: Dispatch<ConflictsAction>) {
  dispatch({ type: "SET_LOADING", loading: true });
  dispatch({ type: "SET_ERROR", error: null });
  try {
    const result = await window.ade.conflicts.getBatchAssessment();
    dispatch({ type: "SET_BATCH", batch: result });
    if (result.progress) {
      dispatch({ type: "SET_PROGRESS", progress: result.progress });
    }
  } catch (err: unknown) {
    dispatch({ type: "SET_ERROR", error: err instanceof Error ? err.message : String(err) });
  } finally {
    dispatch({ type: "SET_LOADING", loading: false });
  }
}

/** Fetch overlaps for the selected lane */
export async function fetchOverlaps(dispatch: Dispatch<ConflictsAction>, laneId: string) {
  try {
    const overlaps = await window.ade.conflicts.listOverlaps({ laneId });
    dispatch({ type: "SET_OVERLAPS", overlaps });
  } catch {
    dispatch({ type: "SET_OVERLAPS", overlaps: [] });
  }
}

/** Fetch git conflict state for a lane */
export async function fetchGitConflictState(dispatch: Dispatch<ConflictsAction>, laneId: string) {
  dispatch({ type: "SET_GIT_CONFLICT_BUSY", busy: true });
  dispatch({ type: "SET_GIT_CONFLICT_ERROR", error: null });
  try {
    const state = await window.ade.git.getConflictState(laneId);
    dispatch({ type: "SET_GIT_CONFLICT", state });
  } catch (err: unknown) {
    dispatch({ type: "SET_GIT_CONFLICT_ERROR", error: err instanceof Error ? err.message : String(err) });
  } finally {
    dispatch({ type: "SET_GIT_CONFLICT_BUSY", busy: false });
  }
}

/** Fetch restack suggestions */
export async function fetchRestackSuggestions(dispatch: Dispatch<ConflictsAction>) {
  try {
    const suggestions = await window.ade.lanes.listRestackSuggestions();
    dispatch({ type: "SET_RESTACK_SUGGESTIONS", suggestions });
  } catch {
    dispatch({ type: "SET_RESTACK_SUGGESTIONS", suggestions: [] });
  }
}

/** Fetch proposals for a lane */
export async function fetchProposals(dispatch: Dispatch<ConflictsAction>, laneId: string) {
  try {
    const proposals = await window.ade.conflicts.listProposals(laneId);
    dispatch({ type: "SET_PROPOSALS", proposals });
  } catch {
    dispatch({ type: "SET_PROPOSALS", proposals: [] });
  }
}

/** Fetch external resolver runs */
export async function fetchExternalRuns(dispatch: Dispatch<ConflictsAction>, laneId?: string) {
  try {
    const runs = await window.ade.conflicts.listExternalResolverRuns({ laneId, limit: 20 });
    dispatch({ type: "SET_EXTERNAL_RUNS", runs });
  } catch {
    dispatch({ type: "SET_EXTERNAL_RUNS", runs: [] });
  }
}

/** Prepare a resolver session (for the modal) */
export async function prepareResolverSession(
  dispatch: Dispatch<ConflictsAction>,
  args: PrepareResolverSessionArgs
) {
  dispatch({ type: "SET_RESOLVER_MODAL_PHASE", phase: "preparing" });
  try {
    const result = await window.ade.conflicts.prepareResolverSession(args);
    if (result.status === "blocked") {
      dispatch({ type: "SET_EXTERNAL_ERROR", error: `Blocked: ${result.contextGaps.map((g) => g.message).join(", ")}` });
      dispatch({ type: "SET_RESOLVER_MODAL_PHASE", phase: "configure" });
      return null;
    }
    dispatch({ type: "SET_RESOLVER_CWD_LANE_ID", laneId: result.cwdLaneId });
    dispatch({ type: "SET_RESOLVER_MODAL_PHASE", phase: "running" });
    return result;
  } catch (err: unknown) {
    dispatch({ type: "SET_EXTERNAL_ERROR", error: err instanceof Error ? err.message : String(err) });
    dispatch({ type: "SET_RESOLVER_MODAL_PHASE", phase: "configure" });
    return null;
  }
}

/** Finalize a resolver session after the PTY exits */
export async function finalizeResolverSession(
  dispatch: Dispatch<ConflictsAction>,
  runId: string,
  exitCode: number
) {
  try {
    const summary = await window.ade.conflicts.finalizeResolverSession({ runId, exitCode });
    dispatch({ type: "SET_LAST_EXTERNAL_RUN", run: summary });
    dispatch({ type: "SET_RESOLVER_MODAL_PHASE", phase: "done" });
    return summary;
  } catch (err: unknown) {
    dispatch({ type: "SET_EXTERNAL_ERROR", error: err instanceof Error ? err.message : String(err) });
    dispatch({ type: "SET_RESOLVER_MODAL_PHASE", phase: "done" });
    return null;
  }
}

/** Request ADE AI suggestion for which worktree to resolve in */
export async function fetchResolverTargetSuggestion(
  dispatch: Dispatch<ConflictsAction>,
  sourceLaneId: string,
  targetLaneId: string
) {
  dispatch({ type: "SET_RESOLVER_TARGET_SUGGESTION_LOADING", loading: true });
  dispatch({ type: "SET_RESOLVER_TARGET_SUGGESTION", suggestion: null });
  try {
    const result = await window.ade.conflicts.suggestResolverTarget({ sourceLaneId, targetLaneId });
    dispatch({ type: "SET_RESOLVER_TARGET_SUGGESTION", suggestion: result });
  } catch {
    // Non-critical — just don't show a suggestion
  } finally {
    dispatch({ type: "SET_RESOLVER_TARGET_SUGGESTION_LOADING", loading: false });
  }
}

/** Continue a merge/rebase */
export async function continueGitOperation(
  dispatch: Dispatch<ConflictsAction>,
  laneId: string,
  kind: "merge" | "rebase"
) {
  dispatch({ type: "SET_CONTINUE_BUSY", busy: true });
  dispatch({ type: "SET_CONTINUE_ERROR", error: null });
  try {
    if (kind === "merge") {
      await window.ade.git.mergeContinue(laneId);
    } else {
      await window.ade.git.rebaseContinue(laneId);
    }
    await fetchGitConflictState(dispatch, laneId);
  } catch (err: unknown) {
    dispatch({ type: "SET_CONTINUE_ERROR", error: err instanceof Error ? err.message : String(err) });
  } finally {
    dispatch({ type: "SET_CONTINUE_BUSY", busy: false });
  }
}

/** Abort a merge/rebase */
export async function abortGitOperation(
  dispatch: Dispatch<ConflictsAction>,
  laneId: string,
  kind: "merge" | "rebase"
) {
  dispatch({ type: "SET_ABORT_BUSY", busy: true });
  dispatch({ type: "SET_ABORT_ERROR", error: null });
  try {
    if (kind === "merge") {
      await window.ade.git.mergeAbort(laneId);
    } else {
      await window.ade.git.rebaseAbort(laneId);
    }
    dispatch({ type: "SET_ABORT_OPEN", open: false });
    dispatch({ type: "SET_ABORT_CONFIRM", text: "" });
    await fetchGitConflictState(dispatch, laneId);
  } catch (err: unknown) {
    dispatch({ type: "SET_ABORT_ERROR", error: err instanceof Error ? err.message : String(err) });
  } finally {
    dispatch({ type: "SET_ABORT_BUSY", busy: false });
  }
}

/** Commit external resolver run changes */
export async function commitExternalRun(
  dispatch: Dispatch<ConflictsAction>,
  runId: string,
  message?: string
) {
  dispatch({ type: "SET_EXTERNAL_COMMIT_BUSY", runId });
  dispatch({ type: "SET_EXTERNAL_COMMIT_ERROR", error: null });
  dispatch({ type: "SET_EXTERNAL_COMMIT_INFO", info: null });
  try {
    const result = await window.ade.conflicts.commitExternalResolverRun({ runId, message });
    dispatch({
      type: "SET_EXTERNAL_COMMIT_INFO",
      info: `Committed ${result.commitSha.slice(0, 8)}: ${result.message}`,
    });
  } catch (err: unknown) {
    dispatch({ type: "SET_EXTERNAL_COMMIT_ERROR", error: err instanceof Error ? err.message : String(err) });
  } finally {
    dispatch({ type: "SET_EXTERNAL_COMMIT_BUSY", runId: null });
  }
}

/** Fetch PRs with conflict analysis (for "By PR" view) */
export async function fetchPrsWithConflicts(dispatch: Dispatch<ConflictsAction>) {
  dispatch({ type: "SET_PRS_LOADING", loading: true });
  try {
    const prs = await window.ade.prs.listWithConflicts();
    dispatch({ type: "SET_PRS_WITH_CONFLICTS", prs });
  } catch {
    dispatch({ type: "SET_PRS_WITH_CONFLICTS", prs: [] });
  } finally {
    dispatch({ type: "SET_PRS_LOADING", loading: false });
  }
}

/** Prepare and send a proposal */
export async function prepareAndSendProposal(
  dispatch: Dispatch<ConflictsAction>,
  laneId: string,
  peerLaneId: string | null
) {
  dispatch({ type: "SET_PREPARE_BUSY", busy: true });
  dispatch({ type: "SET_PREPARE_ERROR", error: null });
  try {
    const preview = await window.ade.conflicts.prepareProposal({ laneId, peerLaneId });
    dispatch({ type: "SET_PROPOSAL_PREVIEW", preview });
  } catch (err: unknown) {
    dispatch({ type: "SET_PREPARE_ERROR", error: err instanceof Error ? err.message : String(err) });
  } finally {
    dispatch({ type: "SET_PREPARE_BUSY", busy: false });
  }
}

/** Apply a proposal */
export async function applyProposal(
  dispatch: Dispatch<ConflictsAction>,
  laneId: string,
  proposalId: string,
  applyMode: "unstaged" | "staged" | "commit",
  commitMessage?: string
) {
  dispatch({ type: "SET_PROPOSAL_BUSY", busy: true });
  dispatch({ type: "SET_PROPOSAL_ERROR", error: null });
  try {
    await window.ade.conflicts.applyProposal({ laneId, proposalId, applyMode, commitMessage });
    await fetchProposals(dispatch, laneId);
  } catch (err: unknown) {
    dispatch({ type: "SET_PROPOSAL_ERROR", error: err instanceof Error ? err.message : String(err) });
  } finally {
    dispatch({ type: "SET_PROPOSAL_BUSY", busy: false });
  }
}

/** Undo a proposal */
export async function undoProposal(
  dispatch: Dispatch<ConflictsAction>,
  laneId: string,
  proposalId: string
) {
  dispatch({ type: "SET_PROPOSAL_BUSY", busy: true });
  dispatch({ type: "SET_PROPOSAL_ERROR", error: null });
  try {
    await window.ade.conflicts.undoProposal({ laneId, proposalId });
    await fetchProposals(dispatch, laneId);
  } catch (err: unknown) {
    dispatch({ type: "SET_PROPOSAL_ERROR", error: err instanceof Error ? err.message : String(err) });
  } finally {
    dispatch({ type: "SET_PROPOSAL_BUSY", busy: false });
  }
}
