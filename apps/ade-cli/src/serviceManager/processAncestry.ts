/**
 * Whether this process runs inside another one's process tree, and the refusal
 * every service backend returns when a command running inside the brain asks
 * to stop or restart it (an agent's shell is a child of the brain).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveTrustedWindowsTool } from "../lib/trustedWindowsTools";
import {
  ADE_RUNTIME_SERVICE_NAME,
  processOutputRaw,
  processOutputText,
  type ServiceManagerProcessResult,
  type ServiceManagerResult,
  type ServiceManagerSpawnSync,
} from "./common";

/**
 * The ancestry query could not be answered at all — the mechanism itself is
 * broken/absent, so we know NOTHING about the process tree. Distinct from
 * `null`, which is the definitive answer "this process has no further parent".
 */
export const PARENT_PID_UNKNOWN = "unknown" as const;

export type ParentPidLookup = number | null | typeof PARENT_PID_UNKNOWN;

/** Every pid from this process up to the root of its tree, or `PARENT_PID_UNKNOWN`. */
export type ProcessAncestry = ReadonlySet<number> | typeof PARENT_PID_UNKNOWN;

/** First token of a win32 ancestry line: a process in the chain. */
const WINDOWS_ANCESTRY_PROCESS = "P";
/** First token of the line that ends a win32 ancestry walk. */
const WINDOWS_ANCESTRY_END = "E";

/**
 * PowerShell that walks the parent chain of `pid` in ONE process start and
 * prints a line per process (`P <pid> <parent pid> <executable>`), then how the
 * walk ended (`E root`, `E broken` or `E depth`).
 *
 * One start rather than one per ancestor: a powershell.exe cold start is about
 * half a second, and a chain from an agent's Git Bash to the brain is ten or
 * more processes deep. `broken` means the next parent is gone, or its pid now
 * names a process created after the child (a reused pid, not the real parent).
 * A CIM error is not "gone": under `Stop` it fails the query (exit 1), which
 * reads as unknown, never as the end of the chain.
 *
 * `Get-CimInstance Win32_Process` rather than `wmic`: wmic is deprecated and is
 * being removed from Windows, and this matches the CIM queries already used by
 * `serviceManager/windowsSupervisor.ts`.
 */
export function buildWindowsAncestryQueryArgs(pid: number): string[] {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid for the Windows process-ancestry query: ${String(pid)}`);
  }
  const P = WINDOWS_ANCESTRY_PROCESS;
  const E = WINDOWS_ANCESTRY_END;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$cursor = ${pid}`,
    "$seen = @{}",
    "$childCreated = $null",
    "for ($depth = 0; $depth -lt 64; $depth++) {",
    `  if ($cursor -le 0 -or $seen.ContainsKey($cursor)) { [Console]::Out.Write("${E}\`troot"); exit 0 }`,
    "  $seen[$cursor] = $true",
    "  $row = Get-CimInstance Win32_Process -Filter \"ProcessId = $cursor\"",
    `  if ($null -eq $row) { [Console]::Out.Write("${E}\`tbroken"); exit 0 }`,
    "  $created = $row.CreationDate",
    `  if ($null -ne $childCreated -and $null -ne $created -and $created -gt $childCreated) { [Console]::Out.Write("${E}\`tbroken"); exit 0 }`,
    `  [Console]::Out.WriteLine("${P}\`t$($row.ProcessId)\`t$($row.ParentProcessId)\`t$($row.ExecutablePath)")`,
    "  if ($null -ne $created) { $childCreated = $created }",
    "  $cursor = [int]$row.ParentProcessId",
    "}",
    `[Console]::Out.Write("${E}\`tdepth")`,
  ].join("\n");
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

/**
 * Per-attempt budgets for the win32 ancestry query, in order.
 *
 * 5s was not enough: powershell.exe cold start plus the first CIM call in a
 * session routinely exceeds it on a contended Windows host, and a timeout is
 * indistinguishable from a real failure, so the guard falls back to
 * PARENT_PID_UNKNOWN and refuses a teardown the user is entitled to. 15s was
 * still not enough on a CPU-saturated host (a 2-core CI runner running other
 * suites in parallel), so a timeout gets ONE retry on a longer budget: by then
 * powershell.exe and the CIM infrastructure are warm, so the retry is the
 * steady-state cost, not another cold start. Only a timeout is retried — a real
 * answer and a real failure are both final.
 */
const WINDOWS_ANCESTRY_QUERY_TIMEOUTS_MS = [15_000, 25_000] as const;

/**
 * Whether `spawnSync` killed the child because it blew its `timeout` budget, as
 * opposed to the child answering. Node reports this as `error.code === 'ETIMEDOUT'`
 * with a null status; the signal check covers runtimes that only surface the kill.
 */
function isSpawnTimeout(result: ServiceManagerProcessResult): boolean {
  if (result.status !== null) return false;
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ETIMEDOUT" || result.signal === "SIGTERM";
}

type WindowsAncestor = { pid: number; parentPid: number; executablePath: string | null };
type WindowsAncestrySegment = { chain: WindowsAncestor[]; end: "root" | "broken" };

function parseWindowsAncestryOutput(text: string): WindowsAncestrySegment | typeof PARENT_PID_UNKNOWN {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const [endToken, end] = (lines.pop() ?? "").split("\t");
  if (endToken !== WINDOWS_ANCESTRY_END || (end !== "root" && end !== "broken")) return PARENT_PID_UNKNOWN;
  const chain: WindowsAncestor[] = [];
  for (const line of lines) {
    const [kind, pidText, parentText, ...executable] = line.split("\t");
    if (kind !== WINDOWS_ANCESTRY_PROCESS || !/^\d+$/.test(pidText ?? "") || !/^\d+$/.test(parentText ?? "")) {
      return PARENT_PID_UNKNOWN;
    }
    const pid = Number(pidText);
    if (pid <= 0) return PARENT_PID_UNKNOWN;
    chain.push({ pid, parentPid: Number(parentText), executablePath: executable.join("\t").trim() || null });
  }
  return { chain, end };
}

function readWindowsAncestrySegment(
  run: ServiceManagerSpawnSync,
  pid: number,
): WindowsAncestrySegment | typeof PARENT_PID_UNKNOWN {
  let result: ServiceManagerProcessResult | undefined;
  for (const [attempt, timeout] of WINDOWS_ANCESTRY_QUERY_TIMEOUTS_MS.entries()) {
    try {
      // Resolve through the hardened GLOBALROOT lookup: a bare `powershell` is
      // redirectable via PATH/SystemRoot, and this guard protects a teardown.
      result = run(
        resolveTrustedWindowsTool("powershell"),
        buildWindowsAncestryQueryArgs(pid),
        { encoding: "utf8", timeout, windowsHide: true },
      );
    } catch {
      return PARENT_PID_UNKNOWN;
    }
    const isLastAttempt = attempt === WINDOWS_ANCESTRY_QUERY_TIMEOUTS_MS.length - 1;
    if (isLastAttempt || !isSpawnTimeout(result)) break;
  }
  if (!result || result.status !== 0) return PARENT_PID_UNKNOWN;
  return parseWindowsAncestryOutput(processOutputRaw(result));
}

/** The runtime DLL that marks a folder as an MSYS2 (Git for Windows) or Cygwin `bin`. */
const MSYS_RUNTIME_DLLS = ["msys-2.0.dll", "cygwin1.dll"] as const;
const MSYS_PROCESS_LIST_TIMEOUT_MS = 15_000;

/**
 * The Windows pid of the MSYS parent of the chain's broken end, when the chain
 * broke inside an MSYS shell (Git Bash, which agents use on Windows).
 *
 * MSYS emulates `exec` of an MSYS program by starting a NEW Windows process and
 * ending the old one, so a script (`#!/bin/sh … exec ade.exe`, the shape of
 * ADE's own `ade` shim for Git Bash) leaves `sh.exe` with a Windows parent that
 * no longer exists. Windows ancestry ends there, far below the brain. MSYS
 * still knows the real parent: its own `ps -W` maps each MSYS pid to the
 * Windows pid currently running it, and to its MSYS parent.
 *
 * - `null`: the break is not inside MSYS, or the MSYS process has no MSYS
 *   parent (it was started by a Windows process, or its parent exited). The
 *   chain genuinely ends here, as it always has.
 * - `PARENT_PID_UNKNOWN`: the break is inside MSYS and MSYS could not say.
 */
function resolveMsysParentWinPid(
  run: ServiceManagerSpawnSync,
  chain: readonly WindowsAncestor[],
): number | null | typeof PARENT_PID_UNKNOWN {
  const broken = chain.at(-1);
  if (!broken?.executablePath) return null;
  // The chain comes from this host's Windows, so the host's path module is win32 there.
  const binDir = path.dirname(broken.executablePath);
  if (!MSYS_RUNTIME_DLLS.some((dll) => fs.existsSync(path.join(binDir, dll)))) return null;
  // That same install's `ps`: an MSYS install only knows its own processes.
  let result: ServiceManagerProcessResult;
  try {
    result = run(path.join(binDir, "ps.exe"), ["-W"], {
      encoding: "utf8",
      timeout: MSYS_PROCESS_LIST_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return PARENT_PID_UNKNOWN;
  }
  if (result.status !== 0) return PARENT_PID_UNKNOWN;
  // `ps -W` rows: [flag] PID PPID PGID WINPID TTY UID STIME COMMAND. A Windows
  // process MSYS did not start is listed with PPID 0.
  const byWinPid = new Map<number, { pid: number; ppid: number }>();
  const winPidByPid = new Map<number, number>();
  for (const line of processOutputRaw(result).split(/\r?\n/)) {
    const match = /^\s*(?:[A-Za-z]\s+)?(\d+)\s+(\d+)\s+\d+\s+(\d+)\s/.exec(line);
    if (!match) continue;
    const [pid, ppid, winPid] = [Number(match[1]), Number(match[2]), Number(match[3])];
    winPidByPid.set(pid, winPid);
    const known = byWinPid.get(winPid);
    if (!known || (known.ppid === 0 && ppid > 0)) byWinPid.set(winPid, { pid, ppid });
  }
  // The MSYS pid survives the exec; its Windows pid moved to the process that
  // replaced it, which sits further down the chain than the broken end.
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const row = byWinPid.get(chain[index]!.pid);
    if (!row || row.ppid === 0) continue;
    if (row.ppid === 1) return null;
    return winPidByPid.get(row.ppid) ?? null;
  }
  return PARENT_PID_UNKNOWN;
}

/** Most MSYS breaks one chain can recover from: one per script `exec` between the brain and this process. */
const MAX_WINDOWS_ANCESTRY_SEGMENTS = 8;

function readWindowsAncestorPids(run: ServiceManagerSpawnSync, startPid: number): ProcessAncestry {
  const ancestors = new Set<number>();
  let cursor = startPid;
  for (let segment = 0; segment < MAX_WINDOWS_ANCESTRY_SEGMENTS; segment += 1) {
    const walk = readWindowsAncestrySegment(run, cursor);
    if (walk === PARENT_PID_UNKNOWN) return PARENT_PID_UNKNOWN;
    // This process exists while it asks, so a walk that cannot find it found nothing.
    if (segment === 0 && walk.chain.length === 0) return PARENT_PID_UNKNOWN;
    for (const ancestor of walk.chain) {
      if (ancestors.has(ancestor.pid)) return ancestors;
      ancestors.add(ancestor.pid);
    }
    if (walk.end === "root") return ancestors;
    const next = resolveMsysParentWinPid(run, walk.chain);
    if (next === PARENT_PID_UNKNOWN) return PARENT_PID_UNKNOWN;
    if (next == null || ancestors.has(next)) return ancestors;
    cursor = next;
  }
  return PARENT_PID_UNKNOWN;
}

function readPosixParentPid(run: ServiceManagerSpawnSync, pid: number): ParentPidLookup {
  // `ps` exits 1 both for "no such pid" and for a genuine failure, so a POSIX
  // host cannot distinguish the two. `ps` is part of every POSIX base system,
  // so treat a non-zero exit as end-of-chain. A `ps` that never ran or was
  // killed answered nothing at all.
  let result: ServiceManagerProcessResult;
  try {
    result = run("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  } catch {
    return PARENT_PID_UNKNOWN;
  }
  if (result.error || result.status === null) return PARENT_PID_UNKNOWN;
  if (result.status !== 0) return null;
  const parentPid = Number.parseInt(processOutputText(result), 10);
  return Number.isFinite(parentPid) && parentPid > 0 ? parentPid : null;
}

type ProcessAncestryArgs = {
  run?: ServiceManagerSpawnSync;
  currentPid?: number;
  /** The platform whose process table is read; defaults to this host's. */
  platform?: NodeJS.Platform;
  /** Replaces the per-platform parent lookup with one answer per pid. */
  parentPid?: (pid: number) => ParentPidLookup;
};

/**
 * Every pid from this process up to the root of its tree, this process
 * included, or `PARENT_PID_UNKNOWN` when the ancestry cannot be determined.
 * One read answers any number of "is it inside X" questions.
 */
export function readCurrentProcessAncestorPids(args: ProcessAncestryArgs = {}): ProcessAncestry {
  const run = args.run ?? spawnSync;
  const platform = args.platform ?? process.platform;
  const start = Math.floor(args.currentPid ?? process.pid);
  if (!Number.isFinite(start) || start <= 0) return new Set();
  if (platform === "win32" && !args.parentPid) return readWindowsAncestorPids(run, start);
  const readPid = args.parentPid ?? ((pid: number) => readPosixParentPid(run, pid));
  const ancestors = new Set<number>();
  let cursor = start;
  while (Number.isFinite(cursor) && cursor > 0 && !ancestors.has(cursor)) {
    ancestors.add(cursor);
    const next = readPid(cursor);
    if (next === PARENT_PID_UNKNOWN) return PARENT_PID_UNKNOWN;
    if (!next) break;
    cursor = next;
  }
  return ancestors;
}

/**
 * Whether this process is running inside the process tree rooted at `targetPid`.
 *
 * This is a SAFETY guard: its callers use it to refuse tearing down the very
 * runtime the command was issued from. When ancestry cannot be determined
 * (`PARENT_PID_UNKNOWN`) it therefore answers `true` — fail CLOSED. A false
 * "yes" costs the user one refusal that names the
 * `ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION=1` override; a false "no" silently
 * destroys a live runtime and every active session on it. Only the first is
 * recoverable.
 */
export function isCurrentProcessDescendantOfPid(args: ProcessAncestryArgs & { targetPid: number }): boolean {
  const targetPid = Math.floor(args.targetPid);
  if (!Number.isFinite(targetPid) || targetPid <= 0) return false;
  const ancestors = readCurrentProcessAncestorPids(args);
  return ancestors === PARENT_PID_UNKNOWN || ancestors.has(targetPid);
}

/**
 * `pids` without the processes this command runs inside, for a reap whose list
 * was read after the refusal ran (a later scan finds brains the refusal never
 * saw). Reaps none when the ancestry cannot be read; the override keeps all.
 */
export function withoutOwnAncestors(
  pids: readonly number[],
  args: Omit<ProcessAncestryArgs, "platform"> & { platform: NodeJS.Platform; env: NodeJS.ProcessEnv },
): number[] {
  if (pids.length === 0 || allowsSelfServiceMutation(args.env)) return [...pids];
  const ancestors = readCurrentProcessAncestorPids(args);
  if (ancestors === PARENT_PID_UNKNOWN) return [];
  return pids.filter((pid) => !ancestors.has(pid));
}

/** Whether `ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION=1` lets a command inside the brain tear it down. */
export function allowsSelfServiceMutation(env: NodeJS.ProcessEnv): boolean {
  return env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION === "1";
}

/**
 * The result a backend returns when it refuses to stop or restart the brain
 * this command may be running inside. `brainPid` names the process, when one
 * is known; `unconfirmed` is set when the command could not tell whether it
 * runs inside the brain (it is refused all the same).
 */
export function selfServiceMutationRefusal(args: {
  action: "install" | "uninstall";
  path: string | null;
  serviceName?: string;
  brainPid?: number | null;
  unconfirmed?: boolean;
}): ServiceManagerResult {
  const verb = args.action === "install" ? "restart" : "stop";
  const pid = args.brainPid != null ? ` (pid ${args.brainPid})` : "";
  const subject = args.unconfirmed
    ? `ADE brain${pid}: this command could not confirm that it runs outside that brain`
    : `ADE brain from a command running inside that brain${pid}`;
  return {
    ok: false,
    selfMutationBlocked: true,
    ...(args.unconfirmed ? { selfMutationUnconfirmed: true } : {}),
    serviceName: args.serviceName ?? ADE_RUNTIME_SERVICE_NAME,
    action: args.action,
    path: args.path,
    message:
      `Refusing to ${verb} ${subject}. Run this from an external terminal, or set `
      + "ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION=1 if you intentionally want to tear down active ADE sessions.",
  };
}

/**
 * The refusal every service backend returns when a command running inside the
 * brain asks to restart or stop it, or null when it may go ahead.
 *
 * `pids` is every process the action would stop (brain first, then
 * supervisors and strays). The ancestry is read once for all of them, and only
 * when there is one. `ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION=1` skips the
 * check; ADE's own update helpers set it. Callers branch on
 * `selfMutationBlocked`, never the message.
 */
export function refuseSelfServiceMutation(args: Omit<ProcessAncestryArgs, "platform"> & {
  /** The service backend's own platform, not the host's (tests run every backend on every host). */
  platform: NodeJS.Platform;
  action: "install" | "uninstall";
  path: string | null;
  pids: ReadonlyArray<number | null | undefined>;
  env: NodeJS.ProcessEnv;
  serviceName?: string;
}): ServiceManagerResult | null {
  if (allowsSelfServiceMutation(args.env)) return null;
  const candidates = [...new Set(args.pids)].filter(
    (pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0,
  );
  if (candidates.length === 0) return null;
  const ancestors = readCurrentProcessAncestorPids(args);
  const unconfirmed = ancestors === PARENT_PID_UNKNOWN;
  const owner = unconfirmed ? candidates[0] : candidates.find((pid) => ancestors.has(pid));
  if (owner == null) return null;
  return selfServiceMutationRefusal({
    action: args.action,
    path: args.path,
    serviceName: args.serviceName,
    brainPid: owner,
    unconfirmed,
  });
}
