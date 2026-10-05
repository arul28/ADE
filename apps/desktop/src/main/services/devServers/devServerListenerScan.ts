import { execFile } from "node:child_process";

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
    if (known) locations.set(pid, known);
    else unknown.push(pid);
  }
  if (unknown.length > 0) {
    try {
      const cwdText = await runText(
        "lsof",
        ["-a", "-d", "cwd", "-F", "pn", "-p", unknown.join(",")],
        SCAN_TIMEOUT_MS,
      );
      for (const [pid, cwd] of parseLsofCwds(cwdText)) {
        locations.set(pid, { cwd, commandLine: null });
      }
    } catch {
      // A process that exited between the two queries has no cwd; it is
      // simply not attributed to a lane.
    }
  }
  return { sockets, locations };
}
