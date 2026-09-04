/**
 * The host-call map, in one file.
 *
 * Every call the compiled History made into ADE has exactly one counterpart
 * here, and the mapping is the whole point of the page tier:
 *
 * | compiled call                                      | page call                          |
 * |----------------------------------------------------|------------------------------------|
 * | `useAppStore(s => s.lanes)`                        | `invoke("pageLanes")`              |
 * | `window.ade.git.listRecentCommits` + `listBranches`| `invoke("pageCommitGraph")` — ONE  |
 * | `window.ade.git.getCommit` + `isCommitInLaneHistory` | `invoke("pageCommitLookup")`     |
 * | `getCommit` + `getCommitMessage` + `listCommitFiles` | `invoke("pageCommitDetail")` — ONE |
 * | `window.ade.history.listOperations`                | `invoke("pageOperations")`         |
 * | `window.ade.agentChat.list` + `cto.getState`       | `invoke("pageActivitySupplement")` |
 * | `window.ade.git.getConflictState`                  | `invoke("pageConflictState")`      |
 * | `window.ade.git.getOriginRemote`                   | `invoke("pageOriginRemote")`       |
 * | `window.ade.git.getOpenPrForBranch`                | `invoke("pageOpenPrForBranch")`    |
 * | `window.ade.git.stashList`                         | `invoke("pageStashList")`          |
 * | `window.ade.diff.getFilePatch`                     | `invoke("pageFilePatch")`          |
 * | `window.ade.history.exportOperations`              | `invoke("pageExportOperations")`   |
 * | git / lane mutations                               | `invoke("page…")` mutations        |
 * | `window.ade.app.writeClipboardText`                | `host/ui.ts` `writeClipboard`      |
 * | `window.ade.app.openExternal`                      | `host/ui.ts` `openLink`            |
 *
 * The plugin's own child process answers every one of these ids
 * (`../../pageActions.js`).
 */

import { requireBridge } from "../bridge";
import type {
  AgentChatSessionSummary,
  CtoSnapshot,
  ExportHistoryResult,
  GitBranchSummary,
  GitCommitSummary,
  GitConflictState,
  GitOpenPrForBranch,
  GitOriginRemote,
  GitStashSummary,
  HistoryLane,
  OperationRecord,
  PageActionResult,
} from "../lib/types";

function call<T>(action: string, args?: Record<string, unknown>): Promise<T> {
  return requireBridge().invoke(action, args ?? {}) as Promise<T>;
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

export const getLanes = (): Promise<HistoryLane[]> => call("pageLanes");

export type PageCommitGraph = {
  commits: GitCommitSummary[];
  branches: GitBranchSummary[];
};

export const getCommitGraph = (laneId: string, limit: number): Promise<PageCommitGraph> =>
  call("pageCommitGraph", { laneId, limit });

export type PageCommitLookup = {
  commit: GitCommitSummary | null;
  inLaneHistory: boolean;
};

export const lookupCommit = (laneId: string, sha: string): Promise<PageCommitLookup> =>
  call("pageCommitLookup", { laneId, sha });

export type PageCommitDetail = {
  commit: GitCommitSummary | null;
  message: string | null;
  files: string[];
};

export const getCommitDetail = (laneId: string, sha: string): Promise<PageCommitDetail> =>
  call("pageCommitDetail", { laneId, sha });

export const getOperations = (args?: {
  laneId?: string;
  kind?: string;
  limit?: number;
}): Promise<OperationRecord[]> => call("pageOperations", (args ?? {}) as Record<string, unknown>);

export type PageActivitySupplement = {
  chats: AgentChatSessionSummary[];
  ctoSnapshot: CtoSnapshot | null;
};

export const getActivitySupplement = (limit: number): Promise<PageActivitySupplement> =>
  call("pageActivitySupplement", { limit });

export const getConflictState = (laneId: string): Promise<GitConflictState | null> =>
  call("pageConflictState", { laneId });

export const getOriginRemote = (laneId: string): Promise<GitOriginRemote> =>
  call("pageOriginRemote", { laneId });

export const getOpenPrForBranch = (laneId: string): Promise<GitOpenPrForBranch> =>
  call("pageOpenPrForBranch", { laneId });

export const getStashList = (laneId: string): Promise<GitStashSummary[]> =>
  call("pageStashList", { laneId });

export const getFilePatch = (args: {
  laneId: string;
  path: string;
  mode: string;
  compareRef: string;
  compareTo: string;
}): Promise<string | null> => call("pageFilePatch", args as unknown as Record<string, unknown>);

export const exportOperations = (args: Record<string, unknown>): Promise<ExportHistoryResult | PageActionResult> =>
  call("pageExportOperations", args);

/* ── Mutations ──────────────────────────────────────────────────────────── */

export const cherryPick = (laneId: string, commitSha: string): Promise<PageActionResult> =>
  call("pageCherryPick", { laneId, commitSha });

export const revertCommit = (laneId: string, commitSha: string): Promise<PageActionResult> =>
  call("pageRevertCommit", { laneId, commitSha });

export const resetToCommit = (
  laneId: string,
  commitSha: string,
  mode: "soft" | "mixed" | "hard",
): Promise<PageActionResult> => call("pageResetToCommit", { laneId, commitSha, mode });

export const checkoutBranch = (args: {
  laneId: string;
  branchName: string;
  mode: string;
  startPoint: string;
}): Promise<PageActionResult> => call("pageCheckoutBranch", args as unknown as Record<string, unknown>);

export const createTag = (args: {
  laneId: string;
  tagName: string;
  commitSha: string;
  message?: string;
}): Promise<PageActionResult> => call("pageCreateTag", args as unknown as Record<string, unknown>);

export const createLane = (args: {
  name: string;
  parentLaneId: string;
  branchName: string;
  startPoint: string;
  baseBranch?: string;
}): Promise<PageActionResult & { laneId?: string; laneName?: string }> =>
  call("pageCreateLane", args as unknown as Record<string, unknown>);

export const gitFetch = (laneId: string): Promise<PageActionResult> => call("pageGitFetch", { laneId });

export const gitPull = (laneId: string, mode: string): Promise<PageActionResult> =>
  call("pageGitPull", { laneId, mode });

export const gitPush = (laneId: string, forceWithLease = false): Promise<PageActionResult> =>
  call("pageGitPush", { laneId, forceWithLease });

export const undoLastHeadChange = (laneId: string): Promise<PageActionResult> =>
  call("pageUndoHead", { laneId });

export const redoLastHeadChange = (laneId: string): Promise<PageActionResult> =>
  call("pageRedoHead", { laneId });

export const gitSync = (laneId: string, mode: "merge" | "rebase"): Promise<PageActionResult> =>
  call("pageGitSync", { laneId, mode });

export const stashPush = (args: {
  laneId: string;
  message?: string;
  includeUntracked?: boolean;
}): Promise<PageActionResult> => call("pageStashPush", args as unknown as Record<string, unknown>);

export const stashApply = (args: {
  laneId: string;
  stashRef: string;
  stashOid: string;
}): Promise<PageActionResult> => call("pageStashApply", args as unknown as Record<string, unknown>);

export const stashPop = (args: {
  laneId: string;
  stashRef: string;
  stashOid: string;
}): Promise<PageActionResult> => call("pageStashPop", args as unknown as Record<string, unknown>);

export const stashDrop = (args: {
  laneId: string;
  stashRef: string;
  stashOid: string;
}): Promise<PageActionResult> => call("pageStashDrop", args as unknown as Record<string, unknown>);

export const stashClear = (laneId: string): Promise<PageActionResult> => call("pageStashClear", { laneId });

export const rebaseContinue = (laneId: string): Promise<PageActionResult> =>
  call("pageRebaseContinue", { laneId });

export const rebaseAbort = (laneId: string): Promise<PageActionResult> =>
  call("pageRebaseAbort", { laneId });

export const mergeContinue = (laneId: string): Promise<PageActionResult> =>
  call("pageMergeContinue", { laneId });

export const mergeAbort = (laneId: string): Promise<PageActionResult> =>
  call("pageMergeAbort", { laneId });

export const renameLane = (laneId: string, name: string): Promise<PageActionResult> =>
  call("pageRenameLane", { laneId, name });

export const archiveLane = (laneId: string): Promise<PageActionResult> =>
  call("pageArchiveLane", { laneId });

export const deleteLane = (
  laneId: string,
  options?: { deleteBranch?: boolean; force?: boolean },
): Promise<PageActionResult> =>
  call("pageDeleteLane", {
    laneId,
    deleteBranch: options?.deleteBranch === true,
    force: options?.force === true,
  });
