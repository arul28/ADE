import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import type { AgentChatEvent, AgentChatStopSource } from "../../../shared/types/chat";

/**
 * OpenCode background shells for one chat runtime.
 *
 * OpenCode's `shell` tool takes `background: true`. The call returns at once
 * with `metadata: { status: "running", shellID }`, the command keeps running
 * inside the OpenCode server, and OpenCode wakes the session when it ends. The
 * server publishes server-wide `shell.exited` / `shell.deleted` events that
 * carry only the shell id, so each runtime settles the shells it tracks.
 *
 * While a shell is tracked the chat is still working: it must keep listening
 * (and keep its hold on the shared server) or the wake-up reaches nobody.
 * Each shell is projected onto the `scheduled_work_update {kind:
 * "background_task"}` rows Claude's background commands use, so the thread,
 * the Background popover and the Work row show it the same way.
 */

export type OpenCodeBackgroundShellStart = { shellId: string; command: string };

export type OpenCodeBackgroundShellEnd = {
  shellId: string;
  status: "completed" | "failed" | "stopped";
  exitCode: number | null;
};

type ShellInfo = Awaited<ReturnType<OpenCodeClient["shell"]["get"]>>["data"];

function readRecordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The background shell a successful tool call left running, if it did. */
export function openCodeBackgroundShellStarted(
  event: OpenCodeEvent,
  toolInput: unknown,
): OpenCodeBackgroundShellStart | null {
  if (event.type !== "session.tool.success") return null;
  const metadata = readRecordValue(event.data.metadata);
  const shellId = metadata?.shellID;
  if (typeof shellId !== "string" || !shellId || metadata?.status !== "running") return null;
  const input = readRecordValue(toolInput);
  const command = typeof input?.command === "string" ? input.command.trim() : "";
  return { shellId, command };
}

function shellEndFromExit(status: unknown, exit: unknown): OpenCodeBackgroundShellEnd["status"] {
  if (status === "killed" || status === "cancelled") return "stopped";
  if (status === "timeout" || status === "error" || status === "failed") return "failed";
  // OpenCode records a signal death as `exited` with no exit code.
  if (typeof exit !== "number") return "stopped";
  return exit !== 0 ? "failed" : "completed";
}

/** A shell OpenCode reports as no longer running, as an end; null while it runs. */
export function openCodeShellInfoEnded(
  info: { id: string; status: string; exit?: number },
): OpenCodeBackgroundShellEnd | null {
  if (info.status === "running") return null;
  return {
    shellId: info.id,
    status: shellEndFromExit(info.status, info.exit),
    exitCode: typeof info.exit === "number" ? info.exit : null,
  };
}

/** The background shell an event reports as ended, if any. */
export function openCodeBackgroundShellEnded(event: OpenCodeEvent): OpenCodeBackgroundShellEnd | null {
  if (event.type === "shell.exited") return openCodeShellInfoEnded(event.data);
  if (event.type === "shell.deleted") {
    // Only meaningful for a shell still tracked as running: a normal exit is
    // reported first, and deletion then follows it.
    return { shellId: event.data.id, status: "stopped", exitCode: null };
  }
  if (event.type === "session.synthetic") {
    const metadata = readRecordValue(event.data.metadata);
    const shellId = metadata?.shellID;
    if (metadata?.source !== "shell" || typeof shellId !== "string" || !shellId) return null;
    // The notice names the job's state, not the process's: a completed job
    // with no exit code still completed.
    const exit = typeof metadata.exit === "number" ? metadata.exit : null;
    const status = metadata.state === "completed"
      ? (exit !== null && exit !== 0 ? "failed" : "completed")
      : shellEndFromExit(metadata.state, exit ?? undefined);
    return { shellId, status, exitCode: exit };
  }
  return null;
}

type ScheduledWorkEvent = Extract<AgentChatEvent, { type: "scheduled_work_update" }>;

export type OpenCodeShellRowDetail = {
  summary?: string;
  stopReason?: string;
  stopSource?: AgentChatStopSource;
};

type TrackedShell = {
  shellId: string;
  command: string;
  startedAt: number;
  /** The `shell` tool call that started it. */
  callId: string;
  turnId: string | null;
};

export type OpenCodeBackgroundShells = {
  /** Shells still running. */
  readonly size: number;
  /** When the oldest running shell started, or null when none runs. */
  earliestStartedAt(): number | null;
  has(shellId: string): boolean;
  track(start: OpenCodeBackgroundShellStart, callId: string): void;
  settle(end: OpenCodeBackgroundShellEnd, detail?: OpenCodeShellRowDetail): void;
  /**
   * Kill every running shell and settle the rows of those confirmed gone. A
   * shell that survives stays tracked and visible as running. Returns how many
   * stopped.
   */
  stopAll(detail: OpenCodeShellRowDetail): Promise<number>;
  /**
   * For a teardown, which cannot wait: settle every row as stopped now and
   * kill in the background. A kill that cannot be confirmed is reported
   * through `onKillUnconfirmed`; the shared server's own shutdown ends that
   * process later. Returns how many rows it settled.
   */
  stopAllNow(detail: OpenCodeShellRowDetail): number;
  /** Kill one running shell and, once it is gone, settle its row as stopped by the user. */
  stopOne(shellId: string): Promise<{ stopped: true } | { stopped: false; reason: string }>;
  /** Settle shells that ended while the event stream was down. */
  reconcile(): Promise<void>;
};

/**
 * Ends seen before their shell was tracked. A short command can exit before
 * its `session.tool.success` arrives; the late start then settles at once.
 * Bounded, because every shell on the server (foreground ones too, and other
 * chats') reports an exit.
 */
const EARLY_END_LIMIT = 32;

/** How long a stop waits for a signalled shell to exit before it reports failure. */
const STOP_CONFIRM_TIMEOUT_MS = 3_000;
const STOP_CONFIRM_POLL_MS = 100;

type KillOutcome = { gone: true } | { gone: false; reason: string };

export function createOpenCodeBackgroundShells(args: {
  client: Pick<OpenCodeClient, "shell">;
  directory: string;
  /** Emit one job row update into the chat. */
  emit: (event: ScheduledWorkEvent) => void;
  /** The turn the chat is in now, so a row lands in it. */
  currentTurnId: () => string | null;
  /** Stop a shell's process and its children. */
  killProcessTree: (pid: number) => void;
  isProcessAlive: (pid: number) => boolean;
  /** A kill a teardown could not confirm. */
  onKillUnconfirmed?: (shellId: string, reason: string) => void;
  /** False once the runtime that owns these shells was replaced or torn down. */
  isLive: () => boolean;
}): OpenCodeBackgroundShells {
  const shells = new Map<string, TrackedShell>();
  const endedBeforeTracking = new Map<string, OpenCodeBackgroundShellEnd>();
  const location = { directory: args.directory };

  const emitRow = (shell: TrackedShell, status: ScheduledWorkEvent["status"], detail?: OpenCodeShellRowDetail): void => {
    const turnId = args.currentTurnId() ?? shell.turnId ?? undefined;
    args.emit({
      type: "scheduled_work_update",
      id: `background:${shell.shellId}`,
      kind: "background_task",
      status,
      origin: "background_task",
      title: shell.command || "Background command",
      ...(detail?.summary ? { summary: detail.summary } : {}),
      ...(detail?.stopReason ? { stopReason: detail.stopReason } : {}),
      ...(detail?.stopSource ? { stopSource: detail.stopSource } : {}),
      sourceTaskId: shell.shellId,
      sourceToolUseId: shell.callId,
      ...(turnId ? { turnId } : {}),
    });
  };

  const settle = (end: OpenCodeBackgroundShellEnd, detail?: OpenCodeShellRowDetail): void => {
    const shell = shells.get(end.shellId);
    if (!shell) {
      // `shell.deleted` follows every normal exit; only the first end counts.
      if (endedBeforeTracking.has(end.shellId)) return;
      endedBeforeTracking.set(end.shellId, end);
      if (endedBeforeTracking.size > EARLY_END_LIMIT) {
        const oldest = endedBeforeTracking.keys().next().value;
        if (oldest !== undefined) endedBeforeTracking.delete(oldest);
      }
      return;
    }
    shells.delete(end.shellId);
    const summary = detail?.summary
      ?? (end.exitCode !== null && end.exitCode !== 0 ? `Exited with code ${end.exitCode}` : undefined);
    emitRow(shell, end.status, { ...detail, ...(summary ? { summary } : {}) });
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * Kill the process, not the record: OpenCode then tells the agent the
   * command was killed. Confirmed by the process being gone, not by the kill's
   * own result.
   */
  const kill = async (shellId: string): Promise<KillOutcome> => {
    let info: ShellInfo;
    try {
      info = (await args.client.shell.get({ id: shellId, location })).data;
    } catch (error) {
      return { gone: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (info.status !== "running") return { gone: true };
    const pid = info.pid;
    if (typeof pid !== "number") return { gone: false, reason: "OpenCode reported no process id for this command." };
    args.killProcessTree(pid);
    for (let waited = 0; args.isProcessAlive(pid); waited += STOP_CONFIRM_POLL_MS) {
      if (waited >= STOP_CONFIRM_TIMEOUT_MS) return { gone: false, reason: "The command was still running after ADE stopped it." };
      await sleep(STOP_CONFIRM_POLL_MS);
    }
    return { gone: true };
  };

  return {
    get size() {
      return shells.size;
    },
    earliestStartedAt() {
      let earliest: number | null = null;
      for (const shell of shells.values()) {
        if (earliest === null || shell.startedAt < earliest) earliest = shell.startedAt;
      }
      return earliest;
    },
    has: (shellId) => shells.has(shellId),
    track(start, callId) {
      if (shells.has(start.shellId)) return;
      const shell: TrackedShell = {
        shellId: start.shellId,
        command: start.command,
        startedAt: Date.now(),
        callId,
        turnId: args.currentTurnId(),
      };
      shells.set(shell.shellId, shell);
      emitRow(shell, "running");
      const endedEarly = endedBeforeTracking.get(shell.shellId);
      if (endedEarly) {
        endedBeforeTracking.delete(shell.shellId);
        settle(endedEarly);
      }
    },
    settle,
    async stopAll(detail) {
      const outcomes = await Promise.all([...shells.keys()].map(async (shellId) => ({ shellId, outcome: await kill(shellId) })));
      let stopped = 0;
      for (const { shellId, outcome } of outcomes) {
        if (!outcome.gone) continue;
        stopped += 1;
        if (args.isLive()) settle({ shellId, status: "stopped", exitCode: null }, detail);
      }
      return stopped;
    },
    stopAllNow(detail) {
      const running = [...shells.keys()];
      for (const shellId of running) {
        void kill(shellId).then((outcome) => {
          if (!outcome.gone) args.onKillUnconfirmed?.(shellId, outcome.reason);
        });
        settle({ shellId, status: "stopped", exitCode: null }, detail);
      }
      return running.length;
    },
    async stopOne(shellId) {
      if (!shells.has(shellId)) return { stopped: false, reason: "That background command is not running." };
      const outcome = await kill(shellId);
      if (!outcome.gone) return { stopped: false, reason: outcome.reason };
      if (args.isLive()) settle({ shellId, status: "stopped", exitCode: null }, { stopSource: "user", summary: "Stopped by user" });
      return { stopped: true };
    },
    async reconcile() {
      if (shells.size === 0) return;
      const listed = await args.client.shell.list({ location }).catch(() => null);
      if (!listed || !args.isLive()) return;
      const byId = new Map(listed.data.map((info) => [info.id, info] as const));
      for (const shellId of [...shells.keys()]) {
        const info = byId.get(shellId);
        if (info) {
          const ended = openCodeShellInfoEnded(info);
          if (ended) settle(ended);
          continue;
        }
        // OpenCode drops a shell once its result is read, so a missing one ended.
        settle({ shellId, status: "completed", exitCode: null }, { summary: "Ended while ADE was reconnecting" });
      }
    },
  };
}
