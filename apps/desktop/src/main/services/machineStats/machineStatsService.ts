import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MachineStats } from "../../../shared/types/machineStats";
import type { KeepAwakeSnapshot } from "../../../shared/types/keepAwake";
import { ghHostsFiles } from "../shared/providerConfigHomes";
import { parseTasklist, runTasklistCsv, runText, windowsSystemTool } from "../home/homeMachine";
import { listMachineRemoteWorkCopies, measureRemoteWorkCopy } from "../remoteWork/remoteWorkCopyService";

/**
 * This machine's load and capabilities for `machine_stats.get`: what Settings
 * › Machines shows and what "Least loaded" weighs. One module-wide reader per
 * brain, so every project scope (and every client asking through a pin)
 * shares one cache. Nothing here runs unless someone asks: no timer, no poll.
 *
 * Three tiers, so the first open never waits on a slow tool:
 * - fast, on every uncached read: whole-host CPU (`os.cpus()` deltas — the
 *   same on Windows, which has no load average), memory, disk;
 * - medium, every 15 s at most, awaited for up to 1 s: running build tools
 *   (`ps` / `tasklist`), battery (`pmset`, `/sys`), available memory on a Mac
 *   (`vm_stat`; `os.freemem()` there counts only free pages);
 * - slow, every 3 minutes at most, never awaited: signed-in CLIs (config
 *   files, never a token), Xcode and simulators, the OS name, work copies and
 *   their size, and the battery on Windows (PowerShell is slow to start).
 * A whole answer is cached for 5 s, so two windows opening at once read once.
 */

type Logger = { warn: (event: string, data?: Record<string, unknown>) => void };

const ANSWER_TTL_MS = 5_000;
const MEDIUM_TTL_MS = 15_000;
const MEDIUM_WAIT_MS = 1_000;
const SLOW_TTL_MS = 3 * 60_000;
const CPU_SAMPLE_MS = 200;
/** A previous CPU reading this recent is a better sample than a fresh 200 ms one. */
const CPU_REUSE_MAX_MS = 60_000;

/** Build tools counted as "a build is running", by process base name. */
const BUILD_TOOLS: Record<string, string> = {
  xcodebuild: "xcodebuild",
  "swift-build": "swift",
  "swift-test": "swift",
  cargo: "cargo",
  msbuild: "msbuild",
  ninja: "ninja",
  bazel: "bazel",
  gradle: "gradle",
  gradlew: "gradle",
  make: "make",
  gmake: "make",
};

type CpuTotals = { idle: number; total: number; at: number };
type Medium = { builds: MachineStats["builds"]; power: MachineStats["power"]; availableBytes: number | null };
type Slow = Pick<MachineStats, "clis" | "xcode" | "osName" | "workCopies"> & { power: MachineStats["power"] };

export type MachineStatsReaderDeps = {
  platform?: NodeJS.Platform;
  keepAwake?: () => Promise<KeepAwakeSnapshot | null>;
  logger?: Logger;
  now?: () => number;
};

function cpuTotals(at: number): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, at };
}

function busyBetween(before: CpuTotals, after: CpuTotals): number | null {
  if (after.total <= before.total) return null;
  const busy = 1 - (after.idle - before.idle) / (after.total - before.total);
  return Math.max(0, Math.min(100, Math.round(busy * 100)));
}

function baseName(command: string): string {
  return command.trim().split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
}

/** Build tools by name from a list of process names. */
function countBuildTools(names: Iterable<string>): Array<{ tool: string; count: number }> {
  const counts = new Map<string, number>();
  for (const name of names) {
    const tool = BUILD_TOOLS[baseName(name)];
    if (tool) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
}

/** `vm_stat`: free + inactive + speculative pages, what macOS can hand out without swapping. */
function parseVmStatAvailable(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  const available = (pages("free") + pages("inactive") + pages("speculative")) * pageSize;
  return available > 0 ? available : null;
}

/** `pmset -g batt`. */
function parsePmsetBattery(text: string): MachineStats["power"] {
  const onBattery = /'Battery Power'/.test(text);
  const percent = /InternalBattery[^\n]*?\t(\d{1,3})%/.exec(text)?.[1];
  const hasBattery = /InternalBattery/.test(text);
  return { hasBattery, onBattery: hasBattery && onBattery, batteryPercent: percent ? Number(percent) : null };
}

async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function anyFileMatches(files: string[], test: (text: string) => boolean): Promise<boolean> {
  for (const file of files) {
    const text = await readFileOrNull(file);
    if (text != null && test(text)) return true;
  }
  return false;
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Developer CLIs and whether each has a sign-in on this machine, from the
 * files each one keeps (or its token variable in the brain's environment).
 * Only ever "signed in or not": nothing read here leaves this function.
 */
async function readCliSignIns(platform: NodeJS.Platform): Promise<NonNullable<MachineStats["clis"]>> {
  const home = os.homedir();
  const env = process.env;
  const appData = env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
  const xdg = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  const has = (key: string) => Boolean(env[key]?.trim());
  const wranglerDirs = platform === "darwin"
    ? [path.join(home, "Library", "Preferences", ".wrangler")]
    : platform === "win32"
      ? [path.join(appData, "xdg.config", ".wrangler")]
      : [path.join(xdg, ".wrangler")];
  wranglerDirs.push(path.join(home, ".wrangler"));
  const vercelAuth = platform === "darwin"
    ? path.join(home, "Library", "Application Support", "com.vercel.cli", "auth.json")
    : platform === "win32"
      ? path.join(appData, "com.vercel.cli", "Data", "auth.json")
      : path.join(home, ".local", "share", "com.vercel.cli", "auth.json");
  const gcloudDir = platform === "win32" ? path.join(appData, "gcloud") : path.join(xdg, "gcloud");

  const checks: Array<[id: string, label: string, check: () => Promise<boolean>]> = [
    ["gh", "GitHub", async () => has("GH_TOKEN") || has("GITHUB_TOKEN")
      || anyFileMatches(ghHostsFiles({ platform }), (text) => /^\s+(user|oauth_token):\s*\S/m.test(text))],
    ["wrangler", "Cloudflare", async () => has("CLOUDFLARE_API_TOKEN")
      || anyFileMatches(wranglerDirs.map((dir) => path.join(dir, "config", "default.toml")), (text) => /^\s*(oauth_token|api_token)\s*=/m.test(text))],
    ["sentry", "Sentry", async () => has("SENTRY_AUTH_TOKEN")
      || anyFileMatches([path.join(home, ".sentryclirc")], (text) => /^\s*token\s*=\s*\S/m.test(text))],
    ["asc", "App Store Connect", async () => anyFileMatches([path.join(home, ".asc", "config.json")], (text) => {
      try {
        const parsed = JSON.parse(text) as { key_id?: unknown; keys?: unknown };
        const keys = parsed.keys;
        return (typeof parsed.key_id === "string" && parsed.key_id.trim() !== "")
          || (Array.isArray(keys) ? keys.length > 0 : Boolean(keys && typeof keys === "object" && Object.keys(keys).length > 0));
      } catch {
        return false;
      }
    })],
    ["vercel", "Vercel", async () => has("VERCEL_TOKEN") || anyFileMatches([vercelAuth], (text) => /"token"\s*:\s*"[^"]+"/.test(text))],
    ["fly", "Fly.io", async () => has("FLY_API_TOKEN") || anyFileMatches([path.join(home, ".fly", "config.yml")], (text) => /^\s*access_token:\s*\S/m.test(text))],
    ["stripe", "Stripe", async () => anyFileMatches([path.join(xdg, "stripe", "config.toml")], (text) => /(test|live)_mode_api_key\s*=\s*['"]\S/.test(text))],
    ["gcloud", "Google Cloud", async () => exists(path.join(gcloudDir, "credentials.db"))],
    ["aws", "AWS", async () => has("AWS_ACCESS_KEY_ID") || exists(path.join(home, ".aws", "credentials"))],
  ];
  return await Promise.all(checks.map(async ([id, label, check]) => ({ id, label, signedIn: await check().catch(() => false) })));
}

async function readXcode(): Promise<MachineStats["xcode"]> {
  let version: string | null = null;
  try {
    version = /^Xcode\s+(\S+)/m.exec(await runText("/usr/bin/xcrun", ["xcodebuild", "-version"], 8_000))?.[1] ?? null;
  } catch {
    return null;
  }
  if (!version) return null;
  let simulators = 0;
  let booted = 0;
  try {
    const parsed = JSON.parse(await runText("/usr/bin/xcrun", ["simctl", "list", "devices", "available", "-j"], 15_000)) as {
      devices?: Record<string, Array<{ state?: string }>>;
    };
    for (const devices of Object.values(parsed.devices ?? {})) {
      simulators += devices.length;
      booted += devices.filter((device) => device.state === "Booted").length;
    }
  } catch {
    // Xcode without simulators installed.
  }
  return { version, simulators, bootedSimulators: booted };
}

async function readOsName(platform: NodeJS.Platform): Promise<string | null> {
  if (platform === "darwin") {
    const version = (await runText("/usr/bin/sw_vers", ["-productVersion"], 4_000).catch(() => "")).trim();
    return version ? `macOS ${version}` : "macOS";
  }
  if (platform === "win32") {
    const build = Number(os.release().split(".")[2]);
    return Number.isFinite(build) && build >= 22_000 ? "Windows 11" : "Windows 10";
  }
  if (platform === "linux") {
    const text = await readFileOrNull("/etc/os-release");
    return text ? /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text)?.[1] ?? "Linux" : "Linux";
  }
  return platform;
}

async function readWindowsBattery(): Promise<MachineStats["power"]> {
  const out = await runText(
    windowsSystemTool(path.win32.join("WindowsPowerShell", "v1.0", "powershell.exe")),
    ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress"],
    10_000,
  );
  if (!out.trim()) return { hasBattery: false, onBattery: false, batteryPercent: null };
  const parsed = JSON.parse(out) as { EstimatedChargeRemaining?: number; BatteryStatus?: number };
  // BatteryStatus 1, 4 (low) and 5 (critical) are on battery; the rest are on AC (charging, full…).
  return {
    hasBattery: true,
    onBattery: parsed.BatteryStatus === 1 || parsed.BatteryStatus === 4 || parsed.BatteryStatus === 5,
    batteryPercent: typeof parsed.EstimatedChargeRemaining === "number" ? parsed.EstimatedChargeRemaining : null,
  };
}

async function readLinuxBattery(): Promise<MachineStats["power"]> {
  const root = "/sys/class/power_supply";
  const entries = await fs.readdir(root).catch(() => [] as string[]);
  const battery = entries.find((name) => /^BAT/i.test(name));
  if (!battery) return { hasBattery: false, onBattery: false, batteryPercent: null };
  const status = (await readFileOrNull(path.join(root, battery, "status")))?.trim() ?? "";
  const capacity = Number((await readFileOrNull(path.join(root, battery, "capacity")))?.trim());
  return { hasBattery: true, onBattery: status === "Discharging", batteryPercent: Number.isFinite(capacity) ? capacity : null };
}

async function readWorkCopies(logger?: Logger): Promise<MachineStats["workCopies"]> {
  const copies = listMachineRemoteWorkCopies(undefined, logger ? { info: () => {}, warn: logger.warn } : undefined);
  let sizeBytes: number | null = 0;
  for (const copy of copies) {
    const size = await measureRemoteWorkCopy(copy.path);
    if (size == null) {
      sizeBytes = null;
      break;
    }
    sizeBytes += size;
  }
  return { count: copies.length, sizeBytes };
}

export function createMachineStatsReader(deps: MachineStatsReaderDeps = {}) {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  let lastCpu: CpuTotals | null = null;
  let answer: { at: number; value: Promise<MachineStats> } | null = null;
  let medium: { at: number; value: Medium } | null = null;
  let mediumInFlight: Promise<Medium> | null = null;
  let slow: { at: number; value: Slow } | null = null;
  let slowInFlight: Promise<void> | null = null;

  const readCpu = async (): Promise<number | null> => {
    const at = now();
    if (lastCpu && at - lastCpu.at < CPU_REUSE_MAX_MS && at - lastCpu.at >= CPU_SAMPLE_MS) {
      const current = cpuTotals(at);
      const busy = busyBetween(lastCpu, current);
      lastCpu = current;
      return busy;
    }
    const before = cpuTotals(at);
    await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_MS));
    const after = cpuTotals(now());
    lastCpu = after;
    return busyBetween(before, after);
  };

  /** A reading that failed shows as unknown; the log says why. */
  const unknownAfter = (part: string) => (error: unknown): null => {
    deps.logger?.warn(`machine_stats.${part}_failed`, { error: error instanceof Error ? error.message : String(error) });
    return null;
  };

  const readMedium = (): Promise<Medium> => {
    if (medium && now() - medium.at < MEDIUM_TTL_MS) return Promise.resolve(medium.value);
    mediumInFlight ??= (async () => {
      const [builds, power, availableBytes] = await Promise.all([
        (platform === "win32"
          ? runTasklistCsv(6_000).then((text) => countBuildTools([...parseTasklist(text).values()].map((row) => row.name)))
          : runText(platform === "darwin" ? "/bin/ps" : "ps", ["-A", "-o", "comm="], 4_000).then((text) => countBuildTools(text.split("\n"))))
          .catch(unknownAfter("builds")),
        (platform === "darwin"
          ? runText("/usr/bin/pmset", ["-g", "batt"], 3_000).then(parsePmsetBattery)
          : platform === "linux" ? readLinuxBattery() : Promise.resolve(null))
          .catch(unknownAfter("battery")),
        platform === "darwin"
          ? runText("/usr/bin/vm_stat", [], 3_000).then(parseVmStatAvailable).catch(unknownAfter("memory"))
          : Promise.resolve(null),
      ]);
      const value: Medium = { builds, power, availableBytes };
      medium = { at: now(), value };
      return value;
    })().finally(() => {
      mediumInFlight = null;
    });
    return mediumInFlight;
  };

  const refreshSlow = () => {
    if (slowInFlight || (slow && now() - slow.at < SLOW_TTL_MS)) return;
    slowInFlight = (async () => {
      const [clis, xcode, osName, workCopies, power] = await Promise.all([
        readCliSignIns(platform).catch(unknownAfter("cli_sign_ins")),
        // No Xcode is an ordinary answer (readXcode returns null for it); anything else is logged.
        platform === "darwin" ? readXcode().catch(unknownAfter("xcode")) : Promise.resolve(null),
        readOsName(platform).catch(unknownAfter("os_name")),
        readWorkCopies(deps.logger).catch(unknownAfter("work_copies")),
        platform === "win32" ? readWindowsBattery().catch(unknownAfter("battery")) : Promise.resolve(null),
      ]);
      slow = { at: now(), value: { clis, xcode, osName, workCopies, power } };
    })()
      .catch((error: unknown) => deps.logger?.warn("machine_stats.slow_failed", { error: String(error) }))
      .finally(() => {
        slowInFlight = null;
      });
  };

  const readSleep = async (): Promise<MachineStats["sleep"]> => {
    const snapshot = await deps.keepAwake?.().catch(unknownAfter("sleep"));
    if (!snapshot) return null;
    const level = snapshot.preferences.level;
    const inForce = snapshot.levelError == null;
    return { keptAwake: inForce && level !== "never", lidClosedAwake: snapshot.lidClosedActive };
  };

  const compute = async (): Promise<MachineStats> => {
    refreshSlow();
    const mediumRead = readMedium();
    const [busyPercent, disk, sleep, mediumValue] = await Promise.all([
      readCpu(),
      fs.statfs(os.homedir())
        .then((stats) => (stats.blocks > 0 ? { freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize } : null))
        .catch(unknownAfter("disk")),
      readSleep(),
      // The first read waits a beat for the process scan; later ones have it cached.
      Promise.race([mediumRead, new Promise<null>((resolve) => setTimeout(() => resolve(null), MEDIUM_WAIT_MS).unref?.())]),
    ]);
    const mediumNow = mediumValue ?? medium?.value ?? null;
    const cpus = os.cpus();
    return {
      at: now(),
      platform,
      arch: os.arch(),
      hostname: os.hostname(),
      osName: slow?.value.osName ?? null,
      cpu: { busyPercent, cores: cpus.length, model: cpus[0]?.model?.trim() || null },
      memory: { totalBytes: os.totalmem(), availableBytes: mediumNow?.availableBytes ?? os.freemem() },
      disk,
      power: (platform === "win32" ? slow?.value.power : mediumNow?.power) ?? null,
      sleep,
      builds: mediumNow?.builds ?? null,
      clis: slow?.value.clis ?? null,
      xcode: slow?.value.xcode ?? null,
      workCopies: slow?.value.workCopies ?? null,
      slowAt: slow?.at ?? null,
    };
  };

  return {
    get(): Promise<MachineStats> {
      if (answer && now() - answer.at < ANSWER_TTL_MS) return answer.value;
      const value = compute();
      answer = { at: now(), value };
      value.catch(() => {
        if (answer?.value === value) answer = null;
      });
      return value;
    },
  };
}

let shared: ReturnType<typeof createMachineStatsReader> | null = null;

/** The brain's one reader; the first caller's keep-awake source is the machine's. */
export function machineStatsReader(deps: MachineStatsReaderDeps): ReturnType<typeof createMachineStatsReader> {
  shared ??= createMachineStatsReader(deps);
  return shared;
}
