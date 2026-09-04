/**
 * Everything the canvas reads, in one hook.
 *
 * The compiled page read a Zustand store (`useAppStore`) for lanes and the
 * project, and issued ten-odd `window.ade.*` calls of its own for the rest. A
 * guest has neither: the DATA comes from the plugin's own page actions and the
 * SIGNAL comes from `host.subscribe`, coalesced by the host at 120 ms.
 *
 * So this hook is the store's replacement, and it is deliberately one hook
 * rather than ten `useEffect`s inside `WorkspaceGraph`: the refetch rules — which
 * host kind invalidates which read — are a table, and a table is easier to keep
 * right in one place than spread across a 2,000-line component.
 */

import React from "react";

import * as actions from "../host/actions";
import { useHostRefresh } from "../host/refresh";
import { useHostSubscription } from "../host/useHostSubscription";
import type { PluginWebviewHostKind } from "../bridge";
import { listSocketEntries, GRAPH_NODE_SOCKET } from "../host/sockets";
import type { PluginWebviewSocketEntry } from "../bridge";
import type {
  AutoRebaseLaneStatus,
  BatchAssessmentResult,
  EnvironmentMapping,
  GitUpstreamSyncStatus,
  IntegrationProposal,
  LaneSummary,
  OperationRecord,
  PrWithConflicts,
} from "./types";

/** How many operation rows the activity score reads. The compiled page's own. */
const GRAPH_ACTIVITY_OPERATION_LIMIT = 150;

export type GraphData = {
  lanes: LaneSummary[];
  environments: EnvironmentMapping[];
  prs: PrWithConflicts[];
  proposals: IntegrationProposal[];
  syncByLaneId: Record<string, GitUpstreamSyncStatus | null>;
  autoRebaseByLaneId: Record<string, AutoRebaseLaneStatus | null>;
  batch: BatchAssessmentResult | null;
  operations: OperationRecord[];
  socketEntries: PluginWebviewSocketEntry[];
  /** The stored `lastViewMode`, once it has been read. Null until then. */
  storedState: unknown;
  loadingTopology: boolean;
  loadingRisk: boolean;
  error: string | null;
};

export type GraphDataApi = GraphData & {
  refreshLanes: () => Promise<void>;
  refreshPrs: () => Promise<void>;
  refreshRiskBatch: () => Promise<void>;
  refreshProposals: () => Promise<void>;
  refreshSync: () => Promise<void>;
  refreshOperations: () => Promise<void>;
  setError: (message: string | null) => void;
};

/** Which host kinds the graph follows. `operation` replaces the pty stream. */
export const GRAPH_HOST_KINDS: PluginWebviewHostKind[] = ["lane", "pr", "conflict", "operation"];

function message(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" && error.trim() ? error : fallback;
}

export function useGraphData(active: boolean): GraphDataApi {
  const [lanes, setLanes] = React.useState<LaneSummary[]>([]);
  const [environments, setEnvironments] = React.useState<EnvironmentMapping[]>([]);
  const [prs, setPrs] = React.useState<PrWithConflicts[]>([]);
  const [proposals, setProposals] = React.useState<IntegrationProposal[]>([]);
  const [syncByLaneId, setSyncByLaneId] = React.useState<Record<string, GitUpstreamSyncStatus | null>>({});
  const [autoRebaseByLaneId, setAutoRebaseByLaneId] = React.useState<
    Record<string, AutoRebaseLaneStatus | null>
  >({});
  const [batch, setBatch] = React.useState<BatchAssessmentResult | null>(null);
  const [operations, setOperations] = React.useState<OperationRecord[]>([]);
  const [socketEntries, setSocketEntries] = React.useState<PluginWebviewSocketEntry[]>([]);
  const [storedState, setStoredState] = React.useState<unknown>(undefined);
  const [loadingTopology, setLoadingTopology] = React.useState(true);
  const [loadingRisk, setLoadingRisk] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  /** Set once the component unmounts, so a late answer cannot set state. */
  const liveRef = React.useRef(true);
  React.useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  const refreshLanes = React.useCallback(async () => {
    try {
      const next = await actions.getLanes();
      if (!liveRef.current) return;
      setLanes(Array.isArray(next) ? next : []);
    } catch (err) {
      if (!liveRef.current) return;
      setError((prev) => prev ?? message(err, "The graph could not load the latest lanes."));
    } finally {
      if (liveRef.current) setLoadingTopology(false);
    }
  }, []);

  const refreshPrs = React.useCallback(async () => {
    try {
      const next = await actions.getPrs();
      if (liveRef.current) setPrs(Array.isArray(next) ? next : []);
    } catch {
      // A PR read that fails leaves the canvas drawing lanes without overlays,
      // which is the graph this project had before any PR existed.
    }
  }, []);

  const refreshProposals = React.useCallback(async () => {
    try {
      const next = await actions.getProposals();
      if (liveRef.current) setProposals(Array.isArray(next) ? next : []);
    } catch {
      // Best effort, exactly as the compiled page treated it.
    }
  }, []);

  const refreshRiskBatch = React.useCallback(async () => {
    try {
      const next = await actions.getConflictAssessment();
      if (liveRef.current) setBatch(next ?? null);
    } catch {
      // Best effort.
    } finally {
      if (liveRef.current) setLoadingRisk(false);
    }
  }, []);

  const refreshSync = React.useCallback(async () => {
    const [sync, autoRebase] = await Promise.allSettled([
      actions.getSyncStatuses(),
      actions.getAutoRebaseStatuses(),
    ]);
    if (!liveRef.current) return;
    if (sync.status === "fulfilled" && sync.value) setSyncByLaneId(sync.value);
    if (autoRebase.status === "fulfilled" && Array.isArray(autoRebase.value)) {
      const next: Record<string, AutoRebaseLaneStatus | null> = {};
      for (const status of autoRebase.value) next[status.laneId] = status;
      setAutoRebaseByLaneId(next);
    }
  }, []);

  const refreshOperations = React.useCallback(async () => {
    try {
      const next = await actions.getOperations(GRAPH_ACTIVITY_OPERATION_LIMIT);
      if (liveRef.current) setOperations(Array.isArray(next) ? next : []);
    } catch {
      // Activity is a decoration on the layout, never the layout itself.
    }
  }, []);

  // The first read. One pass, everything at once: a guest is destroyed when its
  // placement hides, so every open pays for its own cold start and staggering
  // the reads the way the compiled page did (1.5s, 2.5s, 3.5s timers) would only
  // make that start longer.
  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      const [state, config] = await Promise.allSettled([
        actions.getGraphState(),
        actions.getProjectConfig(),
      ]);
      if (cancelled || !liveRef.current) return;
      setStoredState(state.status === "fulfilled" ? state.value : null);
      if (config.status === "fulfilled") setEnvironments(config.value?.environments ?? []);
      await Promise.allSettled([
        refreshLanes(),
        refreshPrs(),
        refreshProposals(),
        refreshRiskBatch(),
        refreshSync(),
        refreshOperations(),
      ]);
    })();
    return () => {
      cancelled = true;
    };
  }, [active, refreshLanes, refreshOperations, refreshProposals, refreshPrs, refreshRiskBatch, refreshSync]);

  // Contributed nodes, read once per open. There is no host event for a
  // contribution change yet, so a plugin that publishes a node while the page is
  // open is seen on the next open — the same latency a panel had before the
  // page tier.
  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void listSocketEntries(GRAPH_NODE_SOCKET).then((entries) => {
      if (!cancelled && liveRef.current) setSocketEntries(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  /**
   * One frame, one refetch table.
   *
   * `overflow` is not read: every branch here refetches the whole family rather
   * than patching by id, because a lane row is cheap and a wrong row is not —
   * the rule the bridge documents for a frame that could not name every id.
   */
  useHostSubscription(GRAPH_HOST_KINDS, (frame) => {
    if (frame.kind === "lane") {
      void refreshLanes();
      void refreshSync();
      return;
    }
    if (frame.kind === "pr") {
      void refreshPrs();
      void refreshProposals();
      return;
    }
    if (frame.kind === "conflict") {
      void refreshRiskBatch();
      return;
    }
    if (frame.kind === "operation") {
      void refreshOperations();
      void refreshSync();
    }
  });

  useHostRefresh(() => {
    if (!active) return;
    void Promise.allSettled([
      refreshLanes(),
      refreshPrs(),
      refreshProposals(),
      refreshRiskBatch(),
      refreshSync(),
      refreshOperations(),
    ]);
  });

  return {
    lanes,
    environments,
    prs,
    proposals,
    syncByLaneId,
    autoRebaseByLaneId,
    batch,
    operations,
    socketEntries,
    storedState,
    loadingTopology,
    loadingRisk,
    error,
    refreshLanes,
    refreshPrs,
    refreshRiskBatch,
    refreshProposals,
    refreshSync,
    refreshOperations,
    setError,
  };
}
