import type {
  ListGitHubPrFilterOptionsResult,
  SearchGitHubPrsResult,
  SetPrAssigneesResult,
  PrMobileGithubDetailSnapshot,
  PrMobileSnapshot,
  PrDetailBundle,
  PrSummary,
  PrWithConflicts,
  StackLinkOffer,
} from "../../../shared/types";
import { EMPTY_PR_DETAIL_BUNDLE, settlePrDetailBundle } from "../../../shared/prDetailBundle";
import type { PrChatWatchSummary } from "../../../shared/prWatch";
import type { ResolvePrMediaResult } from "../../../shared/githubMedia";
import type { AdapterInfra, AdeNamespace } from "./types";
import { createCoalescingReadCache } from "./infra/coalescingReadCache";
import { unavailableOnHost } from "./misc";
import { assertWebRuntimePinRoutable, guardPinnedMembers, type RuntimePinArg } from "./runtimePinGuard";

const READ_CACHE_TTL_MS = 3_000;

// The desktop contract's trailing runtime pin for these calls names the
// machine/project that owns the PR or chat. The web adapter is bound to one
// machine and project, so it can serve a matching pin as-is and must reject a
// different target rather than silently using its bound project. Keep this in
// sync with the pin-bearing methods in preload/global.d.ts.
const PINNED_METHOD_ARG_INDEX: Record<string, number> = {
  preflightCreateLaneFromPrBranch: 1,
  createLaneFromPrBranch: 1,
  getForLane: 1,
  syncLanePr: 1,
  reconcileNow: 0,
  reconcileOnFocus: 0,
  listAll: 0,
  listAllConditional: 1,
  refresh: 1,
  getStatus: 1,
  getChecks: 1,
  getComments: 1,
  getReviews: 1,
  getReviewThreads: 1,
  delete: 1,
  land: 1,
  updateBranch: 1,
  listSnapshots: 1,
  linkChatSession: 1,
  unlinkChatSession: 1,
  setChatWatch: 1,
  getChatWatches: 1,
  resolveMedia: 1,
  linkChatStack: 1,
  listChatSessionsForPr: 1,
  getStackLinkOffer: 1,
  onEvent: 1,
  getDetail: 1,
  getFiles: 1,
  getCommits: 1,
  getActionRuns: 1,
  getActivity: 1,
  addComment: 1,
  updateTitle: 1,
  updateBody: 1,
  setLabels: 1,
  setAssignees: 1,
  listGitHubFilterOptions: 1,
  searchGitHubPrs: 1,
  requestReviewers: 1,
  submitReview: 1,
  close: 1,
  reopen: 1,
  setDraft: 1,
  setAutoMerge: 1,
  rerunChecks: 1,
  getDeployments: 1,
  reactToComment: 1,
  cleanupBranch: 1,
};

export function createPrsNamespace(infra: AdapterInfra): AdeNamespace<"prs"> {
  const { commands, events } = infra;
  // A read carries a fallback; a mutation has none — its fallback could never
  // be resolved — so the two shapes stay disjoint at the wrapper too.
  const mutation = { idempotent: false } as const;

  const emptyMobileSnapshot = (): PrMobileSnapshot => ({
    generatedAt: new Date().toISOString(),
    prs: [],
    stacks: [],
    workflowCards: [],
    capabilities: {},
    createCapabilities: { canCreateAny: false, defaultBaseBranch: null, lanes: [] },
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
    return idempotent
      ? commands.call<T>(action, asRecord(args), { fallback })
      : commands.call<T>(action, asRecord(args), mutation);
  }

  function read<T>(action: string, args: unknown, fallback: T): Promise<T> {
    return commands.call<T>(action, asRecord(args), { fallback, cacheTtlMs: READ_CACHE_TTL_MS });
  }

  async function getDetailBundle(prId: string): Promise<PrDetailBundle> {
    if (commands.hasAction("prs.getDetailBundle")) {
      return await read<PrDetailBundle>("prs.getDetailBundle", { prId }, EMPTY_PR_DETAIL_BUNDLE);
    }
    return settlePrDetailBundle({
      status: () => read<PrDetailBundle["status"]>("prs.getStatus", { prId }, null),
      checks: () => read<PrDetailBundle["checks"]>("prs.getChecks", { prId }, []),
      reviews: () => read<PrDetailBundle["reviews"]>("prs.getReviews", { prId }, []),
      comments: () => read<PrDetailBundle["comments"]>("prs.getComments", { prId }, []),
    });
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
    getForLane: async (laneId: string, pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.getForLane", pin, infra);
      // Prefer the host's own answer: it prefers the current-branch PR, and it
      // answers null for a primary lane parked on its base branch — the exact
      // contract every lane link is written against (the local fallback can
      // only approximate it by recency, and would still name the ancient PR).
      if (commands.hasAction("prs.getForLane")) {
        return await read<PrSummary | null>("prs.getForLane", { laneId }, null);
      }
      return (await listPrs()).find((pr) => pr.laneId === laneId) ?? null;
    },
    // Manual ⟳ PR-sync (ChatGitToolbar) — force a fresh reconcile for one lane.
    // Mirrors the preload runtime action `pr.syncLanePr` (single positional
    // laneId); the sync command layer marshals a named record, exactly like the
    // `prs.getForLane` host handler that reads `{ laneId }`. It mutates, so the
    // read cache is dropped afterward like `refresh` does.
    syncLanePr: async (laneId: string, pin?: RuntimePinArg) => {
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
    reconcileOnFocus: async (pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.reconcileOnFocus", pin, infra);
      await call("prs.reconcileOnFocus", {}, undefined, false);
      invalidatePrsReads();
    },
    listAll: async (pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.listAll", pin, infra);
      return await listPrs();
    },
    listOpenForRepo: () => read("prs.listOpenForRepo", {}, []),
    refresh: async (args?: unknown, pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.refresh", pin, infra);
      const result = await call<unknown>("prs.refresh", args, [], false);
      invalidatePrsReads();
      return arrayField<PrSummary>(result, "prs");
    },
    getStatus: async (prId: string, pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.getStatus", pin, infra);
      return await read("prs.getStatus", { prId }, null);
    },
    getChecks: async (prId: string, pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.getChecks", pin, infra);
      return await read("prs.getChecks", { prId }, []);
    },
    getComments: async (prId: string, pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.getComments", pin, infra);
      return await read("prs.getComments", { prId }, []);
    },
    getReviews: async (prId: string, pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.getReviews", pin, infra);
      return await read("prs.getReviews", { prId }, []);
    },
    getReviewThreads: (prId: string) => read("prs.getReviewThreads", { prId }, []),
    delete: (args: unknown) => call("prs.delete", args, { ok: false, error: "unsupported" }, false),
    land: (args: unknown) => call("prs.land", args, null, false),
    updateBranch: (args: unknown) => call("prs.updateBranch", args, null, false),
    openInGitHub: async (prId: string) => {
      if (/^https?:\/\//.test(prId) && typeof window !== "undefined") window.open(prId, "_blank", "noopener,noreferrer");
    },
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
    linkChatSession: async (args: unknown) => {
      const result = await call("prs.linkChatSession", args, { ok: false }, false);
      invalidatePrsReads();
      return result;
    },
    unlinkChatSession: async (args: unknown) => {
      const result = await call("prs.unlinkChatSession", args, { ok: false }, false);
      invalidatePrsReads();
      return result;
    },
    linkChatStack: async (args: unknown) => {
      if (commands.hasAction("prs.linkChatStack")) {
        const result = await call("prs.linkChatStack", args, { ok: false, linked: 0 }, false);
        invalidatePrsReads();
        return result;
      }
      // Old-host shim: a host predating `prs.linkChatStack` has no server-side
      // stack-link action, so the adapter re-derives "unclaimed siblings, roll
      // back on failure" from the offer. Keep it a thin per-PR loop — the offer
      // is the owner; do not grow policy here.
      const record = asRecord(args);
      const sessionId = String(record.sessionId ?? "");
      const stackNumber = Number(record.stackNumber);
      const offer = await read<StackLinkOffer | null>(
        "prs.getStackLinkOffer",
        { sessionId, prId: record.prId },
        null,
      );
      if (!offer || offer.stackNumber !== stackNumber) return { ok: false, linked: 0 };
      const unclaimed = offer.siblings.filter((sibling) => !sibling.claimedByOtherChat);
      const linkedIds: string[] = [];
      for (const sibling of unclaimed) {
        const result = await call<{ ok: boolean }>("prs.linkChatSession", {
          prId: sibling.prId,
          sessionId: offer.sessionId,
          allowCrossLane: true,
        }, { ok: false }, false);
        if (!result.ok) {
          for (const prId of [...linkedIds].reverse()) {
            // `dismiss: false`: these were linked by this attempt, and the offer
            // only lists siblings this chat had not unlinked, so nothing needs
            // its tombstone restored. Match the server's failure shape.
            await call<{ ok: boolean }>("prs.unlinkChatSession", {
              prId,
              sessionId: offer.sessionId,
              dismiss: false,
            }, { ok: false }, false);
          }
          invalidatePrsReads();
          return { ok: false, linked: 0 };
        }
        linkedIds.push(sibling.prId);
      }
      invalidatePrsReads();
      return { ok: true, linked: linkedIds.length };
    },
    listChatSessionsForPr: (args: unknown) => read("prs.listChatSessionsForPr", args, []),
    setChatWatch: async (args: unknown) => {
      // A host without PR Watch must say so; a null result reads as "turned off".
      if (!commands.hasAction("prs.setChatWatch")) throw new Error("This machine's ADE does not have PR Watch yet. Update it to use Watch and Ship.");
      const result = await call<PrChatWatchSummary | null>("prs.setChatWatch", args, null, false);
      invalidatePrsReads();
      return result;
    },
    getChatWatches: (args: unknown) => read("prs.getChatWatches", args, []),
    // An older host has no resolver: the picture keeps its own fallback.
    resolveMedia: async (args: unknown, pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.resolveMedia", pin, infra);
      const unavailable = { status: "unavailable" as const, reason: "github_error" as const };
      if (!commands.hasAction("prs.resolveMedia")) return unavailable;
      return await read<ResolvePrMediaResult>("prs.resolveMedia", args, unavailable);
    },
    getStackLinkOffer: (args: unknown) => read("prs.getStackLinkOffer", args, null),
    onEvent: (listener: (event: unknown) => void, pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.onEvent", pin, infra);
      return events.on("prsEvent", listener as never);
    },
    getDetail: (prId: string) => read("prs.getDetail", { prId }, null),
    getDetailBundle,
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
    replyToReviewThread: async (args: unknown) => {
      const result = await call("prs.replyToReviewThread", args, null, false);
      invalidatePrsReads();
      return result;
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
    // A host without these must say so, so the GitHub tab falls back to loaded
    // rows (and read-only assignees) instead of reading an empty answer.
    setAssignees: async (args: unknown, pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.setAssignees", pin, infra);
      if (!commands.hasAction("prs.setAssignees")) throw new Error("This machine's ADE cannot assign people yet. Update it to edit assignees.");
      // A mutation has no fallback: the host's own answer or a rejection, so
      // the card keeps its draft when no project is open on that machine.
      const result = await commands.call<SetPrAssigneesResult>("prs.setAssignees", asRecord(args), mutation);
      invalidatePrsReads();
      return result;
    },
    listGitHubFilterOptions: async (args: unknown, pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.listGitHubFilterOptions", pin, infra);
      if (!commands.hasAction("prs.listGitHubFilterOptions")) throw new Error("This machine's ADE cannot search GitHub filters yet.");
      return await read<ListGitHubPrFilterOptionsResult>("prs.listGitHubFilterOptions", args, {
        kind: "label",
        query: "",
        options: [],
        complete: false,
      });
    },
    searchGitHubPrs: async (args: unknown, pin?: RuntimePinArg) => {
      assertWebRuntimePinRoutable("prs.searchGitHubPrs", pin, infra);
      if (!commands.hasAction("prs.searchGitHubPrs")) throw new Error("This machine's ADE cannot search GitHub yet.");
      return await call<SearchGitHubPrsResult>("prs.searchGitHubPrs", args, {
        items: [],
        totalCount: 0,
        nextCursor: null,
        query: "",
        error: { kind: "failed", message: "GitHub search is unavailable." },
      });
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
    setDraft: async (args: unknown) => {
      await call("prs.setDraft", args, undefined, false);
    },
    setAutoMerge: async (args: unknown) => {
      await call("prs.setAutoMerge", args, undefined, false);
    },
    rerunChecks: async (args: unknown) => {
      await call("prs.rerunChecks", args, undefined, false);
    },
    getDeployments: (prId: string) => call("prs.getDeployments", { prId }, []),
    postReviewComment: (args: unknown) => call("prs.postReviewComment", args, null, false),
    setReviewThreadResolved: (args: unknown) => call("prs.setReviewThreadResolved", args, null, false),
    reactToComment: async (args: unknown) => {
      await call("prs.reactToComment", args, undefined, false);
    },
    cleanupBranch: (args: unknown) => call("prs.cleanupBranch", args, { ok: false, error: "unsupported" }, false),
  };

  return guardPinnedMembers(prs, "prs", PINNED_METHOD_ARG_INDEX, infra) as AdeNamespace<"prs">;
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
