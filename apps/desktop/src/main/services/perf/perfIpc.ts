import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import { aggregate } from "./aggregator";
import {
  appendEvent,
  finishPerfRun,
  getActiveRun,
  isRunActive,
  type PerfEventKind,
} from "./perfLog";
import { stopMetricsSampler } from "./metricsSampler";

export type PerfRunConfigForRenderer = {
  active: boolean;
  runId: string | null;
  scenario: string | null;
  initialRoute: string | null;
  allowClaude: boolean;
  modelOverride: string | null;
  projectRoot: string | null;
};

export type PerfRecordEventArgs = {
  ts?: number;
  kind: string;
  [key: string]: unknown;
};

const PERF_EVENT_KINDS: ReadonlySet<string> = new Set<PerfEventKind>([
  "scenarioStart",
  "scenarioEnd",
  "manualStep",
  "mark",
  "measure",
  "webVital",
  "longTask",
  "ipcInvoke",
  "processMetrics",
  "rendererMemory",
  "note",
]);

function isPerfEventKind(kind: string): kind is PerfEventKind {
  return PERF_EVENT_KINDS.has(kind);
}

export function registerPerfIpcHandlers(): void {
  ipcMain.removeHandler(IPC.perfGetConfig);
  ipcMain.handle(IPC.perfGetConfig, (): PerfRunConfigForRenderer => {
    const run = getActiveRun();
    return {
      active: run !== null,
      runId: run?.runId ?? null,
      scenario: run?.scenario ?? null,
      initialRoute: run?.initialRoute ?? null,
      allowClaude: run?.allowClaude ?? false,
      modelOverride: run?.modelOverride ?? null,
      projectRoot: process.env.ADE_PERF_PASS_DIR ?? null,
    };
  });

  ipcMain.removeHandler(IPC.perfRecordEvent);
  ipcMain.handle(IPC.perfRecordEvent, (_event, args: PerfRecordEventArgs) => {
    if (!isRunActive()) return { ok: false, reason: "no-active-run" };
    const ts = typeof args.ts === "number" ? args.ts : Date.now();
    const { kind, ts: _ignored, ...rest } = args;
    if (!isPerfEventKind(kind)) return { ok: false, reason: "invalid-kind" };
    appendEvent({ ts, kind, ...rest });
    return { ok: true };
  });

  ipcMain.removeHandler(IPC.perfScenarioComplete);
  ipcMain.handle(IPC.perfScenarioComplete, (_event, args: {
    scenario: string;
    ok: boolean;
    smokeFailures?: string[];
  }) => {
    if (!isRunActive()) return { ok: false, reason: "no-active-run" };
    appendEvent({
      ts: Date.now(),
      kind: "scenarioEnd",
      scenario: args.scenario,
      ok: args.ok,
      smokeFailures: args.smokeFailures ?? [],
    });
    return { ok: true };
  });

  ipcMain.removeHandler(IPC.perfFinalize);
  ipcMain.handle(IPC.perfFinalize, () => {
    const run = getActiveRun();
    if (!run) return { ok: false, reason: "no-active-run" };
    stopMetricsSampler();
    try {
      const summary = aggregate(run.runId);
      return { ok: true, summary };
    } catch (error) {
      return {
        ok: false,
        reason: "aggregate-failed",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      finishPerfRun(run.runId);
    }
  });
}
