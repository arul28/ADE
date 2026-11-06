import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readHostMemorySignals,
  type HostMemoryPressure,
  type HostMemorySignals,
} from "../../../../desktop/src/main/services/machineStats/hostMemorySignals";
import {
  readProcessGroups,
  type ProcessGroupSnapshot,
  type ProcessGroupUsage,
} from "../../../../desktop/src/main/services/machineStats/processGroups";
import {
  openDatabaseWalSizesMb,
  takeDbWriteCounts,
} from "../../../../desktop/src/main/services/state/dbActivity";
import { writeTextAtomic } from "../../../../desktop/src/main/services/shared/utils";
import type { ProductAnalyticsCapture } from "../../../../desktop/src/shared/types/productAnalytics";

/*
 * Resource-pressure episodes: the machine running short of memory or swap, a
 * project database's write-ahead log ballooning, or the brain itself pinning a
 * core. On 2026-11-06 a Mac froze with no ADE signal at all; this is the signal.
 *
 * It rides the brain loop watchdog's existing five-minute sample
 * (`BRAIN_MEMORY_SAMPLE_INTERVAL_MS`), in the machine brain only. Per tick:
 * one `sysctl` on macOS, file reads on Linux, no spawn on Windows unless
 * memory already looks short (then one PowerShell for the commit charge); an
 * async `stat` per open database's `-wal`; the brain's own CPU from
 * `process.cpuUsage`. A breach opens ONE episode, which costs one process
 * listing (`processGroups.ts`), one Sentry Log `machine.resource_pressure`,
 * one PostHog `ade_resource_pressure` (deduped per kind for six hours, four a
 * day) and a line in `runtime/resource-pressure.json`, which keeps the last
 * five for diagnostic reports. The episode closes after 30 minutes without a
 * breach; only then can another one open.
 */

export const RESOURCE_PRESSURE_FILE = "resource-pressure.json";
export const RESOURCE_PRESSURE_EPISODES_KEPT = 5;
/** Healthy this long closes an episode, so the next breach is a new one. */
export const RESOURCE_PRESSURE_REARM_MS = 30 * 60_000;
export const RESOURCE_PRESSURE_ANALYTICS_DEDUPE_MS = 6 * 60 * 60_000;

/** Available memory below this share of RAM is a breach. */
const MEMORY_AVAILABLE_SHARE = 0.10;
const MEMORY_AVAILABLE_CRITICAL_SHARE = 0.05;
/** Linux and Windows: swap used past this share of the swap there is. */
const SWAP_USED_SHARE = 0.85;
/**
 * macOS grows its swap files as it needs them, so "used of total" is near 100%
 * whenever there is any swap at all and says nothing. A third of RAM swapped
 * out is the equivalent: the Mac that froze had 15 GB swapped on 36 GB.
 */
const DARWIN_SWAP_OF_RAM_SHARE = 1 / 3;
const WAL_LIMIT_MB = 2 * 1024;
const WAL_GROWTH_MB = 1024;
const OWN_CPU_PERCENT = 80;
/** Ticks the brain's own CPU must stay over the line: two, so ten minutes. */
const OWN_CPU_TICKS = 2;
/** Windows answers free memory without a spawn; the PowerShell read runs only below this share. */
const WINDOWS_FULL_READ_SHARE = 0.15;

export type ResourcePressureKind = "memory" | "swap" | "wal" | "cpu";
export type ResourcePressureSeverity = "warn" | "critical";

const KIND_PRIORITY: readonly ResourcePressureKind[] = ["memory", "swap", "wal", "cpu"];

export type ResourcePressureMemory = Pick<
  HostMemorySignals,
  "totalMb" | "availableMb" | "pressure" | "swapUsedMb" | "swapTotalMb" | "commitUsedMb" | "commitLimitMb" | "psiSomeAvg10"
>;

export type ResourcePressureSample = {
  atMs: number;
  platform: NodeJS.Platform;
  memory: ResourcePressureMemory | null;
  /** Each open database's write-ahead log, MB, largest first. */
  walMb: number[];
  /** The brain's own CPU over the last interval, percent of one core. */
  ownCpuPercent: number | null;
};

export type ResourcePressureState = {
  open: { id: string; openedAtMs: number } | null;
  lastBreachAtMs: number | null;
  hotCpuTicks: number;
  lastWalMaxMb: number | null;
};

export type ResourcePressureEpisode = {
  id: string;
  openedAt: string;
  closedAt: string | null;
  kinds: ResourcePressureKind[];
  severity: ResourcePressureSeverity;
  memory: ResourcePressureMemory | null;
  walMaxMb: number;
  ownCpuPercent: number | null;
  processes: ProcessGroupUsage[] | null;
  emulatorCount: number | null;
  devBrainRunning: boolean | null;
  /** ADE's tables with the most writes in the interval before, at most three. */
  topTables: Array<{ table: string; writes: number }>;
};

export type ResourcePressureRecord = {
  version: 1;
  state: Pick<ResourcePressureState, "open" | "lastBreachAtMs">;
  lastSample: ResourcePressureSample | null;
  episodes: ResourcePressureEpisode[];
};

export const INITIAL_RESOURCE_PRESSURE_STATE: ResourcePressureState = {
  open: null,
  lastBreachAtMs: null,
  hotCpuTicks: 0,
  lastWalMaxMb: null,
};

/** Which limits a sample breaks, and how badly. Pure. */
export function resourcePressureBreach(
  sample: ResourcePressureSample,
  context: { hotCpuTicks: number; lastWalMaxMb: number | null },
): { kinds: ResourcePressureKind[]; severity: ResourcePressureSeverity } | null {
  const kinds = new Set<ResourcePressureKind>();
  let critical = false;
  const memory = sample.memory;
  if (memory) {
    const availableShare = memory.availableMb !== null && memory.totalMb > 0 ? memory.availableMb / memory.totalMb : null;
    const pressure: HostMemoryPressure | null = memory.pressure;
    if ((availableShare !== null && availableShare < MEMORY_AVAILABLE_SHARE) || pressure === "warn" || pressure === "critical") {
      kinds.add("memory");
    }
    if (pressure === "critical" || (availableShare !== null && availableShare < MEMORY_AVAILABLE_CRITICAL_SHARE)) critical = true;
    if (memory.swapUsedMb !== null) {
      const swapped = sample.platform === "darwin"
        ? memory.totalMb > 0 && memory.swapUsedMb > memory.totalMb * DARWIN_SWAP_OF_RAM_SHARE
        : memory.swapTotalMb !== null && memory.swapTotalMb > 0 && memory.swapUsedMb / memory.swapTotalMb > SWAP_USED_SHARE;
      if (swapped) kinds.add("swap");
    }
  }
  const walMaxMb = sample.walMb[0] ?? 0;
  if (walMaxMb > WAL_LIMIT_MB || (context.lastWalMaxMb !== null && walMaxMb - context.lastWalMaxMb >= WAL_GROWTH_MB)) {
    kinds.add("wal");
  }
  if (context.hotCpuTicks >= OWN_CPU_TICKS) kinds.add("cpu");
  if (kinds.size === 0) return null;
  return { kinds: KIND_PRIORITY.filter((kind) => kinds.has(kind)), severity: critical ? "critical" : "warn" };
}

/**
 * One tick of the episode state machine. Pure. `opened` is true exactly once
 * per episode: on the first breach after at least {@link RESOURCE_PRESSURE_REARM_MS}
 * without one.
 */
export function evaluateResourcePressure(
  state: ResourcePressureState,
  sample: ResourcePressureSample,
  newId: () => string = () => randomBytes(4).toString("hex"),
): {
  state: ResourcePressureState;
  breach: { kinds: ResourcePressureKind[]; severity: ResourcePressureSeverity } | null;
  opened: boolean;
  closed: boolean;
} {
  const hotCpuTicks = sample.ownCpuPercent !== null && sample.ownCpuPercent > OWN_CPU_PERCENT ? state.hotCpuTicks + 1 : 0;
  const breach = resourcePressureBreach(sample, { hotCpuTicks, lastWalMaxMb: state.lastWalMaxMb });
  const next: ResourcePressureState = { ...state, hotCpuTicks, lastWalMaxMb: sample.walMb[0] ?? 0 };
  if (breach) {
    next.lastBreachAtMs = sample.atMs;
    if (state.open) return { state: next, breach, opened: false, closed: false };
    next.open = { id: newId(), openedAtMs: sample.atMs };
    return { state: next, breach, opened: true, closed: false };
  }
  if (state.open && (state.lastBreachAtMs === null || sample.atMs - state.lastBreachAtMs >= RESOURCE_PRESSURE_REARM_MS)) {
    next.open = null;
    return { state: next, breach: null, opened: false, closed: true };
  }
  return { state: next, breach: null, opened: false, closed: false };
}

export function emulatorCountBucket(count: number | null): string {
  if (count === null || count <= 0) return "0";
  if (count === 1) return "1";
  if (count === 2) return "2";
  return count <= 4 ? "3_4" : "5_plus";
}

export function resourcePressureFilePath(runtimeDir: string): string {
  return path.join(runtimeDir, RESOURCE_PRESSURE_FILE);
}

/** The record on disk, or null when there is none or it cannot be read. Never throws. */
export function readResourcePressureRecord(runtimeDir: string): ResourcePressureRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(resourcePressureFilePath(runtimeDir), "utf8")) as Partial<ResourcePressureRecord>;
    if (!parsed || parsed.version !== 1) return null;
    return {
      version: 1,
      state: {
        open: parsed.state?.open && typeof parsed.state.open.id === "string" && Number.isFinite(parsed.state.open.openedAtMs)
          ? parsed.state.open
          : null,
        lastBreachAtMs: Number.isFinite(parsed.state?.lastBreachAtMs) ? parsed.state!.lastBreachAtMs! : null,
      },
      lastSample: parsed.lastSample && typeof parsed.lastSample === "object" ? parsed.lastSample : null,
      episodes: Array.isArray(parsed.episodes) ? parsed.episodes.slice(-RESOURCE_PRESSURE_EPISODES_KEPT) : [],
    };
  } catch {
    return null;
  }
}

export function memoryOf(signals: HostMemorySignals): ResourcePressureMemory {
  return {
    totalMb: signals.totalMb,
    availableMb: signals.availableMb,
    pressure: signals.pressure,
    swapUsedMb: signals.swapUsedMb,
    swapTotalMb: signals.swapTotalMb,
    commitUsedMb: signals.commitUsedMb,
    commitLimitMb: signals.commitLimitMb,
    psiSomeAvg10: signals.psiSomeAvg10,
  };
}

/**
 * This machine's memory for one tick, at the least cost each OS allows.
 * Windows reads free memory from `os` and starts PowerShell (for the commit
 * charge and the paging file) only when that already looks short.
 */
export async function readTickMemory(
  platform: NodeJS.Platform = process.platform,
  read: typeof readHostMemorySignals = readHostMemorySignals,
): Promise<ResourcePressureMemory | null> {
  try {
    if (platform === "win32") {
      const totalMb = Math.round(os.totalmem() / (1024 * 1024));
      const availableMb = Math.round(os.freemem() / (1024 * 1024));
      if (totalMb > 0 && availableMb / totalMb >= WINDOWS_FULL_READ_SHARE) {
        return {
          totalMb,
          availableMb,
          pressure: null,
          swapUsedMb: null,
          swapTotalMb: null,
          commitUsedMb: null,
          commitLimitMb: null,
          psiSomeAvg10: null,
        };
      }
    }
    return memoryOf(await read({ platform, pagingSampleMs: 0 }));
  } catch {
    return null;
  }
}

export type ResourcePressureMonitorDeps = {
  runtimeDir: string;
  logger: {
    warn: (event: string, meta?: Record<string, unknown>) => void;
    info?: (event: string, meta?: Record<string, unknown>) => void;
  };
  capture?: (input: ProductAnalyticsCapture) => void;
  platform?: NodeJS.Platform;
  now?: () => number;
  readMemory?: () => Promise<ResourcePressureMemory | null>;
  readWal?: () => Promise<number[]>;
  readProcesses?: () => Promise<ProcessGroupSnapshot | null>;
  takeWrites?: () => Array<{ table: string; writes: number }>;
  cpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
};

export type ResourcePressureMonitor = {
  /** One sample; called on the watchdog's five-minute tick. Never throws; overlapping calls are dropped. */
  tick: () => Promise<void>;
};

export function createResourcePressureMonitor(deps: ResourcePressureMonitorDeps): ResourcePressureMonitor {
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const readMemory = deps.readMemory ?? (() => readTickMemory(platform));
  const readWal = deps.readWal ?? openDatabaseWalSizesMb;
  const readProcesses = deps.readProcesses ?? (() => readProcessGroups({ platform }));
  const takeWrites = deps.takeWrites ?? takeDbWriteCounts;
  const cpuUsage = deps.cpuUsage ?? ((previous?: NodeJS.CpuUsage) => process.cpuUsage(previous));
  const stored = readResourcePressureRecord(deps.runtimeDir);
  // An episode still open when the last brain stopped stays open, so a restart
  // in the middle of one does not count it twice.
  let state: ResourcePressureState = {
    ...INITIAL_RESOURCE_PRESSURE_STATE,
    open: stored?.state.open ?? null,
    lastBreachAtMs: stored?.state.lastBreachAtMs ?? null,
  };
  let episodes: ResourcePressureEpisode[] = stored?.episodes ?? [];
  let lastCpu = cpuUsage();
  let lastCpuAtMs = now();
  let running = false;

  const persist = (sample: ResourcePressureSample): void => {
    const record: ResourcePressureRecord = {
      version: 1,
      state: { open: state.open, lastBreachAtMs: state.lastBreachAtMs },
      lastSample: sample,
      episodes: episodes.slice(-RESOURCE_PRESSURE_EPISODES_KEPT),
    };
    try {
      fs.mkdirSync(deps.runtimeDir, { recursive: true });
      writeTextAtomic(resourcePressureFilePath(deps.runtimeDir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // The local record is for reports; a full disk must not fail the sample.
    }
  };

  const openEpisode = async (
    id: string,
    sample: ResourcePressureSample,
    breach: { kinds: ResourcePressureKind[]; severity: ResourcePressureSeverity },
    topTables: Array<{ table: string; writes: number }>,
  ): Promise<void> => {
    const processes = await readProcesses().catch(() => null);
    const episode: ResourcePressureEpisode = {
      id,
      openedAt: new Date(sample.atMs).toISOString(),
      closedAt: null,
      kinds: breach.kinds,
      severity: breach.severity,
      memory: sample.memory,
      walMaxMb: sample.walMb[0] ?? 0,
      ownCpuPercent: sample.ownCpuPercent,
      processes: processes?.groups ?? null,
      emulatorCount: processes?.emulatorCount ?? null,
      devBrainRunning: processes?.devBrainRunning ?? null,
      topTables: topTables.slice(0, 3),
    };
    episodes = [...episodes, episode].slice(-RESOURCE_PRESSURE_EPISODES_KEPT);
    const groups = Object.fromEntries((processes?.groups ?? []).map((group) => [`${group.group}Mb`, group.mb]));
    // A warn line is a Sentry Log (`logBridge.ts`), searchable by machine_id.
    // Numbers and group names only.
    deps.logger.warn("machine.resource_pressure", {
      episodeId: id,
      kinds: breach.kinds.join(","),
      severity: breach.severity,
      totalMb: sample.memory?.totalMb ?? null,
      availableMb: sample.memory?.availableMb ?? null,
      pressure: sample.memory?.pressure ?? null,
      swapUsedMb: sample.memory?.swapUsedMb ?? null,
      swapTotalMb: sample.memory?.swapTotalMb ?? null,
      commitUsedMb: sample.memory?.commitUsedMb ?? null,
      commitLimitMb: sample.memory?.commitLimitMb ?? null,
      walMaxMb: episode.walMaxMb,
      ownCpuPercent: sample.ownCpuPercent,
      emulatorCount: episode.emulatorCount,
      devBrainRunning: episode.devBrainRunning,
      topTable: episode.topTables[0]?.table ?? null,
      ...groups,
    });
    const primary = breach.kinds[0]!;
    try {
      deps.capture?.({
        event: "ade_resource_pressure",
        surface: "api",
        dedupeKey: `resource_pressure:${primary}`,
        minimumIntervalMs: RESOURCE_PRESSURE_ANALYTICS_DEDUPE_MS,
        properties: {
          kind: primary,
          severity: breach.severity,
          emulator_count: emulatorCountBucket(episode.emulatorCount),
          ...(episode.devBrainRunning === null ? {} : { dev_brain_running: episode.devBrainRunning }),
          ...(episode.topTables[0] ? { top_table: episode.topTables[0].table } : {}),
        },
      });
    } catch {
      // Analytics never changes what the sample does.
    }
  };

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const atMs = now();
      const cpu = cpuUsage(lastCpu);
      const wallMs = Math.max(1, atMs - lastCpuAtMs);
      lastCpu = cpuUsage();
      lastCpuAtMs = atMs;
      const [memory, walMb] = await Promise.all([
        readMemory().catch(() => null),
        readWal().catch(() => [] as number[]),
      ]);
      const sample: ResourcePressureSample = {
        atMs,
        platform,
        memory,
        walMb,
        // Over a whole interval only: the first tick comes right after start,
        // when a few busy milliseconds would read as a pinned core.
        ownCpuPercent: wallMs >= 60_000 ? Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 100) : null,
      };
      const topTables = takeWrites();
      const result = evaluateResourcePressure(state, sample);
      state = result.state;
      if (result.opened && result.breach && state.open) {
        await openEpisode(state.open.id, sample, result.breach, topTables);
      } else if (result.closed) {
        const last = episodes[episodes.length - 1];
        if (last && !last.closedAt) {
          episodes = [...episodes.slice(0, -1), { ...last, closedAt: new Date(atMs).toISOString() }];
        }
        deps.logger.info?.("machine.resource_pressure_ended", { episodeId: last?.id ?? null });
      }
      persist(sample);
    } catch {
      // A sample that failed is a sample skipped; the next tick tries again.
    } finally {
      running = false;
    }
  };

  return { tick };
}
