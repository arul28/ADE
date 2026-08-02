import type {
  PrMergeContext,
  PrMobileSnapshot,
  PrSummary,
} from "../../../shared/types";
import type { AdapterInfra, AdeNamespace } from "./types";
import { assertWebRuntimePinUnsupported } from "./runtimePinGuard";

export function createPrsNamespace(infra: AdapterInfra): AdeNamespace<"prs"> {
  const { commands, events } = infra;

  const emptyMobileSnapshot = (): PrMobileSnapshot => ({
    generatedAt: new Date().toISOString(),
    prs: [],
    stacks: [],
    capabilities: {},
    createCapabilities: { canCreateAny: false, defaultBaseBranch: null, lanes: [] },
    workflowCards: [],
    live: false,
  });

  async function mobileSnapshot(options: { surfaceErrors?: boolean } = {}): Promise<PrMobileSnapshot> {
    const fallback = options.surfaceErrors
      ? () => { throw new Error("The PR snapshot is temporarily unavailable."); }
      : emptyMobileSnapshot;
    if (commands.hasAction("prs.getMobileSnapshot")) {
      return await commands.call("prs.getMobileSnapshot", {}, {
        fallback,
        idempotent: true,
        cacheTtlMs: 3_000,
      });
    }
    const prs = await commands.call<PrSummary[]>("prs.list", {}, {
      fallback: options.surfaceErrors
        ? () => { throw new Error("The PR list is temporarily unavailable."); }
        : [],
      idempotent: true,
      cacheTtlMs: 3_000,
    });
    return { ...emptyMobileSnapshot(), prs };
  }

  function call<T>(action: string, args: unknown, fallback: T, idempotent = true): Promise<T> {
    return commands.call<T>(action, asRecord(args), { fallback, idempotent });
  }

  function read<T>(action: string, args: unknown, fallback: T): Promise<T> {
    return commands.call<T>(action, asRecord(args), { fallback, cacheTtlMs: 3_000 });
  }

  infra.addDispose(
    events.on("prsInvalidated", (event) => {
      commands.invalidateCache(["prs."]);
      // `prs-updated` is authoritative in PrsContext; never represent a stale
      // cache marker as an empty PR list. Hydrate one coalesced aggregate read
      // and emit only when the host actually returned a snapshot.
      void mobileSnapshot({ surfaceErrors: true }).then((snapshot) => {
        events.emit("prsEvent", {
          type: "prs-updated",
          polledAt: event.at,
          prs: snapshot.prs,
        });
      }).catch(() => {});
    })
  );

  const prs: Record<string, unknown> = {
    createFromLane: (args: unknown) => call("prs.createFromLane", args, null, false),
    linkToLane: (args: unknown) => call("prs.linkToLane", args, null, false),
    preflightCreateLaneFromPrBranch: (args: unknown) => call("prs.preflightCreateLaneFromPrBranch", args, null),
    createLaneFromPrBranch: (args: unknown) => call("prs.createLaneFromPrBranch", args, null, false),
    getForLane: async (laneId: string, pin?: unknown) => {
      assertWebRuntimePinUnsupported("prs.getForLane", pin);
      return (await mobileSnapshot()).prs.find((pr) => pr.laneId === laneId) ?? null;
    },
    // Manual ⟳ PR-sync (ChatGitToolbar) — force a fresh reconcile for one lane.
    // Mirrors the preload runtime action `pr.syncLanePr` (single positional
    // laneId); the sync command layer marshals a named record, exactly like the
    // `prs.getForLane` host handler that reads `{ laneId }`. It mutates, so the
    // read cache is dropped afterward like `refresh` does.
    syncLanePr: async (laneId: string, pin?: unknown) => {
      assertWebRuntimePinUnsupported("prs.syncLanePr", pin);
      const result = await call<PrSummary | null>("prs.syncLanePr", { laneId }, null, false);
      commands.invalidateCache(["prs."]);
      return result;
    },
    // Force a global PR reconcile. Routes to the same daemon action the preload
    // uses (`pr.reconcileOnFocus` with `{ force: true }`).
    reconcileNow: async () => {
      await call("prs.reconcileOnFocus", { force: true }, undefined, false);
      commands.invalidateCache(["prs."]);
    },
    listAll: async (pin?: unknown) => {
      assertWebRuntimePinUnsupported("prs.listAll", pin);
      return (await mobileSnapshot()).prs;
    },
    listOpenForRepo: () => read("prs.listOpenForRepo", {}, []),
    refresh: async (args?: unknown, pin?: unknown) => {
      assertWebRuntimePinUnsupported("prs.refresh", pin);
      const result = await call<unknown>("prs.refresh", args, [], false);
      commands.invalidateCache(["prs."]);
      return arrayField<PrSummary>(result, "prs");
    },
    getStatus: (prId: string, pin?: unknown) => {
      assertWebRuntimePinUnsupported("prs.getStatus", pin);
      return read("prs.getStatus", { prId }, null);
    },
    getChecks: (prId: string, pin?: unknown) => {
      assertWebRuntimePinUnsupported("prs.getChecks", pin);
      return read("prs.getChecks", { prId }, []);
    },
    getComments: (prId: string, pin?: unknown) => {
      assertWebRuntimePinUnsupported("prs.getComments", pin);
      return read("prs.getComments", { prId }, []);
    },
    getReviews: (prId: string, pin?: unknown) => {
      assertWebRuntimePinUnsupported("prs.getReviews", pin);
      return read("prs.getReviews", { prId }, []);
    },
    getReviewThreads: (prId: string) => read("prs.getReviewThreads", { prId }, []),
    updateDescription: async (args: unknown) => {
      await call("prs.updateDescription", args, undefined, false);
    },
    delete: (args: unknown) => call("prs.delete", args, { ok: false, error: "unsupported" }, false),
    draftDescription: (args: unknown) => call("prs.draftDescription", args, { title: "", body: "" }),
    land: (args: unknown) => call("prs.land", args, null, false),
    updateBranch: (args: unknown) => call("prs.updateBranch", args, null, false),
    retargetBase: async (args: unknown) => {
      await call("prs.retargetBase", args, undefined, false);
    },
    openInGitHub: async (prId: string) => {
      if (/^https?:\/\//.test(prId) && typeof window !== "undefined") window.open(prId, "_blank", "noopener,noreferrer");
    },
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
    getHealth: (prId: string) => call("prs.getHealth", { prId }, null),
    getConflictAnalysis: (prId: string) => call("prs.getConflictAnalysis", { prId }, null),
    getMergeContext: (prId: string) => read("prs.getMergeContext", { prId }, null),
    getMergeContexts: (prIds: string[]) => read(
      "prs.getMergeContexts",
      { prIds },
      Object.fromEntries(prIds.map((prId) => [prId, emptyMergeContext(prId)])),
    ),
    listWithConflicts: async (args?: unknown) => {
      if (asRecord(args).includeConflictAnalysis === true) {
        return await read("prs.listWithConflicts", args, []);
      }
      return (await mobileSnapshot()).prs.map((pr) => ({
        ...pr,
        conflictAnalysis: null,
      }));
    },
    listSnapshots: (args?: unknown) => read("prs.listSnapshots", args, []),
    getGitHubSnapshot: (args?: unknown) => read("prs.getGitHubSnapshot", args, null),
    listGitHubStacks: (args?: unknown) => read("prs.listGithubStacks", args, []),
    syncGitHubStacks: async (args?: unknown) => {
      const result = await call("prs.syncGithubStacks", args, [], false);
      commands.invalidateCache(["prs."]);
      return result;
    },
    createGitHubStack: async (args: unknown) => {
      const result = await call("prs.createGithubStack", args, null, false);
      commands.invalidateCache(["prs."]);
      return result;
    },
    addGitHubStackPullRequests: async (args: unknown) => {
      const result = await call("prs.addGithubStackPullRequests", args, null, false);
      commands.invalidateCache(["prs."]);
      return result;
    },
    unstackGitHubStack: async (args: unknown) => {
      const result = await call("prs.unstackGithubStack", args, null, false);
      commands.invalidateCache(["prs."]);
      return result;
    },
    listIntegrationWorkflows: (args?: unknown) => call("prs.listIntegrationWorkflows", args, []),
    onEvent: (listener: (event: unknown) => void, pin?: unknown) => {
      assertWebRuntimePinUnsupported("prs.onEvent", pin);
      return events.on("prsEvent", listener as never);
    },
    getDetail: (prId: string) => read("prs.getDetail", { prId }, null),
    getFiles: (prId: string) => read("prs.getFiles", { prId }, []),
    getCommits: (prId: string) => read("prs.getCommits", { prId }, []),
    getActionRuns: (prId: string) => read("prs.getActionRuns", { prId }, []),
    getActivity: (prId: string) => read("prs.getActivity", { prId }, []),
    getWorkflowGraph: (args: unknown) => read("prs.getWorkflowGraph", args, null),
    getCheckLog: (args: unknown) => read("prs.getCheckLog", args, null),
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

function arrayField<T>(result: unknown, key: string): T[] {
  if (Array.isArray(result)) return result as T[];
  if (!result || typeof result !== "object") return [];
  const value = (result as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function emptyMergeContext(prId: string): PrMergeContext {
  return {
    prId,
    groupId: null,
    groupType: null,
    sourceLaneIds: [],
    targetLaneId: null,
    integrationLaneId: null,
    members: [],
  };
}
