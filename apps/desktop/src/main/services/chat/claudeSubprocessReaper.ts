import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../logging/logger";
import { killWindowsProcessTree, resolveCliSpawnInvocation, terminateProcessTree } from "../shared/processExecution";

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

/**
 * Image names a registered Claude subprocess can legitimately be running under
 * on Windows: the resolved executable itself, or the interpreter that a shim
 * hands off to (`claude.cmd` runs under cmd.exe, `claude.ps1` under PowerShell,
 * an npm-linked entry under node.exe).
 */
function windowsExpectedImageNames(command: string): string[] {
  const base = path.win32.basename(command).toLowerCase();
  const stem = base.replace(/\.(cmd|bat|ps1|exe|com)$/u, "");
  return [base, `${stem}.exe`, "cmd.exe", "powershell.exe", "pwsh.exe", "node.exe", "conhost.exe"];
}

function windowsPidImageName(pid: number): string | null {
  try {
    const result = spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    if (result.error || result.status !== 0) return null;
    // CSV row: "image.exe","1234","Console","1","12,345 K"
    const name = String(result.stdout ?? "").trim().match(/^"([^"]+)"/u)?.[1];
    return name ? name.toLowerCase() : null;
  } catch {
    return null;
  }
}

function windowsPidLooksLikeRecord(record: ClaudeSubprocessRecord): boolean {
  const image = windowsPidImageName(record.pid);
  if (!image) return true;
  return windowsExpectedImageNames(record.command).includes(image);
}
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
  /** Overridable so the POSIX and Windows kill paths can each be exercised. */
  platform?: NodeJS.Platform;
}) {
  const logger = args.logger;
  const platform = args.platform ?? process.platform;
  const isWindows = platform === "win32";
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
    if (isWindows) {
      // This registry outlives the app, and Windows recycles PIDs far faster
      // than macOS, so a stale record can point at somebody else's process by
      // the time we read it. Only refuse when Windows positively names an image
      // that cannot be ours — an unreadable answer still gets reaped, because
      // leaking a Claude subprocess is the worse failure.
      if (!windowsPidLooksLikeRecord(record)) {
        logger.warn("agent_chat.claude_subprocess_pid_reused", {
          pid: record.pid,
          sessionId: record.sessionId,
          reason,
        });
        removeRegistryPid(record.pid);
        return;
      }
      logger.warn("agent_chat.claude_subprocess_terminate", {
        pid: record.pid,
        sessionId: record.sessionId,
        reason,
      });
      // `process.kill(pid, "SIGTERM")` on Windows is an immediate, ungraceful
      // TerminateProcess of that one PID — it leaves the Claude binary's own
      // children (ripgrep, MCP servers, node) orphaned. There is no graceful
      // stage to escalate from, so kill the whole tree in one step.
      killWindowsProcessTree(record.pid, (detail) => {
        logger.warn("agent_chat.claude_subprocess_taskkill_failed", { ...detail, sessionId: record.sessionId });
      });
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
    // A `.cmd`/`.bat` shim — what `npm i -g @anthropic-ai/claude-code` puts on
    // PATH — cannot be handed to `spawn` directly: since the CVE-2024-27980 fix
    // Node refuses it with EINVAL unless it goes through a command interpreter.
    // `resolveCliSpawnInvocation` produces the correctly quoted cmd.exe (or
    // PowerShell, for `.ps1`) invocation and is a no-op for a plain `.exe`.
    const invocation = resolveCliSpawnInvocation(options.command, options.args, options.env, platform);
    const child = spawnProcess(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
    // `child.killed` only means "a signal was sent", not "the process exited" —
    // gate on exit/signal codes so a hung child still gets the SIGKILL escalation.
    const exited = () => child.exitCode !== null || (child as { signalCode?: string | null }).signalCode != null;
    if (exited() || entry.killTimer) return;
    logger.warn("agent_chat.claude_subprocess_terminate", {
      pid,
      sessionId: entry.record.sessionId,
      reason,
    });
    try {
      if (isWindows) {
        // taskkill /T /F is the only way to take the Claude binary's own
        // children (ripgrep, MCP servers, and the cmd.exe that fronts a `.cmd`
        // shim) down with it — `child.kill("SIGTERM")` on Windows terminates
        // this one PID and orphans the rest.
        terminateProcessTree(child as unknown as Parameters<typeof terminateProcessTree>[0], "SIGTERM", (detail) => {
          logger.warn("agent_chat.claude_subprocess_taskkill_failed", { ...detail, sessionId: entry.record.sessionId });
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // Best effort; the process may already be gone.
    }
    entry.killTimer = setTimer(() => {
      if (!exited()) {
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
