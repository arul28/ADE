import type { BrainLoopWatchdogEvaluation } from "./brainLoopWatchdog";
import { readSyncFsCall } from "./syncFsCallTracker";

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

/**
 * How long the main thread must sit in one synchronous file call before the
 * worker names it. Well past any healthy disk, well before the kill.
 */
export const BRAIN_LOOP_SYNC_FS_BLOCK_REPORT_MS = 5_000;

/** How long a project open must have frozen the loop before the worker names it. */
export const BRAIN_LOOP_PROJECT_OPEN_STALL_REPORT_MS = 5_000;

/**
 * The longest the watchdog waits on the machine before it restarts the brain
 * anyway. A freeze the brain did not cause (memory paged out under swap, a
 * drive that stopped answering) is not fixed by a restart, and the restart
 * takes every terminal and agent session with it. This ceiling only bounds a
 * wait that never ends.
 */
export const BRAIN_LOOP_MACHINE_WAIT_CEILING_MS = 5 * 60_000;

/**
 * Page faults per 30 s of freeze that mean memory is coming back from swap
 * (major) or being unpacked from compressed memory (minor). Rates, not counts,
 * so a long freeze is not blamed on memory only because it lasted long.
 */
export const BRAIN_LOOP_MEMORY_STARVED_MAJOR_FAULTS_PER_30S = 50;
export const BRAIN_LOOP_MEMORY_STARVED_MINOR_FAULTS_PER_30S = 50_000;

/**
 * Share of the freeze the process may spend on the CPU and still be waiting
 * on memory. A loop that allocates as it spins also takes minor faults, but it
 * runs the whole time; a process waiting for its pages mostly does not.
 */
export const BRAIN_LOOP_MEMORY_STARVED_MAX_CPU_SHARE = 0.5;

/** A synchronous file call open this long is a drive not answering. */
export const BRAIN_LOOP_DRIVE_STALL_MS = 10_000;

export type BrainLoopFreezeCause = "self" | "memory" | "drive";

/**
 * Who froze the brain: the brain itself, or the machine under it.
 *
 * Memory: the process is reading pages back from swap, or unpacking
 * compressed memory while mostly off the CPU, as on 2026-11-13 when the Mac
 * Studio had 12.6 of 13.3 GB of swap in use and the watchdog killed a brain
 * that was only waiting for its memory. Drive: the main thread sits inside one
 * synchronous file call. Anything else (a busy loop, a sync child wait, a
 * deadlock) is the brain's own, and a restart is still the cure.
 *
 * Fault counts are null where they mean nothing: libuv reports every Windows
 * page fault, soft ones included, as major, so Windows never waits on memory.
 */
export function brainLoopFreezeCause(args: {
  /** Faults since the last heartbeat, or null where the platform's counts are not meaningful. */
  majorFaults: number | null;
  minorFaults: number | null;
  /** CPU the process used since the last heartbeat. */
  cpuMs: number;
  /** How long since the last heartbeat. */
  windowMs: number;
  syncFsCallBlockedMs: number | null;
}): BrainLoopFreezeCause {
  // No nested functions here: this body is stringified into the worker, and a
  // bundler's name helper (`__name`) does not exist there.
  const windowMs = Math.max(1, args.windowMs);
  const per30s = 30_000 / windowMs;
  if (args.majorFaults != null && args.majorFaults * per30s >= BRAIN_LOOP_MEMORY_STARVED_MAJOR_FAULTS_PER_30S) {
    return "memory";
  }
  if (
    args.minorFaults != null
    && args.minorFaults * per30s >= BRAIN_LOOP_MEMORY_STARVED_MINOR_FAULTS_PER_30S
    && args.cpuMs <= windowMs * BRAIN_LOOP_MEMORY_STARVED_MAX_CPU_SHARE
  ) return "memory";
  if (args.syncFsCallBlockedMs != null && args.syncFsCallBlockedMs >= BRAIN_LOOP_DRIVE_STALL_MS) return "drive";
  return "self";
}

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
    const BRAIN_LOOP_SYNC_FS_BLOCK_REPORT_MS = ${BRAIN_LOOP_SYNC_FS_BLOCK_REPORT_MS};
    const BRAIN_LOOP_PROJECT_OPEN_STALL_REPORT_MS = ${BRAIN_LOOP_PROJECT_OPEN_STALL_REPORT_MS};
    const evaluateBrainLoopWatchdog = ${evaluateBrainLoopWatchdog.toString()};
    const BRAIN_LOOP_MACHINE_WAIT_CEILING_MS = ${BRAIN_LOOP_MACHINE_WAIT_CEILING_MS};
    const BRAIN_LOOP_MEMORY_STARVED_MAJOR_FAULTS_PER_30S = ${BRAIN_LOOP_MEMORY_STARVED_MAJOR_FAULTS_PER_30S};
    const BRAIN_LOOP_MEMORY_STARVED_MINOR_FAULTS_PER_30S = ${BRAIN_LOOP_MEMORY_STARVED_MINOR_FAULTS_PER_30S};
    const BRAIN_LOOP_MEMORY_STARVED_MAX_CPU_SHARE = ${BRAIN_LOOP_MEMORY_STARVED_MAX_CPU_SHARE};
    const BRAIN_LOOP_DRIVE_STALL_MS = ${BRAIN_LOOP_DRIVE_STALL_MS};
    const brainLoopFreezeCause = ${brainLoopFreezeCause.toString()};
    // Process-wide counters at the last heartbeat: what the freeze since then
    // cost in paging and CPU. resourceUsage() in a worker reads the whole
    // process, and this thread's own share of it is a timer tick a second.
    const usageNow = () => {
      const usage = process.resourceUsage();
      return {
        major: usage.majorPageFault,
        minor: usage.minorPageFault,
        cpuMs: (usage.userCPUTime + usage.systemCPUTime) / 1000,
      };
    };
    let usageAtHeartbeat = usageNow();
    // The freeze the watchdog is waiting out instead of killing, if any.
    let machineWait = null;
    // While it waits, it keeps the machine heartbeat fresh so the outside
    // watchdog (brainWatchdogCheck.ts, which kills a brain whose beat is 90 s
    // old) does not end the wait early. Only a file this process published is
    // touched; the ceiling below still bounds the whole wait.
    const heartbeatPath = path.join(workerData.runtimeDir, workerData.heartbeatFile);
    const refreshHeartbeatDuringWait = (nowWallMs, cause) => {
      let tempPath = null;
      try {
        const beat = JSON.parse(fs.readFileSync(heartbeatPath, "utf8"));
        if (!beat || beat.pid !== process.pid) return;
        beat.ts = nowWallMs;
        beat.machineWait = cause;
        tempPath = heartbeatPath + "." + process.pid + ".wait.tmp";
        fs.writeFileSync(tempPath, JSON.stringify(beat), { encoding: "utf8", mode: 0o600 });
        // Windows rename fails onto an existing file (see atomicJson.ts).
        if (process.platform === "win32" && fs.existsSync(heartbeatPath)) {
          fs.unlinkSync(heartbeatPath);
        }
        fs.renameSync(tempPath, heartbeatPath);
      } catch {
        // No heartbeat (a lane brain), or the disk is the thing stuck: the
        // outside watchdog then decides as it did before.
        if (tempPath) {
          try { fs.unlinkSync(tempPath); } catch {}
        }
      }
    };
    const readSyncFsCall = ${readSyncFsCall.toString()};
    // What the main thread is inside, when the brain installed the tracker.
    const currentSyncFsCall = () => {
      if (!workerData.syncFsBuffer) return null;
      try {
        const call = readSyncFsCall(workerData.syncFsBuffer, workerData.syncFsMethods);
        if (!call) return null;
        return {
          method: call.method,
          path: call.path,
          caller: call.caller,
          blockedMs: Math.max(0, Math.floor(Date.now() - call.startedAtMs)),
          sequence: call.sequence,
        };
      } catch {
        return null;
      }
    };
    let reportedSyncFsCallSequence = null;

    const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);
    let lastHeartbeatWallMs = null;
    let lastHeartbeatMonotonicMs = null;
    let previousCheckWallMs = Date.now();
    let previousCheckMonotonicMs = monotonicMs();
    let lastCommand = "idle";
    let diagnostics = null;
    // Project scopes opening right now: { projectId, phase, startedAtMs }.
    let projectOpens = [];
    const openingProjectsNow = () => projectOpens.map((open) => ({
      projectId: open.projectId,
      phase: open.phase,
      elapsedMs: Math.max(0, Date.now() - open.startedAtMs),
      phaseElapsedMs: Math.max(0, Date.now() - (open.phaseStartedAtMs || open.startedAtMs)),
    }));
    // One stalled-open line per stall: cleared when a heartbeat arrives again.
    let projectOpenStallReported = false;

    let killStarted = false;
    /** Writes the wedge breadcrumb (and its log line); returns it. */
    const writeBreadcrumb = (blockedMs, freezeCause) => {
      const breadcrumb = {
        pid: process.pid,
        lastCommand,
        blockedMs: Math.max(0, Math.floor(blockedMs)),
        ts: new Date().toISOString(),
        thresholdMs: workerData.thresholdMs,
        diagnostics,
        diagnosticReportPath: workerData.reportEnabled ? workerData.reportPath : null,
      };
      if (freezeCause) breadcrumb.freezeCause = freezeCause;
      // The projects that were opening: the next brain counts the kill against them.
      const openingProjects = openingProjectsNow();
      if (openingProjects.length > 0) breadcrumb.openingProjects = openingProjects;
      // A synchronous file call the main thread is stuck in: the path and the
      // code that made it, which the native sample cannot name.
      const blockedFsCall = currentSyncFsCall();
      if (blockedFsCall) {
        breadcrumb.blockedFsCall = {
          method: blockedFsCall.method,
          path: blockedFsCall.path,
          caller: blockedFsCall.caller,
          blockedMs: blockedFsCall.blockedMs,
        };
      }
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
      }
      return breadcrumb;
    };
    const writeBreadcrumbAndKill = (blockedMs, freezeCause) => {
      const breadcrumb = writeBreadcrumb(blockedMs, freezeCause);
      {
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
      if (message && message.type === "projectOpens" && Array.isArray(message.opens)) {
        projectOpens = message.opens.filter((open) => open && typeof open.projectId === "string");
        return;
      }
      if (!message || message.type !== "heartbeat") return;
      lastHeartbeatWallMs = Date.now();
      lastHeartbeatMonotonicMs = monotonicMs();
      projectOpenStallReported = false;
      if (machineWait) {
        // The machine let go: the wait was right, so no wedge is left to report.
        try {
          fs.writeSync(2, "[" + new Date().toISOString() + "] INFO brain.loop_watchdog_machine_wait_ended " + JSON.stringify({
            pid: process.pid,
            cause: machineWait.cause,
            blockedMs: Math.max(0, Date.now() - machineWait.heartbeatWallMs),
          }) + "\n");
        } catch {}
        // Unless a kill already started (the loop freed up inside its grace):
        // the next start needs that breadcrumb. Another brain sharing this
        // home may have written the file since, so only this brain's goes.
        if (!killStarted) {
          const breadcrumbPath = path.join(workerData.runtimeDir, workerData.breadcrumbFile);
          try {
            if (JSON.parse(fs.readFileSync(breadcrumbPath, "utf8")).pid === process.pid) {
              fs.unlinkSync(breadcrumbPath);
            }
          } catch {}
        }
        machineWait = null;
      }
      usageAtHeartbeat = usageNow();
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
        // machineWait stays: the next heartbeat ends it and removes its
        // breadcrumb, which a resume must not leave for the next start.
        lastHeartbeatWallMs = nowWallMs;
        lastHeartbeatMonotonicMs = nowMonotonicMs;
        // A suspended process resumes with a stale heartbeat. Forgive that gap so
        // the resume is not read as a block; the pause report above labels it.
        return;
      }

      // Named well before the kill, so a wait that ends on its own (a person
      // answering the prompt) still leaves the path and caller in the log.
      if (evaluation.blockedMs >= BRAIN_LOOP_SYNC_FS_BLOCK_REPORT_MS) {
        const call = currentSyncFsCall();
        // Once per call: the sequence tells this call from the next one.
        if (call && call.blockedMs >= BRAIN_LOOP_SYNC_FS_BLOCK_REPORT_MS && call.sequence !== reportedSyncFsCallSequence) {
          reportedSyncFsCallSequence = call.sequence;
          try {
            fs.writeSync(2, "[" + new Date().toISOString() + "] WARN brain.sync_fs_call_blocked " + JSON.stringify({
              pid: process.pid,
              lastCommand,
              method: call.method,
              path: call.path,
              caller: call.caller,
              blockedMs: call.blockedMs,
            }) + "\n");
          } catch {}
        }
      }

      // A project open that has frozen the loop this long is named now, from
      // this thread, while the main thread cannot log anything: if the freeze
      // ends in a kill, this line is what the log keeps of the open.
      if (
        evaluation.blockedMs >= BRAIN_LOOP_PROJECT_OPEN_STALL_REPORT_MS
        && !projectOpenStallReported
        && projectOpens.length > 0
      ) {
        projectOpenStallReported = true;
        try {
          fs.writeSync(2, "[" + new Date().toISOString() + "] WARN brain.project_open_stalled " + JSON.stringify({
            pid: process.pid,
            blockedMs: evaluation.blockedMs,
            thresholdMs: workerData.thresholdMs,
            openingProjects: openingProjectsNow(),
          }) + "\n");
        } catch {}
      }

      if (evaluation.blocked) {
        // A freeze the machine caused is waited out (see brainLoopFreezeCause);
        // only the brain's own freeze, or a wait past the ceiling, restarts it.
        // Judged again every tick: a freeze that outlasts the machine's trouble
        // is the brain's own.
        const usage = usageNow();
        const blockedFsCall = currentSyncFsCall();
        const faultsMeaningful = process.platform !== "win32";
        const majorFaults = faultsMeaningful ? Math.max(0, usage.major - usageAtHeartbeat.major) : null;
        const minorFaults = faultsMeaningful ? Math.max(0, usage.minor - usageAtHeartbeat.minor) : null;
        const cpuMs = Math.max(0, usage.cpuMs - usageAtHeartbeat.cpuMs);
        const cause = brainLoopFreezeCause({
          majorFaults,
          minorFaults,
          cpuMs,
          windowMs: evaluation.blockedMs,
          syncFsCallBlockedMs: blockedFsCall ? blockedFsCall.blockedMs : null,
        });
        if (cause !== "self" && evaluation.blockedMs < BRAIN_LOOP_MACHINE_WAIT_CEILING_MS) {
          if (!machineWait) {
            machineWait = { cause, heartbeatWallMs: lastHeartbeatWallMs, evidenceAtMs: null };
            try {
              fs.writeSync(2, "[" + new Date().toISOString() + "] WARN brain.loop_watchdog_waiting_on_machine " + JSON.stringify({
                pid: process.pid,
                lastCommand,
                cause,
                blockedMs: evaluation.blockedMs,
                majorFaults,
                minorFaults,
                cpuMs: Math.round(cpuMs),
                ceilingMs: BRAIN_LOOP_MACHINE_WAIT_CEILING_MS,
              }) + "\n");
            } catch {}
          }
          machineWait.cause = cause;
          // The evidence is on disk throughout, so a kill from outside still
          // leaves the wedged command, the stuck file call and the cause. At
          // the heartbeat's cadence, not every tick: on a stuck drive this
          // thread's own writes may be what blocks.
          if (
            machineWait.evidenceAtMs === null
            || nowWallMs - machineWait.evidenceAtMs >= workerData.heartbeatRefreshMs
          ) {
            machineWait.evidenceAtMs = nowWallMs;
            writeBreadcrumb(evaluation.blockedMs, cause);
            refreshHeartbeatDuringWait(nowWallMs, cause);
          }
          return;
        }
        writeBreadcrumbAndKill(evaluation.blockedMs, cause);
      }
    }, workerData.checkIntervalMs);
  `;
}
