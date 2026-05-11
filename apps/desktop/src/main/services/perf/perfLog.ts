import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PerfEventKind =
  | "scenarioStart"
  | "scenarioEnd"
  | "mark"
  | "measure"
  | "webVital"
  | "longTask"
  | "ipcInvoke"
  | "processMetrics"
  | "rendererMemory"
  | "note";

export type PerfEvent = {
  ts: number;
  kind: PerfEventKind;
} & Record<string, unknown>;

type PerfRunConfig = {
  runId: string;
  scenario: string | null;
  initialRoute: string | null;
  allowClaude: boolean;
  modelOverride: string | null;
  startedAt: number;
  dir: string;
  eventsPath: string;
  summaryPath: string;
};

let active: PerfRunConfig | null = null;

function readEnvRunId(): string | null {
  const raw = process.env.ADE_PERF_RUN_ID;
  return raw && raw.length > 0 ? raw : null;
}

function readEnvScenario(): string | null {
  const raw = process.env.ADE_PERF_SCENARIO;
  return raw && raw.length > 0 ? raw : null;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function initPerfRunFromEnv(): PerfRunConfig | null {
  if (active) return active;
  const runId = readEnvRunId();
  if (!runId) return null;
  const dir = join(homedir(), ".ade", "perf-runs", runId);
  ensureDir(dir);
  active = {
    runId,
    scenario: readEnvScenario(),
    initialRoute: process.env.ADE_PERF_INITIAL_ROUTE ?? null,
    allowClaude: process.env.ADE_PERF_ALLOW_CLAUDE === "1",
    modelOverride: process.env.ADE_MODEL_OVERRIDE ?? null,
    startedAt: Date.now(),
    dir,
    eventsPath: join(dir, "events.jsonl"),
    summaryPath: join(dir, "summary.json"),
  };
  appendEvent({
    kind: "note",
    ts: active.startedAt,
    note: "perfRunStarted",
    runId: active.runId,
    scenario: active.scenario,
    initialRoute: active.initialRoute,
    allowClaude: active.allowClaude,
    modelOverride: active.modelOverride,
  });
  return active;
}

export function getActiveRun(): PerfRunConfig | null {
  return active;
}

export function isRunActive(): boolean {
  return active !== null;
}

export function appendEvent(event: PerfEvent): void {
  if (!active) return;
  try {
    appendFileSync(active.eventsPath, JSON.stringify(event) + "\n");
  } catch {
    // Swallow — perf logging never breaks the app.
  }
}
