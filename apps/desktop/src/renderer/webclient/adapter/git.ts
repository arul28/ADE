import type { AdapterInfra, AdeNamespace } from "./types";
import { assertWebRuntimePinRoutable, type RuntimePinArg as Pin } from "./runtimePinGuard";

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
   *
   * `operation` names the member in the user-facing refusal and defaults to the
   * action, which is the same string everywhere except the three `diff.*`
   * members that call a `git.*` action.
   */
  async function guarded<T>(
    action: string,
    args: unknown,
    pin: Pin,
    fallback: T,
    idempotent = true,
    operation: string = action,
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
    git[method] = (args: unknown, pin?: Pin) => guarded(`git.${method}`, args, pin, gitActionFallback, false);
  }

  Object.assign(git, {
    generateCommitMessage: (args: unknown, pin?: Pin) =>
      guarded("git.generateCommitMessage", args, pin, { message: "", model: null }),
    listRecentCommits: (args: unknown, pin?: Pin) => guarded("git.listRecentCommits", args, pin, []),
    listCommitFiles: (args: unknown, pin?: Pin) => guarded("git.listCommitFiles", args, pin, []),
    getCommitMessage: (args: unknown, pin?: Pin) => guarded("git.getCommitMessage", args, pin, ""),
    getCommit: (args: unknown, pin?: Pin) => guarded("git.getCommit", args, pin, null),
    isCommitInLaneHistory: (args: unknown, pin?: Pin) => guarded("git.isCommitInLaneHistory", args, pin, false),
    stashList: (args: unknown, pin?: Pin) => guarded("git.stashList", args, pin, []),
    stashClear: (args: unknown, pin?: Pin) => guarded("git.stashClear", args, pin, gitActionFallback, false),
    getSyncStatus: (args: unknown, pin?: Pin) => guarded("git.getSyncStatus", args, pin, null),
    getOriginRemote: (args: unknown, pin?: Pin) =>
      guarded("git.getOriginRemote", args, pin, { remoteUrl: null, branch: null }),
    getOpenPrForBranch: (args: unknown, pin?: Pin) =>
      guarded("git.getOpenPrForBranch", args, pin, {
        prUrl: null,
        prNumber: null,
        title: null,
        headRefName: null,
      }),
    getConflictState: (args: unknown, pin?: Pin) =>
      guarded("git.getConflictState", laneRecord(args), pin, { state: "clean" }),
    rebaseContinue: (args: unknown, pin?: Pin) =>
      guarded("git.rebaseContinue", laneRecord(args), pin, gitActionFallback, false),
    rebaseAbort: (args: unknown, pin?: Pin) =>
      guarded("git.rebaseAbort", laneRecord(args), pin, gitActionFallback, false),
    mergeContinue: (args: unknown, pin?: Pin) =>
      guarded("git.mergeContinue", laneRecord(args), pin, gitActionFallback, false),
    mergeAbort: (args: unknown, pin?: Pin) =>
      guarded("git.mergeAbort", laneRecord(args), pin, gitActionFallback, false),
    listBranches: (args: unknown, pin?: Pin) => guarded("git.listBranches", args, pin, []),
    getUserIdentity: (args: unknown, pin?: Pin) =>
      guarded("git.getUserIdentity", args, pin, {
        name: null,
        email: null,
        source: "unsupported",
      }),
  });

  const diff: Record<string, unknown> = {
    getChanges: (args: unknown, pin?: Pin) =>
      guarded("git.getChanges", args, pin, { files: [] }, true, "diff.getChanges"),
    getFile: (args: unknown, pin?: Pin) => guarded("git.getFile", args, pin, null, true, "diff.getFile"),
    getFilePatch: (args: unknown, pin?: Pin) =>
      guarded("git.getFilePatch", args, pin, null, true, "diff.getFilePatch"),
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
