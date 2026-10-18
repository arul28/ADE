import React from "react";
import type {
  DiskPressureSnapshot,
  RuntimeHealthSnapshot,
  StorageSnapshot,
} from "../../../../shared/types/storage";
import type { ProjectHealthReport } from "../../../../shared/types/projectHealth";
import type { AppResourceUsageSnapshot, LaneCleanupConfig, OpenProjectBinding } from "../../../../shared/types";
import { getAppResourceUsageCoalesced } from "../../../lib/resourcePressure";
import { baseName } from "../storage/storageView";

export type StorageData = {
  snapshot: StorageSnapshot | null;
  pressureState: DiskPressureSnapshot["state"] | undefined;
  laneIdByKey: Map<string, string>;
  archivedAtByKey: Map<string, string | null>;
  policy: LaneCleanupConfig;
  effectivePolicy: LaneCleanupConfig;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
};

export type DiagnosticsData = {
  usage: AppResourceUsageSnapshot | null;
  usageReady: boolean;
  runtimeHealth: RuntimeHealthSnapshot | null;
  /** False on another machine or an older build: there is nothing to read. */
  runtimeHealthAvailable: boolean;
};

export type ReportData = {
  report: ProjectHealthReport | null;
  loading: boolean;
  checking: boolean;
  error: string | null;
  /** False when this build's bridge has no project health. */
  available: boolean;
};

const EMPTY_POLICY: LaneCleanupConfig = {};

/**
 * Everything Settings → Health reads, loaded once when the page opens and
 * again on demand (Rescan, Check again, after a cleanup). No polling.
 *
 * Remote machines: every storage, lane, config and project-health call carries
 * the Settings machine's `pin`. Disk pressure, resource usage and runtime
 * health are plain IPC that only reach this computer, so they are read only
 * when `isThisMachine`, and the page says "Only on this computer" otherwise.
 */
export function useHealthData(pin: OpenProjectBinding | null, isThisMachine: boolean) {
  const [storage, setStorage] = React.useState<StorageData>({
    snapshot: null,
    pressureState: undefined,
    laneIdByKey: new Map(),
    archivedAtByKey: new Map(),
    policy: EMPTY_POLICY,
    effectivePolicy: EMPTY_POLICY,
    loading: true,
    refreshing: false,
    error: null,
  });
  const [diagnostics, setDiagnostics] = React.useState<DiagnosticsData>({
    usage: null,
    usageReady: false,
    runtimeHealth: null,
    runtimeHealthAvailable: false,
  });
  const reportAvailable = typeof window.ade?.projectHealth?.getReport === "function";
  const [report, setReportState] = React.useState<ReportData>({
    report: null,
    loading: reportAvailable,
    checking: false,
    error: null,
    available: reportAvailable,
  });
  // A newer read wins over an older one still in flight (a Rescan pressed
  // while the first scan runs, or a machine switch).
  const storageRequest = React.useRef(0);
  const reportRequest = React.useRef(0);

  const loadStorage = React.useCallback(async (opts: { force?: boolean; silent?: boolean } = {}) => {
    const request = ++storageRequest.current;
    setStorage((current) => ({
      ...current,
      loading: !(opts.silent || opts.force) && current.snapshot == null,
      refreshing: Boolean(opts.silent || opts.force),
      error: null,
    }));
    try {
      const [snap, pressure, lanes, config] = await Promise.all([
        window.ade.storage.getSnapshot({ forceRefresh: opts.force }, pin),
        isThisMachine ? window.ade.storage.getPressure().catch(() => null) : Promise.resolve(null),
        window.ade.lanes?.list?.({ includeArchived: true }, pin).catch(() => []) ?? Promise.resolve([]),
        window.ade.projectConfig.get(pin).catch(() => null),
      ]);
      if (request !== storageRequest.current) return;
      const ids = new Map<string, string>();
      const archivedAt = new Map<string, string | null>();
      for (const lane of lanes) {
        const key = baseName(lane.worktreePath);
        ids.set(key, lane.id);
        archivedAt.set(key, lane.archivedAt ?? null);
      }
      setStorage({
        snapshot: snap,
        pressureState: pressure?.state,
        laneIdByKey: ids,
        archivedAtByKey: archivedAt,
        policy: config
          ? {
              ...(config.local.laneCleanup ?? {}),
              autoDeleteArchivedAfterHours: undefined,
              deleteRemoteBranchOnCleanup: undefined,
            }
          : EMPTY_POLICY,
        effectivePolicy: config?.effective.laneCleanup ?? EMPTY_POLICY,
        loading: false,
        refreshing: false,
        error: null,
      });
    } catch (err) {
      if (request !== storageRequest.current) return;
      setStorage((current) => ({
        ...current,
        loading: false,
        refreshing: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [isThisMachine, pin]);

  const loadDiagnostics = React.useCallback(async () => {
    const runtimeHealthFn = isThisMachine && typeof window.ade?.app?.getRuntimeHealth === "function"
      ? window.ade.app.getRuntimeHealth
      : null;
    const [usage, runtimeHealth] = await Promise.all([
      isThisMachine ? getAppResourceUsageCoalesced().catch(() => null) : Promise.resolve(null),
      runtimeHealthFn ? runtimeHealthFn().catch(() => null) : Promise.resolve(null),
    ]);
    setDiagnostics({
      usage,
      usageReady: true,
      runtimeHealth,
      runtimeHealthAvailable: Boolean(runtimeHealthFn),
    });
  }, [isThisMachine]);

  const loadReport = React.useCallback(async (opts: { force?: boolean } = {}) => {
    if (!reportAvailable) return;
    const request = ++reportRequest.current;
    setReportState((current) => ({
      ...current,
      loading: current.report == null,
      checking: Boolean(opts.force),
      error: null,
    }));
    try {
      const next = await window.ade.projectHealth.getReport({ forceRefresh: opts.force }, pin);
      if (request !== reportRequest.current) return;
      setReportState({ report: next, loading: false, checking: false, error: null, available: true });
    } catch (err) {
      if (request !== reportRequest.current) return;
      setReportState((current) => ({
        ...current,
        loading: false,
        checking: false,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [pin, reportAvailable]);

  /** A fix returns the report after it; show that one. */
  const setReport = React.useCallback((next: ProjectHealthReport) => {
    reportRequest.current += 1;
    setReportState({ report: next, loading: false, checking: false, error: null, available: true });
  }, []);

  const savePolicy = React.useCallback(async (next: LaneCleanupConfig) => {
    const current = await window.ade.projectConfig.get(pin);
    await window.ade.projectConfig.save({
      shared: current.shared,
      local: { ...current.local, laneCleanup: next },
    }, pin);
  }, [pin]);

  const setPolicy = React.useCallback((next: LaneCleanupConfig) => {
    setStorage((current) => ({ ...current, policy: next }));
  }, []);

  // Keyed on the machine (pin identity follows its key), not on each render.
  React.useEffect(() => {
    void loadStorage();
    void loadDiagnostics();
    void loadReport();
  }, [loadStorage, loadDiagnostics, loadReport]);

  return {
    storage,
    diagnostics,
    report,
    loadStorage,
    loadDiagnostics,
    loadReport,
    setReport,
    savePolicy,
    setPolicy,
  };
}

export type HealthData = ReturnType<typeof useHealthData>;
