import type {
  PrMergeContext,
  PrMobileGithubDetailSnapshot,
  PrMobileSnapshot,
  PrSummary,
  PrWithConflicts,
} from "../../../shared/types";
import type { AdapterInfra, AdeNamespace } from "./types";
import { createCoalescingReadCache } from "./infra/coalescingReadCache";
import { unavailableOnHost } from "./misc";
import { assertWebRuntimePinRoutable } from "./runtimePinGuard";

const READ_CACHE_TTL_MS = 3_000;

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

  /**
   * The PR list, from the cheapest command the host offers.
   *
   * `prs.list` is a bare DB read; the mobile aggregate it replaced rebuilds
   * lanes, capabilities, stacks and — worst of all — runs a sequential per-lane
   * `scanRebaseNeeds()` git sweep, which head-of-line-blocks every other call on
   * the peer. Older hosts without `prs.list` still fall back to the aggregate.
   */
  async function listPrs(options: { surfaceErrors?: boolean } = {}): Promise<PrSummary[]> {
    const fallback = options.surfaceErrors
      ? unavailableOnHost("The PR list is temporarily unavailable.")
      : () => [] as PrSummary[];
    if (commands.hasAction("prs.list")) {
      return await commands.call<PrSummary[]>("prs.list", {}, {
        fallback,
        idempotent: true,
        cacheTtlMs: READ_CACHE_TTL_MS,
      });
    }
    const snapshot = await commands.call<PrMobileSnapshot>("prs.getMobileSnapshot", {}, {
      fallback: options.surfaceErrors
        ? unavailableOnHost("The PR snapshot is temporarily unavailable.")
        : emptyMobileSnapshot,
      idempotent: true,
      cacheTtlMs: READ_CACHE_TTL_MS,
    });
    return snapshot.prs;
  }

  function call<T>(action: string, args: unknown, fallback: T, idempotent = true): Promise<T> {
    return commands.call<T>(action, asRecord(args), { fallback, idempotent });
  }

  function read<T>(action: string, args: unknown, fallback: T): Promise<T> {
    return commands.call<T>(action, asRecord(args), { fallback, cacheTtlMs: READ_CACHE_TTL_MS });
  }

  // ---- Batched GitHub detail ----
  //
  // Opening a PR detail fans out into ~10 sidecar reads (detail, status, checks,
  // reviews, comments, files, commits, threads, runs, activity). Each one is a
  // serialized relay round trip; `prs.getMobileGithubDetail` answers all of them
  // from one host-side `Promise.all`. The individual getters read through this
  // batch, so the fan-out collapses to a single call per PR.
  //
  // `getStatusByGithub` deliberately never *starts* a batch: the mergeability
  // poll calls it alone, and turning a status poll into a ten-way GitHub fan-out
  // would cost more than it saves. It still reads a batch another getter opened.
  // The shared read cache, not a hand-rolled Map: it arms the TTL at
  // RESOLUTION (an expiry armed at creation could retire a batch before its
  // sidecars ever read it) and `cacheResult` keeps a failed batch out, so one
  // bad fan-out is not replayed to every sidecar for the rest of the window.
  const githubDetailBatches = createCoalescingReadCache(READ_CACHE_TTL_MS);

  /**
   * Drop every cached PR read, batches included.
   *
   * Batches are live GitHub state layered over the same rows the `prs.` reads
   * serve; a caller that invalidates one and not the other leaves the detail
   * pane showing pre-write data. Every invalidation goes through here so the
   * two cannot drift apart.
   */
  function invalidatePrsReads(): void {
    commands.invalidateCache(["prs."]);
    githubDetailBatches.clear();
  }

  function coordsKey(coords: unknown): string | null {
    const record = asRecord(coords);
    const owner = typeof record.repoOwner === "string" ? record.repoOwner : "";
    const name = typeof record.repoName === "string" ? record.repoName : "";
    const number = Number(record.githubPrNumber);
    if (!owner || !name || !Number.isFinite(number) || number <= 0) return null;
    return `${owner}/${name}#${number}`;
  }

  type GithubDetailBatch = PrMobileGithubDetailSnapshot | null;

  /** Read a batch another sidecar already opened, without opening one. */
  function joinGithubDetailBatch(coords: unknown): Promise<GithubDetailBatch> {
    const key = coordsKey(coords);
    if (!key) return Promise.resolve(null);
    return githubDetailBatches.get<GithubDetailBatch>(key) ?? Promise.resolve(null);
  }

  /** Join the open batch for these coordinates, or start one. */
  function openGithubDetailBatch(coords: unknown): Promise<GithubDetailBatch> {
    const key = coordsKey(coords);
    if (!key) return Promise.resolve(null);
    if (!commands.hasAction("prs.getMobileGithubDetail")) return joinGithubDetailBatch(coords);
    return githubDetailBatches.coalesce<GithubDetailBatch>(
      key,
      () => commands
        .call<GithubDetailBatch>("prs.getMobileGithubDetail", asRecord(coords), {
          fallback: null,
          idempotent: true,
        })
        // Resolving null keeps each sidecar on its own per-part fallback rather
        // than failing them all together.
        .catch(() => null),
      // Detail data is live GitHub state, so hold a batch only long enough to
      // serve the sidecars that open with it — and never hold a failed one.
      { cacheResult: (snapshot) => snapshot != null },
    );
  }

  /**
   * Serve one sidecar from the batch, falling back to its own command when the
   * host has no batched action, the batch failed, or the host flagged that part
   * as unavailable — an empty array from a failed part must never be presented
   * as a true zero.
   */
  function batchedGithubRead<T>(
    part: string,
    action: string,
    pick: (snapshot: PrMobileGithubDetailSnapshot) => T | null,
    fallback: T,
    options: { joinOnly?: boolean } = {},
  ) {
    return async (coords: unknown): Promise<T> => {
      const snapshot = options.joinOnly
        ? await joinGithubDetailBatch(coords)
        : await openGithubDetailBatch(coords);
      if (snapshot && !snapshot.unavailableParts.includes(part)) {
        const value = pick(snapshot);
        // A null part falls through to the per-part command. Whether the host
        // means "absent" or "genuinely null" here is unconfirmed, so this keeps
        // the existing behaviour rather than guessing.
        if (value != null) return value;
      }
      return await call<T>(action, coords, fallback);
    };
  }

  infra.addDispose(
    events.on("prsInvalidated", (event) => {
      invalidatePrsReads();
      // `prs-updated` is authoritative in PrsContext; never represent a stale
      // cache marker as an empty PR list. Hydrate one coalesced list read and
      // emit only when the host actually answered.
      void listPrs({ surfaceErrors: true }).then((prs) => {
        events.emit("prsEvent", {
          type: "prs-updated",
          polledAt: event.at,
          prs,
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
      assertWebRuntimePinRoutable("prs.getForLane", pin, infra);
      return (await listPrs()).find((pr) => pr.laneId === laneId) ?? null;
    },
    // Manual ⟳ PR-sync (ChatGitToolbar) — force a fresh reconcile for one lane.
    // Mirrors the preload runtime action `pr.syncLanePr` (single positional
    // laneId); the sync command layer marshals a named record, exactly like the
    // `prs.getForLane` host handler that reads `{ laneId }`. It mutates, so the
    // read cache is dropped afterward like `refresh` does.
    syncLanePr: async (laneId: string, pin?: unknown) => {
      assertWebRuntimePinRoutable("prs.syncLanePr", pin, infra);
      const result = await call<PrSummary | null>("prs.syncLanePr", { laneId }, null, false);
      invalidatePrsReads();
      return result;
    },
    // Force a global PR reconcile. Routes to the same daemon action the preload
    // uses (`pr.reconcileOnFocus` with `{ force: true }`).
    reconcileNow: async () => {
      await call("prs.reconcileOnFocus", { force: true }, undefined, false);
      invalidatePrsReads();
    },
    listAll: async (pin?: unknown) => {
      assertWebRuntimePinRoutable("prs.listAll", pin, infra);
      return await listPrs();
    },
    listOpenForRepo: () => read("prs.listOpenForRepo", {}, []),
    refresh: async (args?: unknown, pin?: unknown) => {
      assertWebRuntimePinRoutable("prs.refresh", pin, infra);
      const result = await call<unknown>("prs.refresh", args, [], false);
      invalidatePrsReads();
      return arrayField<PrSummary>(result, "prs");
    },
    getStatus: (prId: string, pin?: unknown) => {
      assertWebRuntimePinRoutable("prs.getStatus", pin, infra);
      return read("prs.getStatus", { prId }, null);
    },
    getChecks: (prId: string, pin?: unknown) => {
      assertWebRuntimePinRoutable("prs.getChecks", pin, infra);
      return read("prs.getChecks", { prId }, []);
    },
    getComments: (prId: string, pin?: unknown) => {
      assertWebRuntimePinRoutable("prs.getComments", pin, infra);
      return read("prs.getComments", { prId }, []);
    },
    getReviews: (prId: string, pin?: unknown) => {
      assertWebRuntimePinRoutable("prs.getReviews", pin, infra);
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
      // With analysis off this is a bare DB read host-side; only the analysed
      // form pays for the per-lane merge-tree sweep.
      if (commands.hasAction("prs.listWithConflicts") || asRecord(args).includeConflictAnalysis === true) {
        return await read<PrWithConflicts[]>("prs.listWithConflicts", args, []);
      }
      // Older host: the unanalysed shape is the list with a null analysis.
      return (await listPrs()).map((pr) => ({
        ...pr,
        conflictAnalysis: null,
      }));
    },
    listSnapshots: (args?: unknown) => read("prs.listSnapshots", args, []),
    getGitHubSnapshot: (args?: unknown) => read("prs.getGitHubSnapshot", args, null),
    listGitHubStacks: (args?: unknown) => read("prs.listGithubStacks", args, []),
    syncGitHubStacks: async (args?: unknown) => {
      const result = await call("prs.syncGithubStacks", args, [], false);
      invalidatePrsReads();
      return result;
    },
    createGitHubStack: async (args: unknown) => {
      const result = await call("prs.createGithubStack", args, null, false);
      invalidatePrsReads();
      return result;
    },
    addGitHubStackPullRequests: async (args: unknown) => {
      const result = await call("prs.addGithubStackPullRequests", args, null, false);
      invalidatePrsReads();
      return result;
    },
    unstackGitHubStack: async (args: unknown) => {
      const result = await call("prs.unstackGithubStack", args, null, false);
      invalidatePrsReads();
      return result;
    },
    listIntegrationWorkflows: (args?: unknown) => call("prs.listIntegrationWorkflows", args, []),
    onEvent: (listener: (event: unknown) => void, pin?: unknown) => {
      assertWebRuntimePinRoutable("prs.onEvent", pin, infra);
      return events.on("prsEvent", listener as never);
    },
    getDetail: (prId: string) => read("prs.getDetail", { prId }, null),
    getFiles: (prId: string) => read("prs.getFiles", { prId }, []),
    getCommits: (prId: string) => read("prs.getCommits", { prId }, []),
    getActionRuns: (prId: string) => read("prs.getActionRuns", { prId }, []),
    getActivity: (prId: string) => read("prs.getActivity", { prId }, []),
    getWorkflowGraph: (args: unknown) => read("prs.getWorkflowGraph", args, null),
    getCheckLog: (args: unknown) => read("prs.getCheckLog", args, null),
    getDetailByGithub: batchedGithubRead("detail", "prs.getDetailByGithub", (s) => s.snapshot.detail, null),
    getFilesByGithub: batchedGithubRead("files", "prs.getFilesByGithub", (s) => s.snapshot.files, []),
    getCommitsByGithub: batchedGithubRead("commits", "prs.getCommitsByGithub", (s) => s.snapshot.commits, []),
    getActionRunsByGithub: batchedGithubRead("action_runs", "prs.getActionRunsByGithub", (s) => s.actionRuns, []),
    getActivityByGithub: batchedGithubRead("activity", "prs.getActivityByGithub", (s) => s.activity, []),
    getStatusByGithub: batchedGithubRead(
      "status",
      "prs.getStatusByGithub",
      (s) => s.snapshot.status,
      null,
      { joinOnly: true },
    ),
    getChecksByGithub: batchedGithubRead("checks", "prs.getChecksByGithub", (s) => s.snapshot.checks, []),
    getReviewsByGithub: batchedGithubRead("reviews", "prs.getReviewsByGithub", (s) => s.snapshot.reviews, []),
    getCommentsByGithub: batchedGithubRead("comments", "prs.getCommentsByGithub", (s) => s.snapshot.comments, []),
    getReviewThreadsByGithub: batchedGithubRead(
      "review_threads",
      "prs.getReviewThreadsByGithub",
      (s) => s.reviewThreads,
      [],
    ),
    // Mutates the GitHub thread the detail batch caches, so drop it.
    addComment: async (args: unknown) => {
      const result = await call("prs.addComment", args, null, false);
      invalidatePrsReads();
      return result;
    },
    // Mutates the GitHub thread the detail batch caches, so drop it.
    updateComment: async (args: unknown) => {
      const result = await call("prs.updateComment", args, null, false);
      invalidatePrsReads();
      return result;
    },
    // Mutates the GitHub thread the detail batch caches, so drop it.
    replyToReviewThread: async (args: unknown) => {
      const result = await call("prs.replyToReviewThread", args, null, false);
      invalidatePrsReads();
      return result;
    },
    // Mutates the GitHub thread the detail batch caches, so drop it — same as
    // the comment writes above.
    resolveReviewThread: async (args: unknown) => {
      await call("prs.resolveReviewThread", args, undefined, false);
      invalidatePrsReads();
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
