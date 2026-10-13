import type { BrainLoopWatchdogEvaluation } from "./brainLoopWatchdog";

/**
 * The watchdog's worker thread. It runs apart from the brain's main thread, so it
 * keeps ticking while that thread is blocked: it judges the heartbeats, reports its
 * own pauses, and when the brain is wedged it samples and kills it. The worker's
 * code is a string (see buildBrainLoopWatchdogWorkerSource), so it cannot import
 * anything; the constants and evaluator it needs are inlined when the string is built.
 */

/** The watchdog's tick: the worker checks, and the main thread beats, once per interval. */
export const BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS = 1_000;

/**
 * How late the worker's own 1 s check must run before it reports a pause. A late
 * check means this thread was not running either: the whole process was off the
 * CPU, not just the main thread blocked.
 */
export const BRAIN_LOOP_WORKER_LATE_REPORT_MS = 500;

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

export function buildBrainLoopWatchdogWorkerSource(): string {
  return String.raw`
    const fs = require("node:fs");
    const path = require("node:path");
    const { parentPort, workerData } = require("node:worker_threads");
    const BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS = ${BRAIN_LOOP_WATCHDOG_HEARTBEAT_MS};
    const BRAIN_LOOP_WORKER_LATE_REPORT_MS = ${BRAIN_LOOP_WORKER_LATE_REPORT_MS};
    const evaluateBrainLoopWatchdog = ${evaluateBrainLoopWatchdog.toString()};

    const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);
    let lastHeartbeatWallMs = null;
    let lastHeartbeatMonotonicMs = null;
    let previousCheckWallMs = Date.now();
    let previousCheckMonotonicMs = monotonicMs();
    let lastCommand = "idle";
    let diagnostics = null;

    let killStarted = false;
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
        } catch {}
        // The Node report below is written by the main thread, which is the
        // one that is stuck: it only lands if the loop frees up within the
        // grace, so a wedge that lasts left no stack at all. On macOS, sample
        // the process from outside first; this thread keeps running while the
        // main one is blocked. JS frames show as JIT addresses, but the native
        // frames (SQLite, fs, a child-process wait) name the call.
        //
        // -mayDie loads symbols before it samples (seconds, on Electron), so
        // the kill waits for "Sampling completed"; the detached sampler then
        // writes its file after this process is gone.
        // Every check after the threshold lands here again; the breadcrumb
        // above keeps its latest blockedMs, but one sampler and one kill.
        if (killStarted) return;
        killStarted = true;
        let killed = false;
        const kill = () => {
          if (killed) return;
          killed = true;
          if (workerData.reportEnabled) {
            try { process.kill(process.pid, workerData.reportSignal); } catch {}
          }
          setTimeout(() => process.kill(process.pid, "SIGKILL"), workerData.reportGraceMs);
        };
        if (!workerData.sampleEnabled) {
          kill();
          return;
        }
        setTimeout(kill, workerData.sampleTimeoutMs);
        try {
          try { fs.unlinkSync(workerData.samplePath); } catch {}
          // Progress goes to a file, not a pipe: once this process is gone a
          // pipe would break and could take the sampler down with it.
          const progressPath = workerData.samplePath + ".log";
          const progressFd = fs.openSync(progressPath, "w", 0o600);
          const sampler = require("node:child_process").spawn(
            "/usr/bin/sample",
            [String(process.pid), String(workerData.sampleSeconds), "-mayDie", "-file", workerData.samplePath],
            { detached: true, stdio: ["ignore", progressFd, progressFd] },
          );
          fs.closeSync(progressFd);
          sampler.unref();
          sampler.once("error", kill);
          sampler.once("exit", kill);
          const poll = setInterval(() => {
            let progress = "";
            try { progress = fs.readFileSync(progressPath, "utf8"); } catch {}
            if (progress.includes("Sampling completed")) {
              clearInterval(poll);
              kill();
            }
          }, 100);
        } catch {
          kill();
        }
      }
    };

    parentPort.on("message", (message) => {
      // A command starting or ending is sent at once: a call that blocks the
      // loop the moment it starts never reaches the next heartbeat, so only
      // this message can name it in the wedge report.
      if (message && message.type === "command" && typeof message.lastCommand === "string") {
        lastCommand = message.lastCommand || "idle";
        return;
      }
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

      const monotonicSinceCheck = nowMonotonicMs - previousCheckMonotonicMs;
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
      // This thread's own 1 s timer ran late, so the whole process was off the CPU
      // for the lateness. Nothing on the main thread can observe its own absence,
      // so report it whether or not it is long enough to forgive below. The
      // timer was due at previousCheck + interval and fired now, so the paused
      // interval is [now - lateMs, now]. The main thread matches it against its
      // own lag.
      const lateMs = monotonicSinceCheck - workerData.checkIntervalMs;
      if (lateMs >= BRAIN_LOOP_WORKER_LATE_REPORT_MS) {
        try {
          parentPort.postMessage({
            type: "sleep",
            pausedMs: Math.floor(lateMs),
            resumedAtMonotonicMs: nowMonotonicMs,
          });
        } catch {}
      }
      if (evaluation.slept) {
        lastHeartbeatWallMs = nowWallMs;
        lastHeartbeatMonotonicMs = nowMonotonicMs;
        // A suspended process resumes with a stale heartbeat. Forgive that gap so
        // the resume is not read as a block; the pause report above labels it.
        return;
      }

      if (evaluation.blocked) {
        writeBreadcrumbAndKill(evaluation.blockedMs);
      }
    }, workerData.checkIntervalMs);
  `;
}
