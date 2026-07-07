import type { AdapterInfra, AdeNamespace } from "./types";

export function createPrsNamespace(infra: AdapterInfra): AdeNamespace<"prs"> {
  const { commands, events } = infra;

  function call<T>(action: string, args: unknown, fallback: T, idempotent = true): Promise<T> {
    return commands.call<T>(action, asRecord(args), { fallback, idempotent });
  }

  infra.addDispose(
    events.on("prsInvalidated", (event) => {
      events.emit("prsEvent", {
        type: "prs-updated",
        polledAt: event.at,
        prs: [],
      });
    })
  );

  const prs: Record<string, unknown> = {
    createFromLane: (args: unknown) => call("prs.createFromLane", args, null, false),
    linkToLane: (args: unknown) => call("prs.linkToLane", args, null, false),
    preflightCreateLaneFromPrBranch: (args: unknown) => call("prs.preflightCreateLaneFromPrBranch", args, null),
    createLaneFromPrBranch: (args: unknown) => call("prs.createLaneFromPrBranch", args, null, false),
    getForLane: (laneId: string) => call("prs.getForLane", { laneId }, null),
    listAll: () => call("prs.list", {}, []),
    listOpenForRepo: () => call("prs.listOpenForRepo", {}, []),
    refresh: (args?: unknown) => call("prs.refresh", args, [], false),
    getStatus: (prId: string) => call("prs.getStatus", { prId }, null),
    getChecks: (prId: string) => call("prs.getChecks", { prId }, []),
    getComments: (prId: string) => call("prs.getComments", { prId }, []),
    getReviews: (prId: string) => call("prs.getReviews", { prId }, []),
    getReviewThreads: (prId: string) => call("prs.getReviewThreads", { prId }, []),
    updateDescription: async (args: unknown) => {
      await call("prs.updateDescription", args, undefined, false);
    },
    delete: (args: unknown) => call("prs.delete", args, { ok: false, error: "unsupported" }, false),
    draftDescription: (args: unknown) => call("prs.draftDescription", args, { title: "", body: "" }),
    land: (args: unknown) => call("prs.land", args, null, false),
    updateBranch: (args: unknown) => call("prs.updateBranch", args, null, false),
    landStack: (args: unknown) => call("prs.landStack", args, [], false),
    retargetBase: async (args: unknown) => {
      await call("prs.retargetBase", args, undefined, false);
    },
    openInGitHub: async (prId: string) => {
      if (/^https?:\/\//.test(prId) && typeof window !== "undefined") window.open(prId, "_blank", "noopener,noreferrer");
    },
    createQueue: (args: unknown) => call("prs.createQueue", args, null, false),
    createIntegration: (args: unknown) => call("prs.createIntegration", args, null, false),
    simulateIntegration: (args: unknown) => call("prs.simulateIntegration", args, null),
    commitIntegration: (args: unknown) => call("prs.commitIntegration", args, null, false),
    listProposals: () => call("prs.listProposals", {}, []),
    updateProposal: async (args: unknown) => {
      await call("prs.updateIntegrationProposal", args, undefined, false);
    },
    deleteProposal: (args: unknown) => call("prs.deleteIntegrationProposal", args, { deleted: false }, false),
    createIntegrationLaneForProposal: (args: unknown) => call("prs.createIntegrationLaneForProposal", args, null, false),
    startIntegrationResolution: (args: unknown) => call("prs.startIntegrationResolution", args, null, false),
    recheckIntegrationStep: (args: unknown) => call("prs.recheckIntegrationStep", args, null, false),
    getIntegrationResolutionState: (proposalId: string) => call("prs.getIntegrationResolutionState", { proposalId }, null),
    aiResolutionStart: (args: unknown) => call("prs.aiResolutionStart", args, { ok: false, error: "unsupported" }, false),
    aiResolutionGetSession: (args: unknown) => call("prs.aiResolutionGetSession", args, null),
    aiResolutionInput: async (args: unknown) => {
      await call("prs.aiResolutionInput", args, undefined, false);
    },
    aiResolutionStop: async (args: unknown) => {
      await call("prs.aiResolutionStop", args, undefined, false);
    },
    onAiResolutionEvent: () => () => {},
    landStackEnhanced: (args: unknown) => call("prs.landStackEnhanced", args, [], false),
    landQueueNext: (args: unknown) => call("prs.landQueueNext", args, null, false),
    startQueueAutomation: (args: unknown) => call("prs.startQueueAutomation", args, null, false),
    pauseQueueAutomation: (queueId: string) => call("prs.pauseQueueAutomation", { queueId }, null, false),
    resumeQueueAutomation: (args: unknown) => call("prs.resumeQueueAutomation", args, null, false),
    cancelQueueAutomation: (queueId: string) => call("prs.cancelQueueAutomation", { queueId }, null, false),
    reorderQueuePrs: async (args: unknown) => {
      await call("prs.reorderQueue", args, undefined, false);
    },
    getHealth: (prId: string) => call("prs.getHealth", { prId }, null),
    getQueueState: (groupId: string) => call("prs.getQueueState", { groupId }, null),
    listQueueStates: (args?: unknown) => call("prs.listQueueStates", args, []),
    getConflictAnalysis: (prId: string) => call("prs.getConflictAnalysis", { prId }, null),
    getMergeContext: (prId: string) => call("prs.getMergeContext", { prId }, null),
    getMergeContexts: (prIds: string[]) => call("prs.getMergeContexts", { prIds }, {}),
    listWithConflicts: (args?: unknown) => call("prs.listWithConflicts", args, []),
    listSnapshots: (args?: unknown) => call("prs.listSnapshots", args, []),
    getGitHubSnapshot: (args?: unknown) => call("prs.getGitHubSnapshot", args, null),
    listIntegrationWorkflows: (args?: unknown) => call("prs.listIntegrationWorkflows", args, []),
    onEvent: (listener: (event: unknown) => void) => events.on("prsEvent", listener as never),
    getDetail: (prId: string) => call("prs.getDetail", { prId }, null),
    getFiles: (prId: string) => call("prs.getFiles", { prId }, []),
    getCommits: (prId: string) => call("prs.getCommits", { prId }, []),
    getActionRuns: (prId: string) => call("prs.getActionRuns", { prId }, []),
    getActivity: (prId: string) => call("prs.getActivity", { prId }, []),
    getDetailByGithub: (coords: unknown) => call("prs.getDetailByGithub", coords, null),
    getFilesByGithub: (coords: unknown) => call("prs.getFilesByGithub", coords, []),
    getCommitsByGithub: (coords: unknown) => call("prs.getCommitsByGithub", coords, []),
    getActionRunsByGithub: (coords: unknown) => call("prs.getActionRunsByGithub", coords, []),
    getActivityByGithub: (coords: unknown) => call("prs.getActivityByGithub", coords, []),
    getStatusByGithub: (coords: unknown) => call("prs.getStatusByGithub", coords, null),
    getChecksByGithub: (coords: unknown) => call("prs.getChecksByGithub", coords, []),
    getReviewsByGithub: (coords: unknown) => call("prs.getReviewsByGithub", coords, []),
    getCommentsByGithub: (coords: unknown) => call("prs.getCommentsByGithub", coords, []),
    getReviewThreadsByGithub: (coords: unknown) => call("prs.getReviewThreadsByGithub", coords, []),
    addComment: (args: unknown) => call("prs.addComment", args, null, false),
    updateComment: (args: unknown) => call("prs.updateComment", args, null, false),
    replyToReviewThread: (args: unknown) => call("prs.replyToReviewThread", args, null, false),
    resolveReviewThread: async (args: unknown) => {
      await call("prs.resolveReviewThread", args, undefined, false);
    },
    updateTitle: async (args: unknown) => {
      await call("prs.updateTitle", args, undefined, false);
    },
    updateBody: async (args: unknown) => {
      await call("prs.updateBody", args, undefined, false);
    },
    setLabels: async (args: unknown) => {
      await call("prs.setLabels", args, undefined, false);
    },
    requestReviewers: async (args: unknown) => {
      await call("prs.requestReviewers", args, undefined, false);
    },
    submitReview: (args: unknown) => call("prs.submitReview", args, null, false),
    close: async (args: unknown) => {
      await call("prs.close", args, undefined, false);
    },
    reopen: async (args: unknown) => {
      await call("prs.reopen", args, undefined, false);
    },
    rerunChecks: async (args: unknown) => {
      await call("prs.rerunChecks", args, undefined, false);
    },
    aiReviewSummary: (args: unknown) => call("prs.aiReviewSummary", args, null),
    dismissIntegrationCleanup: (args: unknown) => call("prs.dismissIntegrationCleanup", args, null, false),
    cleanupIntegrationWorkflow: (args: unknown) => call("prs.cleanupIntegrationWorkflow", args, null, false),
    getDeployments: (prId: string) => call("prs.getDeployments", { prId }, []),
    getAiSummary: (prId: string) => call("prs.getAiSummary", { prId }, null),
    regenerateAiSummary: (prId: string) => call("prs.regenerateAiSummary", { prId }, null, false),
    postReviewComment: (args: unknown) => call("prs.postReviewComment", args, null, false),
    setReviewThreadResolved: (args: unknown) => call("prs.setReviewThreadResolved", args, null, false),
    reactToComment: async (args: unknown) => {
      await call("prs.reactToComment", args, undefined, false);
    },
    cleanupBranch: (args: unknown) => call("prs.cleanupBranch", args, { ok: false, error: "unsupported" }, false),
  };

  return prs as AdeNamespace<"prs">;
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}
