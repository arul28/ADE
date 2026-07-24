import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

export const DEFAULT_BRAIN_LOOP_WATCHDOG_MS = 15_000;
export const BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS = 1_000;
export const BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE = "event-loop-wedge.json";
export const BRAIN_LOOP_WATCHDOG_LAST_WEDGE_FILE = "last-wedge.json";

export type BrainLoopWatchdogBreadcrumb = {
  lastCommand: string;
  blockedMs: number;
  ts: string;
};

export type BrainLoopWatchdogEvaluation = {
  blocked: boolean;
  blockedMs: number;
  slept: boolean;
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
  };
}

function parseWatchdogThresholdMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_BRAIN_LOOP_WATCHDOG_MS;
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
    return {
      lastCommand: parsed.lastCommand,
      blockedMs: Math.max(0, Math.floor(parsed.blockedMs)),
      ts: parsed.ts,
    };
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

    const writeBreadcrumbAndKill = (blockedMs) => {
      const breadcrumb = {
        lastCommand,
        blockedMs: Math.max(0, Math.floor(blockedMs)),
        ts: new Date().toISOString(),
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
          process.kill(process.pid, "SIGKILL");
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
  onRecovered?: (breadcrumb: BrainLoopWatchdogBreadcrumb) => void;
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

  const thresholdMs = parseWatchdogThresholdMs(env.ADE_LOOP_WATCHDOG_MS);
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
      },
    });
  } catch (error) {
    args.warn?.("brain.loop_watchdog_start_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return () => {};
  }
  worker.unref();

  const heartbeat = (): void => {
    try {
      worker.postMessage({
        type: "heartbeat",
        lastCommand: currentCommandName(),
      });
    } catch {
      // The worker's error/exit handlers report a failed watchdog once.
    }
  };
  heartbeat();
  const interval = setInterval(heartbeat, BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS);
  interval.unref?.();

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
    void worker.terminate();
  };
}
