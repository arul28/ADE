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
import { isAdeAvailable } from "../../../lib/adeAvailability";
import { saveProjectLocalConfig } from "../../../lib/projectLocalConfig";

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

function emptyStorage(loading: boolean): StorageData {
  return {
    snapshot: null,
    pressureState: undefined,
    laneIdByKey: new Map(),
    archivedAtByKey: new Map(),
    policy: EMPTY_POLICY,
    effectivePolicy: EMPTY_POLICY,
    loading,
    refreshing: false,
    error: null,
  };
}

function emptyReport(available: boolean, wanted: boolean): ReportData {
  return { report: null, loading: available && wanted, checking: false, error: null, available };
}

const EMPTY_DIAGNOSTICS: DiagnosticsData = {
  usage: null,
  usageReady: false,
  runtimeHealth: null,
  runtimeHealthAvailable: false,
};

/** Which of the three reads a page needs; each page loads only its own. */
export type HealthDataParts = { storage?: boolean; diagnostics?: boolean; report?: boolean };

const ALL_PARTS: HealthDataParts = { storage: true, diagnostics: true, report: true };

/**
 * What the project and service pages read (Project → Lanes, Storage & cleanup and Location,
 * Computer → ADE service), loaded once when the page opens and again on
 * demand (Check again, after a cleanup). No polling.
 *
 * Remote machines: every storage, lane, config and project-health call carries
 * the Settings machine's `pin`. Disk pressure, resource usage and runtime
 * health are plain IPC that only reach this computer, so they are read only
 * when `isThisMachine`, and the page says "Only on this computer" otherwise.
 */
export function useHealthData(
  pin: OpenProjectBinding | null,
  isThisMachine: boolean,
  parts: HealthDataParts = ALL_PARTS,
) {
  const wantStorage = Boolean(parts.storage);
  const wantDiagnostics = Boolean(parts.diagnostics);
  const wantReport = Boolean(parts.report);
  const reportAvailable = isAdeAvailable(window.ade?.projectHealth?.getReport);
  const [storage, setStorage] = React.useState<StorageData>(() => emptyStorage(wantStorage));
  const [diagnostics, setDiagnostics] = React.useState<DiagnosticsData>(EMPTY_DIAGNOSTICS);
  const [report, setReportState] = React.useState<ReportData>(() => emptyReport(reportAvailable, wantReport));
  // A newer read wins over an older one still in flight (a Rescan pressed
  // while the first scan runs, or a machine switch).
  const storageRequest = React.useRef(0);
  const diagnosticsRequest = React.useRef(0);
  const reportRequest = React.useRef(0);

  const loadStorage = React.useCallback(async (opts: { force?: boolean; silent?: boolean } = {}) => {
    if (!wantStorage) return;
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
  }, [isThisMachine, pin, wantStorage]);

  const loadDiagnostics = React.useCallback(async () => {
    if (!wantDiagnostics) return;
    const request = ++diagnosticsRequest.current;
    const runtimeHealthFn = isThisMachine && isAdeAvailable(window.ade?.app?.getRuntimeHealth)
      ? window.ade.app.getRuntimeHealth
      : null;
    const [usage, runtimeHealth] = await Promise.all([
      isThisMachine ? getAppResourceUsageCoalesced().catch(() => null) : Promise.resolve(null),
      runtimeHealthFn ? runtimeHealthFn().catch(() => null) : Promise.resolve(null),
    ]);
    if (request !== diagnosticsRequest.current) return;
    setDiagnostics({
      usage,
      usageReady: true,
      runtimeHealth,
      runtimeHealthAvailable: Boolean(runtimeHealthFn),
    });
  }, [isThisMachine, wantDiagnostics]);

  const loadReport = React.useCallback(async (opts: { force?: boolean } = {}) => {
    if (!reportAvailable || !wantReport) return;
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
  }, [pin, reportAvailable, wantReport]);

  /** A fix returns the report after it; show that one. */
  const setReport = React.useCallback((next: ProjectHealthReport) => {
    reportRequest.current += 1;
    setReportState({ report: next, loading: false, checking: false, error: null, available: true });
  }, []);

  const savePolicy = React.useCallback(async (next: LaneCleanupConfig) => {
    await saveProjectLocalConfig((current) => ({ ...current.local, laneCleanup: next }), pin);
  }, [pin]);

  const setPolicy = React.useCallback((next: LaneCleanupConfig) => {
    setStorage((current) => ({ ...current, policy: next }));
  }, []);

  // Keyed on the machine (pin identity follows its key), not on each render.
  // On a machine switch the old machine's lanes and sizes go first: they must
  // never show, or be acted on, as the new machine's.
  const machineKey = pin?.key ?? null;
  const shownMachine = React.useRef(machineKey);
  React.useEffect(() => {
    if (shownMachine.current !== machineKey) {
      shownMachine.current = machineKey;
      setStorage(emptyStorage(wantStorage));
      setDiagnostics(EMPTY_DIAGNOSTICS);
      setReportState(emptyReport(reportAvailable, wantReport));
    }
    void loadStorage();
    void loadDiagnostics();
    void loadReport();
  }, [loadStorage, loadDiagnostics, loadReport, machineKey, reportAvailable, wantReport, wantStorage]);

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
