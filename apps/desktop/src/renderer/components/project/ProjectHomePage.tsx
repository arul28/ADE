import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pulse as Activity,
  WarningCircle as AlertCircle,
  ArrowSquareOut as ExternalLink,
  FolderOpen,
  House as Home,
  SquaresFour as Layers,
  Play,
  ArrowsClockwise as RefreshCw,
  FloppyDisk as Save,
  ShieldCheck,
  Stop as Square,
  Pause as SquareDashed,
  Trash as Trash2,
  MagnifyingGlass
} from "@phosphor-icons/react";
import type {
  ConfigProcessDefinition,
  ConfigStackButtonDefinition,
  ConfigTestSuiteDefinition,
  ProcessDefinition,
  ProcessRestartPolicy,
  ProcessRuntime,
  ProcessRuntimeStatus,
  ProjectConfigCandidate,
  ProjectConfigFile,
  ProjectConfigSnapshot,
  StackAggregateStatus,
  StackButtonDefinition,
  TestRunSummary,
  TestSuiteDefinition,
  TestSuiteTag
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { CiImportPanel } from "./CiImportPanel";
import { PaneTilingLayout, type PaneConfig, type PaneSplit } from "../ui/PaneTilingLayout";
const DEFAULT_PROCESS_COMMAND = '["npm", "run", "dev"]';
const DEFAULT_PROCESS_COMMAND_LINE = "npm run dev";
const DEFAULT_TEST_COMMAND = '["npm", "run", "test"]';
const DEFAULT_ENV = "{}";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function formatDate(ts: string | null): string {
  if (!ts) return "-";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatDurationMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "-";
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatUptime(runtime: ProcessRuntime, nowMs: number): string {
  if (!runtime.startedAt) return "-";
  const startedAtMs = Date.parse(runtime.startedAt);
  if (Number.isNaN(startedAtMs)) return "-";

  if (
    runtime.status === "running" ||
    runtime.status === "starting" ||
    runtime.status === "degraded" ||
    runtime.status === "stopping"
  ) {
    return formatDurationMs(Math.max(0, nowMs - startedAtMs));
  }

  if (runtime.endedAt) {
    const endedAtMs = Date.parse(runtime.endedAt);
    if (!Number.isNaN(endedAtMs)) {
      return formatDurationMs(Math.max(0, endedAtMs - startedAtMs));
    }
  }

  return formatDurationMs(runtime.uptimeMs);
}

function statusTone(status: ProcessRuntimeStatus): string {
  if (status === "running") return "text-emerald-400 border-emerald-900";
  if (status === "starting" || status === "stopping") return "text-amber-400 border-amber-900";
  if (status === "degraded" || status === "crashed") return "text-red-400 border-red-900";
  return "text-muted-fg border-border";
}

function readinessTone(readiness: ProcessRuntime["readiness"]): string {
  if (readiness === "ready") return "text-emerald-400 border-emerald-900";
  if (readiness === "not_ready") return "text-red-400 border-red-900";
  return "text-muted-fg border-border";
}

function stackTone(status: StackAggregateStatus): string {
  if (status === "running") return "text-emerald-700 border-emerald-200";
  if (status === "partial") return "text-amber-700 border-amber-200";
  if (status === "error") return "text-red-700 border-red-200";
  return "text-muted-fg border-border";
}

function statusBadgeBg(status: ProcessRuntimeStatus): string {
  if (status === "running") return "bg-emerald-500/15 text-emerald-400";
  if (status === "starting" || status === "stopping") return "bg-amber-500/15 text-amber-400";
  if (status === "degraded" || status === "crashed") return "bg-red-500/15 text-red-400";
  return "bg-muted/50 text-muted-fg";
}

function readinessBadgeBg(readiness: ProcessRuntime["readiness"]): string {
  if (readiness === "ready") return "bg-emerald-500/15 text-emerald-400";
  if (readiness === "not_ready") return "bg-red-500/15 text-red-400";
  return "bg-muted/50 text-muted-fg";
}

function testStatusBadgeBg(status: string | undefined): string {
  if (status === "passed") return "bg-emerald-500/15 text-emerald-400";
  if (status === "failed") return "bg-red-500/15 text-red-400";
  if (status === "running") return "bg-blue-500/15 text-blue-400";
  return "bg-muted/50 text-muted-fg";
}

function getRuntimeFallback(laneId: string | null, processId: string): ProcessRuntime {
  return {
    laneId: laneId ?? "",
    processId,
    status: "stopped",
    readiness: "unknown",
    pid: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    lastExitCode: null,
    lastEndedAt: null,
    uptimeMs: null,
    ports: [],
    logPath: null,
    updatedAt: new Date().toISOString()
  };
}

function aggregateStackStatus(stack: StackButtonDefinition, runtimeById: Map<string, ProcessRuntime>, laneId: string | null): StackAggregateStatus {
  if (!stack.processIds.length) return "stopped";

  let running = 0;
  let stopped = 0;
  let errors = 0;

  for (const processId of stack.processIds) {
    const runtime = runtimeById.get(processId) ?? getRuntimeFallback(laneId, processId);
    if (runtime.status === "crashed" || runtime.status === "degraded") {
      errors += 1;
      continue;
    }
    if (runtime.status === "running") {
      running += 1;
      continue;
    }
    if (runtime.status === "stopped" || runtime.status === "exited") {
      stopped += 1;
      continue;
    }
    // starting/stopping counts toward partial
  }

  if (errors > 0) return "error";
  if (running === stack.processIds.length) return "running";
  if (stopped === stack.processIds.length) return "stopped";
  return "partial";
}

function normalizeLog(raw: string): string {
  return raw.replace(/\u0000/g, "");
}

function filterLog(raw: string, query: string): string {
  const q = query.trim().toLowerCase();
  if (!q) return raw;
  const lines = raw.split("\n");
  return lines.filter((line) => line.toLowerCase().includes(q)).join("\n");
}

function quoteShellArg(arg: string): string {
  if (!arg.length) return '""';
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

function commandArrayToLine(command: string[]): string {
  if (!command.length) return "";
  return command.map(quoteShellArg).join(" ");
}

function parseCommandLine(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        const next = input[i + 1];
        if (next == null) {
          current += "\\";
        } else {
          i += 1;
          current += next;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length) {
        out.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaped) current += "\\";
  if (quote != null) throw new Error("Unclosed quote in command line");
  if (current.length) out.push(current);
  if (!out.length) throw new Error("Command line must not be empty");
  return out;
}

type EditableProcessRow = {
  id: string;
  name: string;
  cwd: string;
  commandLine: string;
  commandJson: string;
  envJson: string;
  autostart: boolean;
  restart: ProcessRestartPolicy;
  gracefulShutdownMs: string;
  dependsOnCsv: string;
  readinessType: "none" | "port" | "logRegex";
  readinessPort: string;
  readinessPattern: string;
};

type EditableStackRow = {
  id: string;
  name: string;
  processIdsCsv: string;
  startOrder: "parallel" | "dependency";
};

type EditableSuiteRow = {
  id: string;
  name: string;
  cwd: string;
  commandJson: string;
  envJson: string;
  timeoutMs: string;
  tagsCsv: string;
};

function processRowsFromFile(file: ProjectConfigFile): EditableProcessRow[] {
  return (file.processes ?? []).map((p) => {
    const command = p.command ?? ["npm", "run", "dev"];
    const readiness = p.readiness;
    return {
      id: p.id,
      name: p.name ?? "",
      cwd: p.cwd ?? ".",
      commandLine: commandArrayToLine(command),
      commandJson: JSON.stringify(command),
      envJson: JSON.stringify(p.env ?? {}),
      autostart: p.autostart ?? false,
      restart: p.restart ?? "never",
      gracefulShutdownMs: String(p.gracefulShutdownMs ?? 7000),
      dependsOnCsv: (p.dependsOn ?? []).join(", "),
      readinessType: (readiness?.type as "none" | "port" | "logRegex" | undefined) ?? "none",
      readinessPort: readiness?.type === "port" ? String(readiness.port ?? "") : "",
      readinessPattern: readiness?.type === "logRegex" ? readiness.pattern ?? "" : ""
    };
  });
}

function stackRowsFromFile(file: ProjectConfigFile): EditableStackRow[] {
  return (file.stackButtons ?? []).map((s) => ({
    id: s.id,
    name: s.name ?? "",
    processIdsCsv: (s.processIds ?? []).join(", "),
    startOrder: s.startOrder ?? "parallel"
  }));
}

function suiteRowsFromFile(file: ProjectConfigFile): EditableSuiteRow[] {
  return (file.testSuites ?? []).map((s) => ({
    id: s.id,
    name: s.name ?? "",
    cwd: s.cwd ?? ".",
    commandJson: JSON.stringify(s.command ?? ["npm", "run", "test"]),
    envJson: JSON.stringify(s.env ?? {}),
    timeoutMs: s.timeoutMs != null ? String(s.timeoutMs) : "",
    tagsCsv: (s.tags ?? []).join(", ")
  }));
}

function parseJsonArray(name: string, raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be valid JSON array`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item.trim().length)) {
    throw new Error(`${name} must be a non-empty argv JSON array of strings`);
  }
  return parsed.map((item) => String(item));
}

function parseStringMap(name: string, raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new Error(`${name} must be valid JSON object`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new Error(`${name} values must be strings`);
    }
    out[k] = v;
  }
  return out;
}

function parseProcessCommand(name: string, row: EditableProcessRow): string[] {
  const line = row.commandLine.trim();
  if (line.length) {
    try {
      return parseCommandLine(line);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`${name} command line is invalid: ${detail}`);
    }
  }
  return parseJsonArray(`${name} command`, row.commandJson);
}

function toFileProcesses(rows: EditableProcessRow[]): ConfigProcessDefinition[] {
  const out: ConfigProcessDefinition[] = [];
  for (const row of rows) {
    const id = row.id.trim();
    if (!id) continue;

    const command = parseProcessCommand(`process ${id}`, row);
    const env = parseStringMap(`process ${id} env`, row.envJson);
    const graceful = Number(row.gracefulShutdownMs);
    if (!Number.isFinite(graceful) || graceful <= 0) {
      throw new Error(`process ${id} gracefulShutdownMs must be > 0`);
    }

    const dependsOn = row.dependsOnCsv
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    const readiness =
      row.readinessType === "port"
        ? { type: "port" as const, port: Number(row.readinessPort) }
        : row.readinessType === "logRegex"
          ? { type: "logRegex" as const, pattern: row.readinessPattern }
          : ({ type: "none" as const });

    if (readiness.type === "port" && (!Number.isInteger(readiness.port) || readiness.port < 1 || readiness.port > 65535)) {
      throw new Error(`process ${id} readiness port must be between 1 and 65535`);
    }

    if (readiness.type === "logRegex" && !readiness.pattern.trim()) {
      throw new Error(`process ${id} readiness pattern is required`);
    }

    out.push({
      id,
      name: row.name.trim(),
      cwd: row.cwd.trim(),
      command,
      env,
      autostart: row.autostart,
      restart: row.restart,
      gracefulShutdownMs: Math.floor(graceful),
      dependsOn,
      readiness
    });
  }
  return out;
}

function toFileStacks(rows: EditableStackRow[]): ConfigStackButtonDefinition[] {
  const out: ConfigStackButtonDefinition[] = [];
  for (const row of rows) {
    const id = row.id.trim();
    if (!id) continue;
    out.push({
      id,
      name: row.name.trim(),
      processIds: row.processIdsCsv
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
      startOrder: row.startOrder
    });
  }
  return out;
}

function toFileSuites(rows: EditableSuiteRow[]): ConfigTestSuiteDefinition[] {
  const out: ConfigTestSuiteDefinition[] = [];
  for (const row of rows) {
    const id = row.id.trim();
    if (!id) continue;

    const command = parseJsonArray(`suite ${id} command`, row.commandJson);
    const env = parseStringMap(`suite ${id} env`, row.envJson);
    const tags = row.tagsCsv
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((tag): tag is TestSuiteTag =>
        tag === "unit" || tag === "lint" || tag === "integration" || tag === "e2e" || tag === "custom"
      );

    const timeoutMs = row.timeoutMs.trim().length ? Number(row.timeoutMs) : undefined;
    if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error(`suite ${id} timeoutMs must be > 0`);
    }

    out.push({
      id,
      name: row.name.trim(),
      cwd: row.cwd.trim(),
      command,
      env,
      ...(timeoutMs != null ? { timeoutMs: Math.floor(timeoutMs) } : {}),
      tags
    });
  }
  return out;
}

/* ---- Default tiling layout ---- */

const PROJECT_HOME_TILING_TREE: PaneSplit = {
  type: "split",
  direction: "horizontal",
  children: [
    {
      node: {
        type: "split",
        direction: "vertical",
        children: [
          { node: { type: "pane", id: "overview" }, defaultSize: 40, minSize: 20 },
          { node: { type: "pane", id: "processes" }, defaultSize: 60, minSize: 25 }
        ]
      },
      defaultSize: 50,
      minSize: 25
    },
    {
      node: {
        type: "split",
        direction: "vertical",
        children: [
          { node: { type: "pane", id: "tests" }, defaultSize: 50, minSize: 20 },
          { node: { type: "pane", id: "config" }, defaultSize: 50, minSize: 20 }
        ]
      },
      defaultSize: 50,
      minSize: 25
    }
  ]
};

export function ProjectHomePage() {
  const project = useAppStore((s) => s.project);
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const runLaneId = useAppStore((s) => s.runLaneId);
  const selectRunLane = useAppStore((s) => s.selectRunLane);
  const openRepo = useAppStore((s) => s.openRepo);




  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [config, setConfig] = useState<ProjectConfigSnapshot | null>(null);
  const [definitions, setDefinitions] = useState<ProcessDefinition[]>([]);
  const [runtime, setRuntime] = useState<ProcessRuntime[]>([]);
  const [suites, setSuites] = useState<TestSuiteDefinition[]>([]);
  const [runs, setRuns] = useState<TestRunSummary[]>([]);

  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const [processLogRaw, setProcessLogRaw] = useState("");
  const [processLogSearch, setProcessLogSearch] = useState("");
  const [processPauseAutoscroll, setProcessPauseAutoscroll] = useState(false);

  const [testLogRaw, setTestLogRaw] = useState("");
  const [testLogSearch, setTestLogSearch] = useState("");

  const [configTarget, setConfigTarget] = useState<"shared" | "local">("shared");
  const [processRows, setProcessRows] = useState<EditableProcessRow[]>([]);
  const [stackRows, setStackRows] = useState<EditableStackRow[]>([]);
  const [suiteRows, setSuiteRows] = useState<EditableSuiteRow[]>([]);
  const [quickProcessName, setQuickProcessName] = useState("");
  const [quickProcessCwd, setQuickProcessCwd] = useState(".");
  const [quickProcessCommand, setQuickProcessCommand] = useState(DEFAULT_PROCESS_COMMAND_LINE);

  const [nowTick, setNowTick] = useState(Date.now());

  const effectiveLaneId = runLaneId ?? selectedLaneId ?? lanes[0]?.id ?? null;
  const effectiveLaneName = lanes.find((lane) => lane.id === effectiveLaneId)?.name ?? null;

  const processLogRef = useRef<HTMLPreElement | null>(null);
  const testLogRef = useRef<HTMLPreElement | null>(null);
  const configEditorRef = useRef<HTMLDivElement | null>(null);
  const selectedProcessIdRef = useRef<string | null>(null);
  const selectedRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedProcessIdRef.current = selectedProcessId;
  }, [selectedProcessId]);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!runLaneId && selectedLaneId) {
      selectRunLane(selectedLaneId);
    }
  }, [runLaneId, selectedLaneId, selectRunLane]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [nextConfig, nextDefs, nextSuites] = await Promise.all([
        window.ade.projectConfig.get(),
        window.ade.processes.listDefinitions(),
        window.ade.tests.listSuites()
      ]);
      const [nextRuntime, nextRuns] = effectiveLaneId
        ? await Promise.all([
          window.ade.processes.listRuntime(effectiveLaneId),
          window.ade.tests.listRuns({ laneId: effectiveLaneId, limit: 120 })
        ])
        : [[], []] as [ProcessRuntime[], TestRunSummary[]];

      setConfig(nextConfig);
      setDefinitions(nextDefs);
      setRuntime(nextRuntime);
      setSuites(nextSuites);
      setRuns(nextRuns);

      setSelectedProcessId((current) => {
        const validCurrent = current && nextDefs.some((d) => d.id === current);
        return validCurrent ? current : nextDefs[0]?.id ?? null;
      });

      setSelectedRunId((current) => {
        const validCurrent = current && nextRuns.some((r) => r.id === current);
        return validCurrent ? current : nextRuns[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [effectiveLaneId]);

  useEffect(() => {
    refreshAll().catch(() => { });
  }, [refreshAll]);

  useEffect(() => {
    const unsubProc = window.ade.processes.onEvent((ev) => {
      if (ev.type === "runtime") {
        if (!effectiveLaneId || ev.runtime.laneId !== effectiveLaneId) return;
        setRuntime((prev) => {
          const idx = prev.findIndex((row) => row.processId === ev.runtime.processId);
          if (idx < 0) return [...prev, ev.runtime];
          const next = [...prev];
          next[idx] = ev.runtime;
          return next;
        });
        return;
      }

      if (ev.type === "log" && ev.laneId === effectiveLaneId && selectedProcessIdRef.current === ev.processId) {
        setProcessLogRaw((prev) => normalizeLog(`${prev}${ev.chunk}`));
      }
    });

    const unsubTests = window.ade.tests.onEvent((ev) => {
      if (ev.type === "run") {
        if (ev.run.laneId !== effectiveLaneId) return;
        setRuns((prev) => {
          const idx = prev.findIndex((row) => row.id === ev.run.id);
          if (idx < 0) {
            const next = [ev.run, ...prev];
            next.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
            return next;
          }
          const next = [...prev];
          next[idx] = ev.run;
          next.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
          return next;
        });
        return;
      }

      if (ev.type === "log" && selectedRunIdRef.current === ev.runId) {
        setTestLogRaw((prev) => normalizeLog(`${prev}${ev.chunk}`));
      }
    });

    return () => {
      try {
        unsubProc();
      } catch {
        // ignore
      }
      try {
        unsubTests();
      } catch {
        // ignore
      }
    };
  }, [effectiveLaneId]);

  useEffect(() => {
    if (!selectedProcessId || !effectiveLaneId) {
      setProcessLogRaw("");
      return;
    }

    window.ade.processes
      .getLogTail({ laneId: effectiveLaneId, processId: selectedProcessId, maxBytes: 220_000 })
      .then((log) => setProcessLogRaw(normalizeLog(log)))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedProcessId, effectiveLaneId]);

  useEffect(() => {
    if (!selectedRunId) {
      setTestLogRaw("");
      return;
    }

    window.ade.tests
      .getLogTail({ runId: selectedRunId, maxBytes: 220_000 })
      .then((log) => setTestLogRaw(normalizeLog(log)))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedRunId]);

  useEffect(() => {
    if (!processPauseAutoscroll && processLogRef.current) {
      processLogRef.current.scrollTop = processLogRef.current.scrollHeight;
    }
  }, [processLogRaw, processPauseAutoscroll]);

  useEffect(() => {
    if (testLogRef.current) {
      testLogRef.current.scrollTop = testLogRef.current.scrollHeight;
    }
  }, [testLogRaw]);

  useEffect(() => {
    if (!config) return;
    const file = configTarget === "shared" ? config.shared : config.local;
    setProcessRows(processRowsFromFile(file));
    setStackRows(stackRowsFromFile(file));
    setSuiteRows(suiteRowsFromFile(file));
  }, [config, configTarget]);

  const runtimeById = useMemo(() => new Map(runtime.map((row) => [row.processId, row])), [runtime, nowTick]);

  const processItems = useMemo(() => {
    return definitions.map((def) => ({
      definition: def,
      runtime: runtimeById.get(def.id) ?? getRuntimeFallback(effectiveLaneId, def.id)
    }));
  }, [definitions, runtimeById, effectiveLaneId]);

  const selectedProcessRuntime = useMemo(
    () => (selectedProcessId ? runtimeById.get(selectedProcessId) ?? getRuntimeFallback(effectiveLaneId, selectedProcessId) : null),
    [runtimeById, selectedProcessId, effectiveLaneId]
  );

  const stackStatuses = useMemo(() => {
    const stacks = config?.effective.stackButtons ?? [];
    return stacks.map((stack) => ({
      stack,
      status: aggregateStackStatus(stack, runtimeById, effectiveLaneId)
    }));
  }, [config, runtimeById, effectiveLaneId]);

  const latestRunBySuite = useMemo(() => {
    const out = new Map<string, TestRunSummary>();
    for (const run of runs) {
      if (!out.has(run.suiteId)) out.set(run.suiteId, run);
    }
    return out;
  }, [runs]);

  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? null, [runs, selectedRunId]);

  const visibleProcessLog = useMemo(() => filterLog(processLogRaw, processLogSearch), [processLogRaw, processLogSearch]);
  const visibleTestLog = useMemo(() => filterLog(testLogRaw, testLogSearch), [testLogRaw, testLogSearch]);

  const trustRequired = Boolean(config?.trust.requiresSharedTrust);

  const runWithRefresh = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshAll]);

  const saveConfig = useCallback(async () => {
    if (!config) return;

    setError(null);
    setNotice(null);

    try {
      const targetFileCurrent = configTarget === "shared" ? config.shared : config.local;
      const nextFile: ProjectConfigFile = {
        ...targetFileCurrent,
        version: 1,
        processes: toFileProcesses(processRows),
        stackButtons: toFileStacks(stackRows),
        testSuites: toFileSuites(suiteRows)
      };

      const candidate: ProjectConfigCandidate = {
        shared: configTarget === "shared" ? nextFile : config.shared,
        local: configTarget === "local" ? nextFile : config.local
      };

      const next = await window.ade.projectConfig.save(candidate);
      setConfig(next);
      setNotice(`Saved ${configTarget === "shared" ? ".ade/ade.yaml" : ".ade/local.yaml"}`);

      const [nextDefs, nextSuites] = await Promise.all([
        window.ade.processes.listDefinitions(),
        window.ade.tests.listSuites()
      ]);
      const [nextRuntime, nextRuns] = effectiveLaneId
        ? await Promise.all([
          window.ade.processes.listRuntime(effectiveLaneId),
          window.ade.tests.listRuns({ laneId: effectiveLaneId, limit: 120 })
        ])
        : [[], []] as [ProcessRuntime[], TestRunSummary[]];

      setDefinitions(nextDefs);
      setRuntime(nextRuntime);
      setSuites(nextSuites);
      setRuns(nextRuns);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [config, configTarget, processRows, stackRows, suiteRows, effectiveLaneId]);

  const scrollToConfigEditor = useCallback(() => {
    configEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const addQuickProcessDraft = useCallback(() => {
    setError(null);
    const commandLine = quickProcessCommand.trim();
    if (!commandLine) {
      setError("Command is required.");
      return;
    }

    let argv: string[];
    try {
      argv = parseCommandLine(commandLine);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    setProcessRows((prev) => [
      ...prev,
      {
        id: `proc_${prev.length + 1}`,
        name: quickProcessName.trim(),
        cwd: quickProcessCwd.trim() || ".",
        commandLine,
        commandJson: JSON.stringify(argv),
        envJson: DEFAULT_ENV,
        autostart: false,
        restart: "never",
        gracefulShutdownMs: "7000",
        dependsOnCsv: "",
        readinessType: "none",
        readinessPort: "",
        readinessPattern: ""
      }
    ]);
    setNotice("Added process draft. Save config to apply.");
    scrollToConfigEditor();
  }, [quickProcessCommand, quickProcessCwd, quickProcessName, scrollToConfigEditor]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if input is focused
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === "/") {
        // Optional: Focus search
        return;
      }

      const ids = processItems.map((i) => i.definition.id);
      const idx = ids.indexOf(selectedProcessId ?? "");

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        const next = ids[idx + 1] ?? ids[0];
        if (next) setSelectedProcessId(next);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        const prev = ids[idx - 1] ?? ids[ids.length - 1];
        if (prev) setSelectedProcessId(prev);
      } else if (e.key === "s") {
        e.preventDefault();
        if (selectedProcessId && !trustRequired && effectiveLaneId) {
          const rt = runtimeById.get(selectedProcessId);
          if (rt && (rt.status === "stopped" || rt.status === "exited" || rt.status === "crashed")) {
            runWithRefresh(async () => {
              await window.ade.processes.start({ laneId: effectiveLaneId, processId: selectedProcessId });
            });
          }
        }
      } else if (e.key === "x") {
        e.preventDefault();
        if (selectedProcessId && effectiveLaneId) {
          const rt = runtimeById.get(selectedProcessId);
          if (rt && (rt.status === "running" || rt.status === "starting" || rt.status === "degraded")) {
            runWithRefresh(async () => {
              await window.ade.processes.stop({ laneId: effectiveLaneId, processId: selectedProcessId });
            });
          }
        }
      } else if (e.key === "r") {
        e.preventDefault();
        if (selectedProcessId && !trustRequired && effectiveLaneId) {
          runWithRefresh(async () => {
            await window.ade.processes.restart({ laneId: effectiveLaneId, processId: selectedProcessId });
          });
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [processItems, selectedProcessId, trustRequired, runWithRefresh, runtimeById, effectiveLaneId]);

  /* ---- Pane configs for the floating tiling layout ---- */

  /* eslint-disable @typescript-eslint/no-explicit-any -- Phosphor icons are compatible at runtime */
  const paneConfigs: Record<string, PaneConfig> = useMemo(() => ({
    overview: {
      title: "Overview",
      icon: Home as any,
      meta: project?.displayName ?? "(no project)",
      minimizable: true,
      bodyClassName: "overflow-auto",
      children: (
        <div className="space-y-3 p-3">
          {error ? (
            <div className="rounded bg-red-500/10 border-l-[3px] border-red-500 px-3 py-2 text-xs text-red-400">
              <div className="flex items-start gap-2">
                <AlertCircle size={16} weight="regular" className="mt-0.5 shrink-0" />
                <div className="min-w-0">{error}</div>
              </div>
            </div>
          ) : null}

          {notice ? (
            <div className="rounded bg-emerald-500/10 border-l-[3px] border-emerald-500 px-3 py-2 text-xs text-emerald-400">{notice}</div>
          ) : null}

          {trustRequired ? (
            <div className="rounded bg-amber-500/10 border-l-[3px] border-amber-500 px-3 py-2 text-xs text-amber-400">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2">
                  <ShieldCheck size={16} weight="regular" className="mt-0.5" />
                  <div>
                    Shared config changed and is untrusted. Start/restart/run actions are blocked until you confirm.
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    runWithRefresh(async () => {
                      await window.ade.projectConfig.confirmTrust({ sharedHash: config?.trust.sharedHash });
                    })
                  }
                >
                  Trust shared config
                </Button>
              </div>
            </div>
          ) : null}

          <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-bold tracking-tight text-fg">Project header</div>
                <div className="text-xs text-muted-fg/70">Repo summary and global stack controls</div>
              </div>
              <div className="flex items-center gap-2">
                <Chip>base: {project?.baseRef ?? "main"}</Chip>
                <Chip>{project?.displayName ?? "(no project)"}</Chip>
                <label className="flex items-center gap-2 text-xs text-muted-fg">
                  <span>Running in:</span>
                  <select
                    className="h-7 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                    value={effectiveLaneId ?? ""}
                    onChange={(e) => selectRunLane(e.target.value || null)}
                  >
                    <option value="">Select lane</option>
                    {lanes.map((lane) => (
                      <option key={lane.id} value={lane.id}>
                        {lane.name}
                      </option>
                    ))}
                  </select>
                </label>
                {effectiveLaneName ? <Chip>{effectiveLaneName}</Chip> : null}
              </div>
            </div>

            <div className="mt-2 text-xs text-muted-fg">{project?.rootPath ?? "Open a repository to manage processes/tests."}</div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                disabled={trustRequired || !effectiveLaneId}
                onClick={() => runWithRefresh(async () => {
                  if (!effectiveLaneId) return;
                  await window.ade.processes.startAll({ laneId: effectiveLaneId });
                })}
              >
                <Play size={16} weight="regular" />
                Start all
              </Button>
              <Button size="sm" variant="outline" disabled={!effectiveLaneId} onClick={() => runWithRefresh(async () => {
                if (!effectiveLaneId) return;
                await window.ade.processes.stopAll({ laneId: effectiveLaneId });
              })}>
                <Square size={16} weight="regular" />
                Stop all
              </Button>

              {stackStatuses.map(({ stack, status }) => (
                <div key={stack.id} className={cx("inline-flex items-center gap-1.5 rounded-lg bg-card border border-border px-2.5 py-1.5 border-t-2 transition-colors duration-150", status === "running" ? "border-t-emerald-500/50" : status === "error" ? "border-t-red-500/50" : status === "partial" ? "border-t-amber-500/50" : "border-t-border/30")}>
                  <Chip className={cx("text-xs", stackTone(status))}>{status}</Chip>
                  <span className="text-xs font-semibold">{stack.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    disabled={trustRequired || !effectiveLaneId}
                    onClick={() => runWithRefresh(async () => {
                      if (!effectiveLaneId) return;
                      await window.ade.processes.startStack({ laneId: effectiveLaneId, stackId: stack.id });
                    })}
                  >
                    Start
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    disabled={!effectiveLaneId}
                    onClick={() => runWithRefresh(async () => {
                      if (!effectiveLaneId) return;
                      await window.ade.processes.stopStack({ laneId: effectiveLaneId, stackId: stack.id });
                    })}
                  >
                    Stop
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-bold tracking-tight text-fg">Quick add process</div>
                <div className="text-xs text-muted-fg/70">Use this for common commands. You can fine-tune in Config editor.</div>
              </div>
              <Button size="sm" variant="outline" onClick={scrollToConfigEditor}>
                Jump to config editor
              </Button>
            </div>

            <div className="grid gap-2 md:grid-cols-[160px_1fr_1fr_auto_auto]">
              <input
                className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2.5 text-xs text-fg outline-none transition-colors focus:border-accent/40 placeholder:text-muted-fg/50"
                placeholder="Name (optional)"
                value={quickProcessName}
                onChange={(e) => setQuickProcessName(e.target.value)}
              />
              <input
                className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2.5 text-xs text-fg outline-none transition-colors focus:border-accent/40 placeholder:text-muted-fg/50"
                placeholder="Working directory, e.g. src"
                value={quickProcessCwd}
                onChange={(e) => setQuickProcessCwd(e.target.value)}
              />
              <input
                className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2.5 text-xs text-fg outline-none transition-colors focus:border-accent/40 placeholder:text-muted-fg/50"
                placeholder='Command, e.g. "pnpm dev"'
                value={quickProcessCommand}
                onChange={(e) => setQuickProcessCommand(e.target.value)}
              />
              <Button size="sm" variant="primary" onClick={addQuickProcessDraft}>
                Add process draft
              </Button>
              <Button size="sm" variant="outline" onClick={() => saveConfig().catch(() => { })}>
                Save config
              </Button>
            </div>
            <div className="mt-2 text-xs text-muted-fg">
              For commands that need a subdirectory, set <span className="font-mono">Working directory</span> instead of using <span className="font-mono">cd ... &&</span>.
            </div>
          </div>
        </div>
      )
    },
    processes: {
      title: "Processes",
      icon: Play as any,
      meta: `${processItems.length} processes`,
      minimizable: true,
      bodyClassName: "overflow-auto",
      children: (
        <div className="space-y-3 p-3">
          <div className="space-y-2">
            {processItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Play size={48} weight="regular" className="text-muted-fg/30" />
                <div className="mt-3 text-lg font-medium text-fg">No processes defined</div>
                <div className="mt-1 text-sm text-muted-fg max-w-[45ch]">
                  Use the "Quick add process" panel above or open the config editor to define your first managed process.
                </div>
              </div>
            ) : null}

            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b-2 border-accent/20 bg-surface-recessed">
                    <th className="px-3 py-2 text-xs font-medium tracking-widest uppercase text-muted-fg">Name</th>
                    <th className="w-24 px-3 py-2 text-xs font-medium tracking-widest uppercase text-muted-fg">Status</th>
                    <th className="w-24 px-3 py-2 text-xs font-medium tracking-widest uppercase text-muted-fg">Readiness</th>
                    <th className="w-16 px-3 py-2 text-xs font-medium tracking-widest uppercase text-muted-fg">PID</th>
                    <th className="w-20 px-3 py-2 text-xs font-medium tracking-widest uppercase text-muted-fg">Uptime</th>
                    <th className="w-20 px-3 py-2 text-xs font-medium tracking-widest uppercase text-muted-fg">Port</th>
                    <th className="w-32 px-3 py-2 text-xs font-medium tracking-widest uppercase text-muted-fg">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/10">
                  {processItems.map(({ definition, runtime: rowRuntime }) => {
                    const active = selectedProcessId === definition.id;
                    const isRunning = rowRuntime.status === "running" || rowRuntime.status === "starting" || rowRuntime.status === "degraded";
                    const canStart = !isRunning && !trustRequired && Boolean(effectiveLaneId);
                    const canStop = isRunning && Boolean(effectiveLaneId);
                    return (
                      <tr
                        key={definition.id}
                        className={cx("cursor-pointer transition-colors duration-150 hover:bg-muted/40", active && "bg-accent/15 border-l-2 border-accent")}
                        onClick={() => setSelectedProcessId(definition.id)}
                      >
                        <td className={cx("truncate py-2 font-medium", active ? "pl-2 pr-3" : "px-3")} title={definition.name}>
                          {definition.name}
                          {active && <span className="ml-2 font-bold text-accent">●</span>}
                        </td>
                        <td className="px-3 py-2">
                          <span className={cx("inline-block rounded-full px-2 py-0.5 text-xs font-medium", statusBadgeBg(rowRuntime.status))}>
                            {rowRuntime.status}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={cx("inline-block rounded-full px-2 py-0.5 text-xs font-medium", readinessBadgeBg(rowRuntime.readiness))}>
                            {rowRuntime.readiness}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-fg/70">{rowRuntime.pid ?? "-"}</td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-fg/70">{formatUptime(rowRuntime, nowTick)}</td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-fg/70">
                          {rowRuntime.ports.length ? rowRuntime.ports.join(",") : "-"}
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="flex items-center gap-1">
                            {isRunning ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!canStop}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (!effectiveLaneId) return;
                                  runWithRefresh(async () => {
                                    await window.ade.processes.stop({ laneId: effectiveLaneId, processId: definition.id });
                                  });
                                }}
                              >
                                Stop
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!canStart}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (!effectiveLaneId) return;
                                  runWithRefresh(async () => {
                                    await window.ade.processes.start({ laneId: effectiveLaneId, processId: definition.id });
                                  });
                                }}
                              >
                                Start
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={trustRequired || !effectiveLaneId}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (!effectiveLaneId) return;
                                runWithRefresh(async () => {
                                  await window.ade.processes.restart({ laneId: effectiveLaneId, processId: definition.id });
                                });
                              }}
                            >
                              Restart
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-lg bg-card border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-fg">Process logs</div>
                <div className="text-xs text-muted-fg">
                  {selectedProcessRuntime ? `${selectedProcessRuntime.processId} (${selectedProcessRuntime.status})` : "No process selected"}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setProcessPauseAutoscroll((v) => !v)}
                  title="Pause autoscroll"
                >
                  <SquareDashed size={16} weight="regular" />
                  {processPauseAutoscroll ? "Resume" : "Pause"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setProcessLogRaw("")}>Clear view</Button>
              </div>
            </div>

            <div className="mt-2 relative">
              <MagnifyingGlass size={14} weight="regular" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-fg/40" />
              <input
                className="h-8 w-full rounded-lg border border-border/15 bg-surface-recessed pl-8 pr-2.5 text-xs text-fg outline-none transition-colors focus:border-accent/40 placeholder:text-muted-fg/50"
                placeholder="Search log lines..."
                value={processLogSearch}
                onChange={(e) => setProcessLogSearch(e.target.value)}
              />
            </div>

            <pre
              ref={processLogRef}
              className="mt-2 h-[330px] overflow-auto rounded border border-border/10 bg-[--color-surface-recessed] p-3 font-mono text-xs leading-relaxed text-muted-fg"
            >
              {visibleProcessLog || "(no output yet)"}
            </pre>
          </div>
        </div>
      )
    },
    tests: {
      title: "Tests",
      icon: Layers as any,
      meta: `${suites.length} suites`,
      minimizable: true,
      bodyClassName: "overflow-auto",
      children: (
        <div className="space-y-3 p-3">
          <div className="space-y-2">
            {suites.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Layers size={48} weight="regular" className="text-muted-fg/30" />
                <div className="mt-3 text-lg font-medium text-fg">No test suites defined</div>
                <div className="mt-1 text-sm text-muted-fg max-w-[45ch]">
                  Define test suites in the config editor to run and track your test results from this dashboard.
                </div>
              </div>
            ) : null}

            {suites.map((suite) => {
              const last = latestRunBySuite.get(suite.id);
              const running = last?.status === "running";
              return (
                <div key={suite.id} className={cx("rounded-lg bg-card border border-border p-3 border-l-[3px] transition-colors duration-150", last?.status === "passed" ? "border-l-emerald-500/50" : last?.status === "failed" ? "border-l-red-500/50" : last?.status === "running" ? "border-l-blue-500/50" : "border-l-border/20")}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-fg">{suite.name}</div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-fg">
                        <Chip>{suite.id}</Chip>
                        <span className={cx("inline-block rounded-full px-2 py-0.5 text-xs font-medium", testStatusBadgeBg(last?.status))}>{last?.status ?? "never"}</span>
                        <Chip>duration: {formatDurationMs(last?.durationMs ?? null)}</Chip>
                        <Chip>time: {formatDate(last?.startedAt ?? null)}</Chip>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={trustRequired || running || !effectiveLaneId}
                        onClick={() => runWithRefresh(async () => {
                          if (!effectiveLaneId) return;
                          const next = await window.ade.tests.run({ laneId: effectiveLaneId, suiteId: suite.id });
                          setSelectedRunId(next.id);
                        })}
                      >
                        <Play size={14} weight="regular" />
                        {last ? "Rerun" : "Run"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!running || !last}
                        onClick={() => {
                          if (!last) return;
                          runWithRefresh(async () => { await window.ade.tests.stop({ runId: last.id }); });
                        }}
                      >
                        <Square size={14} weight="regular" />
                        Stop
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="rounded-lg bg-card border border-border p-2">
              <div className="mb-1.5 text-xs font-medium tracking-widest uppercase text-muted-fg">Run history</div>
              <div className="max-h-[180px] space-y-0.5 overflow-auto">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    className={cx(
                      "flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition-colors duration-150 hover:bg-muted/40",
                      selectedRunId === run.id && "bg-accent/10 ring-1 ring-accent/30"
                    )}
                    onClick={() => setSelectedRunId(run.id)}
                  >
                    <span className="truncate font-medium">{run.suiteName}</span>
                    <span className={cx("ml-2 shrink-0 inline-block rounded-full px-2 py-0.5 text-xs font-medium", testStatusBadgeBg(run.status))}>{run.status}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-lg bg-card border border-border p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-fg">Suite logs</div>
                <div className="text-xs text-muted-fg">
                  {selectedRun ? `${selectedRun.suiteName} • ${selectedRun.status}` : "Select a run"}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setTestLogRaw("")}>Clear view</Button>
            </div>

            <div className="mt-2 relative">
              <MagnifyingGlass size={14} weight="regular" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-fg/40" />
              <input
                className="h-8 w-full rounded-lg border border-border/15 bg-surface-recessed pl-8 pr-2.5 text-xs text-fg outline-none transition-colors focus:border-accent/40 placeholder:text-muted-fg/50"
                placeholder="Search log lines..."
                value={testLogSearch}
                onChange={(e) => setTestLogSearch(e.target.value)}
              />
            </div>

            <pre
              ref={testLogRef}
              className="mt-2 h-[330px] overflow-auto rounded border border-border/10 bg-[--color-surface-recessed] p-3 font-mono text-xs leading-relaxed text-muted-fg"
            >
              {visibleTestLog || "(no output yet)"}
            </pre>
          </div>
        </div>
      )
    },
    config: {
      title: "Config",
      icon: Activity as any,
      meta: configTarget === "shared" ? ".ade/ade.yaml" : ".ade/local.yaml",
      minimizable: true,
      bodyClassName: "overflow-auto",
      children: (
        <div className="space-y-3 p-3">
          <CiImportPanel
            onImported={() => {
              refreshAll().catch(() => { });
            }}
          />

          <div ref={configEditorRef}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-fg">Config editor</div>
                <div className="text-xs text-muted-fg">Processes, stack buttons, and test suites</div>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-fg">Editing</label>
                <select
                  className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                  value={configTarget}
                  onChange={(e) => setConfigTarget(e.target.value as "shared" | "local")}
                >
                  <option value="shared">.ade/ade.yaml</option>
                  <option value="local">.ade/local.yaml</option>
                </select>
                <Button size="sm" variant="primary" onClick={() => saveConfig().catch(() => { })}>
                  <Save size={16} weight="regular" />
                  Save config
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-2">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-semibold">Processes</div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setProcessRows((prev) => [
                        ...prev,
                        {
                          id: `proc_${prev.length + 1}`,
                          name: "",
                          cwd: ".",
                          commandLine: DEFAULT_PROCESS_COMMAND_LINE,
                          commandJson: DEFAULT_PROCESS_COMMAND,
                          envJson: DEFAULT_ENV,
                          autostart: false,
                          restart: "never",
                          gracefulShutdownMs: "7000",
                          dependsOnCsv: "",
                          readinessType: "none",
                          readinessPort: "",
                          readinessPattern: ""
                        }
                      ])
                    }
                  >
                    Add process
                  </Button>
                </div>

                <div className="space-y-2">
                  {processRows.map((row, idx) => (
                    <div key={`${row.id}-${idx}`} className="rounded-lg bg-card border border-border p-2 transition-colors duration-150">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="text-xs font-semibold">{row.id || `process ${idx + 1}`}</div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setProcessRows((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          <Trash2 size={14} weight="regular" />
                          Remove
                        </Button>
                      </div>

                      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder="id"
                          value={row.id}
                          onChange={(e) =>
                            setProcessRows((prev) => prev.map((p, i) => (i === idx ? { ...p, id: e.target.value } : p)))
                          }
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder="name"
                          value={row.name}
                          onChange={(e) =>
                            setProcessRows((prev) => prev.map((p, i) => (i === idx ? { ...p, name: e.target.value } : p)))
                          }
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder="cwd (use this instead of cd ... &&)"
                          value={row.cwd}
                          onChange={(e) =>
                            setProcessRows((prev) => prev.map((p, i) => (i === idx ? { ...p, cwd: e.target.value } : p)))
                          }
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder='command, e.g. pnpm dev'
                          value={row.commandLine}
                          onChange={(e) =>
                            setProcessRows((prev) => prev.map((p, i) => (i === idx ? { ...p, commandLine: e.target.value } : p)))
                          }
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder='env JSON, e.g. {"PORT":"3000"}'
                          value={row.envJson}
                          onChange={(e) =>
                            setProcessRows((prev) => prev.map((p, i) => (i === idx ? { ...p, envJson: e.target.value } : p)))
                          }
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder="dependsOn (comma-separated ids)"
                          value={row.dependsOnCsv}
                          onChange={(e) =>
                            setProcessRows((prev) => prev.map((p, i) => (i === idx ? { ...p, dependsOnCsv: e.target.value } : p)))
                          }
                        />
                        <select
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          value={row.restart}
                          onChange={(e) =>
                            setProcessRows((prev) =>
                              prev.map((p, i) => (i === idx ? { ...p, restart: e.target.value as ProcessRestartPolicy } : p))
                            )
                          }
                        >
                          <option value="never">restart: never</option>
                          <option value="on-failure">restart: on-failure</option>
                          <option value="always">restart: always</option>
                          <option value="on_crash">restart: on_crash</option>
                        </select>
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder="gracefulShutdownMs"
                          value={row.gracefulShutdownMs}
                          onChange={(e) =>
                            setProcessRows((prev) =>
                              prev.map((p, i) => (i === idx ? { ...p, gracefulShutdownMs: e.target.value } : p))
                            )
                          }
                        />
                        <select
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          value={row.readinessType}
                          onChange={(e) =>
                            setProcessRows((prev) =>
                              prev.map((p, i) =>
                                i === idx ? { ...p, readinessType: e.target.value as "none" | "port" | "logRegex" } : p
                              )
                            )
                          }
                        >
                          <option value="none">readiness: none</option>
                          <option value="port">readiness: port</option>
                          <option value="logRegex">readiness: logRegex</option>
                        </select>
                        {row.readinessType === "port" ? (
                          <input
                            className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                            placeholder="readiness port"
                            value={row.readinessPort}
                            onChange={(e) =>
                              setProcessRows((prev) =>
                                prev.map((p, i) => (i === idx ? { ...p, readinessPort: e.target.value } : p))
                              )
                            }
                          />
                        ) : null}
                        {row.readinessType === "logRegex" ? (
                          <input
                            className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                            placeholder="readiness pattern"
                            value={row.readinessPattern}
                            onChange={(e) =>
                              setProcessRows((prev) =>
                                prev.map((p, i) => (i === idx ? { ...p, readinessPattern: e.target.value } : p))
                              )
                            }
                          />
                        ) : null}
                        <label className="inline-flex h-8 items-center gap-2 rounded bg-card px-2 text-xs text-fg">
                          <input
                            type="checkbox"
                            checked={row.autostart}
                            onChange={(e) =>
                              setProcessRows((prev) => prev.map((p, i) => (i === idx ? { ...p, autostart: e.target.checked } : p)))
                            }
                          />
                          autostart
                        </label>
                        <details className="rounded-lg border border-border/10 bg-card px-2 py-1 text-xs md:col-span-2 xl:col-span-3">
                          <summary className="cursor-pointer select-none text-muted-fg">Advanced: argv JSON (optional)</summary>
                          <input
                            className="mt-2 h-8 w-full rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                            placeholder='["npm","run","dev"]'
                            value={row.commandJson}
                            onChange={(e) =>
                              setProcessRows((prev) => prev.map((p, i) => (i === idx ? { ...p, commandJson: e.target.value } : p)))
                            }
                          />
                        </details>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-2">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-semibold">Stack buttons</div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setStackRows((prev) => [
                        ...prev,
                        { id: `stack_${prev.length + 1}`, name: "", processIdsCsv: "", startOrder: "parallel" }
                      ])
                    }
                  >
                    Add stack
                  </Button>
                </div>

                <div className="space-y-2">
                  {stackRows.map((row, idx) => (
                    <div key={`${row.id}-${idx}`} className="rounded-lg bg-card border border-border p-2 transition-colors duration-150">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="text-xs font-semibold">{row.id || `stack ${idx + 1}`}</div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setStackRows((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          <Trash2 size={14} weight="regular" />
                          Remove
                        </Button>
                      </div>

                      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder="id"
                          value={row.id}
                          onChange={(e) => setStackRows((prev) => prev.map((p, i) => (i === idx ? { ...p, id: e.target.value } : p)))}
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder="name"
                          value={row.name}
                          onChange={(e) =>
                            setStackRows((prev) => prev.map((p, i) => (i === idx ? { ...p, name: e.target.value } : p)))
                          }
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder="process ids (comma-separated)"
                          value={row.processIdsCsv}
                          onChange={(e) =>
                            setStackRows((prev) =>
                              prev.map((p, i) => (i === idx ? { ...p, processIdsCsv: e.target.value } : p))
                            )
                          }
                        />
                        <select
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          value={row.startOrder}
                          onChange={(e) =>
                            setStackRows((prev) =>
                              prev.map((p, i) =>
                                i === idx ? { ...p, startOrder: e.target.value as "parallel" | "dependency" } : p
                              )
                            )
                          }
                        >
                          <option value="parallel">startOrder: parallel</option>
                          <option value="dependency">startOrder: dependency</option>
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-border/10 bg-card backdrop-blur-sm p-2">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-semibold">Test suites</div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setSuiteRows((prev) => [
                        ...prev,
                        {
                          id: `suite_${prev.length + 1}`,
                          name: "",
                          cwd: ".",
                          commandJson: DEFAULT_TEST_COMMAND,
                          envJson: DEFAULT_ENV,
                          timeoutMs: "",
                          tagsCsv: ""
                        }
                      ])
                    }
                  >
                    Add suite
                  </Button>
                </div>

                <div className="space-y-2">
                  {suiteRows.map((row, idx) => (
                    <div key={`${row.id}-${idx}`} className="rounded-lg bg-card border border-border p-2 transition-colors duration-150">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="text-xs font-semibold">{row.id || `suite ${idx + 1}`}</div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSuiteRows((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          <Trash2 size={14} weight="regular" />
                          Remove
                        </Button>
                      </div>

                      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder="id"
                          value={row.id}
                          onChange={(e) => setSuiteRows((prev) => prev.map((p, i) => (i === idx ? { ...p, id: e.target.value } : p)))}
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder="name"
                          value={row.name}
                          onChange={(e) => setSuiteRows((prev) => prev.map((p, i) => (i === idx ? { ...p, name: e.target.value } : p)))}
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder="cwd"
                          value={row.cwd}
                          onChange={(e) => setSuiteRows((prev) => prev.map((p, i) => (i === idx ? { ...p, cwd: e.target.value } : p)))}
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder='command JSON, e.g. ["npm","run","test:unit"]'
                          value={row.commandJson}
                          onChange={(e) =>
                            setSuiteRows((prev) => prev.map((p, i) => (i === idx ? { ...p, commandJson: e.target.value } : p)))
                          }
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder='env JSON, e.g. {"CI":"1"}'
                          value={row.envJson}
                          onChange={(e) => setSuiteRows((prev) => prev.map((p, i) => (i === idx ? { ...p, envJson: e.target.value } : p)))}
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg"
                          placeholder="timeoutMs (optional)"
                          value={row.timeoutMs}
                          onChange={(e) =>
                            setSuiteRows((prev) => prev.map((p, i) => (i === idx ? { ...p, timeoutMs: e.target.value } : p)))
                          }
                        />
                        <input
                          className="h-8 rounded-lg border border-border/15 bg-surface-recessed px-2 text-xs text-fg md:col-span-2 xl:col-span-3"
                          placeholder="tags (comma-separated: unit, lint, integration, e2e, custom)"
                          value={row.tagsCsv}
                          onChange={(e) => setSuiteRows((prev) => prev.map((p, i) => (i === idx ? { ...p, tagsCsv: e.target.value } : p)))}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )
    }
  }), [
    error, notice, trustRequired, config, project, effectiveLaneId, effectiveLaneName,
    lanes, selectRunLane, stackStatuses, runWithRefresh, quickProcessName, quickProcessCwd,
    quickProcessCommand, addQuickProcessDraft, saveConfig, scrollToConfigEditor,
    processItems, selectedProcessId, selectedProcessRuntime, nowTick, processPauseAutoscroll,
    processLogSearch, visibleProcessLog, suites, latestRunBySuite, runs, selectedRunId,
    selectedRun, testLogSearch, visibleTestLog, configTarget, processRows, stackRows,
    suiteRows, refreshAll, loading
  ]);

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <div className="flex items-center justify-between px-5 py-3 mb-1 shrink-0">
        <div>
          <div className="text-base font-bold tracking-tight text-fg">Run</div>
          <div className="text-xs text-muted-fg/70">Managed processes, lane-scoped stack controls, tests, and config</div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setNotice(null);
              refreshAll().catch(() => { });
            }}
            title="Refresh"
          >
            <RefreshCw size={16} weight="regular" className={cx(loading && "animate-spin")} />
            Refresh
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              openRepo().catch((err) => {
                setError(err instanceof Error ? err.message : String(err));
              });
            }}
          >
            <FolderOpen size={16} weight="regular" />
            Open repo
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              window.ade.project.openAdeFolder().catch((err) => {
                setError(err instanceof Error ? err.message : String(err));
              });
            }}
          >
            <ExternalLink size={16} weight="regular" />
            Open .ade
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <PaneTilingLayout
          layoutId="project-home:tiling:v1"
          tree={PROJECT_HOME_TILING_TREE}
          panes={paneConfigs}
        />
      </div>
    </div>
  );
}
