import { execFile } from "node:child_process";
import fs from "node:fs";

import { resolveTrustedWindowsTool } from "../../../../../ade-cli/src/lib/trustedWindowsTools";

/**
 * Which local TCP ports are listening, and which process owns each one.
 *
 * This is the half of dev-server discovery that does not depend on anyone
 * printing a ready line. A server an agent started in the background
 * (`npx vite &`) prints into a log nobody reads, so the only way to know it is
 * up is to ask the OS. One query covers the whole machine, so the cost does
 * not grow with the number of chats or lanes, and the caller decides when to
 * ask (see `devServerWatcher.ts`). Nothing here connects to a port or sends it
 * a request: a listener is reported, never probed.
 */

export type ListeningSocket = {
  pid: number;
  port: number;
  /** Short process name (`node`, `bun`). */
  command: string | null;
};

/** Where a process runs from, the thing a lane is matched on. */
export type ProcessLocation = {
  /** Working directory (macOS, Linux). */
  cwd: string | null;
  /** Full command line (Windows, which does not expose another process's cwd). */
  commandLine: string | null;
  /**
   * Windows: the process's parents, nearest first. A
   * `node server.js` started from a shell in the lane names no path itself,
   * but the shell or script that launched it often does.
   */
  ancestors?: Array<{ pid: number; commandLine: string | null }>;
  /**
   * The ADE chat whose agent started this process: `ADE_CHAT_SESSION_ID` in its
   * own environment (macOS, Linux). Every process a chat's agent starts
   * inherits it, even after the shell that started it exits and the server is
   * re-parented. Absent on Windows, which exposes no other process's env.
   */
  chatSessionId?: string | null;
  /** The environment could not be read (ps failed): the next scan reads it again. */
  chatSessionIdUnread?: boolean;
};


const SCAN_TIMEOUT_MS = 4_000;
/** Windows pays for a PowerShell start; give it room, it runs rarely. */
const WINDOWS_SCAN_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function runText(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
      (error, stdout) => {
        // lsof exits 1 when a filter matched nothing; its stdout is still the answer.
        if (error && !stdout) {
          reject(error);
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}

function portFromAddress(address: string): number | null {
  const match = /:(\d{1,5})$/.exec(address.trim());
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

/** `lsof -F pcn` output: `p<pid>`, `c<command>`, `n<address>` lines, grouped by process. */
function parseLsofListeners(text: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  const seen = new Set<string>();
  let pid: number | null = null;
  let command: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number(value);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      command = null;
    } else if (tag === "c") {
      command = value || null;
    } else if (tag === "n" && pid != null) {
      const port = portFromAddress(value);
      if (port == null) continue;
      const key = `${pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sockets.push({ pid, port, command });
    }
  }
  return sockets;
}

/** `lsof -d cwd -F pn` output: `p<pid>` then `n<directory>`. */
function parseLsofCwds(text: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line[0] === "p") {
      const parsed = Number(line.slice(1));
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (line[0] === "n" && pid != null) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

/** How far up the parent chain a Windows listener is traced to find its lane. */
const WINDOWS_ANCESTOR_DEPTH = 6;

const WINDOWS_LISTENER_QUERY = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$procs = @{}",
  "foreach ($p in @(Get-CimInstance Win32_Process)) { $procs[[int]$p.ProcessId] = $p }",
  "$rows = @(Get-NetTCPConnection -State Listen | Group-Object -Property OwningProcess | ForEach-Object {",
  "  $proc = $procs[[int]$_.Name]",
  "  $ports = @($_.Group | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique)",
  "  $chain = @()",
  "  $parent = if ($proc) { $procs[[int]$proc.ParentProcessId] } else { $null }",
  `  for ($i = 0; $i -lt ${WINDOWS_ANCESTOR_DEPTH} -and $parent; $i++) { $chain += [ordered]@{ pid = [int]$parent.ProcessId; commandLine = [string]$parent.CommandLine }; $parent = $procs[[int]$parent.ParentProcessId] }`,
  "  [ordered]@{ pid = [int]$_.Name; ports = $ports; name = [string]$proc.Name; commandLine = [string]$proc.CommandLine; ancestors = $chain }",
  "})",
  // rows → row → ancestors → ancestor: anything shallower turns the ancestor
  // objects into type-name strings on Windows PowerShell 5.1.
  "[Console]::Out.Write((ConvertTo-Json -InputObject @($rows) -Compress -Depth 5))",
].join("; ");

type WindowsListenerRow = {
  pid?: unknown;
  ports?: unknown;
  name?: unknown;
  commandLine?: unknown;
  ancestors?: unknown;
};

/** The env key every process a chat's agent starts carries (see `buildAgentRuntimeEnv`). */
const CHAT_SESSION_ENV_KEY = "ADE_CHAT_SESSION_ID";
/** A chat session id as ADE writes it: no spaces, no `=`. Anything else is not ours. */
const CHAT_SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * `ADE_CHAT_SESSION_ID` from one `ps -E` command column. macOS prints the
 * environment after the arguments with no separator a command cannot also
 * contain, so the LAST `ADE_CHAT_SESSION_ID=` token wins: the environment
 * comes after anything a command line spelled out.
 */
export function chatSessionIdFromPsEnvironment(text: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${CHAT_SESSION_ENV_KEY}=(\\S+)`, "g");
  let last: string | null = null;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) last = match[1] ?? null;
  return last && CHAT_SESSION_ID_SHAPE.test(last) ? last : null;
}

/** `ADE_CHAT_SESSION_ID` from a NUL-separated `/proc/<pid>/environ`. */
export function chatSessionIdFromProcEnviron(text: string): string | null {
  const prefix = `${CHAT_SESSION_ENV_KEY}=`;
  for (const entry of text.split("\0")) {
    if (!entry.startsWith(prefix)) continue;
    const value = entry.slice(prefix.length);
    return CHAT_SESSION_ID_SHAPE.test(value) ? value : null;
  }
  return null;
}

/**
 * Which ADE chat each process belongs to, read from its own environment.
 * Pids that exited, belong to another user, or carry no tag map to null; a
 * failed read is never a guess. Windows: always null (no env access).
 */
export async function readProcessChatSessionIds(
  pids: readonly number[],
  platform: NodeJS.Platform = process.platform,
  onError?: (error: unknown) => void,
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  for (const pid of unique) result.set(pid, null);
  if (unique.length === 0 || platform === "win32") return result;
  if (platform === "linux") {
    await Promise.all(unique.map(async (pid) => {
      try {
        const environ = await fs.promises.readFile(`/proc/${pid}/environ`, "utf8");
        result.set(pid, chatSessionIdFromProcEnviron(environ));
      } catch {
        // Exited, or not ours to read.
      }
    }));
    return result;
  }
  try {
    const text = await runText("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", unique.join(",")], SCAN_TIMEOUT_MS);
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      if (result.has(pid)) result.set(pid, chatSessionIdFromPsEnvironment(match[2] ?? ""));
    }
  } catch (error) {
    // ps failed: nothing is attributed, which only hides a server from its chat.
    onError?.(error);
  }
  return result;
}

/** The pids listening on one TCP port right now. Null when the OS could not be asked. */
export async function listeningPidsOnPort(
  port: number,
  platform: NodeJS.Platform = process.platform,
  onError?: (error: unknown) => void,
): Promise<number[] | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return [];
  if (platform === "win32") {
    try {
      const raw = await runText(
        resolveTrustedWindowsTool("powershell"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference = 'SilentlyContinue'; [Console]::Out.Write((ConvertTo-Json -InputObject @(@(Get-NetTCPConnection -State Listen -LocalPort ${port} | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique) | ForEach-Object { [int]$_ }) -Compress))`,
        ],
        WINDOWS_SCAN_TIMEOUT_MS,
      );
      const parsed: unknown = raw.trim() ? JSON.parse(raw) : [];
      const values = Array.isArray(parsed) ? parsed : [parsed];
      return [...new Set(values.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
    } catch (error) {
      onError?.(error);
      return null;
    }
  }
  try {
    const text = await runText("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pcn"], SCAN_TIMEOUT_MS);
    return [...new Set(parseLsofListeners(text).filter((socket) => socket.port === port).map((socket) => socket.pid))];
  } catch (error) {
    // lsof exits 1 with no output when nothing matched: nothing is listening.
    if ((error as { code?: unknown } | null)?.code === 1) return [];
    onError?.(error);
    return null;
  }
}

/**
 * Every listening socket on this machine, plus where each owner runs from.
 * Null when the platform's tool is missing or failed, so the caller can tell
 * "nothing is listening" apart from "could not look".
 */
export async function scanListeningProcesses(input: {
  platform?: NodeJS.Platform;
  /** Locations already known for these pids; only new pids are looked up. */
  knownLocations?: ReadonlyMap<number, ProcessLocation>;
} = {}): Promise<{ sockets: ListeningSocket[]; locations: Map<number, ProcessLocation> } | null> {
  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    let raw: string;
    try {
      // Never PATH's `powershell.exe`: this runs on agent activity.
      raw = await runText(
        resolveTrustedWindowsTool("powershell"),
        ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LISTENER_QUERY],
        WINDOWS_SCAN_TIMEOUT_MS,
      );
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = raw.trim() ? JSON.parse(raw) : [];
    } catch {
      return null;
    }
    const rows = (Array.isArray(parsed) ? parsed : [parsed]) as WindowsListenerRow[];
    const sockets: ListeningSocket[] = [];
    const locations = new Map<number, ProcessLocation>();
    for (const row of rows) {
      const pid = Number(row?.pid);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const ports = Array.isArray(row.ports) ? row.ports : [row.ports];
      for (const value of ports) {
        const port = Number(value);
        if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
          sockets.push({ pid, port, command: typeof row.name === "string" ? row.name : null });
        }
      }
      const ancestors = (Array.isArray(row.ancestors) ? row.ancestors : [row.ancestors])
        .flatMap((value) => {
          const ancestor = value as { pid?: unknown; commandLine?: unknown } | null;
          const ancestorPid = Number(ancestor?.pid);
          if (!Number.isInteger(ancestorPid) || ancestorPid <= 0) return [];
          const line = typeof ancestor?.commandLine === "string" ? ancestor.commandLine.trim() : "";
          return [{ pid: ancestorPid, commandLine: line || null }];
        });
      locations.set(pid, {
        cwd: null,
        commandLine: typeof row.commandLine === "string" && row.commandLine.trim() ? row.commandLine : null,
        ancestors,
      });
    }
    return { sockets, locations };
  }

  let listenersText: string;
  try {
    listenersText = await runText("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], SCAN_TIMEOUT_MS);
  } catch {
    return null;
  }
  const sockets = parseLsofListeners(listenersText);
  const locations = new Map<number, ProcessLocation>();
  const unknown: number[] = [];
  for (const pid of new Set(sockets.map((socket) => socket.pid))) {
    const known = input.knownLocations?.get(pid);
    if (known && !known.chatSessionIdUnread) locations.set(pid, known);
    else unknown.push(pid);
  }
  if (unknown.length > 0) {
    // The chat tag is read once per new pid, beside its cwd; known pids keep
    // theirs. A process's environment never changes, so a tag read is final,
    // unless the read itself failed: then the next scan asks again.
    let tagReadFailed = false;
    const [cwdText, chatSessionIds] = await Promise.all([
      runText("lsof", ["-a", "-d", "cwd", "-F", "pn", "-p", unknown.join(",")], SCAN_TIMEOUT_MS)
        // A process that exited between the two queries has no cwd; it is
        // simply not attributed to a lane.
        .catch(() => ""),
      readProcessChatSessionIds(unknown, platform, () => {
        tagReadFailed = true;
      }),
    ]);
    for (const [pid, cwd] of parseLsofCwds(cwdText)) {
      locations.set(pid, {
        cwd,
        commandLine: null,
        chatSessionId: chatSessionIds.get(pid) ?? null,
        ...(tagReadFailed ? { chatSessionIdUnread: true } : {}),
      });
    }
  }
  return { sockets, locations };
}
