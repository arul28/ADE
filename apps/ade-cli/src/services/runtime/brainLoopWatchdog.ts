import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { SUSPEND_GAP_THRESHOLD_MS } from "../power/suspendGapDetector";

export const DEFAULT_BRAIN_LOOP_WATCHDOG_MS = 30_000;
export const DEFAULT_WINDOWS_BRAIN_LOOP_WATCHDOG_MS = 60_000;
export const BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS = 1_000;
export const BRAIN_LOOP_WATCHDOG_NEAR_MISS_MS = 2_000;
export const BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE = "event-loop-wedge.json";
export const BRAIN_LOOP_WATCHDOG_LAST_WEDGE_FILE = "last-wedge.json";
export const BRAIN_LOOP_WATCHDOG_REPORT_FILE = "event-loop-wedge-report.json";
export const BRAIN_LOOP_WATCHDOG_LAST_REPORT_FILE = "last-wedge-report.json";

export type BrainLoopWatchdogDiagnostics = {
  capturedAt: string;
  heartbeatLagMs: number;
  eventLoopDelay: {
    maxMs: number;
    meanMs: number;
    p99Ms: number;
  };
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  resources: {
    userCpuMicros: number;
    systemCpuMicros: number;
    maxRssKb: number;
    minorPageFaults: number;
    majorPageFaults: number;
    fsReads: number;
    fsWrites: number;
    voluntaryContextSwitches: number;
    involuntaryContextSwitches: number;
  };
};

export type BrainLoopWatchdogBreadcrumb = {
  lastCommand: string;
  blockedMs: number;
  ts: string;
  thresholdMs?: number;
  diagnostics?: BrainLoopWatchdogDiagnostics;
  diagnosticReportPath?: string | null;
};

export type BrainLoopWatchdogEvaluation = {
  blocked: boolean;
  blockedMs: number;
  slept: boolean;
  /**
   * How long the worker's own check was overdue when it decided the process had
   * been suspended, and 0 otherwise. The worker sends this to the main thread,
   * which cannot measure it: a thread that was not running cannot tell a
   * suspension from a block, but a sibling thread that was not running either
   * can.
   */
  sleepGapMs: number;
};

export function evaluateBrainLoopWatchdog(args: {
  nowWallMs: number;
  nowMonotonicMs: number;
  lastHeartbeatWallMs: number;
  lastHeartbeatMonotonicMs: number;
  previousCheckWallMs: number;
  previousCheckMonotonicMs: number;
  thresholdMs: number;
  checkIntervalMs?: number;
}): BrainLoopWatchdogEvaluation {
  const wallSinceHeartbeat = Math.max(0, args.nowWallMs - args.lastHeartbeatWallMs);
  const monotonicSinceHeartbeat = Math.max(
    0,
    args.nowMonotonicMs - args.lastHeartbeatMonotonicMs,
  );
  const blockedMs = Math.floor(Math.min(wallSinceHeartbeat, monotonicSinceHeartbeat));
  const wallSinceCheck = Math.max(0, args.nowWallMs - args.previousCheckWallMs);
  const monotonicSinceCheck = Math.max(
    0,
    args.nowMonotonicMs - args.previousCheckMonotonicMs,
  );
  const sleepGapFloorMs = Math.max(
    args.thresholdMs,
    (args.checkIntervalMs ?? BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS) * 4,
  );
  const checkGapDeltaMs = Math.abs(wallSinceCheck - monotonicSinceCheck);
  const slept = wallSinceCheck > sleepGapFloorMs
    && monotonicSinceCheck > sleepGapFloorMs
    && checkGapDeltaMs <= Math.max(2_000, Math.max(wallSinceCheck, monotonicSinceCheck) * 0.25);
  return {
    blocked: !slept && blockedMs > args.thresholdMs,
    blockedMs,
    slept,
    sleepGapMs: slept ? Math.floor(Math.min(wallSinceCheck, monotonicSinceCheck)) : 0,
  };
}

/**
 * How long a suspension-shaped lag waits for the worker's verdict.
 *
 * Both threads resume at the same moment and the order in which their timers
 * fire is not fixed, so the main thread can observe the gap a beat before the
 * worker reports it. Three heartbeats of patience turn that race into a
 * correctly labelled event; the alternative is a warning that has to be
 * retracted.
 */
export const BRAIN_LOOP_SLEEP_PROOF_GRACE_MS = 3_000;

/** How stale the worker's sleep report may be and still explain this lag. */
export const BRAIN_LOOP_SLEEP_PROOF_WINDOW_MS = 10_000;

/**
 * How often the brain records what it is holding.
 *
 * Five minutes is coarse enough to cost nothing and fine enough to show a
 * slope: the leak this exists to watch grows about 4 MB a minute, so every
 * sample moves. The point is not to catch a spike, it is to let a diagnostic
 * report answer "was this brain growing?" without asking the user to reproduce
 * anything.
 */
export const BRAIN_MEMORY_SAMPLE_INTERVAL_MS = 300_000;

/**
 * RSS above which an idle brain is worth restarting: 1.5 GiB.
 *
 * A healthy idle brain sits in the low hundreds of MB, so this is far above
 * anything normal use produces and well below the point where the machine
 * starts swapping. `ADE_BRAIN_RSS_RESTART_BYTES=0` turns the mitigation off.
 */
export const DEFAULT_BRAIN_RSS_RESTART_BYTES = 1_610_612_736;

/**
 * How many consecutive samples must exceed the threshold.
 *
 * Three samples is fifteen minutes. A leak does not go back down, so waiting
 * costs nothing; a transient peak -- a big clone, an indexing pass -- does, and
 * restarting for one of those would be the mitigation causing the damage.
 */
export const BRAIN_RSS_PRESSURE_SAMPLES = 3;

/** Plain bytes, or a whole number of KB/MB/GB. Nothing else is accepted. */
const BRAIN_RSS_THRESHOLD_PATTERN = /^(\d+)\s*(b|kb|mb|gb)?$/;

const BRAIN_RSS_THRESHOLD_UNITS: Record<"b" | "kb" | "mb" | "gb", number> = {
  b: 1,
  kb: 1_024,
  mb: 1_048_576,
  gb: 1_073_741_824,
};

/**
 * Read the RSS restart threshold. `off`, `false`, and any parseable zero --
 * "0", "0kb", "0mb" -- disable the mitigation; anything unparseable falls back
 * to the default rather than silently disabling a safety net.
 *
 * The whole value must parse. A bare `parseInt` reads "1gb" as the number 1,
 * which the floor below then rounds up to 256 MB — arming exactly the
 * self-inflicted restart chain that floor exists to prevent.
 */
export function resolveBrainRssRestartBytes(raw: string | undefined): number | null {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) return DEFAULT_BRAIN_RSS_RESTART_BYTES;
  if (trimmed === "off" || trimmed === "false") return null;
  const match = BRAIN_RSS_THRESHOLD_PATTERN.exec(trimmed);
  if (!match) return DEFAULT_BRAIN_RSS_RESTART_BYTES;
  const unit = (match[2] ?? "b") as keyof typeof BRAIN_RSS_THRESHOLD_UNITS;
  const parsed = Number.parseInt(match[1]!, 10) * BRAIN_RSS_THRESHOLD_UNITS[unit];
  if (!Number.isFinite(parsed)) return DEFAULT_BRAIN_RSS_RESTART_BYTES;
  // A value that parses to zero in any unit is an explicit "off", the same as
  // the words. Only an unparseable value earns the default.
  if (parsed <= 0) return null;
  // A threshold under 256 MB would restart a perfectly ordinary brain in a
  // loop, so a typo cannot arm a self-inflicted crash loop.
  return Math.max(268_435_456, parsed);
}

/**
 * Samples between one report and the next while RSS stays over the threshold.
 *
 * Twelve samples is about an hour. The host may decline a restart -- a busy
 * brain, a failed handover -- and a leak does not go back down, so a run that
 * reported exactly once would leave the mitigation permanently disarmed on the
 * machines that need it. Asking again on a slow cadence is what keeps it alive
 * without turning the log into a restart request every five minutes.
 */
export const BRAIN_RSS_PRESSURE_REPEAT_SAMPLES = 12;

export type BrainMemoryPressureState = {
  /** Consecutive samples at or above the threshold. */
  samples: number;
  /** Monotonic ms of the first of them. */
  sinceMonotonicMs: number | null;
  /** Set once the pressure has been reported. */
  reported: boolean;
  /** `samples` at the last report, so the repeat cadence can be counted off it. */
  reportedAtSamples: number | null;
};

export const initialBrainMemoryPressureState = (): BrainMemoryPressureState => ({
  samples: 0,
  sinceMonotonicMs: null,
  reported: false,
  reportedAtSamples: null,
});

/** What the watchdog hands the host when it wants a restart considered. */
export type BrainMemoryPressureSample = {
  rssBytes: number;
  thresholdBytes: number;
  sustainedMs: number;
  heapUsedBytes: number;
};

export type BrainMemoryPressureOutcome = {
  state: BrainMemoryPressureState;
  /**
   * True on the sample that completes the run, then once every
   * {@link BRAIN_RSS_PRESSURE_REPEAT_SAMPLES} samples for as long as RSS stays
   * over the threshold.
   */
  triggered: boolean;
  /** How long RSS has been over the threshold, across the counted samples. */
  sustainedMs: number;
};

/**
 * Fold one memory sample into the pressure run.
 *
 * A single reading proves nothing and must never restart anything, so this
 * counts a run before it reports one. RSS dropping back under the threshold
 * clears the run completely, including the report latch: memory that recovered
 * and climbed again is a new event, and the operator should see it as one.
 *
 * While RSS stays over, the run re-reports every
 * {@link BRAIN_RSS_PRESSURE_REPEAT_SAMPLES} samples. The host is free to
 * decline each time; what it must not do is stop being asked.
 */
export function trackBrainMemoryPressure(args: {
  state: BrainMemoryPressureState;
  rssBytes: number;
  thresholdBytes: number | null;
  nowMonotonicMs: number;
  requiredSamples?: number;
  repeatSamples?: number;
}): BrainMemoryPressureOutcome {
  const threshold = args.thresholdBytes;
  if (threshold === null || args.rssBytes < threshold) {
    return { state: initialBrainMemoryPressureState(), triggered: false, sustainedMs: 0 };
  }
  const requiredSamples = Math.max(1, args.requiredSamples ?? BRAIN_RSS_PRESSURE_SAMPLES);
  const repeatSamples = Math.max(1, args.repeatSamples ?? BRAIN_RSS_PRESSURE_REPEAT_SAMPLES);
  const sinceMonotonicMs = args.state.sinceMonotonicMs ?? args.nowMonotonicMs;
  const samples = args.state.samples + 1;
  const sustainedMs = Math.max(0, args.nowMonotonicMs - sinceMonotonicMs);
  const triggered = args.state.reportedAtSamples === null
    ? samples >= requiredSamples
    : samples - args.state.reportedAtSamples >= repeatSamples;
  return {
    state: {
      samples,
      sinceMonotonicMs,
      reported: args.state.reported || triggered,
      reportedAtSamples: triggered ? samples : args.state.reportedAtSamples,
    },
    triggered,
    sustainedMs,
  };
}

export type BrainLoopLagVerdict = {
  /**
   * `normal` is not worth reporting, `stall` is the event loop failing to turn
   * while the process runs, `suspended` is the process not running.
   */
  verdict: "normal" | "stall" | "suspended";
  /**
   * The lag is long enough, and consumed little enough CPU, that a suspension
   * would explain it. Only the worker's report can promote this to `suspended`.
   */
  suspensionShaped: boolean;
  observedLagMs: number;
};

/**
 * Tell a suspended process from a blocked one.
 *
 * CPU alone cannot: a brain blocked on a dataless-file read burns no CPU either,
 * and that is the failure this watchdog exists to name. The decisive fact is the
 * watchdog worker, a separate thread with its own timer. It keeps ticking
 * through anything that blocks the main thread, so its silence means the whole
 * process was off the CPU -- suspend or App Nap -- and its ticking means the
 * main thread stalled on its own.
 */
export function classifyBrainLoopLag(args: {
  heartbeatLagMs: number;
  eventLoopDelayMaxMs: number;
  /** CPU milliseconds the process consumed across the lag. */
  cpuDeltaMs: number;
  /** Whether the worker reported that its own check stopped firing. */
  sleepObserved: boolean;
  nearMissMs?: number;
  suspendFloorMs?: number;
}): BrainLoopLagVerdict {
  const nearMissMs = args.nearMissMs ?? BRAIN_LOOP_WATCHDOG_NEAR_MISS_MS;
  const suspendFloorMs = args.suspendFloorMs ?? SUSPEND_GAP_THRESHOLD_MS;
  const observedLagMs = Math.max(0, Math.max(args.heartbeatLagMs, args.eventLoopDelayMaxMs));
  // A suspended process still burns a little CPU on the way out and back in, so
  // the floor is absolute rather than proportional; the fraction is what rules
  // out a busy loop, which spends the whole gap running.
  const idleAcrossLag = args.cpuDeltaMs <= Math.max(2_000, observedLagMs * 0.1);
  const suspensionShaped = observedLagMs >= suspendFloorMs && idleAcrossLag;
  if (observedLagMs < nearMissMs) {
    return { verdict: "normal", suspensionShaped, observedLagMs };
  }
  return {
    verdict: suspensionShaped && args.sleepObserved ? "suspended" : "stall",
    suspensionShaped,
    observedLagMs,
  };
}

export function resolveBrainLoopWatchdogThresholdMs(
  raw: string | undefined,
  platform = process.platform,
): number {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return platform === "win32"
      ? DEFAULT_WINDOWS_BRAIN_LOOP_WATCHDOG_MS
      : DEFAULT_BRAIN_LOOP_WATCHDOG_MS;
  }
  return Math.max(BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS, parsed);
}

function readBreadcrumb(filePath: string): BrainLoopWatchdogBreadcrumb | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<BrainLoopWatchdogBreadcrumb>;
    if (
      typeof parsed.lastCommand !== "string"
      || typeof parsed.blockedMs !== "number"
      || !Number.isFinite(parsed.blockedMs)
      || typeof parsed.ts !== "string"
    ) {
      return null;
    }
    const breadcrumb: BrainLoopWatchdogBreadcrumb = {
      lastCommand: parsed.lastCommand,
      blockedMs: Math.max(0, Math.floor(parsed.blockedMs)),
      ts: parsed.ts,
    };
    if (typeof parsed.thresholdMs === "number" && Number.isFinite(parsed.thresholdMs)) {
      breadcrumb.thresholdMs = Math.max(0, Math.floor(parsed.thresholdMs));
    }
    if (parsed.diagnostics && typeof parsed.diagnostics === "object") {
      breadcrumb.diagnostics = parsed.diagnostics;
    }
    if (typeof parsed.diagnosticReportPath === "string" || parsed.diagnosticReportPath === null) {
      breadcrumb.diagnosticReportPath = parsed.diagnosticReportPath;
    }
    return breadcrumb;
  } catch {
    return null;
  }
}

export function readBrainLoopWatchdogLastWedge(
  runtimeDir: string,
): BrainLoopWatchdogBreadcrumb | null {
  return readBreadcrumb(path.join(runtimeDir, BRAIN_LOOP_WATCHDOG_LAST_WEDGE_FILE));
}

export function recoverBrainLoopWatchdogBreadcrumb(args: {
  runtimeDir: string;
  warn?: (event: string, meta: Record<string, unknown>) => void;
}): BrainLoopWatchdogBreadcrumb | null {
  const breadcrumbPath = path.join(args.runtimeDir, BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE);
  if (!fs.existsSync(breadcrumbPath)) return null;
  const breadcrumb = readBreadcrumb(breadcrumbPath) ?? {
    lastCommand: "unknown",
    blockedMs: 0,
    ts: new Date().toISOString(),
  };
  fs.mkdirSync(args.runtimeDir, { recursive: true, mode: 0o700 });
  const lastWedgePath = path.join(args.runtimeDir, BRAIN_LOOP_WATCHDOG_LAST_WEDGE_FILE);
  try {
    if (process.platform === "win32" && fs.existsSync(lastWedgePath)) {
      fs.unlinkSync(lastWedgePath);
    }
    fs.renameSync(breadcrumbPath, lastWedgePath);
  } catch {
    fs.copyFileSync(breadcrumbPath, lastWedgePath);
    fs.unlinkSync(breadcrumbPath);
  }
  const reportPath = path.join(args.runtimeDir, BRAIN_LOOP_WATCHDOG_REPORT_FILE);
  const lastReportPath = path.join(args.runtimeDir, BRAIN_LOOP_WATCHDOG_LAST_REPORT_FILE);
  if (fs.existsSync(reportPath)) {
    try {
      if (process.platform === "win32" && fs.existsSync(lastReportPath)) {
        fs.unlinkSync(lastReportPath);
      }
      fs.renameSync(reportPath, lastReportPath);
      breadcrumb.diagnosticReportPath = lastReportPath;
    } catch {
      breadcrumb.diagnosticReportPath = reportPath;
    }
  } else if (breadcrumb.diagnosticReportPath !== undefined) {
    breadcrumb.diagnosticReportPath = null;
  }
  fs.writeFileSync(lastWedgePath, `${JSON.stringify(breadcrumb)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (args.warn) {
    args.warn("brain.recovered_from_wedge", breadcrumb);
  } else {
    process.stderr.write(`brain.recovered_from_wedge ${JSON.stringify(breadcrumb)}\n`);
  }
  return breadcrumb;
}

let nextCommandToken = 0;
const activeCommands = new Map<number, string>();

function currentCommandName(): string {
  let current = "idle";
  for (const action of activeCommands.values()) current = action;
  return current;
}

/**
 * What this brain is doing right now, or `"idle"`.
 *
 * Exported for the one caller that has to decide whether the brain may be
 * restarted underneath the person using it. It reads the same tracker the
 * watchdog puts in its breadcrumbs, so a restart decision and a wedge report
 * can never disagree about what was running.
 */
export function currentBrainLoopWatchdogCommand(): string {
  return currentCommandName();
}

export function trackBrainLoopWatchdogCommand(action: string): () => void {
  const token = ++nextCommandToken;
  activeCommands.set(token, action.trim() || "unknown");
  return () => {
    activeCommands.delete(token);
  };
}

export function buildBrainLoopWatchdogWorkerSource(): string {
  return String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    const { parentPort, workerData } = require("node:worker_threads");
    const BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS = ${BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS};
    const evaluateBrainLoopWatchdog = ${evaluateBrainLoopWatchdog.toString()};

    const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);
    let lastHeartbeatWallMs = null;
    let lastHeartbeatMonotonicMs = null;
    let previousCheckWallMs = Date.now();
    let previousCheckMonotonicMs = monotonicMs();
    let lastCommand = "idle";
    let diagnostics = null;

    const writeBreadcrumbAndKill = (blockedMs) => {
      const breadcrumb = {
        lastCommand,
        blockedMs: Math.max(0, Math.floor(blockedMs)),
        ts: new Date().toISOString(),
        thresholdMs: workerData.thresholdMs,
        diagnostics,
        diagnosticReportPath: workerData.reportEnabled ? workerData.reportPath : null,
      };
      const breadcrumbPath = path.join(workerData.runtimeDir, workerData.breadcrumbFile);
      let tempPath = null;
      try {
        fs.mkdirSync(workerData.runtimeDir, { recursive: true, mode: 0o700 });
        tempPath = breadcrumbPath + "." + process.pid + "." + Date.now() + ".tmp";
        fs.writeFileSync(tempPath, JSON.stringify(breadcrumb) + "\n", {
          encoding: "utf8",
          mode: 0o600,
        });
        if (process.platform === "win32" && fs.existsSync(breadcrumbPath)) {
          fs.unlinkSync(breadcrumbPath);
        }
        fs.renameSync(tempPath, breadcrumbPath);
      } catch (error) {
        if (tempPath) {
          try { fs.unlinkSync(tempPath); } catch {}
        }
        try {
          fs.writeSync(
            2,
            "brain.event_loop_breadcrumb_failed " +
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) +
              "\n",
          );
        } catch {}
      } finally {
        try {
          fs.writeSync(2, "brain.event_loop_blocked " + JSON.stringify(breadcrumb) + "\n");
        } finally {
          if (workerData.reportEnabled) {
            try { process.kill(process.pid, workerData.reportSignal); } catch {}
          }
          setTimeout(() => process.kill(process.pid, "SIGKILL"), workerData.reportGraceMs);
        }
      }
    };

    parentPort.on("message", (message) => {
      if (!message || message.type !== "heartbeat") return;
      lastHeartbeatWallMs = Date.now();
      lastHeartbeatMonotonicMs = monotonicMs();
      if (typeof message.lastCommand === "string" && message.lastCommand.length > 0) {
        lastCommand = message.lastCommand;
      }
      if (message.diagnostics && typeof message.diagnostics === "object") {
        diagnostics = message.diagnostics;
      }
    });

    setInterval(() => {
      const nowWallMs = Date.now();
      const nowMonotonicMs = monotonicMs();
      if (lastHeartbeatWallMs == null || lastHeartbeatMonotonicMs == null) {
        previousCheckWallMs = nowWallMs;
        previousCheckMonotonicMs = nowMonotonicMs;
        return;
      }

      const evaluation = evaluateBrainLoopWatchdog({
        nowWallMs,
        nowMonotonicMs,
        lastHeartbeatWallMs,
        lastHeartbeatMonotonicMs,
        previousCheckWallMs,
        previousCheckMonotonicMs,
        thresholdMs: workerData.thresholdMs,
        checkIntervalMs: workerData.checkIntervalMs,
      });
      previousCheckWallMs = nowWallMs;
      previousCheckMonotonicMs = nowMonotonicMs;
      if (evaluation.slept) {
        lastHeartbeatWallMs = nowWallMs;
        lastHeartbeatMonotonicMs = nowMonotonicMs;
        // This thread's own timer stopped firing, which nothing on the main
        // thread can observe. Telling the main thread is what lets it label its
        // matching gap a suspension instead of a near-miss.
        try {
          parentPort.postMessage({ type: "sleep", gapMs: evaluation.sleepGapMs });
        } catch {}
        return;
      }

      if (evaluation.blocked) {
        writeBreadcrumbAndKill(evaluation.blockedMs);
      }
    }, workerData.checkIntervalMs);
  `;
}

export function startBrainLoopWatchdog(args: {
  runtimeDir: string;
  env?: NodeJS.ProcessEnv;
  forceInTests?: boolean;
  warn?: (event: string, meta: Record<string, unknown>) => void;
  /**
   * Info-level sink for `brain.suspend_gap`. A laptop that slept is a normal
   * fact, and logging it as a warning is what made a healthy brain look sick in
   * a diagnostic report. Falls back to `warn` when a host does not supply one,
   * so the fact is never lost -- only the level is.
   */
  info?: (event: string, meta: Record<string, unknown>) => void;
  onRecovered?: (breadcrumb: BrainLoopWatchdogBreadcrumb) => void;
  /**
   * Called once when RSS has stayed above the restart threshold for a full run
   * of samples. The watchdog only reports the fact; whether the brain may
   * actually be restarted is a question about active work, which only the host
   * can answer.
   */
  onMemoryPressure?: (sample: BrainMemoryPressureSample) => void;
}): () => void {
  const recovered = recoverBrainLoopWatchdogBreadcrumb({
    runtimeDir: args.runtimeDir,
    warn: args.warn,
  });
  if (recovered) {
    try {
      args.onRecovered?.(recovered);
    } catch {
      // Recovery telemetry is best-effort and must not block watchdog startup.
    }
  }
  const env = args.env ?? process.env;
  if (env.ADE_DISABLE_LOOP_WATCHDOG === "1") return () => {};
  if (!args.forceInTests && (env.VITEST || env.NODE_ENV === "test")) return () => {};

  const thresholdMs = resolveBrainLoopWatchdogThresholdMs(env.ADE_LOOP_WATCHDOG_MS);
  const reportPath = path.join(args.runtimeDir, BRAIN_LOOP_WATCHDOG_REPORT_FILE);
  const reportSignal = "SIGUSR2";
  let reportEnabled = false;
  if (process.platform !== "win32" && process.report) {
    try {
      fs.mkdirSync(args.runtimeDir, { recursive: true, mode: 0o700 });
      process.report.directory = args.runtimeDir;
      process.report.filename = BRAIN_LOOP_WATCHDOG_REPORT_FILE;
      process.report.signal = reportSignal;
      process.report.reportOnSignal = true;
      reportEnabled = true;
    } catch (error) {
      args.warn?.("brain.loop_watchdog_report_setup_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  let disposed = false;
  let worker: Worker;
  try {
    worker = new Worker(buildBrainLoopWatchdogWorkerSource(), {
      eval: true,
      workerData: {
        runtimeDir: args.runtimeDir,
        thresholdMs,
        checkIntervalMs: BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS,
        breadcrumbFile: BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE,
        reportEnabled,
        reportPath,
        reportSignal,
        reportGraceMs: 1_000,
      },
    });
  } catch (error) {
    args.warn?.("brain.loop_watchdog_start_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return () => {};
  }
  worker.unref();

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const monotonicMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);
  let lastHeartbeatMonotonicMs = monotonicMs();
  let lastCpuMicros = (() => {
    const usage = process.resourceUsage();
    return usage.userCPUTime + usage.systemCPUTime;
  })();
  const eventLoopDelayMs = (nanoseconds: number): number =>
    Number.isFinite(nanoseconds) ? Math.round(nanoseconds / 1_000_000) : 0;

  const rssRestartBytes = resolveBrainRssRestartBytes(env.ADE_BRAIN_RSS_RESTART_BYTES);
  let memoryPressure = initialBrainMemoryPressureState();
  let lastMemorySampleMonotonicMs: number | null = null;

  /** When the worker last reported that its own check stopped firing. */
  let lastWorkerSleepMonotonicMs: number | null = null;
  let lastWorkerSleepGapMs = 0;
  /**
   * A suspension-shaped lag held back until the worker's verdict can arrive.
   * Only ever one: the next lag long enough to matter is the next suspension,
   * and reporting the older one late helps nobody.
   */
  let heldLag:
    | {
      observedAtMonotonicMs: number;
      lagMs: number;
      lastCommand: string;
      diagnostics: BrainLoopWatchdogDiagnostics;
    }
    | null = null;
  const report = args.info ?? args.warn;

  const sleepExplains = (observedAtMonotonicMs: number): boolean =>
    lastWorkerSleepMonotonicMs !== null
    && lastWorkerSleepMonotonicMs >= observedAtMonotonicMs - BRAIN_LOOP_SLEEP_PROOF_WINDOW_MS;

  const emitLag = (
    held: NonNullable<typeof heldLag>,
    verdict: "stall" | "suspended",
  ): void => {
    if (verdict === "suspended") {
      report?.("brain.suspend_gap", {
        lastCommand: held.lastCommand,
        gapMs: Math.max(held.lagMs, lastWorkerSleepGapMs),
        diagnostics: held.diagnostics,
      });
      return;
    }
    args.warn?.("brain.event_loop_near_miss", {
      lastCommand: held.lastCommand,
      thresholdMs,
      diagnostics: held.diagnostics,
    });
  };

  const resolveHeldLag = (nowMonotonicMs: number): void => {
    if (!heldLag) return;
    const sleepProven = sleepExplains(heldLag.observedAtMonotonicMs);
    if (
      !sleepProven
      && nowMonotonicMs - heldLag.observedAtMonotonicMs < BRAIN_LOOP_SLEEP_PROOF_GRACE_MS
    ) {
      return;
    }
    const held = heldLag;
    heldLag = null;
    emitLag(held, sleepProven ? "suspended" : "stall");
  };

  const heartbeat = (): void => {
    const nowMonotonicMs = monotonicMs();
    const heartbeatLagMs = Math.max(
      0,
      nowMonotonicMs - lastHeartbeatMonotonicMs - BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS,
    );
    lastHeartbeatMonotonicMs = nowMonotonicMs;
    const memory = process.memoryUsage();
    const resources = process.resourceUsage();
    const cpuMicros = resources.userCPUTime + resources.systemCPUTime;
    const cpuDeltaMs = Math.max(0, (cpuMicros - lastCpuMicros) / 1_000);
    lastCpuMicros = cpuMicros;
    resolveHeldLag(nowMonotonicMs);
    const diagnostics: BrainLoopWatchdogDiagnostics = {
      capturedAt: new Date().toISOString(),
      heartbeatLagMs: Math.floor(heartbeatLagMs),
      eventLoopDelay: {
        maxMs: eventLoopDelayMs(eventLoopDelay.max),
        meanMs: eventLoopDelayMs(eventLoopDelay.mean),
        p99Ms: eventLoopDelayMs(eventLoopDelay.percentile(99)),
      },
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      resources: {
        userCpuMicros: resources.userCPUTime,
        systemCpuMicros: resources.systemCPUTime,
        maxRssKb: resources.maxRSS,
        minorPageFaults: resources.minorPageFault,
        majorPageFaults: resources.majorPageFault,
        fsReads: resources.fsRead,
        fsWrites: resources.fsWrite,
        voluntaryContextSwitches: resources.voluntaryContextSwitches,
        involuntaryContextSwitches: resources.involuntaryContextSwitches,
      },
    };
    // The memory sample rides the heartbeat that is already reading these
    // counters, so it costs a comparison per second and a log line per five
    // minutes. A suspended process resumes with a stale schedule, which only
    // means the first sample after a wake is early; nothing here needs an
    // accurate interval.
    if (
      lastMemorySampleMonotonicMs === null
      || nowMonotonicMs - lastMemorySampleMonotonicMs >= BRAIN_MEMORY_SAMPLE_INTERVAL_MS
    ) {
      lastMemorySampleMonotonicMs = nowMonotonicMs;
      report?.("brain.memory_sample", {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        uptimeSec: Math.round(process.uptime()),
      });
      const pressure = trackBrainMemoryPressure({
        state: memoryPressure,
        rssBytes: memory.rss,
        thresholdBytes: rssRestartBytes,
        nowMonotonicMs,
      });
      memoryPressure = pressure.state;
      if (pressure.triggered && rssRestartBytes !== null) {
        try {
          args.onMemoryPressure?.({
            rssBytes: memory.rss,
            thresholdBytes: rssRestartBytes,
            sustainedMs: pressure.sustainedMs,
            heapUsedBytes: memory.heapUsed,
          });
        } catch {
          // The host's restart decision is its own business. A throw there must
          // not take down the watchdog that reported the pressure.
        }
      }
    }
    const lag = classifyBrainLoopLag({
      heartbeatLagMs: diagnostics.heartbeatLagMs,
      eventLoopDelayMaxMs: diagnostics.eventLoopDelay.maxMs,
      cpuDeltaMs,
      sleepObserved: sleepExplains(nowMonotonicMs),
    });
    if (lag.verdict !== "normal") {
      const observation = {
        observedAtMonotonicMs: nowMonotonicMs,
        lagMs: lag.observedLagMs,
        lastCommand: currentCommandName(),
        diagnostics,
      };
      if (lag.verdict === "suspended") {
        emitLag(observation, "suspended");
      } else if (lag.suspensionShaped) {
        // Looks like a suspension but the worker has not spoken yet. Hold it:
        // warning now and being wrong is how a sleeping laptop filled a support
        // report with "event loop near miss".
        heldLag = observation;
      } else {
        emitLag(observation, "stall");
      }
    }
    try {
      worker.postMessage({
        type: "heartbeat",
        lastCommand: currentCommandName(),
        diagnostics,
      });
    } catch {
      // The worker's error/exit handlers report a failed watchdog once.
    }
    eventLoopDelay.reset();
  };
  heartbeat();
  const interval = setInterval(heartbeat, BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS);
  interval.unref?.();

  worker.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const record = message as { type?: unknown; gapMs?: unknown };
    if (record.type !== "sleep") return;
    lastWorkerSleepMonotonicMs = monotonicMs();
    const gapMs = Number(record.gapMs);
    lastWorkerSleepGapMs = Number.isFinite(gapMs) && gapMs > 0 ? Math.floor(gapMs) : 0;
    // The held lag now has its answer; do not make it wait out the grace.
    resolveHeldLag(lastWorkerSleepMonotonicMs);
  });

  worker.on("error", (error) => {
    if (disposed) return;
    args.warn?.("brain.loop_watchdog_failed", { error: error.message });
  });
  worker.on("exit", (code) => {
    if (disposed || code === 0) return;
    args.warn?.("brain.loop_watchdog_exited", { code });
  });

  return () => {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
    // A lag still waiting for the worker's verdict must not vanish with the
    // watchdog. Without proof of a suspension it is a stall, which is the
    // reading that gets investigated.
    if (heldLag) {
      const held = heldLag;
      heldLag = null;
      emitLag(held, sleepExplains(held.observedAtMonotonicMs) ? "suspended" : "stall");
    }
    eventLoopDelay.disable();
    void worker.terminate();
  };
}
