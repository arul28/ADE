import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logging/logger";
import {
  ADE_OPENCODE_XDG_LAYOUT_VERSION,
  resolveAdeOpenCodeIsolationPaths,
  resolveAdeOpenCodeRuntimeRoot,
} from "../../../shared/opencodeDataHome";
import { killWindowsProcessTree, windowsPowerShellCommand } from "../shared/processExecution";
import { parseProcessRows, terminateOrphanProcess as terminateProcessOrphan } from "../shared/processOrphans";

/**
 * The OS side of ADE's OpenCode servers: finding their processes, stopping
 * them, and reaping the ones a dead ADE left behind.
 *
 * A server carries two identities. The `ADE_OPENCODE_MANAGED` and
 * `ADE_OPENCODE_OWNER_PID` markers in its environment show in `ps -wwE` on
 * macOS and in `/proc/<pid>/environ` on Linux; Windows listings cannot show a
 * child's environment, so an on-disk registry record per server is the
 * platform-neutral identity.
 */

export const ADE_OPENCODE_MANAGED_ENV = "ADE_OPENCODE_MANAGED";
export const ADE_OPENCODE_OWNER_PID_ENV = "ADE_OPENCODE_OWNER_PID";
const ORPHAN_RECOVERY_TERM_GRACE_MS = 250;

export type OpenCodeProcessSnapshot = {
  pid: number;
  ppid: number;
  command: string;
};

type OpenCodeProcessController = {
  listProcesses(): OpenCodeProcessSnapshot[];
  listListeningPids(port: number): number[];
  isProcessAlive(pid: number): boolean;
  killProcess(pid: number, signal: NodeJS.Signals): void;
  killProcessTree(pid: number): boolean;
  waitForMs(ms: number): Promise<void>;
};

export type OpenCodeOrphanRecoveryResult = {
  recoveredPids: number[];
  skippedPids: number[];
};

type ElectronLikeModule = {
  app?: {
    getPath(name: string): string;
  };
};

function commandLooksLikeOpenCodeServe(command: string): boolean {
  return /\bopencode(?:\.cmd|\.bat|\.exe)?\b/i.test(command) && /\bserve\b/i.test(command);
}

function readLinuxProcessEnvironment(pid: number): string[] {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    return raw
      .split("\0")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
}

function parseOneCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === "\"") {
        if (line[i + 1] === "\"") {
          cur += "\"";
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }
    if (c === "\"") {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      out.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  out.push(cur);
  return out;
}

/** Parses WMIC `process get ... /FORMAT:CSV` stdout into snapshots (exported for unit tests). */
export function parseWindowsWmicProcessCsv(stdout: string): OpenCodeProcessSnapshot[] {
  const rows: OpenCodeProcessSnapshot[] = [];
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return rows;

  const header = parseOneCsvLine(lines[0]!);
  const processIdIdx = header.indexOf("ProcessId");
  const parentProcessIdIdx = header.indexOf("ParentProcessId");
  const commandLineIdx = header.indexOf("CommandLine");
  if (processIdIdx < 0 || parentProcessIdIdx < 0 || commandLineIdx < 0) {
    return rows;
  }

  const maxIdx = Math.max(processIdIdx, parentProcessIdIdx, commandLineIdx);
  for (let li = 1; li < lines.length; li += 1) {
    const cells = parseOneCsvLine(lines[li]!);
    if (cells.length <= maxIdx) continue;
    const pid = Number(cells[processIdIdx]?.trim());
    const ppid = Number(cells[parentProcessIdIdx]?.trim());
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) {
      continue;
    }
    const command = (cells[commandLineIdx] ?? "").trim();
    rows.push({ pid, ppid, command });
  }
  return rows;
}

function listWindowsProcessesFromWmic(): OpenCodeProcessSnapshot[] {
  const result = spawnSync(
    "wmic",
    ["process", "get", "ProcessId,ParentProcessId,CommandLine", "/FORMAT:CSV"],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return [];
  }
  return parseWindowsWmicProcessCsv(result.stdout);
}

function listWindowsProcessesFromPowerShell(): OpenCodeProcessSnapshot[] {
  const script =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation";
  const result = spawnSync(
    // The System32 path, so a poisoned PATH cannot answer the listing.
    windowsPowerShellCommand(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return [];
  }
  return parseWindowsWmicProcessCsv(result.stdout);
}

function listWindowsProcesses(): OpenCodeProcessSnapshot[] {
  const fromWmic = listWindowsProcessesFromWmic();
  if (fromWmic.length > 0 && fromWmic.every((process) => process.command.trim().length > 0)) {
    return fromWmic;
  }
  return listWindowsProcessesFromPowerShell();
}

function withDarwinCandidateEnvironments(rows: OpenCodeProcessSnapshot[]): OpenCodeProcessSnapshot[] {
  if (process.platform !== "darwin") return rows;
  const candidatePids = rows
    .filter((proc) => commandLooksLikeOpenCodeServe(proc.command))
    .map((proc) => proc.pid);
  if (candidatePids.length === 0) return rows;

  const result = spawnSync(
    "ps",
    ["-wwE", "-p", candidatePids.join(","), "-o", "pid=,ppid=,command="],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 5 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return rows;
  }

  const enrichedByPid = new Map(parseProcessRows(result.stdout).map((proc) => [proc.pid, proc]));
  return rows.map((proc) => enrichedByPid.get(proc.pid) ?? proc);
}

/**
 * The process operations recovery and shutdown use. Every platform difference
 * (WMIC/PowerShell listings, `taskkill` trees, `lsof`) lives here.
 */
const openCodeProcesses: OpenCodeProcessController = {
  listProcesses(): OpenCodeProcessSnapshot[] {
    if (process.platform === "win32") {
      return listWindowsProcesses();
    }
    const result = spawnSync("ps", ["-ww", "-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      return [];
    }
    const rows = parseProcessRows(result.stdout);
    if (process.platform === "linux") {
      return rows.map((proc) => {
        if (!commandLooksLikeOpenCodeServe(proc.command)) return proc;
        return {
          ...proc,
          command: [proc.command, ...readLinuxProcessEnvironment(proc.pid)].join(" "),
        };
      });
    }
    return withDarwinCandidateEnvironments(rows);
  },
  listListeningPids(port: number): number[] {
    if (!Number.isInteger(port) || port <= 0) return [];
    if (process.platform === "win32") return [];
    const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      return [];
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  },
  isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  killProcess(pid: number, signal: NodeJS.Signals): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, signal);
    } catch {
      // ignore
    }
  },
  killProcessTree(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (process.platform === "win32") {
      // The trusted System32 `taskkill /T /F`, so a poisoned PATH cannot
      // answer the kill.
      return killWindowsProcessTree(pid, (detail) => {
        console.error("opencode.kill_process_tree_taskkill_failed", detail);
      });
    }
    // Unix: best-effort tree kill. Send SIGTERM to the process group first
    // (covers children spawned via setsid/group leader). Then walk any
    // descendants with pkill -TERM -P as a fallback. Finally SIGTERM the pid
    // itself so at minimum the root process terminates.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Not a group leader (or no permission); fall through to child-walk.
    }
    try {
      spawnSync("pkill", ["-TERM", "-P", String(pid)], { windowsHide: true });
    } catch {
      // pkill may be unavailable; ignore.
    }
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  },
  waitForMs(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};
let orphanRecoveryPromise: Promise<OpenCodeOrphanRecoveryResult> | null = null;
let lastOrphanRecoveryResult: OpenCodeOrphanRecoveryResult = {
  recoveredPids: [],
  skippedPids: [],
};
let orphanRecoveryCompleted = false;

/**
 * Stop one command an OpenCode server is running (a background shell), with
 * its children. OpenCode starts each shell detached, so on Unix the pid leads
 * its own process group; Windows walks the tree with `taskkill /T`. OpenCode
 * sees the exit and reports the signal to the agent, which a delete of the
 * shell record would not.
 */
export function killOpenCodeShellProcessTree(pid: number): boolean {
  return openCodeProcesses.killProcessTree(pid);
}

export function stopChildProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32" && proc.pid && openCodeProcesses.killProcessTree(proc.pid)) {
    return;
  }
  proc.kill();
}

// `--port` may appear in a recorded command line either bare (`--port=N` or
// `--port N`) or wrapped in cmd.exe-style quotes (`"--port=N"` / `"--port" "N"`)
// because the Windows launch path quotes every token through
// {@link quoteWindowsCmdArg}. Allow leading/trailing `"` as a token boundary
// alongside whitespace so PID discovery still matches managed servers spawned
// via the Windows wrapper.
function commandHasPort(command: string, port: number): boolean {
  const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[\\s"])--port(?:=|\\s+|"\\s+")${escapedPort}(?:[\\s"]|$)`,
  ).test(command);
}

function parseManagedOpenCodePort(command: string): number | null {
  const match = command.match(/(?:^|[\s"])--port(?:=|\s+|"\s+")(\d+)(?:[\s"]|$)/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function resolveOpenCodeListenerPid(port: number): number | null {
  const listeningPids = openCodeProcesses.listListeningPids(port);
  if (listeningPids.length === 1) return listeningPids[0]!;
  if (listeningPids.length > 1) {
    const managed = openCodeProcesses.listProcesses()
      .filter((proc) => listeningPids.includes(proc.pid))
      .find((proc) => isManagedOpenCodeServeCommand(proc.command, buildManagedConfigMarkers()));
    return managed?.pid ?? listeningPids[0]!;
  }

  const configMarkers = buildManagedConfigMarkers();
  const matching = openCodeProcesses.listProcesses()
    .filter((proc) =>
      commandHasPort(proc.command, port)
      && isManagedOpenCodeServeCommand(proc.command, configMarkers)
    );
  if (matching.length === 0) return null;
  const nonNode = matching.find((proc) => !/\bnode(?:\.exe)?\b/i.test(proc.command));
  return (nonNode ?? matching[0]!).pid;
}

export function terminateOpenCodeServerProcesses(proc: ChildProcess, listenerPid: number | null): void {
  const listenerHandled = listenerPid !== null && openCodeProcesses.isProcessAlive(listenerPid);
  if (listenerHandled) {
    if (process.platform === "win32") {
      openCodeProcesses.killProcessTree(listenerPid);
    } else {
      openCodeProcesses.killProcess(listenerPid, "SIGTERM");
    }
  }

  // When the listener PID matches the spawned child PID, the kill above already
  // signalled it -- do not double-kill the same process.
  if (listenerHandled && listenerPid === proc.pid) {
    return;
  }

  stopChildProcess(proc);
}

/**
 * Roots an older ADE could have written before the shared resolver existed.
 *
 * Orphan recovery must still reap a server launched under Electron `userData`;
 * no live code resolves a data home there any more (see
 * `shared/opencodeDataHome.ts` for why that split was a bug).
 */
function resolveLegacyManagedOpenCodeRoots(current: string): string[] {
  const roots: string[] = [];
  try {
    const electron = require("electron") as ElectronLikeModule;
    const userDataPath = electron.app?.getPath?.("userData");
    if (typeof userDataPath === "string" && userDataPath.trim().length > 0) {
      roots.push(path.resolve(userDataPath, "opencode-runtime"));
    }
  } catch {
    // Not running under Electron.
  }
  // A brain launched with ADE_HOME (or the XDG override) elsewhere may still
  // have old servers under the plain home root; Windows cannot see their env,
  // so the registry scan must know the path. This is the only way they get
  // reaped after an upgrade.
  const homeDir = os.homedir().trim();
  if (homeDir.length > 0) roots.push(path.resolve(homeDir, ".ade", "opencode-runtime"));
  return roots.filter((root) => path.resolve(root) !== path.resolve(current));
}

function resolveKnownAdeManagedOpenCodeRoots(): string[] {
  const current = resolveAdeOpenCodeRuntimeRoot();
  const roots = new Set<string>([current]);
  for (const legacy of resolveLegacyManagedOpenCodeRoots(current)) roots.add(legacy);
  return [...roots];
}

function buildManagedConfigMarkers(): string[] {
  const markers = new Set<string>();
  for (const root of resolveKnownAdeManagedOpenCodeRoots()) {
    const xdgRoot = path.join(root, `xdg-v${ADE_OPENCODE_XDG_LAYOUT_VERSION}`);
    markers.add(`XDG_CONFIG_HOME=${path.join(xdgRoot, "config")}`);
    markers.add(`OPENCODE_CONFIG_DIR=${path.join(xdgRoot, "config", "opencode")}`);
  }
  return [...markers];
}

function isManagedOpenCodeServeCommand(command: string, configMarkers: string[]): boolean {
  // Windows: managed markers are injected into the cmd.exe command line (WMIC/CIM omit child env).
  if (
    /\bcmd(?:\.exe)?\b/i.test(command)
    && command.includes(`${ADE_OPENCODE_MANAGED_ENV}=1`)
    && /\bopencode(?:\.cmd|\.bat|\.exe)?\b/i.test(command)
    && /\bserve\b/i.test(command)
  ) {
    return true;
  }
  if (!/\bopencode(?:\.cmd|\.bat|\.exe)?\b\s+serve\b/i.test(command)) return false;
  if (command.includes(`${ADE_OPENCODE_MANAGED_ENV}=1`)) return true;
  // Keep recognizing older isolated servers that predate the ownership marker.
  return command.includes("OPENCODE_DISABLE_PROJECT_CONFIG=1")
    && configMarkers.some((marker) => command.includes(marker));
}

/**
 * On-disk record of a server process ADE launched. Windows process listings do
 * not expose a child's environment, so the `ADE_OPENCODE_MANAGED` marker that
 * identifies managed servers in `ps -wwE` output on macOS (and `/proc/<pid>/environ`
 * on Linux) has no Windows equivalent. This registry is the platform-neutral
 * identity: it survives an ADE crash, so the next launch can reap the servers the
 * dead process left behind on every platform.
 */
type ManagedOpenCodeServerRecord = {
  pid: number;
  port: number;
  ownerPid: number;
  startedAt: number;
  /** The server's generated config, which holds provider keys; removed with the record. */
  configFile?: string;
};

function managedServerRegistryDirs(): string[] {
  return resolveKnownAdeManagedOpenCodeRoots().map((root) => (
    path.join(root, `xdg-v${ADE_OPENCODE_XDG_LAYOUT_VERSION}`, "runtime", "servers")
  ));
}

function managedServerRecordPath(pid: number): string {
  return path.join(
    resolveAdeOpenCodeIsolationPaths().runtimeDir,
    "servers",
    `${pid}.json`,
  );
}

export function writeManagedServerRecord(record: ManagedOpenCodeServerRecord): void {
  try {
    const filePath = managedServerRecordPath(record.pid);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(record), "utf8");
  } catch {
    // Recovery is best-effort; a registry write failure must not fail a launch.
  }
}

export function removeManagedServerRecord(pid: number, options: { keepConfig?: boolean } = {}): void {
  for (const dir of managedServerRegistryDirs()) {
    const file = path.join(dir, `${pid}.json`);
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ManagedOpenCodeServerRecord>;
      if (!options.keepConfig && typeof record.configFile === "string") removeProfileConfig(record.configFile);
    } catch {
      // No record here, or an unreadable one.
    }
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

function readManagedServerRecords(): Array<{ file: string; record: ManagedOpenCodeServerRecord }> {
  const out: Array<{ file: string; record: ManagedOpenCodeServerRecord }> = [];
  const seenPids = new Set<number>();
  for (const dir of managedServerRegistryDirs()) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ManagedOpenCodeServerRecord>;
        const pid = Number(parsed.pid);
        const ownerPid = Number(parsed.ownerPid);
        if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ownerPid) || ownerPid <= 0) {
          fs.rmSync(file, { force: true });
          continue;
        }
        if (seenPids.has(pid)) continue;
        seenPids.add(pid);
        out.push({
          file,
          record: {
            pid,
            ownerPid,
            port: Number.isInteger(Number(parsed.port)) ? Number(parsed.port) : 0,
            startedAt: Number.isFinite(Number(parsed.startedAt)) ? Number(parsed.startedAt) : 0,
            ...(typeof parsed.configFile === "string" ? { configFile: parsed.configFile } : {}),
          },
        });
      } catch {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // ignore
        }
      }
    }
  }
  return out;
}

function parseManagedOwnerPid(command: string): number | null {
  const match = command.match(new RegExp(`${ADE_OPENCODE_OWNER_PID_ENV}=(\\d+)`, "i"));
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Terminate an orphaned managed server, escalating once if it survives the
 * grace period. Windows has no POSIX signals, so it uses a `taskkill /T /F`
 * tree kill on both passes; Unix escalates SIGTERM → SIGKILL.
 */
async function terminateOrphanProcess(pid: number): Promise<boolean> {
  const outcome = await terminateProcessOrphan(pid, {
    platform: process.platform,
    graceMs: ORPHAN_RECOVERY_TERM_GRACE_MS,
    isAlive: (target) => openCodeProcesses.isProcessAlive(target),
    waitMs: (ms) => openCodeProcesses.waitForMs(ms),
    kill: (target, signal) => openCodeProcesses.killProcess(target, signal),
    killTree: (target) => openCodeProcesses.killProcessTree(target),
  });
  return outcome === "exited";
}

/**
 * Reap managed servers whose owner is gone: by process listing first, then by
 * the on-disk registry. `activePorts` names the ports of this process's live
 * servers, which recovery must never touch.
 */
export async function recoverManagedOpenCodeOrphans(args: {
  force?: boolean;
  logger?: Logger | null;
  activePorts: () => ReadonlySet<number>;
}): Promise<OpenCodeOrphanRecoveryResult> {
  if (orphanRecoveryPromise) {
    const inFlightResult = await orphanRecoveryPromise;
    if (!args.force) {
      return inFlightResult;
    }
  }

  if (!args.force && orphanRecoveryCompleted) {
    return lastOrphanRecoveryResult;
  }

  const recoveryPromise = (async () => {
    const configMarkers = buildManagedConfigMarkers();
    const activePorts = args.activePorts();
    const recoveredPids: number[] = [];
    const skippedPids: number[] = [];
    const handledPids = new Set<number>();
    const snapshot = openCodeProcesses.listProcesses();
    const commandByPid = new Map(snapshot.map((proc) => [proc.pid, proc.command]));

    for (const proc of snapshot) {
      if (proc.pid === process.pid) continue;
      if (!isManagedOpenCodeServeCommand(proc.command, configMarkers)) continue;

      const ownerPid = parseManagedOwnerPid(proc.command);
      if (ownerPid === process.pid) {
        const port = parseManagedOpenCodePort(proc.command);
        if (port != null && activePorts.has(port)) {
          skippedPids.push(proc.pid);
          continue;
        }
      }
      const ownerAlive = ownerPid != null
        && openCodeProcesses.isProcessAlive(ownerPid);
      const isOrphan = ownerPid != null
        ? !ownerAlive || ownerPid === process.pid
        : proc.ppid === 1;

      if (!isOrphan) {
        skippedPids.push(proc.pid);
        continue;
      }

      if (!await terminateOrphanProcess(proc.pid)) {
        skippedPids.push(proc.pid);
        args.logger?.warn("opencode.server_orphan_recovery_failed", {
          pid: proc.pid,
          ownerPid,
          ppid: proc.ppid,
        });
        continue;
      }
      handledPids.add(proc.pid);
      recoveredPids.push(proc.pid);
      args.logger?.warn("opencode.server_orphan_recovered", {
        pid: proc.pid,
        ownerPid,
        ppid: proc.ppid,
        port: parseManagedOpenCodePort(proc.command),
      });
      removeManagedServerRecord(proc.pid);
    }

    // Second pass: the on-disk registry. This is the only identity that works on
    // Windows, where a process listing cannot show a child's environment and the
    // managed markers therefore never appear on the server's command line.
    for (const { file, record } of readManagedServerRecords()) {
      if (record.pid === process.pid) continue;
      if (handledPids.has(record.pid)) continue;
      if (!openCodeProcesses.isProcessAlive(record.pid)) {
        removeManagedServerRecord(record.pid);
        continue;
      }
      // Guard against PID reuse: the live process must still look like an
      // OpenCode server before we are willing to kill it.
      const command = commandByPid.get(record.pid);
      if (command === undefined) {
        // The process listing may have failed or missed a newer process. Keep
        // the record for a later pass rather than killing an unidentified PID.
        skippedPids.push(record.pid);
        continue;
      }
      if (!commandLooksLikeOpenCodeServe(command)) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // ignore
        }
        continue;
      }
      const ownerAlive = record.ownerPid !== process.pid
        && openCodeProcesses.isProcessAlive(record.ownerPid);
      if (ownerAlive) {
        skippedPids.push(record.pid);
        continue;
      }
      if (record.ownerPid === process.pid && record.port > 0 && activePorts.has(record.port)) {
        skippedPids.push(record.pid);
        continue;
      }
      if (!await terminateOrphanProcess(record.pid)) {
        skippedPids.push(record.pid);
        args.logger?.warn("opencode.server_orphan_recovery_failed", {
          pid: record.pid,
          ownerPid: record.ownerPid,
          source: "registry",
        });
        continue;
      }
      handledPids.add(record.pid);
      recoveredPids.push(record.pid);
      args.logger?.warn("opencode.server_orphan_recovered", {
        pid: record.pid,
        ownerPid: record.ownerPid,
        port: record.port,
        source: "registry",
      });
      removeManagedServerRecord(record.pid);
    }

    lastOrphanRecoveryResult = { recoveredPids, skippedPids };
    orphanRecoveryCompleted = true;
    return lastOrphanRecoveryResult;
  })().finally(() => {
    orphanRecoveryPromise = null;
  });

  orphanRecoveryPromise = recoveryPromise;
  return await recoveryPromise;
}

function isProfileConfigFile(file: string): boolean {
  const dir = path.resolve(resolveAdeOpenCodeIsolationPaths().root, "config-ade");
  const resolved = path.resolve(file);
  return path.dirname(resolved) === dir && resolved.endsWith(".json");
}

export function removeProfileConfig(file: string): void {
  // A registry record is data on disk: never delete a path it names outside the config directory.
  if (!isProfileConfigFile(file)) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

/** The last recovery pass, for diagnostics. */
export function lastOpenCodeOrphanRecovery(): OpenCodeOrphanRecoveryResult {
  return lastOrphanRecoveryResult;
}
