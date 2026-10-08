import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveTrustedWindowsTool } from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import type {
  HomeKillResult,
  HomeListenersResult,
  HomeListeningProcess,
  HomeMachineDetail,
  HomeMachineDrive,
  HomeMachineHealth,
  HomeMachineProcessGroup,
} from "../../../shared/types/homeWidgets";
import { execFileOffThread, offThreadSpawnEnabled } from "../shared/offThreadSpawn";

/**
 * Machine health and listening ports for the home page's Machine widget.
 *
 * - Health is `os` counters plus one async `statfs`, answered when the widget
 *   asks (every 3 s while it is on screen). The Regular and Large views add
 *   detail: `netstat -e` for network bytes, drives re-listed every 30 s, and
 *   `tasklist` (Windows) or `ps` for the biggest memory users every 30 s.
 * - Listening ports come from `netstat -ano` and `tasklist` on Windows and
 *   `lsof` elsewhere, cached for 5 s and single-flight, so two windows asking
 *   at once run one scan.
 *
 * On Windows every tool is spawned off the main thread (`execFileOffThread`):
 * `CreateProcess` runs on the calling thread and costs 5 ms to a second on a
 * busy PC, and the main thread is the app's UI.
 */

type Logger = { warn: (event: string, data?: Record<string, unknown>) => void };

const LISTENERS_TTL_MS = 5_000;
const PROCESS_LIST_TTL_MS = 30_000;
const COMMAND_MAX_BUFFER = 8 * 1024 * 1024;

const DEV_PROCESS_NAMES = new Set([
  "node", "bun", "deno", "python", "python3", "pythonw", "py", "ruby", "java", "go", "php", "php-cgi", "dotnet",
  "rails", "puma", "uvicorn", "gunicorn", "beam.smp", "erl", "cargo", "esbuild", "vite", "next-server", "hugo",
  "caddy", "nginx", "httpd", "postgres", "redis-server", "mysqld", "mongod", "docker-proxy", "com.docker.backend",
  "wrangler", "workerd", "air", "uv", "ngrok", "cloudflared", "jekyll", "flask", "rustc",
]);

/** ADE's own executables, any channel: "ADE", "ADE Beta", "ADE Helper (GPU)", "ade-music-host", "ade-now-playing". */
const ADE_PROCESS_NAME = /^ade(?:\s|-|$)/i;

function processBaseName(name: string | null): string {
  return (name ?? "").toLowerCase().replace(/\.exe$/, "");
}

type CommandResult = { exitCode: number | null; stdout: string; stderr: string; error: Error | null };

/** Runs a short capture-style command; on Windows the spawn happens off the main thread. */
function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  if (offThreadSpawnEnabled()) return execFileOffThread(command, args, { timeoutMs, maxBuffer: COMMAND_MAX_BUFFER });
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: COMMAND_MAX_BUFFER, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code;
        resolve({
          exitCode: error ? (typeof code === "number" ? code : null) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error: error && typeof code !== "number" ? error : null,
        });
      },
    );
  });
}

/** A command's output; fails only when it produced nothing and could not run (or timed out). */
async function runText(command: string, args: string[], timeoutMs = 6_000): Promise<string> {
  const result = await runCommand(command, args, timeoutMs);
  if (result.error && !result.stdout) throw result.error;
  return result.stdout;
}

function windowsSystemTool(name: string): string {
  // Never PATH's copy: a planted netstat.exe would run on every scan.
  return path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", name);
}

/**
 * `tasklist /FO CSV /NH` as UTF-8. Into a pipe, tasklist writes the console's
 * OEM code page (437, 850, 866…), which turns a process named "pïngé.exe"
 * into mojibake; switching that hidden console to 65001 first makes it write
 * UTF-8. When the System32 path cannot sit unquoted on a command line, the
 * plain call is used and non-ASCII names may read wrong.
 */
function runTasklistCsv(timeoutMs = 6_000): Promise<string> {
  const tasklist = windowsSystemTool("tasklist.exe");
  const chcp = windowsSystemTool("chcp.com");
  if (/[\s"&^%|<>()]/.test(tasklist + chcp)) return runText(tasklist, ["/FO", "CSV", "/NH"], timeoutMs);
  return runText(windowsSystemTool("cmd.exe"), ["/d", "/s", "/c", `${chcp} 65001>nul & ${tasklist} /FO CSV /NH`], timeoutMs);
}

function portOf(address: string): number | null {
  const match = /:(\d{1,5})$/.exec(address.trim());
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** `netstat -ano` rows in the listening state, keyed by owner pid. Locale-proof: a listener's remote end is port 0. */
export function parseNetstatListeners(text: string): Map<number, Set<number>> {
  const byPid = new Map<number, Set<number>>();
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || !/^TCP/i.test(parts[0]!)) continue;
    const local = parts[1]!;
    const remote = parts[2]!;
    if (!/:0$/.test(remote)) continue;
    const pid = Number(parts.at(-1));
    const port = portOf(local);
    if (!Number.isInteger(pid) || pid <= 0 || port == null) continue;
    const ports = byPid.get(pid) ?? new Set<number>();
    ports.add(port);
    byPid.set(pid, ports);
  }
  return byPid;
}

/**
 * Windows processes the ports list never offers to stop, by name: the ones a
 * stop would crash or log off the machine, and service hosts.
 */
const WINDOWS_SYSTEM_PROCESS_NAMES = new Set([
  "system", "registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "lsaiso", "svchost",
  "spoolsv", "dwm", "fontdrvhost", "memory compression", "msmpeng", "searchindexer", "wudfhost",
]);

/**
 * `tasklist /FO CSV /NH`: `"name","pid","session name","session#",…` per
 * line. `system` is a process in session 0 (Windows services) or one named
 * in `WINDOWS_SYSTEM_PROCESS_NAMES`.
 */
export function parseTasklist(text: string): Map<number, { name: string; system: boolean }> {
  const processes = new Map<number, { name: string; system: boolean }>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"(?:,"[^"]*","(\d+)")?/.exec(line.trim());
    if (!match) continue;
    const name = match[1]!;
    const system = match[3] === "0" || WINDOWS_SYSTEM_PROCESS_NAMES.has(processBaseName(name));
    processes.set(Number(match[2]), { name, system });
  }
  return processes;
}

/** `lsof -F pcnu`: ports, names and owner uids by pid. */
function parseLsof(text: string): { byPid: Map<number, Set<number>>; names: Map<number, string>; uids: Map<number, number> } {
  const byPid = new Map<number, Set<number>>();
  const names = new Map<number, string>();
  const uids = new Map<number, number>();
  let pid: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number(value);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (tag === "c" && pid != null) {
      names.set(pid, value);
    } else if (tag === "u" && pid != null) {
      const uid = Number(value);
      if (Number.isInteger(uid)) uids.set(pid, uid);
    } else if (tag === "n" && pid != null) {
      const port = portOf(value);
      if (port == null) continue;
      const ports = byPid.get(pid) ?? new Set<number>();
      ports.add(port);
      byPid.set(pid, ports);
    }
  }
  return { byPid, names, uids };
}

/**
 * `netstat -e` (Windows): the first row with two counters is bytes received
 * and sent since boot. The row's label is localized; its place is not.
 */
export function parseNetstatBytes(text: string): { rx: number; tx: number } | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\S.*?\s+(\d+)\s+(\d+)\s*$/.exec(line.trim());
    if (match) return { rx: Number(match[1]), tx: Number(match[2]) };
  }
  return null;
}

/** `netstat -ib` (macOS): one `<Link#n>` row per interface; bytes in and out are 5th and 2nd from the end. */
export function parseNetstatInterfaceBytes(text: string): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8 || !/^<Link#\d+>$/.test(parts[2] ?? "") || /^lo\d*$/.test(parts[0] ?? "")) continue;
    const inBytes = Number(parts.at(-5));
    const outBytes = Number(parts.at(-2));
    if (!Number.isFinite(inBytes) || !Number.isFinite(outBytes)) continue;
    rx += inBytes;
    tx += outBytes;
    found = true;
  }
  return found ? { rx, tx } : null;
}

/** `/proc/net/dev` (Linux): receive bytes are the first counter, transmit bytes the ninth. */
export function parseProcNetDev(text: string): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!match || match[1] === "lo") continue;
    const fields = match[2]!.trim().split(/\s+/).map(Number);
    if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    rx += fields[0]!;
    tx += fields[8]!;
    found = true;
  }
  return found ? { rx, tx } : null;
}

function groupProcesses(rows: Array<{ name: string; memBytes: number; cpu: number | null }>): HomeMachineProcessGroup[] {
  const groups = new Map<string, HomeMachineProcessGroup>();
  for (const row of rows) {
    const key = row.name.toLowerCase();
    const group = groups.get(key) ?? { name: row.name, count: 0, memBytes: 0, cpuPercent: row.cpu == null ? null : 0 };
    group.count += 1;
    group.memBytes += row.memBytes;
    if (group.cpuPercent != null && row.cpu != null) group.cpuPercent += row.cpu;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, cpuPercent: group.cpuPercent == null ? null : Math.round(group.cpuPercent * 10) / 10 }))
    .sort((a, b) => b.memBytes - a.memBytes);
}

/** `tasklist /FO CSV /NH`, grouped by name: memory is the last column ("123,456 K", separators vary by locale). */
export function parseTasklistMemory(text: string): HomeMachineProcessGroup[] {
  const rows: Array<{ name: string; memBytes: number; cpu: null }> = [];
  for (const line of text.split("\n")) {
    // `"name","pid","session","#","mem"`: a plain split is several times faster than a regex per cell.
    const trimmed = line.trim();
    if (trimmed.length < 2 || trimmed[0] !== '"') continue;
    const cells = trimmed.slice(1, -1).split('","');
    if (cells.length < 5 || !/^\d+$/.test(cells[1]!)) continue;
    const pid = Number(cells[1]);
    const kb = Number(cells[cells.length - 1]!.replace(/[^\d]/g, ""));
    // The idle and kernel pseudo-processes are not something to act on.
    if (pid <= 4 || !Number.isFinite(kb) || kb <= 0) continue;
    rows.push({ name: cells[0]!.replace(/\.exe$/i, ""), memBytes: kb * 1024, cpu: null });
  }
  return groupProcesses(rows);
}

/** `ps -Ao rss=,pcpu=,comm=` (macOS, Linux), grouped by name; CPU becomes a share of all cores. */
export function parsePsList(text: string, cpuCount: number): HomeMachineProcessGroup[] {
  const rows: Array<{ name: string; memBytes: number; cpu: number }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const name = path.posix.basename(match[3]!.trim());
    rows.push({ name, memBytes: Number(match[1]) * 1024, cpu: Number(match[2]) / Math.max(1, cpuCount) });
  }
  return groupProcesses(rows);
}

/**
 * The port the dev renderer's Vite server listens on, when ADE runs from
 * source: `VITE_DEV_SERVER_URL`, else Vite's 5173 for an unpackaged build
 * (the same rule as `trustedRendererSender`).
 */
function devServerPort(isPackaged: boolean): number | null {
  const raw = process.env.VITE_DEV_SERVER_URL;
  if (!raw) return isPackaged ? null : 5173;
  try {
    const url = new URL(raw);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export function createMachineMonitor(deps: {
  platform: NodeJS.Platform;
  /** Pids of ADE's own processes (this app's), which the kill action refuses. */
  ownPids: () => number[];
  /** Pids of ADE's background runtime (the brain), when known. Also refused. */
  runtimePids?: () => Array<number | null | undefined>;
  onBatteryPower?: () => boolean;
  /** Electron's `app.isPackaged`; an unpackaged build also protects the dev renderer's server. Defaults to true. */
  isPackaged?: boolean;
  logger?: Logger;
}) {
  const { platform } = deps;

  let lastCpu: { idle: number; total: number; cores: Array<{ idle: number; total: number }> } | null = null;
  const cpuTimes = (cpus: os.CpuInfo[]) => {
    let idle = 0;
    let total = 0;
    const cores = cpus.map((cpu) => {
      const times = cpu.times;
      const coreTotal = times.user + times.nice + times.sys + times.idle + times.irq;
      idle += times.idle;
      total += coreTotal;
      return { idle: times.idle, total: coreTotal };
    });
    return { idle, total, cores };
  };
  const busyPercent = (now: { idle: number; total: number }, before: { idle: number; total: number } | undefined) => {
    if (!before || now.total <= before.total) return null;
    const busy = 1 - (now.idle - before.idle) / (now.total - before.total);
    return Math.max(0, Math.min(100, Math.round(busy * 100)));
  };

  // Detail state: the last minute of readings, kept while the widget asks.
  type Sample = { at: number; cpu: number; rx: number | null; tx: number | null };
  let samples: Sample[] = [];
  let lastNet: { at: number; rx: number; tx: number } | null = null;
  let lastDetail: { at: number; detail: HomeMachineDetail } | null = null;
  let drivesCache: { at: number; drives: HomeMachineDrive[] } | null = null;
  /** Drive letters whose statfs did not answer (a sleeping network share): never asked again. */
  const stalledDrives = new Set<string>();
  let processCache: { at: number; groups: HomeMachineProcessGroup[] } | null = null;
  let processInFlight: Promise<void> | null = null;

  const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | "timeout"> =>
    Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms).unref?.())]);

  const statDrive = async (drivePath: string): Promise<HomeMachineDrive | null> => {
    const result = await withTimeout(fs.statfs(drivePath).catch(() => null), 1_500);
    if (result === "timeout") {
      stalledDrives.add(drivePath);
      return null;
    }
    if (!result || result.blocks <= 0) return null;
    return { path: drivePath, totalBytes: result.blocks * result.bsize, freeBytes: result.bavail * result.bsize };
  };

  /** Fixed drives (Windows letters C–Z) or mounted volumes (macOS), re-listed every 30 s. */
  const readDrives = async (): Promise<HomeMachineDrive[]> => {
    if (drivesCache && Date.now() - drivesCache.at < 30_000) return drivesCache.drives;
    let candidates: string[];
    if (platform === "win32") {
      candidates = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((letter) => `${letter}:\\`).filter((drive) => !stalledDrives.has(drive));
    } else if (platform === "darwin") {
      const volumes = await fs.readdir("/Volumes", { withFileTypes: true }).catch(() => []);
      // "Macintosh HD" is a symlink to /; real mounts are directories.
      candidates = ["/", ...volumes.filter((entry) => entry.isDirectory()).map((entry) => path.posix.join("/Volumes", entry.name))];
    } else {
      candidates = ["/"];
    }
    const drives = (await Promise.all(candidates.map(statDrive))).filter((drive): drive is HomeMachineDrive => drive != null);
    drivesCache = { at: Date.now(), drives };
    return drives;
  };

  /** Bytes received and sent since boot, from native tools; null where it cannot be read. */
  const readNetTotals = async (): Promise<{ rx: number; tx: number } | null> => {
    try {
      if (platform === "win32") return parseNetstatBytes(await runText(windowsSystemTool("netstat.exe"), ["-e"], 4_000));
      if (platform === "darwin") return parseNetstatInterfaceBytes(await runText("/usr/sbin/netstat", ["-ib"], 4_000));
      return parseProcNetDev(await fs.readFile("/proc/net/dev", "utf8"));
    } catch {
      return null;
    }
  };

  const refreshProcesses = () => {
    // The list is refreshed every 30 s: a process list is a few hundred rows to read and group.
    if (processInFlight || (processCache && Date.now() - processCache.at < PROCESS_LIST_TTL_MS)) return;
    processInFlight = (async () => {
      try {
        const groups = platform === "win32"
          ? parseTasklistMemory(await runTasklistCsv())
          : parsePsList(await runText("ps", ["-Ao", "rss=,pcpu=,comm="]), os.cpus().length);
        processCache = { at: Date.now(), groups: groups.slice(0, 30) };
      } catch (error) {
        deps.logger?.warn("home.machine.processes_failed", { error: String(error) });
        processCache = { at: Date.now(), groups: processCache?.groups ?? [] };
      }
    })().finally(() => {
      processInFlight = null;
    });
  };

  const readDetail = async (cpuPercent: number | null, cores: number[]): Promise<HomeMachineDetail> => {
    const at = Date.now();
    // Two windows asking at once share one reading.
    if (lastDetail && at - lastDetail.at < 2_000) return lastDetail.detail;
    refreshProcesses();
    const [drives, totals] = await Promise.all([readDrives(), readNetTotals()]);
    let rx: number | null = null;
    let tx: number | null = null;
    if (totals && lastNet && at > lastNet.at && totals.rx >= lastNet.rx && totals.tx >= lastNet.tx && at - lastNet.at < 15_000) {
      const seconds = (at - lastNet.at) / 1_000;
      rx = Math.round((totals.rx - lastNet.rx) / seconds);
      tx = Math.round((totals.tx - lastNet.tx) / seconds);
    }
    if (totals) lastNet = { at, ...totals };
    // A gap (the widget was off screen) starts the minute over rather than drawing a straight line across it.
    if (samples.length > 0 && at - samples[samples.length - 1]!.at > 15_000) samples = [];
    if (cpuPercent != null) samples.push({ at, cpu: cpuPercent, rx, tx });
    samples = samples.filter((sample) => at - sample.at <= 62_000);
    const netSamples = samples.filter((sample) => sample.rx != null && sample.tx != null);
    const detail: HomeMachineDetail = {
      cores,
      cpuHistory: samples.map((sample) => sample.cpu),
      cpuAgesMs: samples.map((sample) => at - sample.at),
      netHistory: netSamples.length > 0
        ? { rx: netSamples.map((sample) => sample.rx!), tx: netSamples.map((sample) => sample.tx!), agesMs: netSamples.map((sample) => at - sample.at) }
        : null,
      net: rx != null && tx != null ? { rxBps: rx, txBps: tx } : null,
      drives,
      processes: processCache?.groups ?? null,
      memAvailableBytes: os.freemem(),
    };
    lastDetail = { at, detail };
    return detail;
  };

  const health = async (args?: { detail?: boolean }): Promise<HomeMachineHealth> => {
    if (!lastCpu) {
      // The first call has nothing to compare with: take a reading, wait a beat, and compare to that.
      lastCpu = cpuTimes(os.cpus());
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const cpus = os.cpus();
    const now = cpuTimes(cpus);
    const cpuPercent = busyPercent(now, lastCpu ?? undefined);
    const cores = now.cores.map((core, index) => busyPercent(core, lastCpu?.cores[index]) ?? 0);
    lastCpu = now;
    const diskPath = platform === "win32" ? path.parse(os.homedir()).root : "/";
    let disk: HomeMachineHealth["disk"] = null;
    try {
      const stats = await fs.statfs(diskPath);
      disk = { path: diskPath, totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
    } catch {
      disk = null;
    }
    return {
      cpuPercent,
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model?.trim() || null,
      memTotalBytes: os.totalmem(),
      memUsedBytes: os.totalmem() - os.freemem(),
      disk,
      uptimeSec: Math.round(os.uptime()),
      hostname: os.hostname(),
      platform,
      onBattery: deps.onBatteryPower?.() ?? false,
      ...(args?.detail ? { detail: await readDetail(cpuPercent, cores) } : {}),
    };
  };

  const processNames = new Map<number, string>();
  /** Pids of system and service processes (Windows session 0, root on macOS): listed, never stopped. */
  const systemPids = new Set<number>();
  let listenersCache: { at: number; result: HomeListenersResult } | null = null;
  let listenersInFlight: Promise<HomeListenersResult> | null = null;

  /** ADE's own processes: this app's, its runtime's, and the dev renderer server. */
  const protectedPids = (byPid: Map<number, Set<number>>): Set<number> => {
    const own = new Set<number>([process.pid, process.ppid, ...deps.ownPids()]);
    for (const pid of deps.runtimePids?.() ?? []) if (typeof pid === "number" && pid > 0) own.add(pid);
    const vitePort = devServerPort(deps.isPackaged ?? true);
    if (vitePort != null) {
      for (const [pid, ports] of byPid) if (ports.has(vitePort)) own.add(pid);
    }
    return own;
  };

  const scanListeners = async (): Promise<HomeListenersResult> => {
    let byPid: Map<number, Set<number>>;
    if (platform === "win32") {
      byPid = parseNetstatListeners(await runText(windowsSystemTool("netstat.exe"), ["-ano"]));
      const unknown = [...byPid.keys()].some((pid) => !processNames.has(pid));
      if (unknown) {
        // Names only change when pids do; one tasklist covers every new pid.
        const tasks = parseTasklist(await runTasklistCsv());
        processNames.clear();
        systemPids.clear();
        for (const [pid, task] of tasks) {
          processNames.set(pid, task.name);
          if (task.system) systemPids.add(pid);
        }
      }
    } else {
      const parsed = parseLsof(await runText("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcnu"]));
      byPid = parsed.byPid;
      for (const [pid, name] of parsed.names) processNames.set(pid, name);
      // Root's processes, when ADE is not root: a stop would only be refused.
      const ownUid = process.getuid?.() ?? -1;
      systemPids.clear();
      for (const [pid, uid] of parsed.uids) if (uid === 0 && ownUid !== 0) systemPids.add(pid);
    }
    const own = protectedPids(byPid);
    const processes: HomeListeningProcess[] = [...byPid.entries()]
      .filter(([pid]) => pid > 4)
      .map(([pid, ports]) => {
        const name = processNames.get(pid) ?? null;
        const base = processBaseName(name);
        return {
          pid,
          name,
          ports: [...ports].sort((a, b) => a - b),
          dev: DEV_PROCESS_NAMES.has(base),
          protected: own.has(pid) || ADE_PROCESS_NAME.test(base) || base === "electron",
          system: systemPids.has(pid) || (platform === "win32" && WINDOWS_SYSTEM_PROCESS_NAMES.has(base)),
        };
      })
      .sort((a, b) => Number(b.dev) - Number(a.dev) || (a.ports[0] ?? 0) - (b.ports[0] ?? 0));
    return { ok: true, processes, scannedAt: Date.now() };
  };

  const listeners = async (): Promise<HomeListenersResult> => {
    if (listenersCache && Date.now() - listenersCache.at < LISTENERS_TTL_MS) return listenersCache.result;
    listenersInFlight ??= scanListeners()
      .catch((error: unknown): HomeListenersResult => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then((result) => {
        listenersCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        listenersInFlight = null;
      });
    return listenersInFlight;
  };

  /** taskkill's own words ("ERROR: … Reason: Access is denied."), without the prefix. */
  const taskkillMessage = (result: CommandResult): string => {
    const text = (result.stderr.trim() || result.stdout.trim())
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[A-Z]+:\s*/, ""))
      .filter((line) => line.length > 0)
      .join(" ");
    return text || `taskkill exited with code ${result.exitCode}.`;
  };

  const kill = async (pid: number): Promise<HomeKillResult> => {
    if (!Number.isInteger(pid) || pid <= 4) return { ok: false, error: "Not a process ADE can stop." };
    // Only a process the last scan listed: the widget cannot be used to stop arbitrary pids.
    const current = await listeners();
    const target = current.ok ? current.processes.find((entry) => entry.pid === pid) : null;
    if (!target) return { ok: false, error: "That process is no longer listening." };
    if (target.protected) return { ok: false, error: "That is one of ADE's own processes." };
    if (target.system) return { ok: false, error: "That is a system process." };
    if (platform !== "win32") {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      listenersCache = null;
      return { ok: true };
    }
    let taskkill: string;
    try {
      taskkill = resolveTrustedWindowsTool("taskkill");
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const result = await runCommand(taskkill, ["/PID", String(pid), "/T", "/F"], 6_000);
    if (result.error) return { ok: false, error: result.error.message };
    // Exit 0 only means the kill was sent, and a non-zero exit can still have
    // stopped the leader: a scan started after it says whether it is still listening.
    if (listenersInFlight) await listenersInFlight;
    listenersCache = null;
    const after = await listeners();
    const stillListening = after.ok && after.processes.some((entry) => entry.pid === pid);
    if (!stillListening) return { ok: true };
    return { ok: false, error: result.exitCode === 0 ? "It is still running." : taskkillMessage(result) };
  };

  return { health, listeners, kill };
}

export type MachineMonitor = ReturnType<typeof createMachineMonitor>;
