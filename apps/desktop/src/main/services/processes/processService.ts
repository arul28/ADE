import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import type {
  EffectiveProjectConfig,
  LaneOverlayOverrides,
  LaneSummary,
  ProcessActionArgs,
  ProcessDefinition,
  ProcessEvent,
  ProcessRuntime,
  ProcessRuntimeStatus,
  ProcessStackArgs,
  StackStartOrder,
  StackButtonDefinition,
} from "../../../shared/types";
import { stripAnsi } from "../../utils/ansiStrip";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createLaneService } from "../lanes/laneService";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "../sessions/sessionService";
import { matchLaneOverlayPolicies } from "../config/laneOverlayMatcher";
import { nowIso, resolvePathWithinRoot } from "../shared/utils";

type ManagedTerminationReason = "stopped" | "killed" | "crashed";

type ManagedProcessEntry = {
  runId: string;
  laneId: string;
  processId: string;
  definition: ProcessDefinition;
  runtime: ProcessRuntime;
  stopIntent: ManagedTerminationReason | null;
  sessionId: string | null;
  ptyId: string | null;
  transcriptPath: string | null;
  readinessRegex: RegExp | null;
  readinessTimeout: ReturnType<typeof setTimeout> | null;
  readinessInterval: ReturnType<typeof setInterval> | null;
  healthFailures: number;
  healthInterval: ReturnType<typeof setInterval> | null;
};

const DEFAULT_LOG_TAIL_BYTES = 180_000;
const PROCESS_TERMINATION_WAIT_MS = 10_000;
const MAX_PROCESS_HISTORY_PER_LANE_PROCESS = 20;
const READINESS_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_INTERVAL_MS = 2_500;
const HEALTH_DEGRADED_AFTER_FAILURES = 2;
const RESTART_BACKOFF_BASE_MS = 400;
const RESTART_BACKOFF_MAX_MS = 30_000;

function clampMaxBytes(maxBytes: number | undefined, fallback: number): number {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes)) return fallback;
  return Math.max(1024, Math.min(2_000_000, Math.floor(maxBytes)));
}

function readTail(filePath: string, maxBytes: number): string {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return stripAnsi(buf.toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function isProcessActive(status: ProcessRuntimeStatus): boolean {
  return status === "starting" || status === "running" || status === "degraded" || status === "stopping";
}

function sortByDefinitions(ids: string[], definitions: Map<string, ProcessDefinition>): string[] {
  const ordered = [...ids];
  const orderMap = new Map(Array.from(definitions.keys()).map((key, idx) => [key, idx]));
  ordered.sort((a, b) => (orderMap.get(a) ?? Number.MAX_SAFE_INTEGER) - (orderMap.get(b) ?? Number.MAX_SAFE_INTEGER));
  return ordered;
}

function resolveDependencyOrder(processIds: string[], definitions: Map<string, ProcessDefinition>): string[] {
  const selected = new Set(processIds);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: string[] = [];

  const visit = (id: string) => {
    if (!selected.has(id) || visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Circular dependency detected: process '${id}' is part of a dependency cycle`);
    }
    visiting.add(id);
    const definition = definitions.get(id);
    for (const dependencyId of definition?.dependsOn ?? []) {
      if (selected.has(dependencyId)) visit(dependencyId);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  };

  for (const id of processIds) visit(id);
  return ordered;
}

function checkPortReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };
    socket.setTimeout(600);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function runtimeSortValue(runtime: ProcessRuntime): number {
  const value = runtime.updatedAt || runtime.startedAt || runtime.endedAt || "";
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

export function createProcessService({
  db,
  projectId,
  logger,
  laneService,
  projectConfigService,
  sessionService,
  ptyService,
  getLaneRuntimeEnv,
  broadcastEvent,
}: {
  db: AdeDb;
  projectId: string;
  logger: Logger;
  laneService: ReturnType<typeof createLaneService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  sessionService: Pick<ReturnType<typeof createSessionService>, "get">;
  ptyService: Pick<ReturnType<typeof createPtyService>, "create" | "dispose" | "onData" | "onExit">;
  getLaneRuntimeEnv?: (laneId: string) => Promise<Record<string, string>> | Record<string, string>;
  broadcastEvent: (ev: ProcessEvent) => void;
}) {
  const entries = new Map<string, ManagedProcessEntry>();
  const sessionToRunId = new Map<string, string>();
  const ptyToRunId = new Map<string, string>();
  const terminationWaiters = new Map<string, Set<() => void>>();
  const restartAttemptsByProcess = new Map<string, number>();

  const cloneRuntime = (runtime: ProcessRuntime): ProcessRuntime => {
    const copy = { ...runtime };
    if (copy.startedAt && isProcessActive(copy.status)) {
      copy.uptimeMs = Math.max(0, Date.now() - Date.parse(copy.startedAt));
    } else {
      copy.uptimeMs = null;
    }
    return copy;
  };

  const listEntries = (filter?: (entry: ManagedProcessEntry) => boolean): ManagedProcessEntry[] =>
    Array.from(entries.values())
      .filter((entry) => (filter ? filter(entry) : true))
      .sort((left, right) => runtimeSortValue(right.runtime) - runtimeSortValue(left.runtime));

  const listEntriesForLaneProcess = (laneId: string, processId: string): ManagedProcessEntry[] =>
    listEntries((entry) => entry.laneId === laneId && entry.processId === processId);

  const listActiveEntriesForLaneProcess = (laneId: string, processId: string): ManagedProcessEntry[] =>
    listEntriesForLaneProcess(laneId, processId).filter((entry) => isProcessActive(entry.runtime.status));

  const processKey = (laneId: string, processId: string) => `${laneId}:${processId}`;

  const pruneOldEntriesForLaneProcess = (laneId: string, processId: string) => {
    const history = listEntriesForLaneProcess(laneId, processId);
    if (history.length <= MAX_PROCESS_HISTORY_PER_LANE_PROCESS) return;
    for (const entry of history.slice(MAX_PROCESS_HISTORY_PER_LANE_PROCESS)) {
      if (isProcessActive(entry.runtime.status)) continue;
      if (entry.sessionId) sessionToRunId.delete(entry.sessionId);
      if (entry.ptyId) ptyToRunId.delete(entry.ptyId);
      terminationWaiters.delete(entry.runId);
      entries.delete(entry.runId);
    }
  };

  const bindLiveSession = (entry: ManagedProcessEntry, args: { sessionId: string | null; ptyId: string | null }) => {
    if (entry.sessionId) sessionToRunId.delete(entry.sessionId);
    if (entry.ptyId) ptyToRunId.delete(entry.ptyId);
    entry.sessionId = args.sessionId;
    entry.ptyId = args.ptyId;
    entry.runtime.sessionId = args.sessionId;
    entry.runtime.ptyId = args.ptyId;
    if (args.sessionId) sessionToRunId.set(args.sessionId, entry.runId);
    if (args.ptyId) ptyToRunId.set(args.ptyId, entry.runId);
  };

  const persistAggregateRuntime = (laneId: string, processId: string) => {
    const latest = listEntriesForLaneProcess(laneId, processId)[0] ?? null;
    if (!latest) {
      db.run("delete from process_runtime where project_id = ? and lane_id = ? and process_key = ?", [
        projectId,
        laneId,
        processId,
      ]);
      return;
    }

    const runtime = latest.runtime;
    db.run(
      `
        insert into process_runtime(project_id, lane_id, process_key, status, pid, started_at, ended_at, exit_code, readiness, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(project_id, lane_id, process_key) do update set
          status=excluded.status,
          pid=excluded.pid,
          started_at=excluded.started_at,
          ended_at=excluded.ended_at,
          exit_code=excluded.exit_code,
          readiness=excluded.readiness,
          updated_at=excluded.updated_at
      `,
      [
        projectId,
        laneId,
        processId,
        runtime.status,
        runtime.pid,
        runtime.startedAt,
        runtime.endedAt,
        runtime.lastExitCode,
        runtime.readiness,
        runtime.updatedAt,
      ],
    );
  };

  const emitRuntime = (entry: ManagedProcessEntry) => {
    entry.runtime.updatedAt = nowIso();
    persistAggregateRuntime(entry.laneId, entry.processId);
    broadcastEvent({ type: "runtime", runtime: cloneRuntime(entry.runtime) });
  };

  const clearReadinessTimers = (entry: ManagedProcessEntry) => {
    if (entry.readinessTimeout) {
      clearTimeout(entry.readinessTimeout);
      entry.readinessTimeout = null;
    }
    if (entry.readinessInterval) {
      clearInterval(entry.readinessInterval);
      entry.readinessInterval = null;
    }
  };

  const clearHealthTimers = (entry: ManagedProcessEntry) => {
    if (entry.healthInterval) {
      clearInterval(entry.healthInterval);
      entry.healthInterval = null;
    }
    entry.healthFailures = 0;
  };

  const markReadinessReady = (entry: ManagedProcessEntry) => {
    clearReadinessTimers(entry);
    entry.runtime.readiness = "ready";
    if (entry.runtime.status === "starting") entry.runtime.status = "running";
    emitRuntime(entry);

    clearHealthTimers(entry);
    if (entry.definition.readiness.type !== "port") return;
    const port = entry.definition.readiness.port;
    entry.healthInterval = setInterval(() => {
      if (entry.runtime.status !== "running" && entry.runtime.status !== "degraded") return;
      void checkPortReady(port)
        .then((ready) => {
          if (ready) {
            entry.healthFailures = 0;
            if (entry.runtime.status === "degraded" || entry.runtime.readiness !== "ready") {
              entry.runtime.status = "running";
              entry.runtime.readiness = "ready";
              emitRuntime(entry);
            }
            return;
          }
          entry.healthFailures += 1;
          if (entry.healthFailures < HEALTH_DEGRADED_AFTER_FAILURES) return;
          if (entry.runtime.status !== "degraded" || entry.runtime.readiness !== "not_ready") {
            entry.runtime.status = "degraded";
            entry.runtime.readiness = "not_ready";
            emitRuntime(entry);
          }
        })
        .catch(() => {});
    }, HEALTH_CHECK_INTERVAL_MS);
  };

  const markReadinessFailed = (entry: ManagedProcessEntry) => {
    clearReadinessTimers(entry);
    if (!isProcessActive(entry.runtime.status)) return;
    entry.runtime.readiness = "not_ready";
    entry.runtime.status = "degraded";
    emitRuntime(entry);
  };

  const setupReadinessChecks = (entry: ManagedProcessEntry) => {
    clearReadinessTimers(entry);
    clearHealthTimers(entry);
    entry.readinessRegex = null;

    const readiness = entry.definition.readiness;
    if (readiness.type === "none") {
      markReadinessReady(entry);
      return;
    }

    entry.runtime.status = "starting";
    entry.runtime.readiness = "unknown";
    emitRuntime(entry);

    entry.readinessTimeout = setTimeout(() => {
      markReadinessFailed(entry);
    }, READINESS_TIMEOUT_MS);

    if (readiness.type === "port") {
      entry.readinessInterval = setInterval(() => {
        void checkPortReady(readiness.port)
          .then((ready) => {
            if (ready) markReadinessReady(entry);
          })
          .catch(() => {});
      }, 500);
      return;
    }

    try {
      entry.readinessRegex = new RegExp(readiness.pattern);
    } catch {
      markReadinessFailed(entry);
    }
  };

  const emitLog = (entry: ManagedProcessEntry, chunk: string) => {
    broadcastEvent({
      type: "log",
      runId: entry.runId,
      laneId: entry.laneId,
      processId: entry.processId,
      stream: "stdout",
      chunk,
      ts: nowIso(),
    });
  };

  const upsertRunStart = (runId: string, laneId: string, processId: string, startedAt: string, logPath: string) => {
    db.run(
      `
        insert into process_runs(id, project_id, lane_id, process_key, started_at, ended_at, exit_code, termination_reason, log_path)
        values (?, ?, ?, ?, ?, null, null, 'stopped', ?)
      `,
      [runId, projectId, laneId, processId, startedAt, logPath],
    );
  };

  const upsertRunEnd = (runId: string, endedAt: string, exitCode: number | null, reason: ManagedTerminationReason) => {
    db.run("update process_runs set ended_at = ?, exit_code = ?, termination_reason = ? where id = ?", [
      endedAt,
      exitCode,
      reason,
      runId,
    ]);
  };

  const getLaneSummary = async (laneId: string): Promise<LaneSummary> => {
    const lanes = await laneService.list({ includeArchived: false });
    const lane = lanes.find((entry) => entry.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    return lane;
  };

  const getLaneOverlay = async (laneId: string, config: EffectiveProjectConfig): Promise<LaneOverlayOverrides> => {
    const lane = await getLaneSummary(laneId);
    return matchLaneOverlayPolicies(lane, config.laneOverlayPolicies);
  };

  const applyProcessFilter = (processIds: string[], overlay: LaneOverlayOverrides): string[] => {
    const allowed = overlay.processIds;
    if (!allowed || allowed.length === 0) return processIds;
    const allowedSet = new Set(allowed);
    return processIds.filter((id) => allowedSet.has(id));
  };

  const createEntry = (laneId: string, definition: ProcessDefinition, runId: string, sessionId: string, startedAt: string) => {
    const entry: ManagedProcessEntry = {
      runId,
      laneId,
      processId: definition.id,
      definition,
      stopIntent: null,
      sessionId,
      ptyId: null,
      transcriptPath: null,
      readinessRegex: null,
      readinessTimeout: null,
      readinessInterval: null,
      healthFailures: 0,
      healthInterval: null,
      runtime: {
        runId,
        laneId,
        processId: definition.id,
        status: "starting",
        readiness: "unknown",
        pid: null,
        sessionId,
        ptyId: null,
        startedAt,
        endedAt: null,
        exitCode: null,
        lastExitCode: null,
        lastEndedAt: null,
        uptimeMs: null,
        ports: definition.readiness.type === "port" ? [definition.readiness.port] : [],
        logPath: null,
        updatedAt: startedAt,
      },
    };
    entries.set(runId, entry);
    sessionToRunId.set(sessionId, runId);
    return entry;
  };

  const handleProcessExit = (entry: ManagedProcessEntry, exitCode: number | null) => {
    clearReadinessTimers(entry);
    clearHealthTimers(entry);
    const endedAt = nowIso();
    const stopIntent = entry.stopIntent;
    const reason = stopIntent ?? (exitCode === 0 ? "stopped" : "crashed");
    const runtimeStatus: ProcessRuntimeStatus = reason === "crashed" ? "crashed" : "exited";

    if (entry.sessionId) sessionToRunId.delete(entry.sessionId);
    if (entry.ptyId) ptyToRunId.delete(entry.ptyId);

    entry.stopIntent = null;
    entry.ptyId = null;
    entry.runtime.pid = null;
    entry.runtime.ptyId = null;
    entry.runtime.status = runtimeStatus;
    entry.runtime.readiness = "unknown";
    entry.runtime.endedAt = endedAt;
    entry.runtime.lastEndedAt = endedAt;
    entry.runtime.exitCode = exitCode;
    entry.runtime.lastExitCode = exitCode;
    entry.runtime.logPath = entry.transcriptPath;
    emitRuntime(entry);
    upsertRunEnd(entry.runId, endedAt, exitCode, reason);
    const waiters = terminationWaiters.get(entry.runId);
    if (waiters) {
      terminationWaiters.delete(entry.runId);
      for (const resolve of waiters) resolve();
    }

    const restartKey = processKey(entry.laneId, entry.processId);
    const policy = entry.definition.restart ?? "never";
    const shouldAutoRestart =
      policy === "always"
      || ((policy === "on-failure" || policy === "on_crash") && (exitCode == null || exitCode !== 0));
    if (!stopIntent && shouldAutoRestart) {
      const nextAttempts = (restartAttemptsByProcess.get(restartKey) ?? 0) + 1;
      restartAttemptsByProcess.set(restartKey, nextAttempts);
      const attempt = Math.min(8, Math.max(1, nextAttempts));
      const delayMs = Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_BASE_MS * 2 ** (attempt - 1));
      const jitterMs = Math.floor(Math.random() * 250);
      setTimeout(() => {
        void startById(entry.laneId, entry.processId, { skipTrust: true }).catch((error) => {
          logger.warn("process.auto_restart_failed", {
            laneId: entry.laneId,
            processId: entry.processId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, delayMs + jitterMs);
    } else {
      restartAttemptsByProcess.delete(restartKey);
    }
    pruneOldEntriesForLaneProcess(entry.laneId, entry.processId);
  };

  const waitForEntryStopped = (entry: ManagedProcessEntry): Promise<void> => {
    if (!isProcessActive(entry.runtime.status)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = terminationWaiters.get(entry.runId);
        if (waiters) {
          waiters.delete(resolveAndClear);
          if (waiters.size === 0) terminationWaiters.delete(entry.runId);
        }
        resolve();
      }, PROCESS_TERMINATION_WAIT_MS);
      const resolveAndClear = () => {
        clearTimeout(timer);
        resolve();
      };
      const waiters = terminationWaiters.get(entry.runId) ?? new Set<() => void>();
      waiters.add(resolveAndClear);
      terminationWaiters.set(entry.runId, waiters);
      if (!isProcessActive(entry.runtime.status)) {
        waiters.delete(resolveAndClear);
        if (waiters.size === 0) terminationWaiters.delete(entry.runId);
        resolveAndClear();
      }
    });
  };

  const waitForEntriesStopped = async (targetEntries: ManagedProcessEntry[]): Promise<void> => {
    await Promise.all(targetEntries.map((entry) => waitForEntryStopped(entry)));
  };

  const handleStartFailure = (args: {
    entry: ManagedProcessEntry;
    startedAt: string;
    error: unknown;
  }) => {
    const { entry, startedAt, error } = args;
    const endedAt = nowIso();
    if (entry.sessionId) sessionToRunId.delete(entry.sessionId);
    if (entry.ptyId) ptyToRunId.delete(entry.ptyId);

    entry.stopIntent = null;
    entry.ptyId = null;
    entry.transcriptPath = sessionService.get(entry.sessionId ?? "")?.transcriptPath?.trim() || null;
    entry.runtime.pid = null;
    entry.runtime.status = "crashed";
    entry.runtime.readiness = "unknown";
    entry.runtime.startedAt = startedAt;
    entry.runtime.endedAt = endedAt;
    entry.runtime.lastEndedAt = endedAt;
    entry.runtime.exitCode = null;
    entry.runtime.lastExitCode = null;
    entry.runtime.logPath = entry.transcriptPath;
    emitRuntime(entry);

    upsertRunStart(entry.runId, entry.laneId, entry.processId, startedAt, entry.transcriptPath ?? "");
    upsertRunEnd(entry.runId, endedAt, null, "crashed");

    logger.warn("process.start_failed", {
      laneId: entry.laneId,
      processId: entry.processId,
      command: entry.definition.command,
      envPath: process.env.PATH ?? "",
      envShell: process.env.SHELL ?? "",
      resourcesPath: process.resourcesPath ?? "",
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const startByDefinition = async (
    laneId: string,
    definition: ProcessDefinition,
    opts: { skipTrust?: boolean; overlay?: LaneOverlayOverrides } = {},
  ): Promise<ProcessRuntime> => {
    if (!opts.skipTrust) projectConfigService.getExecutableConfig();

    if (!definition.command.length || !definition.command[0]?.trim()) {
      throw new Error(`Process '${definition.id}' has an empty command`);
    }

    const laneRoot = laneService.getLaneWorktreePath(laneId);
    const configuredCwd = opts.overlay?.cwd?.trim() ? opts.overlay.cwd.trim() : definition.cwd.trim();
    const allowExternalCwd = path.isAbsolute(configuredCwd);
    let cwd: string;
    if (allowExternalCwd) {
      try {
        const resolved = path.resolve(configuredCwd);
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory()) throw new Error("Path is not a directory");
        cwd = fs.realpathSync(resolved);
      } catch {
        throw new Error(`Process '${definition.id}' cwd does not exist: ${configuredCwd}`);
      }
    } else {
      const cwdCandidate = path.join(laneRoot, configuredCwd);
      try {
        cwd = resolvePathWithinRoot(laneRoot, cwdCandidate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Path does not exist")) {
          throw new Error(`Process '${definition.id}' cwd does not exist: ${configuredCwd}`);
        }
        throw new Error(`Process '${definition.id}' cwd must stay within the lane workspace`);
      }
    }

    const laneRuntimeEnv = (await getLaneRuntimeEnv?.(laneId)) ?? {};
    const env = {
      ...process.env,
      FORCE_COLOR: "1",
      TERM: "xterm-256color",
      ...laneRuntimeEnv,
      ...definition.env,
      ...(opts.overlay?.env ?? {}),
    };

    const startedAt = nowIso();
    const runId = randomUUID();
    const sessionId = randomUUID();
    const entry = createEntry(laneId, definition, runId, sessionId, startedAt);
    emitRuntime(entry);

    try {
      const result = await ptyService.create({
        sessionId,
        allowNewSessionId: true,
        allowExternalCwd,
        laneId,
        cwd,
        cols: 120,
        rows: 32,
        title: definition.name,
        tracked: true,
        toolType: "run-shell",
        command: definition.command[0],
        args: definition.command.slice(1),
        env,
      });

      bindLiveSession(entry, { sessionId: result.sessionId, ptyId: result.ptyId });
      const session = sessionService.get(result.sessionId);
      entry.transcriptPath = session?.transcriptPath?.trim() || null;
      entry.runtime.pid = result.pid;
      entry.runtime.logPath = entry.transcriptPath;
      entry.runtime.status = "starting";
      entry.runtime.readiness = "unknown";
      upsertRunStart(runId, laneId, definition.id, startedAt, entry.transcriptPath ?? "");
      emitRuntime(entry);
      setupReadinessChecks(entry);

      logger.info("process.start", {
        laneId,
        processId: definition.id,
        cwd,
        command: definition.command,
        runId,
        envPath: process.env.PATH ?? "",
        envShell: process.env.SHELL ?? "",
      });
      return cloneRuntime(entry.runtime);
    } catch (error) {
      handleStartFailure({ entry, startedAt, error });
      throw error;
    }
  };

  const startById = async (laneId: string, processId: string, opts: { skipTrust?: boolean } = {}) => {
    const config = opts.skipTrust ? projectConfigService.getEffective() : projectConfigService.getExecutableConfig();
    const overlay = await getLaneOverlay(laneId, config);
    const allowedIds = applyProcessFilter(config.processes.map((proc) => proc.id), overlay);
    if (!allowedIds.includes(processId)) {
      throw new Error(`Process '${processId}' is disabled by lane overlay policy for this lane`);
    }
    const definition = config.processes.find((proc) => proc.id === processId);
    if (!definition) throw new Error(`Process not found: ${processId}`);
    return await startByDefinition(laneId, definition, { ...opts, overlay });
  };

  const selectEntriesForAction = (arg: ProcessActionArgs): ManagedProcessEntry[] => {
    if (arg.runId) {
      const entry = entries.get(arg.runId);
      if (!entry) return [];
      if (entry.laneId !== arg.laneId || entry.processId !== arg.processId) return [];
      return isProcessActive(entry.runtime.status) ? [entry] : [];
    }
    return listActiveEntriesForLaneProcess(arg.laneId, arg.processId);
  };

  const stopEntries = async (
    targetEntries: ManagedProcessEntry[],
    intent: ManagedTerminationReason,
  ): Promise<ProcessRuntime | null> => {
    const first = targetEntries[0] ?? null;
    if (!first) return null;
    for (const entry of targetEntries) {
      if (!entry.ptyId || !entry.sessionId || !isProcessActive(entry.runtime.status)) continue;
      entry.stopIntent = intent;
      entry.runtime.status = "stopping";
      emitRuntime(entry);
      ptyService.dispose({ ptyId: entry.ptyId, sessionId: entry.sessionId });
    }
    return cloneRuntime(first.runtime);
  };

  const runStartSet = async (laneId: string, processIds: string[], startOrder: StackStartOrder): Promise<void> => {
    const config = projectConfigService.getExecutableConfig();
    const overlay = await getLaneOverlay(laneId, config);
    const byId = new Map(config.processes.map((proc) => [proc.id, proc] as const));
    const known = applyProcessFilter(processIds.filter((id) => byId.has(id)), overlay);
    const ordered = startOrder === "dependency"
      ? resolveDependencyOrder(known, byId)
      : sortByDefinitions(known, byId);
    if (startOrder === "dependency") {
      for (const id of ordered) {
        await startByDefinition(laneId, byId.get(id)!, { overlay });
      }
      return;
    }
    await Promise.all(ordered.map((id) => startByDefinition(laneId, byId.get(id)!, { overlay })));
  };

  const resolveStopOrder = (processIds: string[], startOrder: StackStartOrder): string[] => {
    const config = projectConfigService.get();
    const byId = new Map(config.effective.processes.map((proc) => [proc.id, proc] as const));
    const known = processIds.filter((id) => byId.has(id));
    const ordered = startOrder === "dependency"
      ? resolveDependencyOrder(known, byId)
      : sortByDefinitions(known, byId);
    return ordered.reverse();
  };

  const runStopSet = async (laneId: string, processIds: string[], intent: ManagedTerminationReason, startOrder: StackStartOrder): Promise<void> => {
    const ordered = resolveStopOrder(processIds, startOrder);
    if (startOrder === "dependency") {
      for (const processId of ordered) {
        await stopEntries(listActiveEntriesForLaneProcess(laneId, processId), intent).catch(() => null);
      }
      return;
    }
    await Promise.all(
      ordered.map((processId) => stopEntries(listActiveEntriesForLaneProcess(laneId, processId), intent).catch(() => null)),
    );
  };

  const stackById = (config: EffectiveProjectConfig, stackId: string): StackButtonDefinition => {
    const stack = config.stackButtons.find((item) => item.id === stackId);
    if (!stack) throw new Error(`Stack button not found: ${stackId}`);
    return stack;
  };

  const unsubscribePtyData = ptyService.onData((event) => {
    const runId = ptyToRunId.get(event.ptyId) ?? sessionToRunId.get(event.sessionId);
    if (!runId) return;
    const entry = entries.get(runId);
    if (!entry) return;
    emitLog(entry, event.data);
    if (
      entry.definition.readiness.type === "logRegex"
      && entry.runtime.status === "starting"
      && entry.readinessRegex
      && entry.readinessRegex.test(event.data)
    ) {
      markReadinessReady(entry);
    }
  });

  const unsubscribePtyExit = ptyService.onExit((event) => {
    const runId = ptyToRunId.get(event.ptyId) ?? sessionToRunId.get(event.sessionId);
    if (!runId) return;
    const entry = entries.get(runId);
    if (!entry) return;
    logger.info("process.exit", {
      laneId: entry.laneId,
      processId: entry.processId,
      runId,
      sessionId: event.sessionId,
      ptyId: event.ptyId,
      code: event.exitCode,
    });
    handleProcessExit(entry, event.exitCode ?? null);
  });

  return {
    listDefinitions(): ProcessDefinition[] {
      return projectConfigService.get().effective.processes;
    },

    listRuntime(laneId: string): ProcessRuntime[] {
      return listEntries((entry) => entry.laneId === laneId).map((entry) => cloneRuntime(entry.runtime));
    },

    async start(arg: ProcessActionArgs): Promise<ProcessRuntime> {
      return await startById(arg.laneId, arg.processId);
    },

    async stop(arg: ProcessActionArgs): Promise<ProcessRuntime | null> {
      return await stopEntries(selectEntriesForAction(arg), "stopped");
    },

    async restart(arg: ProcessActionArgs): Promise<ProcessRuntime> {
      const targets = selectEntriesForAction(arg);
      const stopped = waitForEntriesStopped(targets);
      await stopEntries(targets, "stopped");
      await stopped;
      return await startById(arg.laneId, arg.processId, { skipTrust: true });
    },

    async kill(arg: ProcessActionArgs): Promise<ProcessRuntime | null> {
      return await stopEntries(selectEntriesForAction(arg), "killed");
    },

    async startStack(arg: ProcessStackArgs): Promise<void> {
      const config = projectConfigService.getExecutableConfig();
      const stack = stackById(config, arg.stackId);
      await runStartSet(arg.laneId, stack.processIds, stack.startOrder);
    },

    async stopStack(arg: ProcessStackArgs): Promise<void> {
      const config = projectConfigService.get();
      const stack = stackById(config.effective, arg.stackId);
      await runStopSet(arg.laneId, stack.processIds, "stopped", stack.startOrder);
    },

    async restartStack(arg: ProcessStackArgs): Promise<void> {
      const config = projectConfigService.getExecutableConfig();
      const stack = stackById(config, arg.stackId);
      const targets = stack.processIds.flatMap((processId) => listActiveEntriesForLaneProcess(arg.laneId, processId));
      const stopped = waitForEntriesStopped(targets);
      await runStopSet(arg.laneId, stack.processIds, "stopped", stack.startOrder);
      await stopped;
      await runStartSet(arg.laneId, stack.processIds, stack.startOrder);
    },

    async startAll(arg: { laneId: string }): Promise<void> {
      const config = projectConfigService.getExecutableConfig();
      await runStartSet(arg.laneId, config.processes.map((proc) => proc.id), "dependency");
    },

    async stopAll(arg: { laneId: string }): Promise<void> {
      const config = projectConfigService.get();
      await runStopSet(arg.laneId, config.effective.processes.map((proc) => proc.id), "stopped", "dependency");
    },

    getLogTail({ laneId, processId, runId, maxBytes }: { laneId: string; processId: string; runId?: string; maxBytes?: number }): string {
      const candidate = runId ? entries.get(runId) ?? null : null;
      const entry = candidate?.laneId === laneId && candidate.processId === processId
        ? candidate
        : listEntriesForLaneProcess(laneId, processId)[0] ?? null;
      const transcriptPath = entry?.transcriptPath ?? entry?.runtime.logPath ?? null;
      if (!transcriptPath) return "";
      return readTail(transcriptPath, clampMaxBytes(maxBytes, DEFAULT_LOG_TAIL_BYTES));
    },

    disposeAll() {
      unsubscribePtyData();
      unsubscribePtyExit();
      for (const entry of entries.values()) {
        clearReadinessTimers(entry);
        clearHealthTimers(entry);
        const waiters = terminationWaiters.get(entry.runId);
        if (waiters) {
          terminationWaiters.delete(entry.runId);
          for (const resolve of waiters) resolve();
        }
        entry.stopIntent = "killed";
        restartAttemptsByProcess.delete(processKey(entry.laneId, entry.processId));
        if (entry.ptyId && entry.sessionId) {
          try {
            ptyService.dispose({ ptyId: entry.ptyId, sessionId: entry.sessionId });
          } catch {
            // ignore
          }
        }
      }
    },
  };
}
