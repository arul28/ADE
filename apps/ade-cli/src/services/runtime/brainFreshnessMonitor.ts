import fs from "node:fs";
import { computeRuntimeBuildHashAsync } from "./runtimeBuildIdentity";

const DEFAULT_FRESHNESS_INTERVAL_MS = 300_000;
const DEFAULT_IDLE_POLL_MS = 5_000;
const DEFAULT_MAX_IDLE_WAIT_MS = 30 * 60_000;
/**
 * How long a changed runtime file must hold still before it counts as a new
 * build rather than a swap in progress. An installer replacing the binary
 * churns its size/mtime for as long as the copy takes; acting inside that
 * window restarts the brain onto a truncated file.
 */
const DEFAULT_SETTLE_MS = 2_000;

type BrainFreshnessLogger = {
  warn: (event: string, fields: Record<string, unknown>) => void;
};

type BrainFileStat = {
  mtimeMs: number;
  size: number;
};

export type BrainFreshnessMonitorOptions = {
  filePath: string;
  runningHash: string | null;
  isIdle: () => boolean | Promise<boolean>;
  restart: () => void | Promise<void>;
  logger: BrainFreshnessLogger;
  env?: NodeJS.ProcessEnv;
  stat?: (filePath: string) => Promise<BrainFileStat>;
  computeHash?: (filePath: string) => Promise<string | null> | string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  /** Quiet period a changed file must survive before it is hashed. */
  settleMs?: number;
  idlePollMs?: number;
  maxIdleWaitMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
};

export type BrainFreshnessMonitor = {
  start(): void;
  stop(): void;
  probeNow(): Promise<void>;
};

function parseIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.ADE_BRAIN_FRESHNESS_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_FRESHNESS_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1_000, parsed)
    : DEFAULT_FRESHNESS_INTERVAL_MS;
}

async function statFile(filePath: string): Promise<BrainFileStat> {
  const stat = await fs.promises.stat(filePath);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

function sameStat(left: BrainFileStat, right: BrainFileStat): boolean {
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

export function createBrainFreshnessMonitor(
  options: BrainFreshnessMonitorOptions,
): BrainFreshnessMonitor {
  const env = options.env ?? process.env;
  const stat = options.stat ?? statFile;
  const computeHash = options.computeHash ?? computeRuntimeBuildHashAsync;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? parseIntervalMs(env);
  const idlePollMs = Math.max(1, options.idlePollMs ?? DEFAULT_IDLE_POLL_MS);
  const settleMs = Math.max(0, options.settleMs ?? DEFAULT_SETTLE_MS);
  const maxIdleWaitMs = Math.max(0, options.maxIdleWaitMs ?? DEFAULT_MAX_IDLE_WAIT_MS);
  const setIntervalFn = options.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
  const sleep = options.sleep ?? (async (ms: number) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  });

  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastStat: BrainFileStat | null = null;
  let probeInFlight: Promise<void> | null = null;
  let restartRequested = false;

  const waitForIdleAndRestart = async (
    runningHash: string,
    diskHash: string,
  ): Promise<void> => {
    const deadline = now() + maxIdleWaitMs;
    let idle = await options.isIdle();
    while (!stopped && !idle && now() < deadline) {
      await sleep(Math.min(idlePollMs, Math.max(1, deadline - now())));
      idle = await options.isIdle();
    }
    if (stopped) return;
    if (!idle) {
      options.logger.warn("brain.freshness_restart_forced", {
        runningHash,
        diskHash,
        maxWaitMs: maxIdleWaitMs,
      });
    }
    await options.restart();
  };

  const probe = async (): Promise<void> => {
    if (stopped || restartRequested) return;
    let nextStat: BrainFileStat;
    try {
      nextStat = await stat(options.filePath);
    } catch {
      // The file is missing or unreadable. That is the MIDDLE of an app swap,
      // not a new build: exiting here would hand the supervisor a brain that
      // restarts onto half-written files and crash-loops. Keep the old baseline
      // and re-decide once the file is back.
      return;
    }
    if (lastStat == null) {
      lastStat = nextStat;
      return;
    }
    if (sameStat(lastStat, nextStat)) return;

    // The file changed -- but a file being WRITTEN also looks like that, and
    // hashing a partial copy yields a mismatch that would restart the brain
    // into a truncated binary. Require the change to settle: re-stat after a
    // short pause and only act when the two agree. A swap still in flight
    // simply defers to the next probe with the baseline untouched.
    await sleep(settleMs);
    if (stopped) return;
    let settledStat: BrainFileStat;
    try {
      settledStat = await stat(options.filePath);
    } catch {
      return;
    }
    if (!sameStat(nextStat, settledStat)) return;

    const previousStat = lastStat;
    lastStat = settledStat;
    const diskHash = await computeHash(options.filePath);
    const runningHash = options.runningHash;
    if (!diskHash || !runningHash || diskHash === runningHash) return;

    restartRequested = true;
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    options.logger.warn("brain.freshness_mismatch", {
      runningHash,
      diskHash,
    });
    try {
      await waitForIdleAndRestart(runningHash, diskHash);
    } catch {
      // The service handover can fail transiently. Keep the old stat baseline
      // so the unchanged replacement file is re-hashed on the next scheduled
      // probe instead of disabling freshness checks for this brain forever.
      lastStat = previousStat;
      restartRequested = false;
      if (started && !stopped && !timer) {
        timer = setIntervalFn(() => {
          void probe();
        }, intervalMs);
        timer.unref?.();
      }
    }
  };

  return {
    start(): void {
      if (stopped || timer || env.ADE_DISABLE_BRAIN_FRESHNESS === "1") return;
      started = true;
      void this.probeNow();
      timer = setIntervalFn(() => {
        void this.probeNow();
      }, intervalMs);
      timer.unref?.();
    },

    stop(): void {
      stopped = true;
      if (timer) clearIntervalFn(timer);
      timer = null;
    },

    probeNow(): Promise<void> {
      if (probeInFlight) return probeInFlight;
      const current = probe().finally(() => {
        if (probeInFlight === current) probeInFlight = null;
      });
      probeInFlight = current;
      return current;
    },
  };
}
