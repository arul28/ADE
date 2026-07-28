import type {
  ArchiveAndReclaimLaneResult,
  LaneLifecycleEvent,
  LaneListSnapshot,
  ResolveLaneBranchDriftResult,
  RestoreLaneResult,
} from "../../../shared/types";
import type { AdapterInfra, AdeNamespace } from "./types";

export function createLanesNamespace(infra: AdapterInfra): AdeNamespace<"lanes"> {
  const { commands, events } = infra;

  function call<T>(action: string, args: unknown, fallback: T, idempotent = true): Promise<T> {
    return commands.call<T>(action, asRecord(args), { fallback, idempotent });
  }

  function emitLifecycle(event: LaneLifecycleEvent): void {
    events.emit("lanesLifecycle", event);
  }

  infra.addDispose(
    events.on("lanesInvalidated", (event) => {
      commands.invalidateCache(["lanes.list", "lanes.refreshSnapshots"]);
      events.emit("lanesLifecycle", {
        type: "lane-archived",
        laneId: "__ade_web_invalidation__",
        laneName: "Lanes changed",
      });
      events.emit("rebaseInvalidated", event);
    })
  );

  const lanes: Record<string, unknown> = {
    list: (args?: unknown) => commands.call("lanes.list", asRecord(args), {
      fallback: [],
      idempotent: true,
      cacheTtlMs: 3_000,
    }),
    listSnapshots: async (args?: unknown) => {
      const result = await call<unknown>("lanes.refreshSnapshots", args, []);
      return arrayField<LaneListSnapshot>(result, "snapshots");
    },
    create: async (args: unknown) => {
      const result = await call("lanes.create", args, null, false);
      if (result && typeof result === "object") emitLifecycle(lifecycleFromLane("lane-created", result));
      return result;
    },
    createChild: async (args: unknown) => {
      const result = await call("lanes.createChild", args, null, false);
      if (result && typeof result === "object") emitLifecycle(lifecycleFromLane("lane-created", result));
      return result;
    },
    createFromUnstaged: async (args: unknown) => {
      const result = await call("lanes.createFromUnstaged", args, null, false);
      if (result && typeof result === "object") emitLifecycle(lifecycleFromLane("lane-created", result));
      return result;
    },
    importBranch: async (args: unknown) => {
      const result = await call("lanes.importBranch", args, null, false);
      if (result && typeof result === "object") emitLifecycle(lifecycleFromLane("lane-created", result));
      return result;
    },
    previewBranchSwitch: (args: unknown) => call("lanes.previewBranchSwitch", args, null),
    switchBranch: (args: unknown) => call("lanes.switchBranch", args, { ok: false, error: "unsupported" }, false),
    getBranchDrift: (args: unknown) => call("lanes.getBranchDrift", args, null),
    // The drift strip treats a resolved promise as "drift handled": it disarms
    // the warning and refreshes. A host that cannot run this must therefore
    // reject, not hand back a status object nobody reads.
    resolveBranchDrift: (args: unknown) =>
      commands.call<ResolveLaneBranchDriftResult>("lanes.resolveBranchDrift", asRecord(args), {
        fallback: () => {
          throw new Error("Resolving branch drift is unavailable on the connected ADE host.");
        },
        idempotent: false,
      }),
    attach: (args: unknown) => call("lanes.attach", args, null, false),
    listUnregisteredWorktrees: () => call("lanes.listUnregisteredWorktrees", {}, []),
    adoptAttached: (args: unknown) => call("lanes.adoptAttached", args, null, false),
    rename: async (args: unknown) => {
      await call("lanes.rename", args, undefined, false);
    },
    reparent: (args: unknown) => call("lanes.reparent", args, { ok: false, error: "unsupported" }, false),
    updateAppearance: async (args: unknown) => {
      await call("lanes.updateAppearance", args, undefined, false);
    },
    archive: async (args: unknown) => {
      await call("lanes.archive", args, undefined, false);
      const record = asRecord(args);
      emitLifecycle({
        type: "lane-archived",
        laneId: stringField(record, "laneId"),
        laneName: stringField(record, "laneName") || stringField(record, "name") || "Lane",
      });
    },
    archiveAndReclaim: (args: unknown) =>
      commands.call<ArchiveAndReclaimLaneResult>("lanes.archiveAndReclaim", asRecord(args), {
        fallback: () => {
          throw new Error("Archive & Reclaim is unavailable on the connected ADE host.");
        },
        idempotent: false,
      }),
    unarchive: (args: unknown) =>
      commands.call<RestoreLaneResult>("lanes.unarchive", asRecord(args), {
        fallback: () => {
          throw new Error("Restoring a reclaimed lane is unavailable on the connected ADE host.");
        },
        idempotent: false,
      }),
    delete: async (args: unknown) => {
      await call("lanes.delete", args, undefined, false);
      const record = asRecord(args);
      emitLifecycle({
        type: "lane-deleted",
        laneId: stringField(record, "laneId"),
        laneName: stringField(record, "laneName") || stringField(record, "name") || "Lane",
      });
    },
    cancelDelete: (args: unknown) => call("lanes.cancelDelete", args, { cancelled: false, reason: "unsupported" }, false),
    listDeleteProgress: () => call("lanes.listDeleteProgress", {}, []),
    getDeleteRisk: (args: unknown) =>
      call("lanes.getDeleteRisk", args, {
        laneId: stringField(asRecord(args), "laneId"),
        branchRef: null,
        dirty: false,
        hasUnpushedCommits: false,
        unpushedCommitCount: 0,
        remoteBranchExists: false,
        activeChatCount: 0,
        activePtyCount: 0,
        activeWatcherCount: 0,
        envInitialized: false,
      }),
    getReclaimRisk: (args: unknown) =>
      call("lanes.getReclaimRisk", args, {
        laneId: stringField(asRecord(args), "laneId"),
        laneName: "Lane",
        branchRef: null,
        worktreePath: "",
        dirty: false,
        hasUnpushedCommits: false,
        unpushedCommitCount: 0,
        remoteBranchExists: false,
        activeChatCount: 0,
        activePtyCount: 0,
        activeWatcherCount: 0,
        envInitialized: false,
        worktreeBytes: 0,
        generatedBytes: 0,
        reclaimableBytes: 0,
        worktreeAvailable: false,
        blockedReasons: [],
        lastFailure: null,
        retryCount: 0,
      }),
    getStackChain: (laneId: string) => call("lanes.getStackChain", { laneId }, []),
    getChildren: (laneId: string) => call("lanes.getChildren", { laneId }, []),
    attachLinearIssueToSession: (args: unknown) => call("lanes.attachLinearIssueToSession", args, [], false),
    detachLinearIssueFromSession: (args: unknown) => call("lanes.detachLinearIssueFromSession", args, false, false),
    listLinearIssuesForSession: (args: unknown) => call("lanes.listLinearIssuesForSession", args, []),
    listLinearIssuesForLaneSessions: (args: unknown) => call("lanes.listLinearIssuesForLaneSessions", args, []),
    unlinkLinearIssues: (args: unknown) => call("lanes.unlinkLinearIssues", args, false, false),
    rebaseStart: (args: unknown) => call("lanes.rebaseStart", args, { ok: false, error: "unsupported" }, false),
    rebasePush: (args: unknown) => call("lanes.rebasePush", args, null, false),
    rebaseRollback: (args: unknown) => call("lanes.rebaseRollback", args, null, false),
    rebaseAbort: (args: unknown) => call("lanes.rebaseAbort", args, null, false),
    listRebaseSuggestions: () => call("lanes.listRebaseSuggestions", {}, []),
    dismissRebaseSuggestion: async (args: unknown) => {
      await call("lanes.dismissRebaseSuggestion", args, undefined, false);
    },
    deferRebaseSuggestion: async (args: unknown) => {
      await call("lanes.deferRebaseSuggestion", args, undefined, false);
    },
    listAutoRebaseStatuses: () => call("lanes.listAutoRebaseStatuses", {}, []),
    dismissAutoRebaseStatus: async (args: unknown) => {
      await call("lanes.dismissAutoRebaseStatus", args, undefined, false);
    },
    openFolder: async () => undefined,
    initEnv: (args: unknown) => call("lanes.initEnv", args, null, false),
    getEnvStatus: (args: unknown) => call("lanes.getEnvStatus", args, null),
    getOverlay: (args: unknown) => call("lanes.getOverlay", args, {}),
    listTemplates: () => call("lanes.listTemplates", {}, []),
    getTemplate: (args: unknown) => call("lanes.getTemplate", args, null),
    getDefaultTemplate: () => call("lanes.getDefaultTemplate", {}, null),
    setDefaultTemplate: async (args: unknown) => {
      await call("lanes.setDefaultTemplate", args, undefined, false);
    },
    applyTemplate: (args: unknown) => call("lanes.applyTemplate", args, null, false),
    saveTemplate: async (args: unknown) => {
      await call("lanes.saveTemplate", args, undefined, false);
    },
    deleteTemplate: async (args: unknown) => {
      await call("lanes.deleteTemplate", args, undefined, false);
    },
    portGetLease: (args: unknown) => call("lanes.portGetLease", args, null),
    portListLeases: () => call("lanes.portListLeases", {}, []),
    portAcquire: (args: unknown) => call("lanes.portAcquire", args, null, false),
    portRelease: async (args: unknown) => {
      await call("lanes.portRelease", args, undefined, false);
    },
    portListConflicts: () => call("lanes.portListConflicts", {}, []),
    portRecoverOrphans: () => call("lanes.portRecoverOrphans", {}, [], false),
    proxyGetStatus: () => call("lanes.proxyGetStatus", {}, { running: false, routes: [] }),
    proxyStart: (args?: unknown) => call("lanes.proxyStart", args, { running: false, routes: [] }, false),
    proxyStop: async () => {
      await call("lanes.proxyStop", {}, undefined, false);
    },
    proxyAddRoute: (args: unknown) => call("lanes.proxyAddRoute", args, null, false),
    proxyRemoveRoute: async (args: unknown) => {
      await call("lanes.proxyRemoveRoute", args, undefined, false);
    },
    proxyGetPreviewInfo: (args: unknown) => call("lanes.proxyGetPreviewInfo", args, null),
    proxyOpenPreview: async (args: unknown) => {
      await call("lanes.proxyOpenPreview", args, undefined, false);
    },
    oauthGetStatus: () => call("lanes.oauthGetStatus", {}, { enabled: false }),
    oauthUpdateConfig: async (args: unknown) => {
      await call("lanes.oauthUpdateConfig", args, undefined, false);
    },
    oauthGenerateRedirectUris: (args: unknown) => call("lanes.oauthGenerateRedirectUris", args, []),
    oauthEncodeState: (args: unknown) => call("lanes.oauthEncodeState", args, ""),
    oauthDecodeState: (args: unknown) => call("lanes.oauthDecodeState", args, null),
    oauthListSessions: () => call("lanes.oauthListSessions", {}, []),
    diagnosticsGetStatus: () => call("lanes.diagnosticsGetStatus", {}, { status: "unknown" }),
    diagnosticsGetLaneHealth: (args: unknown) => call("lanes.diagnosticsGetLaneHealth", args, null),
    diagnosticsRunHealthCheck: (args: unknown) => call("lanes.diagnosticsRunHealthCheck", args, null, false),
    diagnosticsRunFullCheck: () => call("lanes.diagnosticsRunFullCheck", {}, [], false),
    diagnosticsActivateFallback: async (args: unknown) => {
      await call("lanes.diagnosticsActivateFallback", args, undefined, false);
    },
    diagnosticsDeactivateFallback: async (args: unknown) => {
      await call("lanes.diagnosticsDeactivateFallback", args, undefined, false);
    },
    onDeleteEvent: (listener: (event: unknown) => void) => events.on("lanesDelete", listener as never),
    onLifecycleEvent: (listener: (event: unknown) => void) => events.on("lanesLifecycle", listener as never),
    rebaseSubscribe: (listener: (event: unknown) => void) => events.on("rebaseEvent", listener as never),
    onRebaseSuggestionsEvent: (listener: (event: unknown) => void) => events.on("rebaseEvent", listener as never),
    onAutoRebaseEvent: (listener: (event: unknown) => void) => events.on("rebaseEvent", listener as never),
    onEnvEvent: () => () => {},
    onPortEvent: () => () => {},
    onProxyEvent: () => () => {},
    onOAuthEvent: () => () => {},
    onDiagnosticsEvent: () => () => {},
  };

  return lanes as AdeNamespace<"lanes">;
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function arrayField<T>(result: unknown, key: string): T[] {
  if (Array.isArray(result)) return result as T[];
  if (!result || typeof result !== "object") return [];
  const value = (result as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function lifecycleFromLane(type: LaneLifecycleEvent["type"], lane: object): LaneLifecycleEvent {
  const record = lane as Record<string, unknown>;
  return {
    type,
    laneId: stringField(record, "id") || stringField(record, "laneId"),
    laneName: stringField(record, "name") || stringField(record, "laneName") || stringField(record, "branchRef") || "Lane",
    color: (record.color as string | null | undefined) ?? null,
    lane: lane as LaneLifecycleEvent["lane"],
  };
}
