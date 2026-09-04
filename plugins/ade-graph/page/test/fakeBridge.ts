/**
 * A scripted `window.adePlugin`, and a log of everything the page asked it.
 *
 * The seam test's whole point is that the plugin and its page are now two
 * programs joined by a named contract. This fake IS that contract, written out:
 * every action id the page may invoke, with the answer the child would give. A
 * page that calls an id this file does not script fails the test rather than
 * finding a helpful stub — which is the only way the test can prove the seam,
 * instead of proving that the page renders.
 *
 * It also stubs the three verbs the platform batch of this wave adds and no
 * shipped host has yet — `bridge.sockets`, `ui.openPathInEditor` and
 * `ui.pickLane` — so the page side of each MISSING contract is exercised here
 * rather than waiting on the host that will answer it.
 */

import type {
  AdePluginBridge,
  PluginWebviewChangeEvent,
  PluginWebviewConfirm,
  PluginWebviewContext,
  PluginWebviewEditorTarget,
  PluginWebviewHostEvent,
  PluginWebviewSocketEntry,
  PluginWebviewThemeSnapshot,
  PluginWebviewToast,
} from "../src/bridge";
import type {
  AutoRebaseLaneStatus,
  BatchAssessmentResult,
  GitUpstreamSyncStatus,
  IntegrationProposal,
  LaneSummary,
  OperationRecord,
  PrWithConflicts,
} from "../src/lib/types";

/** One thing the page asked the host for. */
export type BridgeCall = { method: string; args: Record<string, unknown> };

export type FakeBridge = {
  bridge: AdePluginBridge;
  /** Every call, in order. `invoke` is logged as `invoke:<action>`. */
  calls: BridgeCall[];
  callsTo: (method: string) => BridgeCall[];
  lastCall: (method: string) => BridgeCall | undefined;
  /** Replace one action's answer mid-walk. */
  setAction: (action: string, handler: (args: Record<string, unknown>) => unknown) => void;
  /** Push a `changed`, `theme` or `host` frame at the page. */
  emit: (event: "changed" | "theme" | "host" | "refresh", payload: unknown) => void;
  /** The lanes the scripted child answers `pageLanes` with. Mutable per test. */
  lanes: LaneSummary[];
  /** Whether `ui.pickLane` answers, and with what. Null = the reader dismissed. */
  pickLaneAnswer: { laneId: string } | null;
  setPickLaneAnswer: (answer: { laneId: string } | null) => void;
};

export function fakeLane(overrides: Partial<LaneSummary> & Pick<LaneSummary, "id" | "name">): LaneSummary {
  return {
    description: null,
    laneType: "worktree",
    baseRef: "refs/heads/main",
    branchRef: `refs/heads/${overrides.name}`,
    worktreePath: `/repo/.ade/worktrees/${overrides.name}`,
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 1,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-09-01T10:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

export const PRIMARY_LANE = fakeLane({
  id: "lane-main",
  name: "main",
  laneType: "primary",
  parentLaneId: null,
  childCount: 2,
  stackDepth: 0,
});

export const CHILD_LANE = fakeLane({
  id: "lane-feature",
  name: "feature-a",
  parentLaneId: "lane-main",
  stackDepth: 1,
});

export const GRANDCHILD_LANE = fakeLane({
  id: "lane-nested",
  name: "feature-a-fix",
  parentLaneId: "lane-feature",
  stackDepth: 2,
});

export function fakePr(overrides: Partial<PrWithConflicts> = {}): PrWithConflicts {
  return {
    id: "pr-1",
    laneId: "lane-feature",
    projectId: "project-1",
    repoOwner: "acme",
    repoName: "ade",
    githubPrNumber: 42,
    githubUrl: "https://github.com/acme/ade/pull/42",
    title: "Port the graph to the page tier",
    state: "open",
    baseBranch: "refs/heads/main",
    headBranch: "refs/heads/feature-a",
    checksStatus: "passing",
    checksReason: null,
    reviewStatus: "requested",
    additions: 120,
    deletions: 18,
    lastSyncedAt: "2026-09-02T10:30:00.000Z",
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-02T10:30:00.000Z",
    ...overrides,
  };
}

/** One contributed graph node, in the shape `bridge.sockets.list` answers. */
export function fakeSocketEntry(
  overrides: Partial<PluginWebviewSocketEntry> & { data?: Record<string, unknown> } = {},
): PluginWebviewSocketEntry {
  return {
    socketId: "tracker:node:lane-feature",
    pluginId: "tracker",
    socket: "graph-node",
    label: "ADE-1",
    icon: "kanban",
    ...overrides,
    data: {
      label: "ADE-1",
      detail: "In progress",
      tone: "accent",
      actionId: "openIssue",
      entityKind: "lane",
      entityId: "lane-feature",
      pluginName: "Tracker",
      accent: "#7C6FF0",
      ...(overrides.data ?? {}),
    },
  };
}

const EMPTY_ASSESSMENT: BatchAssessmentResult = {
  lanes: [],
  matrix: [],
  overlaps: [],
  computedAt: "2026-09-02T10:00:00.000Z",
};

export function installFakeBridge(options: {
  lanes?: LaneSummary[];
  prs?: PrWithConflicts[];
  proposals?: IntegrationProposal[];
  operations?: OperationRecord[];
  socketEntries?: PluginWebviewSocketEntry[];
  assessment?: BatchAssessmentResult;
  context?: Partial<PluginWebviewContext>;
  /** Omit `sockets` entirely, to exercise the older-host path. */
  withoutSockets?: boolean;
  /** Omit `ui.pickLane`, to exercise the older-host typed-id fallback. */
  withoutPickLane?: boolean;
} = {}): FakeBridge {
  const state = {
    lanes: options.lanes ?? [PRIMARY_LANE, CHILD_LANE, GRANDCHILD_LANE],
    pickLaneAnswer: null as { laneId: string; name?: string } | null,
  };
  const prs = options.prs ?? [];
  const proposals = options.proposals ?? [];
  const operations = options.operations ?? [];
  const socketEntries = options.socketEntries ?? [];
  const assessment = options.assessment ?? EMPTY_ASSESSMENT;

  const calls: BridgeCall[] = [];
  const listeners: Record<string, Set<(payload: unknown) => void>> = {
    changed: new Set(),
    theme: new Set(),
    host: new Set(),
    refresh: new Set(),
  };

  const syncByLaneId: Record<string, GitUpstreamSyncStatus | null> = {};
  for (const lane of state.lanes) {
    syncByLaneId[lane.id] = {
      hasUpstream: true,
      upstreamState: "tracking",
      upstreamRef: `origin/${lane.name}`,
      ahead: 0,
      behind: 0,
      diverged: false,
      recommendedAction: "none",
    };
  }
  const autoRebase: AutoRebaseLaneStatus[] = [];

  /**
   * Every id the page may invoke, and nothing more.
   *
   * An id missing from this table throws by name, which is the assertion: the
   * table and `page/src/host/actions.ts` are the two halves of one contract, and
   * a page that grew a call the child does not answer fails here.
   */
  const actions: Record<string, (args: Record<string, unknown>) => unknown> = {
    // Reads
    pageLanes: () => state.lanes,
    pageProjectConfig: () => ({ environments: [{ branch: "main", env: "production", color: "#22C55E" }] }),
    pagePrs: () => prs,
    pageProposals: () => proposals,
    pageSyncStatuses: () => syncByLaneId,
    pageAutoRebaseStatuses: () => autoRebase,
    pageConflictAssessment: () => assessment,
    pageConflictOverlaps: () => assessment.overlaps,
    pageRiskMatrix: () => assessment.matrix,
    pageOperations: () => operations,
    pageGraphState: () => ({ lastViewMode: "stack" }),
    pagePrDetail: (args) => {
      const pr = prs.find((entry) => entry.id === args.prId) ?? null;
      return {
        status: pr
          ? {
            prId: pr.id,
            state: pr.state,
            checksStatus: pr.checksStatus,
            reviewStatus: pr.reviewStatus,
            isMergeable: true,
            mergeConflicts: false,
            behindBaseBy: 0,
          }
          : null,
        checks: [],
        reviews: [],
        comments: [],
      };
    },

    // Mutations — every one answers {ok}, never a throw for a refusal.
    pageSaveGraphState: () => ({ ok: true }),
    pageSimulateMerge: () => ({
      ok: true,
      result: {
        outcome: "clean",
        mergedFiles: [],
        conflictingFiles: [],
        diffStat: { insertions: 3, deletions: 1, filesChanged: 2 },
      },
    }),
    pagePrepareProposal: () => ({
      ok: true,
      preview: {
        laneId: "lane-feature",
        peerLaneId: "lane-nested",
        preparedAt: "2026-09-02T10:00:00.000Z",
        contextDigest: "digest-1",
        laneExportLite: null,
        peerLaneExportLite: null,
        conflictExportStandard: null,
        files: [],
        stats: {
          fileCount: 1,
          approxChars: 100,
          laneExportChars: 10,
          peerLaneExportChars: 10,
          conflictExportChars: 80,
        },
        warnings: [],
        existingProposalId: null,
      },
    }),
    pageRequestProposal: () => ({
      ok: true,
      proposal: {
        id: "proposal-1",
        laneId: "lane-feature",
        peerLaneId: "lane-nested",
        confidence: 0.8,
        explanation: "Take both sides.",
        status: "ready",
        createdAt: "2026-09-02T10:00:00.000Z",
        updatedAt: "2026-09-02T10:00:00.000Z",
      },
    }),
    pageApplyProposal: () => ({ ok: true, proposal: { id: "proposal-1", status: "applied" } }),
    pageUndoProposal: () => ({ ok: true, proposal: { id: "proposal-1", status: "reverted" } }),
    pageSubmitReview: () => ({ ok: true, message: "Review submitted." }),
    pageLandPr: () => ({ ok: true, message: "Merged." }),
    pageCreatePr: () => ({ ok: true, prId: "pr-2" }),
    pageGitSync: () => ({ ok: true }),
    pageGitFetch: () => ({ ok: true }),
    pageGitPush: () => ({ ok: true }),
    pageReparentLane: () => ({ ok: true, previousParentLaneId: "lane-main" }),
    pageRebaseStart: () => ({ ok: true }),
    pageRenameLane: () => ({ ok: true, message: "Renamed." }),
    pageArchiveLane: () => ({ ok: true, message: "Archived." }),
    pageDeleteLane: () => ({ ok: true, message: "Deleted." }),
    pageCreateChildLane: () => ({ ok: true, laneId: "lane-new", laneName: "child" }),
    pageUpdateLaneAppearance: () => ({ ok: true }),
  };

  const record = (method: string, args: Record<string, unknown>): void => {
    calls.push({ method, args });
  };

  const bridge: AdePluginBridge = {
    version: 2,
    pluginId: "ade-graph",
    context: {
      subject: null,
      surfaceId: "graph",
      placement: "tab",
      project: { projectId: "project-1", root: "/repo", binding: "local" },
      ...options.context,
    },
    collections: {
      async get(collection, key) {
        record("collections.get", { collection, key });
        return null;
      },
      async put(collection, key, value) {
        record("collections.put", { collection, key, value });
      },
      async list(collection, listOptions) {
        record("collections.list", { collection, options: listOptions ?? {} });
        return [];
      },
    },
    async invoke(action, args) {
      record(`invoke:${action}`, args ?? {});
      const handler = actions[action];
      if (!handler) {
        throw new Error(
          `The page invoked "${action}", which the plugin does not answer.`
          + " Add it to pageActions.js, or stop calling it.",
        );
      }
      return handler(args ?? {});
    },
    config: {
      async get() {
        record("config.get", {});
        return {};
      },
      async set(key, value) {
        record("config.set", typeof key === "string" ? { key, value } : { values: key });
        return {};
      },
    },
    events: {
      on(event: string, listener: (payload: never) => void) {
        const set = listeners[event];
        if (!set) return () => {};
        set.add(listener as (payload: unknown) => void);
        return () => set.delete(listener as (payload: unknown) => void);
      },
    } as AdePluginBridge["events"],
    async openDeeplink(url) {
      record("openDeeplink", { url });
    },
    surface: {
      async close() {
        record("surface.close", {});
      },
    },
    // MISSING platform contract: `bridge.sockets`. Stubbed here so the canvas's
    // contributed-node path is exercised from the page side.
    ...(options.withoutSockets
      ? {}
      : {
        sockets: {
          async list(socket) {
            record("sockets.list", { socket });
            return socketEntries;
          },
          async invoke(socketId, args) {
            record("sockets.invoke", { socketId, ...(args ?? {}) });
            return null;
          },
        },
      }),
    ui: {
      async toast(next: PluginWebviewToast) {
        record("ui.toast", next as unknown as Record<string, unknown>);
        return { id: `toast-${calls.length}` };
      },
      async dismissToast(id: string) {
        record("ui.dismissToast", { id });
      },
      async prompt(request: unknown) {
        record("ui.prompt", { request });
        return null;
      },
      async confirm(request: PluginWebviewConfirm) {
        record("ui.confirm", request as unknown as Record<string, unknown>);
        return true;
      },
      resize(size: { height: number }) {
        record("ui.resize", size as unknown as Record<string, unknown>);
      },
      // MISSING platform contract: `ui.openPathInEditor`.
      async openPathInEditor(target: PluginWebviewEditorTarget) {
        record("ui.openPathInEditor", target as unknown as Record<string, unknown>);
      },
      // MISSING platform contract: `ui.pickLane`. Absent on an older host.
      // Null from a present picker is a dismissal, not a cue to type an id.
      ...(options.withoutPickLane
        ? {}
        : {
          async pickLane(pickOptions?: { value?: string }) {
            record("ui.pickLane", (pickOptions ?? {}) as Record<string, unknown>);
            if (!state.pickLaneAnswer) return null;
            return {
              laneId: state.pickLaneAnswer.laneId,
              name: state.pickLaneAnswer.name ?? state.pickLaneAnswer.laneId,
            };
          },
        }),
    },
    clipboard: {
      async read() {
        record("clipboard.read", {});
        return "";
      },
      async write(value: string) {
        record("clipboard.write", { text: value });
      },
    },
    theme: {
      async get() {
        record("theme.get", {});
        return { scheme: "dark", tokens: {} } as PluginWebviewThemeSnapshot;
      },
    },
    host: {
      async subscribe(subscribeOptions) {
        record("host.subscribe", subscribeOptions as unknown as Record<string, unknown>);
        return () => {};
      },
    },
  };

  (window as unknown as { adePlugin?: AdePluginBridge }).adePlugin = bridge;

  return {
    bridge,
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
    lastCall: (method) => [...calls].reverse().find((call) => call.method === method),
    setAction: (action, handler) => {
      actions[action] = handler;
    },
    emit: (event, payload) => {
      for (const listener of listeners[event] ?? []) {
        listener(payload as PluginWebviewChangeEvent & PluginWebviewThemeSnapshot & PluginWebviewHostEvent);
      }
    },
    get lanes() {
      return state.lanes;
    },
    get pickLaneAnswer() {
      return state.pickLaneAnswer;
    },
    setPickLaneAnswer: (answer) => {
      state.pickLaneAnswer = answer;
    },
  };
}

export function uninstallFakeBridge(): void {
  delete (window as unknown as { adePlugin?: AdePluginBridge }).adePlugin;
}
