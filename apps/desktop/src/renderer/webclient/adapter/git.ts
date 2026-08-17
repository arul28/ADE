import type { AdapterInfra, AdeNamespace } from "./types";
import { assertWebRuntimePinRoutable } from "./runtimePinGuard";

export type GitNamespaces = {
  git: AdeNamespace<"git">;
  diff: AdeNamespace<"diff">;
  conflicts: AdeNamespace<"conflicts">;
};

export function createGitNamespaces(infra: AdapterInfra): GitNamespaces {
  const { commands } = infra;

  function call<T>(action: string, args: unknown, fallback: T, idempotent = true): Promise<T> {
    return commands.call<T>(action, asRecord(args), { fallback, idempotent });
  }

  /**
   * Every `git.*` and `diff.*` member takes a trailing runtime pin in the
   * Electron contract, so each must refuse a pin this adapter cannot route
   * rather than silently answering for the machine it happens to be bound to.
   * `async` so an unroutable pin rejects the returned promise instead of
   * throwing synchronously out of the caller's expression.
   * (`conflicts.*` takes no pin in the preload contract, so it stays as-is.)
   */
  async function guarded<T>(
    operation: string,
    action: string,
    args: unknown,
    pin: unknown,
    fallback: T,
    idempotent = true,
  ): Promise<T> {
    assertWebRuntimePinRoutable(operation, pin, infra);
    return await call<T>(action, args, fallback, idempotent);
  }

  const gitActionFallback = { operationId: "", preHeadSha: null, postHeadSha: null };
  const gitMethods = [
    "stageFile",
    "stageAll",
    "unstageFile",
    "unstageAll",
    "discardFile",
    "restoreStagedFile",
    "commit",
    "revertCommit",
    "cherryPickCommit",
    "createTag",
    "resetToCommit",
    "stashPush",
    "stashApply",
    "stashPop",
    "stashDrop",
    "fetch",
    "pull",
    "undoLastHeadChange",
    "redoLastHeadChange",
    "sync",
    "push",
    "checkoutBranch",
  ];

  const git: Record<string, unknown> = {};
  for (const method of gitMethods) {
    git[method] = (args: unknown, pin?: unknown) =>
      guarded(`git.${method}`, `git.${method}`, args, pin, gitActionFallback, false);
  }

  Object.assign(git, {
    generateCommitMessage: (args: unknown, pin?: unknown) =>
      guarded("git.generateCommitMessage", "git.generateCommitMessage", args, pin, { message: "", model: null }),
    listRecentCommits: (args: unknown, pin?: unknown) =>
      guarded("git.listRecentCommits", "git.listRecentCommits", args, pin, []),
    listCommitFiles: (args: unknown, pin?: unknown) =>
      guarded("git.listCommitFiles", "git.listCommitFiles", args, pin, []),
    getCommitMessage: (args: unknown, pin?: unknown) =>
      guarded("git.getCommitMessage", "git.getCommitMessage", args, pin, ""),
    getCommit: (args: unknown, pin?: unknown) => guarded("git.getCommit", "git.getCommit", args, pin, null),
    isCommitInLaneHistory: (args: unknown, pin?: unknown) =>
      guarded("git.isCommitInLaneHistory", "git.isCommitInLaneHistory", args, pin, false),
    stashList: (args: unknown, pin?: unknown) => guarded("git.stashList", "git.stashList", args, pin, []),
    stashClear: (args: unknown, pin?: unknown) =>
      guarded("git.stashClear", "git.stashClear", args, pin, gitActionFallback, false),
    getSyncStatus: (args: unknown, pin?: unknown) => guarded("git.getSyncStatus", "git.getSyncStatus", args, pin, null),
    getOriginRemote: (args: unknown, pin?: unknown) =>
      guarded("git.getOriginRemote", "git.getOriginRemote", args, pin, { remoteUrl: null, branch: null }),
    getOpenPrForBranch: (args: unknown, pin?: unknown) =>
      guarded("git.getOpenPrForBranch", "git.getOpenPrForBranch", args, pin, {
        prUrl: null,
        prNumber: null,
        title: null,
        headRefName: null,
      }),
    getConflictState: (args: unknown, pin?: unknown) =>
      guarded("git.getConflictState", "git.getConflictState", laneRecord(args), pin, { state: "clean" }),
    rebaseContinue: (args: unknown, pin?: unknown) =>
      guarded("git.rebaseContinue", "git.rebaseContinue", laneRecord(args), pin, gitActionFallback, false),
    rebaseAbort: (args: unknown, pin?: unknown) =>
      guarded("git.rebaseAbort", "git.rebaseAbort", laneRecord(args), pin, gitActionFallback, false),
    mergeContinue: (args: unknown, pin?: unknown) =>
      guarded("git.mergeContinue", "git.mergeContinue", laneRecord(args), pin, gitActionFallback, false),
    mergeAbort: (args: unknown, pin?: unknown) =>
      guarded("git.mergeAbort", "git.mergeAbort", laneRecord(args), pin, gitActionFallback, false),
    listBranches: (args: unknown, pin?: unknown) => guarded("git.listBranches", "git.listBranches", args, pin, []),
    getUserIdentity: (args: unknown, pin?: unknown) =>
      guarded("git.getUserIdentity", "git.getUserIdentity", args, pin, {
        name: null,
        email: null,
        source: "unsupported",
      }),
  });

  const diff: Record<string, unknown> = {
    getChanges: (args: unknown, pin?: unknown) => guarded("diff.getChanges", "git.getChanges", args, pin, { files: [] }),
    getFile: (args: unknown, pin?: unknown) => guarded("diff.getFile", "git.getFile", args, pin, null),
    getFilePatch: (args: unknown, pin?: unknown) =>
      guarded("diff.getFilePatch", "git.getFilePatch", args, pin, null),
  };

  const conflicts: Record<string, unknown> = {
    getLaneStatus: (args: unknown) => call("conflicts.getLaneStatus", args, null),
    listOverlaps: (args: unknown) => call("conflicts.listOverlaps", args, []),
    simulateMerge: (args: unknown) => call("conflicts.simulateMerge", args, null),
    getBatchAssessment: () => call("conflicts.getBatchAssessment", {}, null),
    listProposals: (laneId: string) => call("conflicts.listProposals", { laneId }, []),
    prepareProposal: (args: unknown) => call("conflicts.prepareProposal", args, null),
    requestProposal: (args: unknown) => call("conflicts.requestProposal", args, null, false),
    applyProposal: (args: unknown) => call("conflicts.applyProposal", args, null, false),
    undoProposal: (args: unknown) => call("conflicts.undoProposal", args, null, false),
    onEvent: () => () => {},
  };

  return {
    git: git as AdeNamespace<"git">,
    diff: diff as AdeNamespace<"diff">,
    conflicts: conflicts as AdeNamespace<"conflicts">,
  };
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function laneRecord(args: unknown): Record<string, unknown> {
  return typeof args === "string" ? { laneId: args } : asRecord(args);
}
