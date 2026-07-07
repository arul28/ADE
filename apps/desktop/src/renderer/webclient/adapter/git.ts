import type { AdapterInfra, AdeNamespace } from "./types";

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
    git[method] = (args: unknown) => call(`git.${method}`, args, gitActionFallback, false);
  }

  Object.assign(git, {
    generateCommitMessage: (args: unknown) => call("git.generateCommitMessage", args, { message: "", model: null }),
    listRecentCommits: (args: unknown) => call("git.listRecentCommits", args, []),
    listCommitFiles: (args: unknown) => call("git.listCommitFiles", args, []),
    getCommitMessage: (args: unknown) => call("git.getCommitMessage", args, ""),
    getCommit: (args: unknown) => call("git.getCommit", args, null),
    isCommitInLaneHistory: (args: unknown) => call("git.isCommitInLaneHistory", args, false),
    stashList: (args: unknown) => call("git.stashList", args, []),
    stashClear: (args: unknown) => call("git.stashClear", args, gitActionFallback, false),
    getSyncStatus: (args: unknown) => call("git.getSyncStatus", args, null),
    getOriginRemote: (args: unknown) => call("git.getOriginRemote", args, { remoteUrl: null, branch: null }),
    getOpenPrForBranch: (args: unknown) =>
      call("git.getOpenPrForBranch", args, {
        prUrl: null,
        prNumber: null,
        title: null,
        headRefName: null,
      }),
    getConflictState: (args: unknown) => call("git.getConflictState", laneRecord(args), { state: "clean" }),
    rebaseContinue: (args: unknown) => call("git.rebaseContinue", laneRecord(args), gitActionFallback, false),
    rebaseAbort: (args: unknown) => call("git.rebaseAbort", laneRecord(args), gitActionFallback, false),
    mergeContinue: (args: unknown) => call("git.mergeContinue", laneRecord(args), gitActionFallback, false),
    mergeAbort: (args: unknown) => call("git.mergeAbort", laneRecord(args), gitActionFallback, false),
    listBranches: (args: unknown) => call("git.listBranches", args, []),
    getUserIdentity: (args: unknown) =>
      call("git.getUserIdentity", args, {
        name: null,
        email: null,
        source: "unsupported",
      }),
  });

  const diff: Record<string, unknown> = {
    getChanges: (args: unknown) => call("git.getChanges", args, { files: [] }),
    getFile: (args: unknown) => call("git.getFile", args, null),
    getFilePatch: (args: unknown) => call("git.getFilePatch", args, null),
  };

  const conflicts: Record<string, unknown> = {
    getLaneStatus: (args: unknown) => call("conflicts.getLaneStatus", args, null),
    listOverlaps: (args: unknown) => call("conflicts.listOverlaps", args, []),
    getRiskMatrix: () => call("conflicts.getRiskMatrix", {}, []),
    simulateMerge: (args: unknown) => call("conflicts.simulateMerge", args, null),
    runPrediction: (args?: unknown) => call("conflicts.runPrediction", args, null, false),
    getBatchAssessment: () => call("conflicts.getBatchAssessment", {}, null),
    listProposals: (laneId: string) => call("conflicts.listProposals", { laneId }, []),
    prepareProposal: (args: unknown) => call("conflicts.prepareProposal", args, null),
    requestProposal: (args: unknown) => call("conflicts.requestProposal", args, null, false),
    applyProposal: (args: unknown) => call("conflicts.applyProposal", args, null, false),
    undoProposal: (args: unknown) => call("conflicts.undoProposal", args, null, false),
    runExternalResolver: (args: unknown) => call("conflicts.runExternalResolver", args, null, false),
    listExternalResolverRuns: (args?: unknown) => call("conflicts.listExternalResolverRuns", args, []),
    commitExternalResolverRun: (args: unknown) => call("conflicts.commitExternalResolverRun", args, null, false),
    prepareResolverSession: (args: unknown) => call("conflicts.prepareResolverSession", args, null, false),
    attachResolverSession: (args: unknown) => call("conflicts.attachResolverSession", args, null, false),
    finalizeResolverSession: (args: unknown) => call("conflicts.finalizeResolverSession", args, null, false),
    cancelResolverSession: (args: unknown) => call("conflicts.cancelResolverSession", args, null, false),
    suggestResolverTarget: (args: unknown) => call("conflicts.suggestResolverTarget", args, null),
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
