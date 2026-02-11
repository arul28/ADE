import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type {
  EffectiveProjectConfig,
  ProcessActionArgs,
  ProcessDefinition,
  ProcessEvent,
  ProcessReadinessState,
  ProcessRuntime,
  ProcessRuntimeStatus,
  ProcessStackArgs,
  StackStartOrder,
  StackButtonDefinition
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createProjectConfigService } from "../config/projectConfigService";

type ManagedTerminationReason = "stopped" | "killed" | "crashed" | "restart";

type ManagedProcessEntry = {
  runtime: ProcessRuntime;
  child: ChildProcessByStdio<null, Readable, Readable> | null;
  definition: ProcessDefinition | null;
  runId: string | null;
  stopIntent: ManagedTerminationReason | null;
  logStream: fs.WriteStream | null;
  readinessRegex: RegExp | null;
  readinessTimeout: NodeJS.Timeout | null;
  readinessInterval: NodeJS.Timeout | null;
  gracefulKillTimeout: NodeJS.Timeout | null;
};

const READINESS_TIMEOUT_MS = 15_000;

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
      return buf.toString("utf8");
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
  ordered.sort((a, b) => {
    const ai = definitions.has(a) ? Array.from(definitions.keys()).indexOf(a) : Number.MAX_SAFE_INTEGER;
    const bi = definitions.has(b) ? Array.from(definitions.keys()).indexOf(b) : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
  return ordered;
}

function resolveDependencyOrder(processIds: string[], byId: Map<string, ProcessDefinition>): string[] {
  const set = new Set(processIds);
  const visited = new Set<string>();
  const stack = new Set<string>();
  const out: string[] = [];

  const visit = (id: string) => {
    if (!set.has(id)) return;
    if (visited.has(id)) return;
    if (stack.has(id)) return;

    stack.add(id);
    const proc = byId.get(id);
    if (proc) {
      for (const dep of proc.dependsOn) {
        if (set.has(dep)) {
          visit(dep);
        }
      }
    }
    stack.delete(id);
    visited.add(id);
    out.push(id);
  };

  for (const id of processIds) {
    visit(id);
  }

  return out;
}

function checkPortReady(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let done = false;

    const settle = (ok: boolean) => {
      if (done) return;
      done = true;
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

export function createProcessService({
  db,
  projectRoot,
  projectId,
  processLogsDir,
  logger,
  projectConfigService,
  broadcastEvent
}: {
  db: AdeDb;
  projectRoot: string;
  projectId: string;
  processLogsDir: string;
  logger: Logger;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  broadcastEvent: (ev: ProcessEvent) => void;
}) {
  const entries = new Map<string, ManagedProcessEntry>();

  const nowIso = () => new Date().toISOString();

  const processLogPath = (processId: string) => path.join(processLogsDir, `${processId}.log`);

  const persistRuntime = (runtime: ProcessRuntime) => {
    db.run(
      `
        insert into process_runtime(project_id, process_key, status, pid, started_at, ended_at, exit_code, readiness, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(project_id, process_key) do update set
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
        runtime.processId,
        runtime.status,
        runtime.pid,
        runtime.startedAt,
        runtime.endedAt,
        runtime.lastExitCode,
        runtime.readiness,
        runtime.updatedAt
      ]
    );
  };

  const emitRuntime = (entry: ManagedProcessEntry) => {
    const runtime = entry.runtime;
    const now = nowIso();
    runtime.updatedAt = now;

    if (runtime.startedAt && isProcessActive(runtime.status)) {
      runtime.uptimeMs = Math.max(0, Date.now() - Date.parse(runtime.startedAt));
    } else {
      runtime.uptimeMs = null;
    }

    persistRuntime(runtime);
    broadcastEvent({ type: "runtime", runtime: { ...runtime } });
  };

  const emitLog = (processId: string, stream: "stdout" | "stderr", chunk: string) => {
    broadcastEvent({ type: "log", processId, stream, chunk, ts: nowIso() });
  };

  const upsertRunStart = (runId: string, processId: string, startedAt: string, logPath: string) => {
    db.run(
      `
        insert into process_runs(id, project_id, process_key, started_at, ended_at, exit_code, termination_reason, log_path)
        values (?, ?, ?, ?, null, null, 'stopped', ?)
      `,
      [runId, projectId, processId, startedAt, logPath]
    );
  };

  const upsertRunEnd = (runId: string, endedAt: string, exitCode: number | null, reason: ManagedTerminationReason) => {
    db.run("update process_runs set ended_at = ?, exit_code = ?, termination_reason = ? where id = ?", [
      endedAt,
      exitCode,
      reason,
      runId
    ]);
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

  const clearKillTimer = (entry: ManagedProcessEntry) => {
    if (entry.gracefulKillTimeout) {
      clearTimeout(entry.gracefulKillTimeout);
      entry.gracefulKillTimeout = null;
    }
  };

  const ensureEntry = (processId: string, definition: ProcessDefinition | null): ManagedProcessEntry => {
    const existing = entries.get(processId);
    if (existing) {
      existing.definition = definition;
      if (definition?.readiness.type === "port") {
        existing.runtime.ports = [definition.readiness.port];
      } else {
        existing.runtime.ports = [];
      }
      return existing;
    }

    const persisted = db.get<{
      status: ProcessRuntimeStatus;
      pid: number | null;
      started_at: string | null;
      ended_at: string | null;
      exit_code: number | null;
      readiness: ProcessReadinessState;
      updated_at: string;
    }>(
      `
        select status, pid, started_at, ended_at, exit_code, readiness, updated_at
        from process_runtime
        where project_id = ? and process_key = ?
        limit 1
      `,
      [projectId, processId]
    );

    const hadActiveStatus =
      persisted?.status === "running" ||
      persisted?.status === "starting" ||
      persisted?.status === "stopping" ||
      persisted?.status === "degraded";

    const runtime: ProcessRuntime = {
      processId,
      status: hadActiveStatus ? "exited" : persisted?.status ?? "stopped",
      readiness: persisted?.readiness ?? "unknown",
      pid: null,
      startedAt: hadActiveStatus ? null : persisted?.started_at ?? null,
      endedAt: hadActiveStatus ? nowIso() : persisted?.ended_at ?? null,
      exitCode: hadActiveStatus ? persisted?.exit_code ?? null : persisted?.exit_code ?? null,
      lastExitCode: persisted?.exit_code ?? null,
      lastEndedAt: hadActiveStatus ? nowIso() : persisted?.ended_at ?? null,
      uptimeMs: null,
      ports: definition?.readiness.type === "port" ? [definition.readiness.port] : [],
      logPath: processLogPath(processId),
      updatedAt: persisted?.updated_at ?? nowIso()
    };

    const entry: ManagedProcessEntry = {
      runtime,
      child: null,
      definition,
      runId: null,
      stopIntent: null,
      logStream: null,
      readinessRegex: null,
      readinessTimeout: null,
      readinessInterval: null,
      gracefulKillTimeout: null
    };

    entries.set(processId, entry);
    persistRuntime(runtime);
    return entry;
  };

  const ensureEntriesFromConfig = (config: EffectiveProjectConfig) => {
    const activeIds = new Set<string>();
    for (const proc of config.processes) {
      activeIds.add(proc.id);
      ensureEntry(proc.id, proc);
    }

    for (const [id, entry] of entries) {
      if (!activeIds.has(id)) {
        entry.definition = null;
      }
    }
  };

  const markReadinessReady = (entry: ManagedProcessEntry) => {
    clearReadinessTimers(entry);
    entry.runtime.readiness = "ready";
    if (entry.runtime.status === "starting") {
      entry.runtime.status = "running";
    }
    emitRuntime(entry);
  };

  const markReadinessFailed = (entry: ManagedProcessEntry) => {
    clearReadinessTimers(entry);
    if (!isProcessActive(entry.runtime.status)) return;
    entry.runtime.readiness = "not_ready";
    entry.runtime.status = "degraded";
    emitRuntime(entry);
  };

  const setupReadinessChecks = (entry: ManagedProcessEntry, definition: ProcessDefinition) => {
    clearReadinessTimers(entry);
    entry.readinessRegex = null;

    if (definition.readiness.type === "none") {
      entry.runtime.readiness = "ready";
      entry.runtime.status = "running";
      emitRuntime(entry);
      return;
    }

    entry.runtime.readiness = "unknown";
    entry.runtime.status = "starting";
    emitRuntime(entry);

    entry.readinessTimeout = setTimeout(() => {
      markReadinessFailed(entry);
    }, READINESS_TIMEOUT_MS);

    if (definition.readiness.type === "port") {
      const port = definition.readiness.port;
      entry.readinessInterval = setInterval(() => {
        checkPortReady(port)
          .then((ok) => {
            if (ok) markReadinessReady(entry);
          })
          .catch(() => {
            // ignore probe failures
          });
      }, 500);
      return;
    }

    if (definition.readiness.type === "logRegex") {
      try {
        entry.readinessRegex = new RegExp(definition.readiness.pattern);
      } catch {
        markReadinessFailed(entry);
      }
    }
  };

  const handleProcessExit = (entry: ManagedProcessEntry, processId: string, exitCode: number | null) => {
    clearReadinessTimers(entry);
    clearKillTimer(entry);

    const endedAt = nowIso();

    if (entry.logStream) {
      try {
        entry.logStream.write(`\n# process ended at ${endedAt} exit=${exitCode ?? "null"}\n`);
      } catch {
        // ignore
      }
      try {
        entry.logStream.end();
      } catch {
        // ignore
      }
      entry.logStream = null;
    }

    const reason = entry.stopIntent ?? (exitCode === 0 ? "stopped" : "crashed");
    const runtimeStatus: ProcessRuntimeStatus = reason === "crashed" ? "crashed" : "exited";

    entry.child = null;
    entry.stopIntent = null;
    entry.runtime.pid = null;
    entry.runtime.status = runtimeStatus;
    entry.runtime.readiness = "unknown";
    entry.runtime.endedAt = endedAt;
    entry.runtime.lastEndedAt = endedAt;
    entry.runtime.exitCode = exitCode;
    entry.runtime.lastExitCode = exitCode;

    emitRuntime(entry);

    if (entry.runId) {
      upsertRunEnd(entry.runId, endedAt, exitCode, reason);
      entry.runId = null;
    }

    if (reason === "restart") {
      // Restart uses the latest validated executable config.
      setTimeout(() => {
        void startById(processId).catch((err) => {
          logger.warn("process.restart_failed", { processId, err: String(err) });
        });
      }, 20);
      return;
    }

    if (reason === "crashed" && entry.definition?.restart === "on_crash") {
      setTimeout(() => {
        void startById(processId, { skipTrust: true }).catch((err) => {
          logger.warn("process.auto_restart_failed", { processId, err: String(err) });
        });
      }, 600);
    }
  };

  const attachProcessStreams = (entry: ManagedProcessEntry, processId: string, child: ChildProcessByStdio<null, Readable, Readable>) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const onChunk = (stream: "stdout" | "stderr", chunk: string) => {
      if (entry.logStream) {
        try {
          entry.logStream.write(chunk);
        } catch {
          // ignore
        }
      }
      emitLog(processId, stream, chunk);

      if (
        entry.definition?.readiness.type === "logRegex" &&
        entry.runtime.status === "starting" &&
        entry.readinessRegex &&
        entry.readinessRegex.test(chunk)
      ) {
        markReadinessReady(entry);
      }
    };

    child.stdout.on("data", (chunk: string) => onChunk("stdout", chunk));
    child.stderr.on("data", (chunk: string) => onChunk("stderr", chunk));
  };

  const startByDefinition = async (definition: ProcessDefinition, opts: { skipTrust?: boolean } = {}): Promise<ProcessRuntime> => {
    if (!opts.skipTrust) {
      projectConfigService.getExecutableConfig();
    }

    const entry = ensureEntry(definition.id, definition);

    if (entry.child && isProcessActive(entry.runtime.status)) {
      return { ...entry.runtime };
    }

    if (!definition.command.length) {
      throw new Error(`Process '${definition.id}' has an empty command`);
    }

    const cwd = path.isAbsolute(definition.cwd) ? definition.cwd : path.join(projectRoot, definition.cwd);
    fs.mkdirSync(processLogsDir, { recursive: true });

    const startedAt = nowIso();
    const runId = randomUUID();
    const logPath = processLogPath(definition.id);

    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(`\n# process start ${startedAt} cmd=${JSON.stringify(definition.command)} cwd=${cwd}\n`);

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(definition.command[0]!, definition.command.slice(1), {
        cwd,
        env: { ...process.env, ...definition.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      try {
        logStream.end();
      } catch {
        // ignore
      }
      throw err;
    }

    entry.child = child;
    entry.definition = definition;
    entry.stopIntent = null;
    entry.runId = runId;
    entry.logStream = logStream;
    entry.runtime.status = "starting";
    entry.runtime.readiness = "unknown";
    entry.runtime.pid = child.pid ?? null;
    entry.runtime.startedAt = startedAt;
    entry.runtime.endedAt = null;
    entry.runtime.exitCode = null;
    entry.runtime.ports = definition.readiness.type === "port" ? [definition.readiness.port] : [];

    upsertRunStart(runId, definition.id, startedAt, logPath);
    emitRuntime(entry);
    setupReadinessChecks(entry, definition);

    attachProcessStreams(entry, definition.id, child);

    child.on("spawn", () => {
      entry.runtime.pid = child.pid ?? null;
      emitRuntime(entry);
    });

    child.on("error", (err) => {
      logger.warn("process.child_error", { processId: definition.id, err: String(err) });
      if (entry.logStream) {
        try {
          entry.logStream.write(`\n[process error] ${String(err)}\n`);
        } catch {
          // ignore
        }
      }
    });

    child.on("close", (code) => {
      logger.info("process.exit", { processId: definition.id, code });
      handleProcessExit(entry, definition.id, code ?? null);
    });

    logger.info("process.start", {
      processId: definition.id,
      cwd,
      command: definition.command,
      runId
    });

    return { ...entry.runtime };
  };

  const startById = async (processId: string, opts: { skipTrust?: boolean } = {}) => {
    const config = opts.skipTrust ? projectConfigService.getEffective() : projectConfigService.getExecutableConfig();
    ensureEntriesFromConfig(config);
    const definition = config.processes.find((p) => p.id === processId);
    if (!definition) {
      throw new Error(`Process not found: ${processId}`);
    }
    return await startByDefinition(definition, opts);
  };

  const stopById = async (
    processId: string,
    intent: ManagedTerminationReason,
    force: boolean
  ): Promise<ProcessRuntime> => {
    const config = projectConfigService.get();
    ensureEntriesFromConfig(config.effective);

    const entry = entries.get(processId);
    if (!entry) {
      throw new Error(`Process not found: ${processId}`);
    }

    if (!entry.child) {
      return { ...entry.runtime };
    }

    clearKillTimer(entry);
    entry.stopIntent = intent;
    entry.runtime.status = "stopping";
    emitRuntime(entry);

    if (force) {
      try {
        entry.child.kill("SIGKILL");
      } catch {
        // ignore
      }
      return { ...entry.runtime };
    }

    const shutdownMs = Math.max(250, entry.definition?.gracefulShutdownMs ?? 7000);

    try {
      entry.child.kill("SIGTERM");
    } catch {
      // ignore
    }

    entry.gracefulKillTimeout = setTimeout(() => {
      if (!entry.child) return;
      try {
        entry.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, shutdownMs);

    return { ...entry.runtime };
  };

  const runStartSet = async (processIds: string[], startOrder: StackStartOrder): Promise<void> => {
    const config = projectConfigService.getExecutableConfig();
    ensureEntriesFromConfig(config);
    const byId = new Map(config.processes.map((p) => [p.id, p] as const));
    const known = processIds.filter((id) => byId.has(id));

    const ordered =
      startOrder === "dependency"
        ? resolveDependencyOrder(known, byId)
        : sortByDefinitions(known, byId);

    if (startOrder === "dependency") {
      for (const id of ordered) {
        await startByDefinition(byId.get(id)!, {});
      }
      return;
    }

    await Promise.all(ordered.map((id) => startByDefinition(byId.get(id)!, {})));
  };

  const runStopSet = async (processIds: string[], startOrder: StackStartOrder): Promise<void> => {
    const config = projectConfigService.get();
    ensureEntriesFromConfig(config.effective);
    const byId = new Map(config.effective.processes.map((p) => [p.id, p] as const));
    const known = processIds.filter((id) => byId.has(id));

    const ordered =
      startOrder === "dependency"
        ? resolveDependencyOrder(known, byId).reverse()
        : sortByDefinitions(known, byId).reverse();

    await Promise.all(ordered.map((id) => stopById(id, "stopped", false).catch(() => {})));
  };

  const stackById = (config: EffectiveProjectConfig, stackId: string): StackButtonDefinition => {
    const stack = config.stackButtons.find((s) => s.id === stackId);
    if (!stack) throw new Error(`Stack button not found: ${stackId}`);
    return stack;
  };

  // Load previous runtime cache once and normalize stale active states.
  const initialConfig = projectConfigService.get();
  ensureEntriesFromConfig(initialConfig.effective);
  for (const entry of entries.values()) {
    if (isProcessActive(entry.runtime.status)) {
      entry.runtime.status = "exited";
      entry.runtime.pid = null;
      entry.runtime.endedAt = nowIso();
      entry.runtime.lastEndedAt = entry.runtime.endedAt;
      entry.runtime.readiness = "unknown";
      emitRuntime(entry);
    }
  }

  // Best effort autostart after service init.
  void Promise.resolve()
    .then(async () => {
      let config: EffectiveProjectConfig;
      try {
        config = projectConfigService.getExecutableConfig();
      } catch {
        return;
      }

      const autostart = config.processes.filter((p) => p.autostart);
      for (const proc of autostart) {
        await startByDefinition(proc, {}).catch((err) => {
          logger.warn("process.autostart_failed", { processId: proc.id, err: String(err) });
        });
      }
    })
    .catch(() => {
      // ignore
    });

  return {
    listDefinitions(): ProcessDefinition[] {
      const snapshot = projectConfigService.get();
      ensureEntriesFromConfig(snapshot.effective);
      return snapshot.effective.processes;
    },

    listRuntime(): ProcessRuntime[] {
      const snapshot = projectConfigService.get();
      ensureEntriesFromConfig(snapshot.effective);

      const byDefOrder = snapshot.effective.processes.map((p) => p.id);
      const out: ProcessRuntime[] = [];

      for (const processId of byDefOrder) {
        const entry = entries.get(processId);
        if (!entry) continue;
        const runtime = { ...entry.runtime };
        if (runtime.startedAt && isProcessActive(runtime.status)) {
          runtime.uptimeMs = Math.max(0, Date.now() - Date.parse(runtime.startedAt));
        }
        out.push(runtime);
      }

      for (const [processId, entry] of entries.entries()) {
        if (byDefOrder.includes(processId)) continue;
        out.push({ ...entry.runtime });
      }

      return out;
    },

    async start(arg: ProcessActionArgs): Promise<ProcessRuntime> {
      return await startById(arg.processId);
    },

    async stop(arg: ProcessActionArgs): Promise<ProcessRuntime> {
      return await stopById(arg.processId, "stopped", false);
    },

    async restart(arg: ProcessActionArgs): Promise<ProcessRuntime> {
      const entry = entries.get(arg.processId);
      if (!entry?.child) {
        return await startById(arg.processId);
      }
      return await stopById(arg.processId, "restart", false);
    },

    async kill(arg: ProcessActionArgs): Promise<ProcessRuntime> {
      return await stopById(arg.processId, "killed", true);
    },

    async startStack(arg: ProcessStackArgs): Promise<void> {
      const config = projectConfigService.getExecutableConfig();
      const stack = stackById(config, arg.stackId);
      await runStartSet(stack.processIds, stack.startOrder);
    },

    async stopStack(arg: ProcessStackArgs): Promise<void> {
      const config = projectConfigService.get();
      const stack = stackById(config.effective, arg.stackId);
      await runStopSet(stack.processIds, stack.startOrder);
    },

    async restartStack(arg: ProcessStackArgs): Promise<void> {
      const config = projectConfigService.getExecutableConfig();
      const stack = stackById(config, arg.stackId);
      await runStopSet(stack.processIds, stack.startOrder);
      await runStartSet(stack.processIds, stack.startOrder);
    },

    async startAll(): Promise<void> {
      const config = projectConfigService.getExecutableConfig();
      const ids = config.processes.map((p) => p.id);
      await runStartSet(ids, "dependency");
    },

    async stopAll(): Promise<void> {
      const config = projectConfigService.get();
      const ids = config.effective.processes.map((p) => p.id);
      await runStopSet(ids, "dependency");
    },

    getLogTail({ processId, maxBytes }: { processId: string; maxBytes?: number }): string {
      const entry = entries.get(processId) ?? ensureEntry(processId, null);
      const limit = clampMaxBytes(maxBytes, 180_000);
      return readTail(entry.runtime.logPath ?? processLogPath(processId), limit);
    },

    disposeAll() {
      for (const entry of entries.values()) {
        clearReadinessTimers(entry);
        clearKillTimer(entry);
        entry.stopIntent = "killed";
        if (entry.child) {
          try {
            entry.child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
        if (entry.logStream) {
          try {
            entry.logStream.end();
          } catch {
            // ignore
          }
          entry.logStream = null;
        }
      }
    }
  };
}
