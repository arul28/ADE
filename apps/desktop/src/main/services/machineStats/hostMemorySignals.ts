import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsPowerShellCommand } from "../shared/processExecution";

/*
 * How short of memory this machine is, read the way each OS itself judges it.
 *
 * One reader for every caller that has to decide on memory: the Android
 * emulator's start guard (`androidMemoryGuard.ts`) and the brain's
 * resource-pressure sampling. Each signal is a small pure parser over the
 * text an OS tool prints; the reads (a spawn or a file) sit at the edge, have
 * a bounded timeout, and answer null instead of throwing. Nothing here polls:
 * a caller asks, and only when it asks.
 *
 * Why not a RAM snapshot: on 2026-11-06 a 36 GB Mac froze with five
 * emulators running. `kern.memorystatus_level` still read 41% free, because
 * macOS had pushed the emulators' memory into 15 GB of swap. A free-memory
 * percentage is what is left after the swapping; the pressure level and the
 * paging rate are what say the machine is already swapping.
 *
 * - macOS: `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4
 *   critical: the kernel's own verdict, the one Activity Monitor colours its
 *   graph by), `kern.memorystatus_level` (percent available), `vm.swapusage`,
 *   and swap-outs from `vm_stat` sampled twice. One `sysctl` and, when the
 *   paging rate is asked for, two `vm_stat`s. macOS grows its swap files as
 *   it needs them, so "swap used of total" is not a fullness ratio there.
 * - Linux: `/proc/meminfo` (MemAvailable, swap), PSI `/proc/pressure/memory`
 *   (`some`/`full avg10`: the share of the last 10 s that tasks stalled on
 *   memory), and `pswpout` from `/proc/vmstat`. Files only, no spawn.
 * - Windows: one PowerShell CIM read of `Win32_OperatingSystem` (available
 *   physical memory, the commit charge against the commit limit, the paging
 *   file) and, for the paging rate, `Win32_PerfRawData_PerfOS_Memory`'s
 *   `PagesOutputPersec` twice inside the same script. Windows never
 *   overcommits, so a commit charge near its limit is its "out of memory".
 *   CIM class names are not localized, unlike `Get-Counter` paths.
 */

const MB = 1024 * 1024;
/** Linux and Windows page out in 4 KB pages (x86-64 and the common arm64 kernels). */
const SMALL_PAGE_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 3_000;

export type HostMemoryPressure = "normal" | "warn" | "critical";

export type HostMemorySignals = {
  platform: NodeJS.Platform;
  totalMb: number;
  /** What the OS can hand out without swapping, or null when it could not be read. */
  availableMb: number | null;
  /**
   * The OS's own verdict where it has one (macOS), else derived: Linux from
   * PSI, Windows from the commit charge. Null when unread or unknown.
   */
  pressure: HostMemoryPressure | null;
  swapTotalMb: number | null;
  swapUsedMb: number | null;
  /** Windows: the commit charge and the commit limit. Null elsewhere. */
  commitUsedMb: number | null;
  commitLimitMb: number | null;
  /** Linux PSI `some avg10`, percent. Null elsewhere or without PSI. */
  psiSomeAvg10: number | null;
  /** MB/s written out to swap over the sample window; null when not sampled or unreadable. */
  pagingOutMbPerSec: number | null;
};

export type HostMemoryReadDeps = {
  /** Runs a tool; answers its stdout, or null when it could not run at all. */
  run?: (command: string, args: string[], timeoutMs: number) => Promise<string | null>;
  readFile?: (filePath: string) => Promise<string | null>;
  wait?: (ms: number) => Promise<void>;
  totalBytes?: number;
};

/* ---------- parsers (pure) ---------- */

/** macOS `sysctl <names>` lines (`name: value`), by name. */
function sysctlValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return values;
}

/** `vm.swapusage`'s `total = 7168.00M  used = 5988.69M  free = …`, in MB. */
export function parseDarwinSwapUsage(value: string): { totalMb: number; usedMb: number } | null {
  const amount = (key: string): number | null => {
    const match = new RegExp(`${key}\\s*=\\s*([\\d.]+)([KMGT])`, "u").exec(value);
    if (!match) return null;
    const scale = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }[match[2] as "K" | "M" | "G" | "T"];
    return Number(match[1]) * scale;
  };
  const totalMb = amount("total");
  const usedMb = amount("used");
  return totalMb === null || usedMb === null ? null : { totalMb: Math.round(totalMb), usedMb: Math.round(usedMb) };
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function darwinPressureFromLevel(level: number | null): HostMemoryPressure | null {
  if (level === 1) return "normal";
  if (level === 2) return "warn";
  if (level === 4) return "critical";
  return null;
}

/** The parts of macOS `sysctl kern.memorystatus_level kern.memorystatus_vm_pressure_level vm.swapusage`. */
export function parseDarwinMemorySysctl(text: string): {
  availablePercent: number | null;
  pressure: HostMemoryPressure | null;
  swap: { totalMb: number; usedMb: number } | null;
} {
  const values = sysctlValues(text);
  const percent = Number(values.get("kern.memorystatus_level"));
  const level = Number(values.get("kern.memorystatus_vm_pressure_level"));
  const swapText = values.get("vm.swapusage");
  return {
    availablePercent: Number.isFinite(percent) && percent >= 0 && percent <= 100 && values.has("kern.memorystatus_level") ? percent : null,
    pressure: values.has("kern.memorystatus_vm_pressure_level") ? darwinPressureFromLevel(level) : null,
    swap: swapText ? parseDarwinSwapUsage(swapText) : null,
  };
}

/** `vm_stat`: the page size and the cumulative `Swapouts` count. */
export function parseVmStatSwapouts(text: string): { pageBytes: number; swapouts: number } | null {
  const page = /page size of (\d+) bytes/u.exec(text);
  const swapouts = /^Swapouts:\s+(\d+)\.?$/mu.exec(text);
  if (!page || !swapouts) return null;
  return { pageBytes: Number(page[1]), swapouts: Number(swapouts[1]) };
}

/** `/proc/meminfo` in MB; a missing field is null. */
export function parseLinuxMeminfo(text: string): {
  totalMb: number | null;
  availableMb: number | null;
  swapTotalMb: number | null;
  swapFreeMb: number | null;
} {
  const kb = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "mu").exec(text);
    return match ? Math.round(Number(match[1]) / 1024) : null;
  };
  return { totalMb: kb("MemTotal"), availableMb: kb("MemAvailable"), swapTotalMb: kb("SwapTotal"), swapFreeMb: kb("SwapFree") };
}

/** `/proc/pressure/memory`: `some avg10` and `full avg10`, percent. */
export function parseLinuxPressure(text: string): { someAvg10: number | null; fullAvg10: number | null } {
  const avg10 = (kind: "some" | "full"): number | null => {
    const match = new RegExp(`^${kind}\\s+avg10=([\\d.]+)`, "mu").exec(text);
    return match ? Number(match[1]) : null;
  };
  return { someAvg10: avg10("some"), fullAvg10: avg10("full") };
}

/**
 * PSI to a verdict. A tenth of the last 10 s with some task stalled on
 * memory is the threshold Android's own `lmkd` and Meta's `oomd` treat as
 * "medium"; any full stall (every task waiting) or 40% partial is critical.
 */
export function linuxPressureFromPsi(psi: { someAvg10: number | null; fullAvg10: number | null }): HostMemoryPressure | null {
  if (psi.someAvg10 === null) return null;
  if ((psi.fullAvg10 ?? 0) >= 10 || psi.someAvg10 >= 40) return "critical";
  return psi.someAvg10 >= 10 ? "warn" : "normal";
}

/** `/proc/vmstat`'s cumulative `pswpout` (pages written to swap). */
export function parseLinuxVmstatPswpout(text: string): number | null {
  const match = /^pswpout\s+(\d+)$/mu.exec(text);
  return match ? Number(match[1]) : null;
}

/** What the Windows script prints: KB values of `Win32_OperatingSystem`, and two `PagesOutputPersec` reads. */
type WindowsMemorySample = {
  totalKb?: number;
  freeKb?: number;
  commitLimitKb?: number;
  commitFreeKb?: number;
  pagingTotalKb?: number;
  pagingFreeKb?: number;
  pagesOut0?: number | null;
  pagesOut1?: number | null;
};

/**
 * The Windows commit charge to a verdict: past 90% of the commit limit a
 * new allocation can already fail; past 97% Windows is out of memory.
 */
export function windowsPressureFromCommit(usedMb: number | null, limitMb: number | null): HostMemoryPressure | null {
  if (usedMb === null || limitMb === null || limitMb <= 0) return null;
  const share = usedMb / limitMb;
  if (share >= 0.97) return "critical";
  return share >= 0.9 ? "warn" : "normal";
}

/** The Windows script's JSON, in MB. */
export function parseWindowsMemorySample(text: string, sampleMs: number): Pick<
  HostMemorySignals,
  "availableMb" | "swapTotalMb" | "swapUsedMb" | "commitUsedMb" | "commitLimitMb" | "pagingOutMbPerSec"
> & { totalMb: number | null } {
  let sample: WindowsMemorySample = {};
  try {
    const parsed = JSON.parse(text.trim()) as unknown;
    if (parsed && typeof parsed === "object") sample = parsed as WindowsMemorySample;
  } catch {
    // Unreadable output reads as nothing known.
  }
  const mb = (kb: number | undefined | null): number | null =>
    typeof kb === "number" && Number.isFinite(kb) && kb >= 0 ? Math.round(kb / 1024) : null;
  const commitLimitMb = mb(sample.commitLimitKb);
  const commitFreeMb = mb(sample.commitFreeKb);
  const swapTotalMb = mb(sample.pagingTotalKb);
  const swapFreeMb = mb(sample.pagingFreeKb);
  const pagesOut = typeof sample.pagesOut0 === "number" && typeof sample.pagesOut1 === "number" && sampleMs > 0
    ? Math.max(0, sample.pagesOut1 - sample.pagesOut0)
    : null;
  return {
    totalMb: mb(sample.totalKb),
    availableMb: mb(sample.freeKb),
    commitLimitMb,
    commitUsedMb: commitLimitMb !== null && commitFreeMb !== null ? Math.max(0, commitLimitMb - commitFreeMb) : null,
    swapTotalMb,
    swapUsedMb: swapTotalMb !== null && swapFreeMb !== null ? Math.max(0, swapTotalMb - swapFreeMb) : null,
    pagingOutMbPerSec: pagesOut === null ? null : round1((pagesOut * SMALL_PAGE_BYTES) / MB / (sampleMs / 1000)),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/* ---------- reads (the edge) ---------- */

/** Runs a tool with a bounded timeout and the C locale; its stdout, or null when it could not run. Never throws. */
export function runHostTool(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return defaultRun(command, args, timeoutMs);
}

function defaultRun(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * MB, windowsHide: true, env: { ...process.env, LC_ALL: "C", LANG: "C" } },
        // A tool that printed what was asked and then exited non-zero (one
        // unknown `sysctl` name) still answered the rest.
        (error, stdout) => resolve(stdout ? String(stdout) : error ? null : ""),
      );
    } catch {
      resolve(null);
    }
  });
}

async function defaultReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

// Not unref'd: a caller awaits this sample, and a process with nothing else
// to do must still wait for it rather than exit with the promise unsettled.
const defaultWait = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

const WINDOWS_MEMORY_SCRIPT = (sampleMs: number) => [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$o = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize,FreePhysicalMemory,TotalVirtualMemorySize,FreeVirtualMemory",
  "$f = @(Get-CimInstance Win32_PageFileUsage)",
  sampleMs > 0
    ? `$p0 = (Get-CimInstance Win32_PerfRawData_PerfOS_Memory -Property PagesOutputPersec).PagesOutputPersec; Start-Sleep -Milliseconds ${sampleMs}; $p1 = (Get-CimInstance Win32_PerfRawData_PerfOS_Memory -Property PagesOutputPersec).PagesOutputPersec`
    : "$p0 = $null; $p1 = $null",
  // Win32_PageFileUsage sizes are in MB; the rest of the object is in KB.
  "[pscustomobject]@{ totalKb = [double]$o.TotalVisibleMemorySize; freeKb = [double]$o.FreePhysicalMemory;"
    + " commitLimitKb = [double]$o.TotalVirtualMemorySize; commitFreeKb = [double]$o.FreeVirtualMemory;"
    + " pagingTotalKb = [double](($f | Measure-Object AllocatedBaseSize -Sum).Sum * 1024);"
    + " pagingFreeKb = [double]((($f | Measure-Object AllocatedBaseSize -Sum).Sum - ($f | Measure-Object CurrentUsage -Sum).Sum) * 1024);"
    + " pagesOut0 = $p0; pagesOut1 = $p1 } | ConvertTo-Json -Compress",
].join("; ");

/**
 * This machine's memory signals now. `pagingSampleMs` > 0 also measures the
 * swap-out rate over that window (the call then takes that long); 0 skips it.
 * Never throws: a reading that failed is null.
 */
export async function readHostMemorySignals(options: {
  platform?: NodeJS.Platform;
  pagingSampleMs?: number;
  timeoutMs?: number;
  deps?: HostMemoryReadDeps;
} = {}): Promise<HostMemorySignals> {
  const platform = options.platform ?? process.platform;
  const sampleMs = Math.max(0, options.pagingSampleMs ?? 0);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = options.deps?.run ?? defaultRun;
  const readFile = options.deps?.readFile ?? defaultReadFile;
  const wait = options.deps?.wait ?? defaultWait;
  const totalMb = Math.round((options.deps?.totalBytes ?? os.totalmem()) / MB);
  const signals: HostMemorySignals = {
    platform,
    totalMb,
    availableMb: null,
    pressure: null,
    swapTotalMb: null,
    swapUsedMb: null,
    commitUsedMb: null,
    commitLimitMb: null,
    psiSomeAvg10: null,
    pagingOutMbPerSec: null,
  };

  if (platform === "darwin") {
    const vmStat = () => run("/usr/bin/vm_stat", [], timeoutMs).then((text) => (text ? parseVmStatSwapouts(text) : null));
    const [sysctl, before] = await Promise.all([
      run("/usr/sbin/sysctl", ["kern.memorystatus_level", "kern.memorystatus_vm_pressure_level", "vm.swapusage"], timeoutMs),
      sampleMs > 0 ? vmStat() : Promise.resolve(null),
    ]);
    const parsed = sysctl ? parseDarwinMemorySysctl(sysctl) : null;
    if (parsed?.availablePercent != null) signals.availableMb = Math.round((totalMb * parsed.availablePercent) / 100);
    signals.pressure = parsed?.pressure ?? null;
    signals.swapTotalMb = parsed?.swap?.totalMb ?? null;
    signals.swapUsedMb = parsed?.swap?.usedMb ?? null;
    if (before) {
      await wait(sampleMs);
      const after = await vmStat();
      if (after) {
        const pages = Math.max(0, after.swapouts - before.swapouts);
        signals.pagingOutMbPerSec = round1((pages * after.pageBytes) / MB / (sampleMs / 1000));
      }
    }
    return signals;
  }

  if (platform === "linux") {
    const [meminfo, pressure, before] = await Promise.all([
      readFile("/proc/meminfo"),
      readFile("/proc/pressure/memory"),
      sampleMs > 0 ? readFile("/proc/vmstat").then((text) => (text ? parseLinuxVmstatPswpout(text) : null)) : Promise.resolve(null),
    ]);
    const memory = meminfo ? parseLinuxMeminfo(meminfo) : null;
    if (memory?.totalMb) signals.totalMb = memory.totalMb;
    signals.availableMb = memory?.availableMb ?? Math.round(os.freemem() / MB);
    signals.swapTotalMb = memory?.swapTotalMb ?? null;
    signals.swapUsedMb = memory?.swapTotalMb != null && memory.swapFreeMb != null ? Math.max(0, memory.swapTotalMb - memory.swapFreeMb) : null;
    const psi = pressure ? parseLinuxPressure(pressure) : null;
    signals.psiSomeAvg10 = psi?.someAvg10 ?? null;
    signals.pressure = psi ? linuxPressureFromPsi(psi) : null;
    if (before !== null) {
      await wait(sampleMs);
      const afterText = await readFile("/proc/vmstat");
      const after = afterText ? parseLinuxVmstatPswpout(afterText) : null;
      if (after !== null) signals.pagingOutMbPerSec = round1((Math.max(0, after - before) * SMALL_PAGE_BYTES) / MB / (sampleMs / 1000));
    }
    return signals;
  }

  if (platform === "win32") {
    const text = await run(
      windowsPowerShellCommand(platform),
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_MEMORY_SCRIPT(sampleMs)],
      // PowerShell's cold start, plus the sample window.
      timeoutMs + 5_000 + sampleMs,
    );
    const parsed = text ? parseWindowsMemorySample(text, sampleMs) : null;
    if (parsed?.totalMb) signals.totalMb = parsed.totalMb;
    signals.availableMb = parsed?.availableMb ?? Math.round(os.freemem() / MB);
    signals.commitUsedMb = parsed?.commitUsedMb ?? null;
    signals.commitLimitMb = parsed?.commitLimitMb ?? null;
    signals.swapTotalMb = parsed?.swapTotalMb ?? null;
    signals.swapUsedMb = parsed?.swapUsedMb ?? null;
    signals.pagingOutMbPerSec = parsed?.pagingOutMbPerSec ?? null;
    signals.pressure = windowsPressureFromCommit(signals.commitUsedMb, signals.commitLimitMb);
    return signals;
  }

  signals.availableMb = Math.round(os.freemem() / MB);
  return signals;
}

/* ---------- the memory of chosen processes ---------- */

export type ProcessMemory = {
  pid: number;
  /** The executable's base name, without `.exe`. */
  name: string;
  /**
   * What the process really costs the machine, in MB: macOS
   * `phys_footprint` (resident + compressed + swapped), Linux VmRSS + VmSwap,
   * Windows the larger of the working set and the private commit. Plain RSS
   * reads far too low once memory is swapped: a running emulator measured
   * 2.3 GB RSS against an 8.4 GB footprint.
   */
  mb: number;
};

/** macOS `footprint --noCategories -f bytes`: `phys_footprint` per pid. */
export function parseDarwinFootprint(text: string): Map<number, number> {
  const byPid = new Map<number, number>();
  let pid: number | null = null;
  for (const line of text.split(/\r?\n/u)) {
    const header = /\[(\d+)\]:\s/u.exec(line);
    if (header && !/^\s*Shared with/u.test(line)) {
      pid = Number(header[1]);
      continue;
    }
    const footprint = /^\s*phys_footprint:\s+(\d+)\s*B\b/u.exec(line);
    if (footprint && pid !== null) {
      byPid.set(pid, Math.round(Number(footprint[1]) / MB));
      pid = null;
    }
  }
  return byPid;
}

/** `ps -o pid=,rss=,comm=` rows (RSS in KB). */
export function parsePsMemoryRows(text: string): Array<{ pid: number; rssMb: number; name: string }> {
  const rows: Array<{ pid: number; rssMb: number; name: string }> = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), rssMb: Math.round(Number(match[2]) / 1024), name: path.posix.basename(match[3]!) });
  }
  return rows;
}

/** `/proc/<pid>/status`: VmRSS + VmSwap, in MB. */
export function parseLinuxProcStatusMemory(text: string): number | null {
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "mu").exec(text)?.[1] ?? Number.NaN);
  const rss = kb("VmRSS");
  if (!Number.isFinite(rss)) return null;
  const swap = kb("VmSwap");
  return Math.round((rss + (Number.isFinite(swap) ? swap : 0)) / 1024);
}

/** The Windows script's rows: `pid<TAB>name<TAB>workingSet<TAB>private` (bytes). */
export function parseWindowsProcessMemoryRows(text: string): ProcessMemory[] {
  const rows: ProcessMemory[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const [pid, name, workingSet, privateBytes] = line.trim().split("\t");
    if (!pid || !/^\d+$/u.test(pid)) continue;
    const bytes = Math.max(Number(workingSet) || 0, Number(privateBytes) || 0);
    rows.push({ pid: Number(pid), name: (name ?? "").replace(/\.exe$/iu, ""), mb: Math.round(bytes / MB) });
  }
  return rows;
}

function matchesPrefix(name: string, prefixes: readonly string[]): boolean {
  const lower = name.toLowerCase().replace(/\.exe$/u, "");
  return prefixes.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

/**
 * The real memory of the processes named by pid or whose executable starts
 * with one of `namePrefixes`. One `ps` plus one `footprint` on macOS, one
 * `ps` plus a small file read per process on Linux, one PowerShell call on
 * Windows. A process that cannot be read is left out. Never throws.
 */
export async function readProcessMemory(options: {
  pids?: readonly number[];
  namePrefixes?: readonly string[];
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  deps?: Pick<HostMemoryReadDeps, "run" | "readFile">;
}): Promise<ProcessMemory[]> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = options.deps?.run ?? defaultRun;
  const readFile = options.deps?.readFile ?? defaultReadFile;
  const wanted = new Set((options.pids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0));
  const prefixes = options.namePrefixes ?? [];

  if (platform === "win32") {
    const byName = prefixes.map((prefix) => `'${prefix.replace(/'/gu, "''")}*'`).join(",");
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$p = @(${byName ? `Get-Process -Name ${byName}` : ""}) + @(${wanted.size ? `Get-Process -Id ${[...wanted].join(",")}` : ""})`,
      "$p | Where-Object { $_ } | Sort-Object Id -Unique | ForEach-Object { \"$($_.Id)`t$($_.ProcessName)`t$($_.WorkingSet64)`t$($_.PrivateMemorySize64)\" }",
    ].join("; ");
    const text = await run(windowsPowerShellCommand(platform), ["-NoProfile", "-NonInteractive", "-Command", script], timeoutMs + 5_000);
    return text ? parseWindowsProcessMemoryRows(text) : [];
  }

  const psPath = platform === "darwin" ? "/bin/ps" : "ps";
  const listing = await run(psPath, ["-axo", "pid=,rss=,comm="], timeoutMs);
  const rows = listing ? parsePsMemoryRows(listing) : [];
  const picked = rows.filter((row) => wanted.has(row.pid) || matchesPrefix(row.name, prefixes));
  if (picked.length === 0) return [];

  if (platform === "linux") {
    return Promise.all(picked.map(async (row) => {
      const status = await readFile(`/proc/${row.pid}/status`);
      const real = status ? parseLinuxProcStatusMemory(status) : null;
      return { pid: row.pid, name: row.name, mb: Math.max(row.rssMb, real ?? 0) };
    }));
  }
  if (platform === "darwin") {
    const footprintArgs = picked.flatMap((row) => ["-p", String(row.pid)]);
    const text = await run("/usr/bin/footprint", [...footprintArgs, "--noCategories", "-f", "bytes"], timeoutMs);
    const footprints = text ? parseDarwinFootprint(text) : new Map<number, number>();
    return picked.map((row) => ({ pid: row.pid, name: row.name, mb: Math.max(row.rssMb, footprints.get(row.pid) ?? 0) }));
  }
  return picked.map((row) => ({ pid: row.pid, name: row.name, mb: row.rssMb }));
}
