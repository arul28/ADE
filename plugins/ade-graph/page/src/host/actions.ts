/**
 * The host-call map, in one file.
 *
 * Every call the compiled Graph made into ADE has exactly one counterpart here,
 * and the mapping is the whole point of the page tier:
 *
 * | compiled call                                    | page call                          |
 * |--------------------------------------------------|------------------------------------|
 * | `useAppStore(s => s.lanes)` / `refreshLanes()`    | `invoke("pageLanes")` + `host` events |
 * | `useAppStore(s => s.project)` / `projectBinding`  | `context.project`                  |
 * | `window.ade.projectConfig.get`                    | `invoke("pageProjectConfig")`      |
 * | `window.ade.prs.listWithConflicts`                | `invoke("pagePrs")`                |
 * | `window.ade.prs.listProposals`                    | `invoke("pageProposals")`          |
 * | `window.ade.git.getSyncStatus` ×N (renderer fan-out) | `invoke("pageSyncStatuses")` — ONE call |
 * | `window.ade.lanes.listAutoRebaseStatuses`         | `invoke("pageAutoRebaseStatuses")` |
 * | `window.ade.conflicts.getBatchAssessment`         | `invoke("pageConflictAssessment")` |
 * | `window.ade.conflicts.listOverlaps`               | `invoke("pageConflictOverlaps")`   |
 * | `window.ade.conflicts.getRiskMatrix`              | `invoke("pageRiskMatrix")`         |
 * | `window.ade.history.listOperations`               | `invoke("pageOperations")`         |
 * | `window.ade.graphState.get` / `.set`              | `invoke("pageGraphState"/"pageSaveGraphState")` |
 * | `prs.getStatus` + `getChecks` + `getReviews` + `getComments` (4 calls) | `invoke("pagePrDetail")` — ONE |
 * | `window.ade.conflicts.simulateMerge`              | `invoke("pageSimulateMerge")`      |
 * | `…conflicts.prepareProposal` / `applyProposal` / `undoProposal` / `requestProposal` | `invoke("pagePrepareProposal"/"pageApplyProposal"/"pageUndoProposal"/"pageRequestProposal")` |
 * | `window.ade.prs.submitReview`                     | `invoke("pageSubmitReview")`       |
 * | `window.ade.prs.land`                             | `invoke("pageLandPr")`             |
 * | `window.ade.prs.createFromLane`                   | `invoke("pageCreatePr")`           |
 * | `window.ade.git.sync` / `.fetch` / `.push`        | `invoke("pageGitSync"/"pageGitFetch"/"pageGitPush")` |
 * | `window.ade.lanes.reparent`                       | `invoke("pageReparentLane")`       |
 * | `window.ade.lanes.rebaseStart`                    | `invoke("pageRebaseStart")`        |
 * | `window.ade.lanes.rename`                         | `invoke("pageRenameLane")`         |
 * | `window.ade.lanes.archive`                        | `invoke("pageArchiveLane")`        |
 * | `window.ade.lanes.delete`                         | `invoke("pageDeleteLane")`         |
 * | `window.ade.lanes.createChild`                    | `invoke("pageCreateChildLane")`    |
 * | `window.ade.lanes.updateAppearance`               | `invoke("pageUpdateLaneAppearance")` |
 * | `window.ade.lanes.openFolder`                     | `host/ui.ts` `openPath`            |
 * | `window.ade.app.writeClipboardText`               | `host/ui.ts` `writeClipboard`      |
 * | `usePluginSurfaceContributions("lanes")`          | `host/sockets.ts` `listSocketEntries` |
 * | `usePluginSocketInvoke()`                         | `host/sockets.ts` `invokeSocketEntry` |
 * | `window.ade.pty.onData` / `.onExit` (rebase console) | **gone** — see PARITY.md    |
 *
 * The plugin's own child process answers every one of these ids
 * (`../../pageActions.js`), which is what makes the page work identically on
 * desktop, in the hosted web client and on a phone: the child holds the ADE
 * action surface and the page holds none of it.
 *
 * Two of these ids fan out INSIDE the child on purpose. `pageSyncStatuses` was
 * one `git.getSyncStatus` per lane issued from the renderer, and `pagePrDetail`
 * was four PR reads; a guest paying a bridge round trip for each would be
 * fifty-odd hops on a wide workspace. Both answer one shape, once.
 */

import { requireBridge } from "../bridge";
import type {
  AutoRebaseLaneStatus,
  BatchAssessmentResult,
  BatchOverlapEntry,
  ConflictProposal,
  ConflictProposalPreview,
  GitSyncMode,
  GitUpstreamSyncStatus,
  GraphPersistedState,
  IntegrationProposal,
  LaneIcon,
  LaneSummary,
  MergeMethod,
  MergeSimulationResult,
  OperationRecord,
  PageProjectConfig,
  PrCheck,
  PrComment,
  PrReview,
  PrStatus,
  PrWithConflicts,
  RiskMatrixEntry,
} from "../lib/types";

/**
 * What every mutating page action answers. Never a throw for a refusal.
 *
 * A press on a panel that fails renders as a banner because the host turns
 * `{message, ok:false}` into one. A page's `invoke` has no such chrome: a
 * rejected promise reaches the page as an exception beside the canvas the reader
 * is looking at, and the page would have to invent the banner itself. So every
 * mutation below resolves `{ok:false, message}` for anything git or GitHub
 * refused, and rejects only when the plugin itself is wrong.
 */
export type PageActionResult = {
  ok: boolean;
  message?: string | null;
  [key: string]: unknown;
};

function call<T>(action: string, args?: Record<string, unknown>): Promise<T> {
  return requireBridge().invoke(action, args ?? {}) as Promise<T>;
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

/**
 * Every lane in the project, including archived ones.
 *
 * Archived lanes arrive because the canvas FILTERS them (`hideArchived`,
 * default on) rather than never seeing them: a reader who turns the filter off
 * must get rows, not an empty canvas.
 */
export const getLanes = (): Promise<LaneSummary[]> => call("pageLanes");

/** The effective project config's environment mappings, and nothing else. */
export const getProjectConfig = (): Promise<PageProjectConfig> => call("pageProjectConfig");

export const getPrs = (): Promise<PrWithConflicts[]> => call("pagePrs");

export const getProposals = (): Promise<IntegrationProposal[]> => call("pageProposals");

/** Upstream sync per lane, keyed by lane id. The child does the fan-out. */
export const getSyncStatuses = (): Promise<Record<string, GitUpstreamSyncStatus | null>> =>
  call("pageSyncStatuses");

export const getAutoRebaseStatuses = (): Promise<AutoRebaseLaneStatus[]> =>
  call("pageAutoRebaseStatuses");

export const getConflictAssessment = (): Promise<BatchAssessmentResult> =>
  call("pageConflictAssessment");

export const getConflictOverlaps = (laneId: string): Promise<BatchOverlapEntry[]> =>
  call("pageConflictOverlaps", { laneId });

export const getRiskMatrix = (): Promise<RiskMatrixEntry[]> => call("pageRiskMatrix");

/**
 * The operation ledger, newest first.
 *
 * Two readers, and the second is why this id exists at all. The compiled page
 * scored lane ACTIVITY from `git_commit` operations; it also streamed a rebase's
 * console straight off `window.ade.pty`. A guest has no pty stream, so the
 * rebase's progress is read from these rows and the `operation` host event
 * instead — see PARITY.md.
 */
export const getOperations = (limit = 150): Promise<OperationRecord[]> =>
  call("pageOperations", { limit });

export const getGraphState = (): Promise<unknown> => call("pageGraphState");

/** The four compiled PR reads, as one round trip. */
export type PagePrDetail = {
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  comments: PrComment[];
};

export const getPrDetail = (prId: string): Promise<PagePrDetail> => call("pagePrDetail", { prId });

/* ── Graph state ────────────────────────────────────────────────────────── */

export const saveGraphState = (state: GraphPersistedState): Promise<PageActionResult> =>
  call("pageSaveGraphState", { state: state as unknown as Record<string, unknown> });

/* ── Conflicts ──────────────────────────────────────────────────────────── */

export const simulateMerge = (
  laneAId: string,
  laneBId: string,
): Promise<PageActionResult & { result?: MergeSimulationResult }> =>
  call("pageSimulateMerge", { laneAId, laneBId });

export const prepareProposal = (
  laneId: string,
  peerLaneId: string,
): Promise<PageActionResult & { preview?: ConflictProposalPreview }> =>
  call("pagePrepareProposal", { laneId, peerLaneId });

export const requestProposal = (args: {
  laneId: string;
  peerLaneId: string;
  contextDigest: string;
}): Promise<PageActionResult & { proposal?: ConflictProposal }> =>
  call("pageRequestProposal", args as unknown as Record<string, unknown>);

export const applyProposal = (args: {
  laneId: string;
  proposalId: string;
  applyMode: "unstaged" | "staged" | "commit";
  commitMessage?: string;
}): Promise<PageActionResult & { proposal?: ConflictProposal }> =>
  call("pageApplyProposal", args as unknown as Record<string, unknown>);

export const undoProposal = (
  laneId: string,
  proposalId: string,
): Promise<PageActionResult & { proposal?: ConflictProposal }> =>
  call("pageUndoProposal", { laneId, proposalId });

/* ── PRs ────────────────────────────────────────────────────────────────── */

export const submitReview = (args: {
  prId: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body?: string;
}): Promise<PageActionResult> => call("pageSubmitReview", args as unknown as Record<string, unknown>);

export const landPr = (prId: string, method: MergeMethod): Promise<PageActionResult> =>
  call("pageLandPr", { prId, method });

export const createPr = (args: {
  laneId: string;
  title: string;
  body: string;
  draft: boolean;
  baseBranch?: string;
}): Promise<PageActionResult & { prId?: string }> =>
  call("pageCreatePr", args as unknown as Record<string, unknown>);

/* ── Git ────────────────────────────────────────────────────────────────── */

export const gitSync = (args: {
  laneId: string;
  mode: GitSyncMode;
  baseRef?: string;
}): Promise<PageActionResult> => call("pageGitSync", args as unknown as Record<string, unknown>);

export const gitFetch = (laneId: string): Promise<PageActionResult> =>
  call("pageGitFetch", { laneId });

export const gitPush = (laneId: string, forceWithLease = false): Promise<PageActionResult> =>
  call("pageGitPush", { laneId, forceWithLease });

/* ── Lanes ──────────────────────────────────────────────────────────────── */

export const reparentLane = (
  laneId: string,
  newParentLaneId: string,
): Promise<PageActionResult & { previousParentLaneId?: string | null }> =>
  call("pageReparentLane", { laneId, newParentLaneId });

export const rebaseStart = (
  laneId: string,
  recursive: boolean,
): Promise<PageActionResult> => call("pageRebaseStart", { laneId, recursive });

export const renameLane = (laneId: string, name: string): Promise<PageActionResult> =>
  call("pageRenameLane", { laneId, name });

export const archiveLane = (laneId: string): Promise<PageActionResult> =>
  call("pageArchiveLane", { laneId });

export const deleteLane = (
  laneId: string,
  options?: { force?: boolean; deleteBranch?: boolean },
): Promise<PageActionResult> =>
  call("pageDeleteLane", { laneId, force: options?.force ?? true, deleteBranch: options?.deleteBranch ?? false });

export const createChildLane = (
  parentLaneId: string,
  name: string,
): Promise<PageActionResult & { laneId?: string; laneName?: string }> =>
  call("pageCreateChildLane", { parentLaneId, name });

export const updateLaneAppearance = (args: {
  laneId: string;
  color: string | null;
  icon: LaneIcon;
  tags: string[];
}): Promise<PageActionResult> =>
  call("pageUpdateLaneAppearance", args as unknown as Record<string, unknown>);
