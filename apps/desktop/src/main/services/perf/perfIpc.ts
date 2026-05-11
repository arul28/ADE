import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import { aggregate } from "./aggregator";
import { appendEvent, getActiveRun, isRunActive } from "./perfLog";

export type PerfRunConfigForRenderer = {
  active: boolean;
  runId: string | null;
  scenario: string | null;
  initialRoute: string | null;
  allowClaude: boolean;
  modelOverride: string | null;
};

export type PerfRecordEventArgs = {
  ts?: number;
  kind: string;
  [key: string]: unknown;
};

export function registerPerfIpcHandlers(): void {
  ipcMain.handle(IPC.perfGetConfig, (): PerfRunConfigForRenderer => {
    const run = getActiveRun();
    return {
      active: run !== null,
      runId: run?.runId ?? null,
      scenario: run?.scenario ?? null,
      initialRoute: run?.initialRoute ?? null,
      allowClaude: run?.allowClaude ?? false,
      modelOverride: run?.modelOverride ?? null,
    };
  });

  ipcMain.handle(IPC.perfRecordEvent, (_event, args: PerfRecordEventArgs) => {
    if (!isRunActive()) return { ok: false, reason: "no-active-run" };
    const ts = typeof args.ts === "number" ? args.ts : Date.now();
    const { kind, ts: _ignored, ...rest } = args;
    appendEvent({ ts, kind: kind as never, ...rest });
    return { ok: true };
  });

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

  ipcMain.handle(IPC.perfFinalize, () => {
    const run = getActiveRun();
    if (!run) return { ok: false, reason: "no-active-run" };
    const summary = aggregate(run.runId);
    return { ok: true, summary };
  });
}
