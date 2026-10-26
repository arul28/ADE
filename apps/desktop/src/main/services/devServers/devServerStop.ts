import { execFile } from "node:child_process";

import { resolveTrustedWindowsTool } from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import type { DevServerRecord, DevServerStopResult } from "../../../shared/types/builtInBrowser";
import type { Logger } from "../logging/logger";
import { windowsTaskkillInvocation } from "../shared/processExecution";
import { signalProcessGroup } from "../shared/utils";
import { listeningPidsOnPort, readProcessChatSessionIds } from "./devServerListenerScan";

/**
 * Stop a dev server a chat's agent started, and nothing else.
 *
 * The server was found earlier (a ready line, a listener scan), but a port can
 * change hands between then and the click, so everything is decided again
 * from what the OS says NOW:
 *
 * - Who listens on the port. Every listener must be the chat's: a port shared
 *   with anything else is refused, not half-stopped.
 * - Whose it is. On macOS and Linux the process carries the chat's
 *   `ADE_CHAT_SESSION_ID` in its own environment; every process the agent
 *   starts inherits it, even after it is re-parented. Windows cannot read
 *   another process's environment, so there the chat must have reported the
 *   server (its own command printed the address), the listener must run
 *   under this runtime, and it must have started shortly before that report:
 *   not after it (a port re-used by a newer process) and not long before it
 *   (a server the chat only called or read about).
 * - What must never be hit: this runtime, every process above it (the
 *   desktop app that launched it), and the first two levels below it (the
 *   agent CLIs, the PTY host, the terminal shells and agent CLIs it runs). A
 *   server whose own tree contains one of those (a dev script that launched
 *   ADE) is refused too, because stopping it would stop ADE.
 *
 * Then: SIGTERM to the server's process group when the group holds nothing
 * protected and nothing of another chat's, otherwise to the server and its own
 * children; SIGKILL after a grace period for whatever is still the same
 * process. Windows: `taskkill /T`, then `taskkill /T /F`.
 */

const DEFAULT_GRACE_MS = 3_000;
const POLL_MS = 150;
const PROCESS_TABLE_TIMEOUT_MS = 4_000;
const WINDOWS_PROCESS_TABLE_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Windows: how much later than the chat's report a listener may have started and still be that server. */
const WINDOWS_DETECTION_SLACK_MS = 5_000;
/**
 * Windows: how long before the chat's report the listener may have started. A
 * server a chat starts prints its address within moments; one that was already
 * running when the chat printed its address (a curl, a log it tailed) belongs
 * to someone else. Too strict only ever refuses, and the terminal can stop it.
 */
const WINDOWS_REPORT_WINDOW_MS = 2 * 60_000;
/** Depth below this runtime that is always protected: agent CLIs, the PTY host, terminal shells. */
const PROTECTED_DESCENDANT_DEPTH = 2;

type ProcessEntry = {
  pid: number;
  ppid: number;
  /** POSIX process group; 0 on Windows. */
  pgid: number;
  /** Identity across pid reuse: `lstart` text on POSIX, creation epoch ms on Windows. */
  started: string;
  /** Epoch ms when known (Windows), for the detection-time check. */
  startedMs: number | null;
  zombie: boolean;
};

type ProcessTable = Map<number, ProcessEntry>;

function runText(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        if (error && !stdout) {
          reject(error);
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}

/** `ps -axo pid=,ppid=,pgid=,stat=,lstart=`: four numbers-ish, then the start time with spaces. */
export function parsePosixProcessTable(text: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, {
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      started: match[5] ?? "",
      startedMs: null,
      zombie: (match[4] ?? "").startsWith("Z"),
    });
  }
  return table;
}

const WINDOWS_PROCESS_TABLE_QUERY = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$epoch = [datetime]'1970-01-01T00:00:00Z'",
  "$rows = @(Get-CimInstance Win32_Process | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; started = if ($_.CreationDate) { [long]($_.CreationDate.ToUniversalTime() - $epoch.ToUniversalTime()).TotalMilliseconds } else { 0 } } })",
  "[Console]::Out.Write((ConvertTo-Json -InputObject @($rows) -Compress))",
].join("; ");

async function readProcessTable(platform: NodeJS.Platform, onError?: (error: unknown) => void): Promise<ProcessTable | null> {
  if (platform === "win32") {
    try {
      const raw = await runText(
        resolveTrustedWindowsTool("powershell"),
        ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_TABLE_QUERY],
        WINDOWS_PROCESS_TABLE_TIMEOUT_MS,
      );
      const parsed: unknown = raw.trim() ? JSON.parse(raw) : [];
      const table: ProcessTable = new Map();
      for (const row of (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>) {
        const pid = Number(row?.pid);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const startedMs = Number(row.started);
        table.set(pid, {
          pid,
          ppid: Number(row.ppid) || 0,
          pgid: 0,
          started: String(startedMs || 0),
          startedMs: Number.isFinite(startedMs) && startedMs > 0 ? startedMs : null,
          zombie: false,
        });
      }
      return table;
    } catch (error) {
      onError?.(error);
      return null;
    }
  }
  try {
    const text = await runText("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], PROCESS_TABLE_TIMEOUT_MS);
    const table = parsePosixProcessTable(text);
    return table.size > 0 ? table : null;
  } catch (error) {
    onError?.(error);
    return null;
  }
}

/** Windows recycles pids: a parent link is real only when the parent is older than the child. */
function parentOf(table: ProcessTable, entry: ProcessEntry, platform: NodeJS.Platform): ProcessEntry | null {
  const parent = table.get(entry.ppid);
  if (!parent || parent.pid === entry.pid) return null;
  if (platform === "win32" && parent.startedMs != null && entry.startedMs != null && parent.startedMs > entry.startedMs) {
    return null;
  }
  return parent;
}

function childrenIndex(table: ProcessTable, platform: NodeJS.Platform): Map<number, number[]> {
  const index = new Map<number, number[]>();
  for (const entry of table.values()) {
    const parent = parentOf(table, entry, platform);
    if (!parent) continue;
    const list = index.get(parent.pid);
    if (list) list.push(entry.pid);
    else index.set(parent.pid, [entry.pid]);
  }
  return index;
}

function descendantsOf(pid: number, children: Map<number, number[]>): number[] {
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  const queue = [...(children.get(pid) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return out;
}

/**
 * This runtime, everything above it, and the first levels below it. Pid 1 and
 * the platform's idle/system pids are never targets either.
 */
export function protectedPidsFor(
  table: ProcessTable,
  selfPid: number,
  platform: NodeJS.Platform,
  extraPids: readonly number[] = [],
): Set<number> {
  const protectedPids = new Set<number>([0, 1, 4, selfPid, ...extraPids.filter((pid) => Number.isInteger(pid) && pid > 0)]);
  const self = table.get(selfPid);
  for (let current = self ? parentOf(table, self, platform) : null, guard = 0; current && guard < 64; guard += 1) {
    protectedPids.add(current.pid);
    current = parentOf(table, current, platform);
  }
  const children = childrenIndex(table, platform);
  let level = [selfPid];
  for (let depth = 0; depth < PROTECTED_DESCENDANT_DEPTH; depth += 1) {
    const next: number[] = [];
    for (const pid of level) {
      for (const child of children.get(pid) ?? []) {
        protectedPids.add(child);
        next.push(child);
      }
    }
    level = next;
  }
  return protectedPids;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  // Not unref'd: a stop in progress is a promise someone awaits.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function portOfDevRenderer(): number | null {
  const raw = process.env.VITE_DEV_SERVER_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

type KillPlan = {
  /** POSIX process groups signalled as a whole. */
  groups: number[];
  /** Single processes signalled one by one (POSIX), or tree roots (Windows). */
  pids: number[];
  /** Every process the plan expects to end, with its identity at plan time. */
  expected: Map<number, string>;
};

export async function stopChatDevServer(input: {
  chatSessionId: string;
  port: number;
  /** The chat's own record of this server. Windows ownership rests on it. */
  record?: DevServerRecord | null;
  platform?: NodeJS.Platform;
  /** More of ADE's own processes (a sync listener) that are never targets. */
  protectedPids?: readonly number[];
  graceMs?: number;
  logger?: Logger | null;
}): Promise<DevServerStopResult> {
  const platform = input.platform ?? process.platform;
  const port = input.port;
  const chatSessionId = input.chatSessionId.trim();
  const refuse = (reason: Extract<DevServerStopResult, { ok: false }>["reason"], error: string): DevServerStopResult => {
    input.logger?.info("dev_servers.stop_refused", { chatSessionId, port, reason });
    return { ok: false, port, reason, error };
  };
  if (!chatSessionId || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return refuse("invalid", "Name the chat and the port of the server to stop.");
  }
  if (port === portOfDevRenderer()) {
    return refuse("protected", `Port ${port} is ADE's own dev renderer.`);
  }

  // A failed OS read is refused below; say why in the log, not only that it failed.
  const logReadFailure = (step: string) => (error: unknown) => {
    input.logger?.warn("dev_servers.stop_os_read_failed", {
      chatSessionId,
      port,
      step,
      error: error instanceof Error ? error.message : String(error),
    });
  };
  const listeners = await listeningPidsOnPort(port, platform, logReadFailure("listeners"));
  if (listeners === null) return refuse("failed", `ADE could not check what is using port ${port}.`);
  if (listeners.length === 0) return { ok: true, port, stopped: [], forced: false, alreadyStopped: true };

  const table = await readProcessTable(platform, logReadFailure("process_table"));
  if (!table) return refuse("failed", "ADE could not read this computer's process list.");
  const protectedPids = protectedPidsFor(table, process.pid, platform, input.protectedPids);
  const children = childrenIndex(table, platform);

  for (const pid of listeners) {
    if (protectedPids.has(pid)) {
      return refuse("protected", `Port ${port} belongs to ADE or to a chat's agent itself, not to a server it started.`);
    }
    if (descendantsOf(pid, children).some((child) => protectedPids.has(child))) {
      return refuse("protected", `Stopping the server on port ${port} would also stop ADE.`);
    }
  }

  // Ownership, decided now.
  const tags = await readProcessChatSessionIds(platform === "win32" ? [] : listeners, platform);
  if (platform === "win32") {
    const record = input.record ?? null;
    const reportedAt = record ? Date.parse(record.detectedAt) : Number.NaN;
    const reportedByChat = record?.source.sessionId === chatSessionId && record.port === port && Number.isFinite(reportedAt);
    // Another chat named this port first: a listener already up by then is
    // that chat's server, which this chat only printed the address of.
    const earlier = record?.previousReport;
    const earlierAt = earlier?.sessionId && earlier.sessionId !== chatSessionId ? Date.parse(earlier.detectedAt) : Number.NaN;
    // A report is only the chat printing an address, which it also does for a
    // server it merely called. So the listener must also run under this
    // runtime (an agent or terminal ADE started), never something started
    // outside ADE.
    const underRuntime = new Set(descendantsOf(process.pid, children));
    for (const pid of listeners) {
      const startedMs = table.get(pid)?.startedMs ?? null;
      if (
        !reportedByChat
        || !underRuntime.has(pid)
        || startedMs == null
        || startedMs > reportedAt + WINDOWS_DETECTION_SLACK_MS
        || startedMs < reportedAt - WINDOWS_REPORT_WINDOW_MS
        || (Number.isFinite(earlierAt) && startedMs <= earlierAt + WINDOWS_DETECTION_SLACK_MS)
      ) {
        return refuse("not_owned", `Port ${port} is held by something this chat did not start.`);
      }
    }
  } else {
    for (const pid of listeners) {
      if (tags.get(pid) !== chatSessionId) {
        return refuse("not_owned", `Port ${port} is held by something this chat did not start.`);
      }
    }
  }

  const plan: KillPlan = { groups: [], pids: [], expected: new Map() };
  const expect = (pid: number) => {
    const entry = table.get(pid);
    if (entry && !protectedPids.has(pid)) plan.expected.set(pid, entry.started);
  };
  if (platform === "win32") {
    for (const pid of listeners) {
      plan.pids.push(pid);
      expect(pid);
      for (const child of descendantsOf(pid, children)) expect(child);
    }
  } else {
    // One read of the tags of everything in the listeners' groups.
    const groupIds = [...new Set(listeners.map((pid) => table.get(pid)?.pgid ?? 0))];
    const members = [...table.values()].filter((entry) => groupIds.includes(entry.pgid));
    const memberTags = await readProcessChatSessionIds(members.map((entry) => entry.pid).filter((pid) => !tags.has(pid)), platform);
    const tagOf = (pid: number) => tags.get(pid) ?? memberTags.get(pid) ?? null;
    for (const pid of listeners) {
      const pgid = table.get(pid)?.pgid ?? 0;
      const groupMembers = members.filter((entry) => entry.pgid === pgid);
      const groupIsTheChats = pgid > 1
        && !protectedPids.has(pgid)
        && groupMembers.every((entry) => !protectedPids.has(entry.pid))
        // Every member must be provably the chat's: an untagged process (its
        // environment unreadable, or cleared) may be anyone's.
        && groupMembers.every((entry) => tagOf(entry.pid) === chatSessionId);
      if (groupIsTheChats) {
        if (!plan.groups.includes(pgid)) plan.groups.push(pgid);
        for (const entry of groupMembers) expect(entry.pid);
      } else {
        // The group is shared with the agent or a terminal: the server and its
        // own children only.
        plan.pids.push(pid);
        expect(pid);
      }
      for (const child of descendantsOf(pid, children)) {
        const tag = tagOf(child);
        if (protectedPids.has(child) || (tag !== null && tag !== chatSessionId)) continue;
        if (!groupIsTheChats && !plan.pids.includes(child)) plan.pids.push(child);
        expect(child);
      }
    }
  }

  input.logger?.info("dev_servers.stop_requested", {
    chatSessionId,
    port,
    groups: plan.groups,
    pids: plan.pids,
  });

  const signalAll = async (force: boolean, stillTheSame: Set<number>): Promise<void> => {
    if (platform === "win32") {
      await Promise.all(plan.pids.filter((pid) => stillTheSame.has(pid)).map((pid) => {
        const invocation = windowsTaskkillInvocation(pid, { force });
        return runText(invocation.command, invocation.args, 15_000).catch(() => "");
      }));
      return;
    }
    const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
    for (const pgid of plan.groups) {
      // A group is signalled again only while its leader-side members are the ones planned.
      const members = [...plan.expected.keys()].filter((pid) => table.get(pid)?.pgid === pgid);
      if (force && !members.some((pid) => stillTheSame.has(pid))) continue;
      try {
        signalProcessGroup(pgid, signal);
      } catch {
        // Already gone.
      }
    }
    for (const pid of plan.pids) {
      if (!stillTheSame.has(pid)) continue;
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone.
      }
    }
  };

  await signalAll(false, new Set(plan.expected.keys()));

  const graceMs = Math.max(0, input.graceMs ?? DEFAULT_GRACE_MS);
  const deadline = Date.now() + graceMs;
  let alive = [...plan.expected.keys()].filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(POLL_MS);
    alive = alive.filter(isAlive);
  }

  let forced = false;
  if (alive.length > 0) {
    // Only what is still the SAME process (same start time, not a zombie) is
    // forced; a pid the OS handed to something new in the meantime is left be.
    const now = await readProcessTable(platform);
    const same = new Set(alive.filter((pid) => {
      const entry = now?.get(pid);
      return Boolean(entry && !entry.zombie && entry.started === plan.expected.get(pid));
    }));
    if (same.size > 0) {
      forced = true;
      await signalAll(true, same);
      const forceDeadline = Date.now() + 1_000;
      let remaining = [...same].filter(isAlive);
      while (remaining.length > 0 && Date.now() < forceDeadline) {
        await sleep(POLL_MS);
        remaining = remaining.filter(isAlive);
      }
    }
  }

  const stillListening = await listeningPidsOnPort(port, platform, logReadFailure("final_check"));
  // Could not look: do not claim it stopped, or the row forgets a running server.
  if (stillListening === null) {
    return refuse("failed", `ADE could not confirm that the server on port ${port} stopped.`);
  }
  if (stillListening.some((pid) => listeners.includes(pid))) {
    return refuse("failed", `The server on port ${port} is still running.`);
  }
  input.logger?.info("dev_servers.stopped", { chatSessionId, port, forced });
  return { ok: true, port, stopped: [...plan.expected.keys()], forced };
}
