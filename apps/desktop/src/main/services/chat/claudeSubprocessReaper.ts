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

/** What POSIX `ps` can tell us about a bare pid: is it ours, and does it lead a group? */
export type PosixProcessInfo = {
  pgid: number;
  /** Seconds since the process started, from `ps -o etime=`. */
  elapsedSeconds: number;
  command: string;
};

/**
 * Commands that identify nothing. The SDK spawns `node <cli.js>` whenever the
 * resolved Claude CLI is not directly spawnable, so `record.command` is often
 * the interpreter — and a packaged desktop build's interpreter is ADE itself.
 * Accepting on those stems means "any node process on this machine looks like
 * us", which, now that a bad accept force-kills a whole process GROUP, is how
 * ADE could kill its own freshly restarted brain after a pid reuse. The
 * recorded argv path has to carry the match instead.
 */
const GENERIC_INTERPRETER_STEMS: ReadonlySet<string> = new Set([
  "node", "bun", "deno", "sh", "bash", "zsh", "python", "python3", "electron", "ade",
]);

/** `[[dd-]hh:]mm:ss` — the one `etime` format macOS and Linux `ps` agree on. */
export function parseEtimeSeconds(raw: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(raw.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400
    + Number(hours ?? 0) * 3_600
    + Number(minutes ?? 0) * 60
    + Number(seconds ?? 0)
  );
}

/**
 * The POSIX counterpart to `windowsPidLooksLikeRecord`, and deliberately just
 * as permissive: only refuse when the live process positively cannot be the one
 * we recorded.
 *
 * Two independent checks, because a bad accept here now force-kills a whole
 * process GROUP rather than a single pid:
 *
 *  1. Start time. A pid that has been alive for less time than the record has
 *     existed cannot be the process the record describes — it was handed out
 *     after we wrote the record down. `windows-quirks.md` states the rule
 *     directly: a recorded PID alone is not identity.
 *  2. The command line. `ps` reports the full argv, so the command's own
 *     basename or a recorded PATH-shaped argument is enough — an interpreter
 *     shim (`node …/cli.js`) legitimately shares nothing with `options.command`
 *     but everything with its args. Bare flag tokens deliberately do NOT count:
 *     matching on `--model` or `stream-json` would accept an unrelated node
 *     process, and there is no blanket "contains claude" shortcut for the same
 *     reason — the user's own `claude` CLI is the single most likely collider
 *     on an ADE machine.
 */
function posixPidLooksLikeRecord(record: ClaudeSubprocessRecord, info: PosixProcessInfo): boolean {
  const recordedAtMs = Date.parse(record.createdAt);
  if (Number.isFinite(recordedAtMs) && info.elapsedSeconds >= 0) {
    const processStartedAtMs = Date.now() - info.elapsedSeconds * 1_000;
    // `etime` is whole seconds and clocks drift, so allow a minute of slack
    // before calling a process younger than its record an impostor.
    if (processStartedAtMs - recordedAtMs > 60_000) return false;
  }
  const haystack = info.command.trim().toLowerCase();
  if (!haystack) return true;
  const stem = path.posix.basename(record.command).toLowerCase().replace(/\.(js|cjs|mjs|sh)$/u, "");
  if (stem.length >= 3 && !GENERIC_INTERPRETER_STEMS.has(stem) && haystack.includes(stem)) return true;
  return record.args.some((arg) => {
    const value = String(arg);
    if (!value.includes("/")) return false;
    const base = path.posix.basename(value).toLowerCase();
    return base.length >= 3 && haystack.includes(base);
  });
}

/**
 * The POSIX counterpart to `windowsPidImageName`. One `ps` read answers both
 * questions the stale-registry path has about a pid it has no handle for:
 * whether it still looks like the process we recorded (PID reuse), and whether
 * it leads its own process group (so the whole tree can be signalled at once).
 */
function readPosixProcessInfoSync(pid: number): PosixProcessInfo | null {
  try {
    // Bare `ps` off PATH, matching `ptyService.ts` and
    // `orphanedAgentProcessReaper.ts`: it lives in /bin on macOS and /usr/bin on
    // several Linux distributions, so an absolute path is the portability bug.
    // `etime` rather than `lstart`: it is whole tokens on both macOS and Linux,
    // where `lstart` is a five-word date this would have to reassemble.
    const result = spawnSync("ps", ["-o", "pgid=,etime=,command=", "-p", String(pid)], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2_000,
    });
    if (result.error || result.status !== 0) return null;
    const line = String(result.stdout ?? "").trim().split("\n")[0]?.trim();
    if (!line) return null;
    const match = /^(\d+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (!match) return null;
    const pgid = Number.parseInt(match[1] as string, 10);
    if (!Number.isInteger(pgid) || pgid <= 0) return null;
    const elapsedSeconds = parseEtimeSeconds(match[2] as string);
    if (elapsedSeconds == null) return null;
    return { pgid, elapsedSeconds, command: (match[3] ?? "").trim() };
  } catch {
    return null;
  }
}

type LiveClaudeSubprocess = {
  record: ClaudeSubprocessRecord;
  process: SpawnedProcess;
  killTimer: ReturnType<typeof setTimeout> | null;
  /**
   * True when ADE spawned this child `detached`, which on POSIX makes it a
   * process-group leader — the precondition for signalling `-pid` and taking
   * its MCP servers and other grandchildren down with it.
   */
  groupLeader: boolean;
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
  /** POSIX identity/process-group probe; overridable for the same reason. */
  readProcessInfo?: (pid: number) => PosixProcessInfo | null;
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
  const readProcessInfo = args.readProcessInfo ?? readPosixProcessInfoSync;
  const live = new Map<number, LiveClaudeSubprocess>();

  /**
   * The POSIX half of "kill the tree, not the leaf" — the counterpart to the
   * `taskkill /T /F` the Windows branches already run.
   *
   * A Claude SDK process owns 2-4 MCP servers plus their own children, so
   * signalling the single recorded pid leaves that whole fan-out orphaned and
   * holding its memory; a SIGKILL escalation makes it permanent. ADE spawns the
   * child `detached` (see `spawnClaudeCodeProcess`), which on POSIX makes it a
   * process-group leader, so `kill(-pid)` reaches every descendant that did not
   * deliberately leave the group.
   *
   * The ladder mirrors `signalChildProcessTree` in `../shared/utils.ts`, but the
   * contract is genuinely different, which is why this is not a call into it.
   * That helper signals `-pid` UNCONDITIONALLY — correct for its callers, which
   * all spawn `detached`. This one refuses to signal a group without proof of
   * leadership, and it also has to serve the stale-registry path, where there is
   * no child handle at all. Adding those two shapes to the shared helper would
   * push reaper-specific optionality into code used across the codebase.
   *
   * `groupLeader` is never assumed: signalling a negative pid that is NOT our
   * group leader would either fail harmlessly (no such group) or, after pid
   * reuse, hit somebody else's group. Callers pass proof — construction for a
   * live child we spawned, a `ps` read for a bare registry record.
   *
   * The shared helper's PID-reuse guard (refuse once `exitCode`/`signalCode` is
   * set) is not repeated inside here: on the live path `terminateLiveEntry`'s
   * `exited()` gate already applies it before both the signal and the
   * escalation, and the registry path has no handle to read it from and uses
   * the `ps` identity check instead.
   */
  const signalPosixTree = (
    pid: number,
    signal: NodeJS.Signals,
    child: Pick<ClaudeChildProcess, "kill"> | null,
    groupLeader: boolean,
  ): boolean => {
    if (groupLeader) {
      try {
        processKill(-pid, signal);
        return true;
      } catch {
        // The group is already gone, or this pid never led one. Fall through
        // to the single-process paths rather than giving up on the leader.
      }
    }
    if (child) {
      try {
        if (child.kill(signal)) return true;
      } catch {
        // fall through to signalling the pid directly
      }
    }
    try {
      processKill(pid, signal);
      return true;
    } catch {
      return false;
    }
  };

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
    // `reapStaleRegistry` skips records whose OWNER is us, never records whose
    // subject pid is. After a crash-and-fast-restart the OS can hand our own
    // new pid to a record written seconds earlier, and we spawn detached — so
    // we would look like a group leader that matches, and force-kill our own
    // process group.
    if (record.pid === process.pid) {
      removeRegistryPid(record.pid);
      return;
    }
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
    // POSIX has no live handle here, so one `ps` read has to answer everything:
    // does this pid still look like the process we recorded (pid reuse), is it
    // older than the record that describes it, and does it lead its own group
    // (so the tree can be taken in one signal). An unreadable answer still gets
    // reaped as a single pid — leaking a Claude subprocess is the worse failure.
    const info = readProcessInfo(record.pid);
    if (info && !posixPidLooksLikeRecord(record, info)) {
      logger.warn("agent_chat.claude_subprocess_pid_reused", {
        pid: record.pid,
        sessionId: record.sessionId,
        reason,
      });
      removeRegistryPid(record.pid);
      return;
    }
    const groupLeader = info?.pgid === record.pid;
    logger.warn("agent_chat.claude_subprocess_terminate", {
      pid: record.pid,
      sessionId: record.sessionId,
      reason,
      groupLeader,
    });
    if (!signalPosixTree(record.pid, "SIGTERM", null, groupLeader)) {
      removeRegistryPid(record.pid);
      return;
    }
    const killTimer = setTimer(() => {
      if (!isPidAlive(record.pid)) {
        removeRegistryPid(record.pid);
        return;
      }
      // Re-probe rather than reusing the decision made `killGraceMs` ago. If
      // the SIGTERM worked and the pid was recycled inside the grace window —
      // the exact hazard the identity check exists for — a stale `groupLeader`
      // would aim a forced group kill at the new owner.
      const escalationInfo = readProcessInfo(record.pid);
      if (escalationInfo && !posixPidLooksLikeRecord(record, escalationInfo)) {
        logger.warn("agent_chat.claude_subprocess_pid_reused", {
          pid: record.pid,
          sessionId: record.sessionId,
          reason,
        });
        removeRegistryPid(record.pid);
        return;
      }
      logger.warn("agent_chat.claude_subprocess_kill", {
        pid: record.pid,
        sessionId: record.sessionId,
        reason,
      });
      // Note this deliberately does NOT fall back to the `groupLeader` computed
      // before the grace window. No re-probe answer means no proof, and reusing
      // a stale belief is exactly what the re-probe exists to stop — so an
      // unreadable `ps` downgrades the forced kill to a single pid.
      signalPosixTree(record.pid, "SIGKILL", null, escalationInfo?.pgid === record.pid);
      removeRegistryPid(record.pid);
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
    options?: { groupLeader?: boolean },
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
    live.set(pid, {
      record,
      process: child,
      killTimer: null,
      groupLeader: options?.groupLeader === true,
    });
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
      // POSIX only: put the Claude binary in its own process group so a
      // teardown can signal `-pid` and take its MCP servers (2-4 per SDK
      // process, each with children of its own) down with it. Without this the
      // reaper kills one pid and orphans several hundred MB of node processes
      // per session — the exact leak this reaper exists to prevent, one level
      // deeper. `detached` on Windows means "own console window", which is
      // both wrong and unnecessary there: `taskkill /T /F` already walks the
      // tree by parent link.
      detached: !isWindows,
    }) as ClaudeChildProcess;
    register(child, metadata, options.command, options.args, { groupLeader: !isWindows });
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
        // Same reasoning as the Windows branch, one platform over: a bare
        // `child.kill` signals the leader and leaves its MCP servers running.
        signalPosixTree(pid, "SIGTERM", child, entry.groupLeader);
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
          if (isWindows) {
            // The escalation has to walk the tree too. `child.kill("SIGKILL")`
            // here is a `TerminateProcess` on the leader alone, which is what
            // turns a surviving tree into a permanently orphaned one.
            terminateProcessTree(child as unknown as Parameters<typeof terminateProcessTree>[0], "SIGKILL", (detail) => {
              logger.warn("agent_chat.claude_subprocess_taskkill_failed", { ...detail, sessionId: entry.record.sessionId });
            });
          } else {
            signalPosixTree(pid, "SIGKILL", child, entry.groupLeader);
          }
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
    /**
     * Live SDK processes owned by one chat, for the surfaces that report what a
     * session is actually holding open. Scoped rather than served from
     * `liveRecords()` because session summaries are built in bulk and copying
     * the whole registry per row is the wrong shape.
     */
    recordsForSession: (sessionId: string): ClaudeSubprocessRecord[] => {
      const matches: ClaudeSubprocessRecord[] = [];
      for (const entry of live.values()) {
        if (entry.record.sessionId === sessionId) matches.push({ ...entry.record });
      }
      return matches;
    },
  };
}
