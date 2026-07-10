import { spawn, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../logging/logger";

export type ClaudeSubprocessMetadata = {
  sessionId: string;
  sdkSessionId?: string | null;
  laneId: string;
  cwd: string;
};

export type ClaudeSubprocessRecord = ClaudeSubprocessMetadata & {
  pid: number;
  ownerPid: number;
  command: string;
  args: string[];
  createdAt: string;
};

type ClaudeChildProcess = ChildProcessByStdio<Writable, Readable, null>;
type LiveClaudeSubprocess = {
  record: ClaudeSubprocessRecord;
  process: SpawnedProcess;
  killTimer: ReturnType<typeof setTimeout> | null;
};

export type ClaudeSubprocessReaper = ReturnType<typeof createClaudeSubprocessReaper>;

export function createClaudeSubprocessReaper(args: {
  logger: Pick<Logger, "debug" | "warn">;
  killGraceMs?: number;
  spawnProcess?: typeof spawn;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  registryPath?: string | null;
  processKill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}) {
  const logger = args.logger;
  const killGraceMs = args.killGraceMs ?? 5_000;
  const spawnProcess = args.spawnProcess ?? spawn;
  const setTimer = args.setTimer ?? setTimeout;
  const clearTimer = args.clearTimer ?? clearTimeout;
  const registryPath = args.registryPath === null
    ? null
    : args.registryPath ?? path.join(os.tmpdir(), "ade-claude-subprocesses.json");
  const processKill = args.processKill ?? ((pid: number, signal?: NodeJS.Signals | 0) => process.kill(pid, signal as NodeJS.Signals | undefined));
  const live = new Map<number, LiveClaudeSubprocess>();

  const readRegistry = (): ClaudeSubprocessRecord[] => {
    if (!registryPath || !fs.existsSync(registryPath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is ClaudeSubprocessRecord => {
        const record = entry && typeof entry === "object" ? entry as Partial<ClaudeSubprocessRecord> : null;
        return Boolean(
          record
          && Number.isInteger(record.pid)
          && (record.pid ?? 0) > 0
          && Number.isInteger(record.ownerPid)
          && (record.ownerPid ?? 0) > 0
          && typeof record.sessionId === "string"
          && typeof record.laneId === "string"
          && typeof record.cwd === "string"
          && typeof record.command === "string"
          && Array.isArray(record.args)
          && typeof record.createdAt === "string",
        );
      });
    } catch (error) {
      logger.warn("agent_chat.claude_subprocess_registry_read_failed", {
        registryPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  const writeRegistry = (records: ClaudeSubprocessRecord[]): void => {
    if (!registryPath) return;
    try {
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      const tmpPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
      fs.renameSync(tmpPath, registryPath);
    } catch (error) {
      logger.warn("agent_chat.claude_subprocess_registry_write_failed", {
        registryPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const isPidAlive = (pid: number): boolean => {
    try {
      processKill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const removeRegistryPid = (pid: number): void => {
    if (!registryPath) return;
    writeRegistry(readRegistry().filter((record) => record.pid !== pid));
  };

  const upsertRegistryRecord = (record: ClaudeSubprocessRecord): void => {
    if (!registryPath) return;
    const records = readRegistry().filter((entry) => entry.pid !== record.pid);
    records.push(record);
    writeRegistry(records);
  };

  const terminatePid = (record: ClaudeSubprocessRecord, reason: string): void => {
    if (!isPidAlive(record.pid)) {
      removeRegistryPid(record.pid);
      return;
    }
    logger.warn("agent_chat.claude_subprocess_terminate", {
      pid: record.pid,
      sessionId: record.sessionId,
      reason,
    });
    try {
      processKill(record.pid, "SIGTERM");
    } catch {
      removeRegistryPid(record.pid);
      return;
    }
    const killTimer = setTimer(() => {
      if (!isPidAlive(record.pid)) {
        removeRegistryPid(record.pid);
        return;
      }
      logger.warn("agent_chat.claude_subprocess_kill", {
        pid: record.pid,
        sessionId: record.sessionId,
        reason,
      });
      try {
        processKill(record.pid, "SIGKILL");
      } catch {
        // Best effort; process may already be gone.
      } finally {
        removeRegistryPid(record.pid);
      }
    }, killGraceMs);
    killTimer.unref?.();
  };

  const reapStaleRegistry = (reason: string): void => {
    if (!registryPath) return;
    const records = readRegistry();
    const survivors: ClaudeSubprocessRecord[] = [];
    for (const record of records) {
      if (record.ownerPid === process.pid) {
        survivors.push(record);
        continue;
      }
      if (isPidAlive(record.ownerPid)) {
        survivors.push(record);
        continue;
      }
      terminatePid(record, reason);
    }
    writeRegistry(survivors.filter((record) => !live.has(record.pid)));
  };

  reapStaleRegistry("startup");

  const unregister = (pid: number, reason: string): void => {
    const entry = live.get(pid);
    if (!entry) return;
    if (entry.killTimer) {
      clearTimer(entry.killTimer);
    }
    live.delete(pid);
    removeRegistryPid(pid);
    logger.debug("agent_chat.claude_subprocess_unregistered", {
      pid,
      sessionId: entry.record.sessionId,
      reason,
    });
  };

  const register = (
    child: SpawnedProcess & { pid?: number },
    metadata: ClaudeSubprocessMetadata,
    command: string,
    procArgs: string[],
  ): void => {
    const pid = child.pid;
    if (!pid) return;
    const record: ClaudeSubprocessRecord = {
      ...metadata,
      pid,
      ownerPid: process.pid,
      command,
      args: procArgs,
      createdAt: new Date().toISOString(),
    };
    live.set(pid, { record, process: child, killTimer: null });
    upsertRegistryRecord(record);
    child.once("exit", () => unregister(pid, "exit"));
    child.once("error", () => unregister(pid, "error"));
    logger.debug("agent_chat.claude_subprocess_registered", {
      pid,
      sessionId: metadata.sessionId,
      sdkSessionId: metadata.sdkSessionId ?? null,
      laneId: metadata.laneId,
    });
  };

  const spawnClaudeCodeProcess = (
    options: SpawnOptions,
    metadata: ClaudeSubprocessMetadata,
  ): SpawnedProcess => {
    const child = spawnProcess(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }) as ClaudeChildProcess;
    register(child, metadata, options.command, options.args);
    return child;
  };

  const terminateLiveEntry = (
    pid: number,
    entry: LiveClaudeSubprocess,
    reason: string,
  ): void => {
    const child = entry.process;
    if (child.killed || child.exitCode !== null || entry.killTimer) return;
    logger.warn("agent_chat.claude_subprocess_terminate", {
      pid,
      sessionId: entry.record.sessionId,
      reason,
    });
    try {
      child.kill("SIGTERM");
    } catch {
      // Best effort; the process may already be gone.
    }
    entry.killTimer = setTimer(() => {
      if (!child.killed && child.exitCode === null) {
        logger.warn("agent_chat.claude_subprocess_kill", {
          pid,
          sessionId: entry.record.sessionId,
          reason,
        });
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort; the process may already be gone.
        }
      }
      removeRegistryPid(pid);
    }, killGraceMs);
    entry.killTimer.unref?.();
  };

  const reapForSession = (sessionId: string, reason: string): void => {
    for (const [pid, entry] of live) {
      if (entry.record.sessionId !== sessionId) continue;
      terminateLiveEntry(pid, entry, reason);
    }
  };

  const reapAll = (reason: string): void => {
    for (const [pid, entry] of live) {
      terminateLiveEntry(pid, entry, reason);
    }
  };

  return {
    register,
    spawnClaudeCodeProcess,
    reapForSession,
    reapAll,
    reapStaleRegistry,
    liveRecords: (): ClaudeSubprocessRecord[] => [...live.values()].map((entry) => ({ ...entry.record })),
  };
}
