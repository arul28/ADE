import path from "node:path";
import { readProcessMemory, runHostTool, type HostMemoryReadDeps } from "./hostMemorySignals";
import { windowsPowerShellCommand } from "../shared/processExecution";

/*
 * What is using this machine, in the few groups a triage needs: ADE's own
 * processes split into the installed brain, a developer's brain, and the
 * desktop app; Android emulators; iOS simulators; and everything else as one
 * sum. On 2026-11-06 a Mac froze with no ADE signal at all, and the question
 * nobody could answer afterwards was "was it ADE, the emulators, or something
 * else?".
 *
 * Privacy: command lines are read only to sort a process into a group, here,
 * and never leave this module. The answer is group names, counts, MB and CPU
 * percent: no process names, paths or arguments, and nothing about another
 * application beyond its share of "other".
 *
 * One listing per call (`ps` with the command line, or one PowerShell CIM read
 * on Windows), plus the real-memory read `readProcessMemory` makes for ADE's
 * and the emulators' pids (macOS `footprint`: RSS under-reports an emulator
 * about fourfold). A caller asks only when it needs the answer: a resource
 * pressure episode, a diagnostic report.
 */

export type ProcessGroupName =
  | "installed_brain"
  | "dev_brain"
  | "desktop"
  | "android_emulator"
  | "ios_simulator"
  | "other";

export const PROCESS_GROUP_NAMES: readonly ProcessGroupName[] = [
  "installed_brain",
  "dev_brain",
  "desktop",
  "android_emulator",
  "ios_simulator",
  "other",
];

export type ProcessGroupUsage = {
  group: ProcessGroupName;
  count: number;
  /** Real memory for ADE's and the emulators' groups (footprint on macOS), RSS for `other`. */
  mb: number;
  /** Sum of the processes' CPU percent (one core = 100); null where it is not read (Windows). */
  cpuPercent: number | null;
};

export type ProcessGroupSnapshot = {
  groups: ProcessGroupUsage[];
  /** Running Android emulators (one `qemu-system` per device). */
  emulatorCount: number;
  devBrainRunning: boolean;
};

type ListedProcess = { pid: number; rssMb: number; cpuPercent: number | null; command: string };

/** A source checkout's CLI: `apps/ade-cli/{src,dist}/…`, as `isSourceCheckoutRuntimeModule` reads it. */
const SOURCE_CHECKOUT_CLI = /(?:^|[/\\])apps[/\\]ade-cli[/\\](?:src|dist)[/\\]/i;
const SOURCE_CHECKOUT_DESKTOP = /(?:^|[/\\])apps[/\\]desktop[/\\]/i;
/** The packaged brain: the app's bundled `ade-cli/cli.cjs`, or the standalone runtime serving. */
const PACKAGED_CLI = /[/\\]ade-cli[/\\]cli\.cjs\b/i;
const DESKTOP_APP = /[/\\]ADE(?: Alpha)?\.app[/\\]|[/\\]ADE(?: Alpha)?\.exe\b|[/\\](?:opt|usr[/\\]lib)[/\\]ade(?:-alpha)?[/\\]|\.AppImage\b/i;

/**
 * The base name of the command's first token (quoted on Windows when it has
 * spaces). Only the emulator and standalone-runtime checks use it; the app
 * bundles, whose paths have spaces, are matched on the whole line.
 */
function executableName(command: string): string {
  const trimmed = command.trim();
  const quoted = /^"([^"]+)"/.exec(trimmed);
  const head = quoted ? quoted[1]! : trimmed.split(/\s+/)[0] ?? trimmed;
  return path.basename(head.replace(/\\/g, "/")).replace(/\.exe$/i, "").toLowerCase();
}

/** Which group one process belongs to, from its command line. Pure. */
export function classifyProcessCommand(command: string): ProcessGroupName {
  const exe = executableName(command);
  if (/^qemu-system/.test(exe) || /^emulator(?:64)?(?:-|$)/.test(exe) || /[/\\]emulator[/\\]qemu[/\\]/i.test(command)) {
    return "android_emulator";
  }
  if (exe === "launchd_sim" || exe === "simulator" || /[/\\]CoreSimulator[/\\]|[/\\]Simulator\.app[/\\]/i.test(command)) {
    return "ios_simulator";
  }
  const serving = /\sserve(?:\s|$)/.test(command);
  // A brain from a source checkout; its other commands (a test run, a one-off
  // `ade`) are not a second brain and stay in `other`.
  if (SOURCE_CHECKOUT_CLI.test(command) && serving) return "dev_brain";
  if (PACKAGED_CLI.test(command) || ((exe === "ade" || exe === "ade-alpha") && serving)) return "installed_brain";
  if (DESKTOP_APP.test(command) || (SOURCE_CHECKOUT_DESKTOP.test(command) && /electron/i.test(command))) return "desktop";
  return "other";
}

/** `ps -axww -o pid=,rss=,pcpu=,args=` rows (RSS in KB). */
export function parsePsCommandRows(text: string): ListedProcess[] {
  const rows: ListedProcess[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      rssMb: Math.round(Number(match[2]) / 1024),
      cpuPercent: Number(match[3]),
      command: match[4]!,
    });
  }
  return rows;
}

/** The Windows script's rows: `pid<TAB>workingSet<TAB>privateBytes<TAB>commandLine` (bytes). */
export function parseWindowsProcessCommandRows(text: string): ListedProcess[] {
  const rows: ListedProcess[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const [pid, workingSet, privateBytes, ...commandParts] = line.replace(/\r$/, "").split("\t");
    if (!pid || !/^\d+$/u.test(pid.trim())) continue;
    const bytes = Math.max(Number(workingSet) || 0, Number(privateBytes) || 0);
    rows.push({ pid: Number(pid), rssMb: Math.round(bytes / (1024 * 1024)), cpuPercent: null, command: commandParts.join("\t") });
  }
  return rows;
}

const WINDOWS_PROCESS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "Get-CimInstance Win32_Process -Property ProcessId,WorkingSetSize,PrivatePageCount,CommandLine,ExecutablePath"
    + " | ForEach-Object { $c = if ($_.CommandLine) { $_.CommandLine } else { $_.ExecutablePath };"
    + " \"$($_.ProcessId)`t$($_.WorkingSetSize)`t$($_.PrivatePageCount)`t$c\" }",
].join("; ");

/** Groups listed processes; pure, so the sorting rules are testable on captured listings. */
export function groupProcesses(
  rows: readonly ListedProcess[],
  realMbByPid: ReadonlyMap<number, number> = new Map(),
): ProcessGroupSnapshot {
  const totals = new Map<ProcessGroupName, { count: number; mb: number; cpu: number | null }>();
  let emulatorCount = 0;
  for (const row of rows) {
    const group = classifyProcessCommand(row.command);
    if (group === "android_emulator" && /qemu-system/i.test(row.command)) emulatorCount += 1;
    const entry = totals.get(group) ?? { count: 0, mb: 0, cpu: row.cpuPercent === null ? null : 0 };
    entry.count += 1;
    entry.mb += realMbByPid.get(row.pid) ?? row.rssMb;
    entry.cpu = entry.cpu === null || row.cpuPercent === null ? null : entry.cpu + row.cpuPercent;
    totals.set(group, entry);
  }
  const groups = PROCESS_GROUP_NAMES.flatMap((group): ProcessGroupUsage[] => {
    const entry = totals.get(group);
    if (!entry) return [];
    return [{
      group,
      count: entry.count,
      mb: Math.round(entry.mb),
      cpuPercent: entry.cpu === null ? null : Math.round(entry.cpu),
    }];
  });
  return { groups, emulatorCount, devBrainRunning: totals.has("dev_brain") };
}

/**
 * This machine's processes by group, now. Null when the listing could not be
 * read at all. Never throws.
 */
export async function readProcessGroups(options: {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  deps?: Pick<HostMemoryReadDeps, "run" | "readFile">;
} = {}): Promise<ProcessGroupSnapshot | null> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const run = options.deps?.run ?? runHostTool;
  try {
    if (platform === "win32") {
      const text = await run(windowsPowerShellCommand(platform), ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_SCRIPT], timeoutMs + 5_000);
      if (!text) return null;
      // The working set and private bytes are already the real figure on Windows.
      return groupProcesses(parseWindowsProcessCommandRows(text));
    }
    const listing = await run(platform === "darwin" ? "/bin/ps" : "ps", ["-axww", "-o", "pid=,rss=,pcpu=,args="], timeoutMs);
    if (!listing) return null;
    const rows = parsePsCommandRows(listing);
    // Real memory only for the groups a reader acts on; `other` stays RSS.
    const measured = rows.filter((row) => classifyProcessCommand(row.command) !== "other").map((row) => row.pid);
    const real = measured.length
      ? await readProcessMemory({ pids: measured, platform, timeoutMs, deps: options.deps })
      : [];
    return groupProcesses(rows, new Map(real.map((entry) => [entry.pid, entry.mb])));
  } catch {
    return null;
  }
}
