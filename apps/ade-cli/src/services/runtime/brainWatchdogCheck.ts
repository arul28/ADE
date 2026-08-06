import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "./atomicJson";
import {
  BRAIN_HEARTBEAT_STALE_MS,
  type BrainHeartbeat,
  brainHeartbeatPath,
  evaluateBrainHeartbeat,
  readBrainHeartbeat,
} from "./brainHeartbeat";
import {
  BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE,
  type BrainLoopWatchdogBreadcrumb,
} from "./brainLoopWatchdog";

/**
 * The one action an external watchdog is allowed to take.
 *
 * It does NOT restart anything. launchd `KeepAlive` (macOS) and the PowerShell
 * supervisor loop (Windows) already restart a brain that exits; the only thing
 * missing was a way to make a wedged brain exit. So this kills, and lets the
 * supervisor that already owns the lifecycle do the restarting. Anything else
 * would put a second thing in the business of starting brains.
 */
export const BRAIN_WATCHDOG_KILL_COMMAND = "external-watchdog";

export type BrainWatchdogCheckResult = {
  ok: true;
  action: "absent" | "healthy" | "self" | "already_exited" | "killed" | "kill_failed";
  pid: number | null;
  ageMs: number | null;
  staleAfterMs: number;
  message: string;
};

export function resolveBrainHeartbeatStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.ADE_BRAIN_HEARTBEAT_STALE_MS?.trim() ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return BRAIN_HEARTBEAT_STALE_MS;
  // Never let a misconfiguration make the watchdog trigger-happy: below the
  // beat interval it would fire on every ordinary gap.
  return Math.max(30_000, parsed);
}

/**
 * How far the OS-reported process start time may sit AFTER the first beat.
 *
 * Zero in theory -- a process cannot beat before it starts -- so this only
 * absorbs `ps` second-granularity rounding and a clock nudge between the two
 * readings. Mirrors the +/-2s window `syncHostSingleton` uses to bind its lock
 * to a process start time.
 */
export const BRAIN_IDENTITY_START_TOLERANCE_MS = 2_000;

/**
 * How far the process start time may sit BEFORE the first beat: the brain's own
 * boot, from `main()` to `startBrainHeartbeat`. Generous (5 minutes) because
 * overshooting only costs a delayed wedge kill, while undershooting would make
 * the watchdog spare a genuinely wedged brain that booted slowly.
 */
export const BRAIN_IDENTITY_MAX_BOOT_MS = 300_000;

/** What the OS says about a live pid. `null` means "could not tell". */
export type BrainProcessIdentity = { startedAtMs: number } | null;

/**
 * Read a live pid's start time.
 *
 * POSIX only, and deliberately not a fallback-laden probe: on win32 the
 * supervisor loop owns the wedge kill (it holds a `Process` handle for the exact
 * child it started, so it never has to identify a pid by number), and this
 * checker's kill path is skipped there entirely.
 */
export function defaultBrainProcessIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): BrainProcessIdentity {
  if (platform === "win32") return null;
  let raw = "";
  try {
    raw = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(Math.floor(pid))], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      // A missing pid makes `ps` complain on stderr, which would otherwise land
      // in the launch agent's log once a minute for a brain that is simply gone.
      stdio: ["ignore", "pipe", "ignore"],
      // `lstart` is rendered in the process locale: a de_DE or fr_FR host prints
      // "Mi 6 Aug ..." or "mer. 6 août ...", which `Date.parse` rejects. Without
      // this pin the identity probe returns null on every non-English machine,
      // so the wedge kill never fires there at all.
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
  } catch {
    // No such process, or `ps` is unavailable. Both mean "no identity", which
    // the caller treats as "do not kill".
    return null;
  }
  // `ps` pads the day of month ("Aug  6"); Date.parse rejects the double space.
  const startedAtMs = Date.parse(raw.trim().replace(/\s+/g, " "));
  if (!Number.isFinite(startedAtMs)) return null;
  return { startedAtMs };
}

/**
 * Whether the live pid is still the process that wrote this heartbeat.
 *
 * Without this the watchdog kills a bare pid. After a crash the heartbeat file
 * names a dead pid, and once the OS recycles that number the watchdog SIGKILLs
 * a completely unrelated process -- every 60s, forever. So a kill requires
 * positive identity: absent, unreadable, or mismatched all mean "not ours".
 */
export function brainProcessIdentityMatches(
  heartbeat: BrainHeartbeat,
  identity: BrainProcessIdentity,
): boolean {
  if (!identity || !Number.isFinite(identity.startedAtMs)) return false;
  const bootMs = heartbeat.startedAt - identity.startedAtMs;
  return bootMs >= -BRAIN_IDENTITY_START_TOLERANCE_MS && bootMs <= BRAIN_IDENTITY_MAX_BOOT_MS;
}

/**
 * `isPidAlive` reports EPERM as alive, which is right for a caller stopping its
 * own child but wrong here: the brain runs as this user, so a pid this process
 * may not signal is by definition not the brain, and treating it as live would
 * feed a foreign pid straight into the kill path.
 */
function brainPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Leave the same breadcrumb the in-process loop watchdog leaves, so the next
 * brain start promotes it to `last-wedge.json`, logs `brain.recovered_from_wedge`,
 * and the existing `lastWedge` field on `runtime/info` surfaces it to clients.
 * A separate record would mean a second thing to plumb to every surface.
 */
function writeWedgeBreadcrumb(args: {
  runtimeDir: string;
  heartbeat: BrainHeartbeat;
  ageMs: number;
  staleAfterMs: number;
  now: () => number;
}): void {
  const breadcrumb: BrainLoopWatchdogBreadcrumb = {
    lastCommand: BRAIN_WATCHDOG_KILL_COMMAND,
    blockedMs: Math.max(0, Math.floor(args.ageMs)),
    ts: new Date(args.now()).toISOString(),
    thresholdMs: args.staleAfterMs,
    diagnosticReportPath: null,
  };
  try {
    writeJsonAtomic(
      path.join(args.runtimeDir, BRAIN_LOOP_WATCHDOG_BREADCRUMB_FILE),
      breadcrumb,
      String(args.heartbeat.pid),
    );
  } catch {
    // A breadcrumb is a diagnostic. Failing to leave one must never stop the
    // kill that the breadcrumb is only there to explain.
  }
}

/**
 * One external liveness check. Safe to run on a timer from outside the brain.
 *
 * Deliberately conservative: an absent or unreadable heartbeat means "no
 * judgement available", never "wedged". Only a heartbeat that is BOTH stale and
 * owned by a live pid is a wedge, and that combination cannot be produced by a
 * brain whose event loop is turning.
 */
export function runBrainWatchdogCheck(args: {
  runtimeDir: string;
  staleAfterMs?: number;
  now?: () => number;
  selfPid?: number;
  pidAlive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  platform?: NodeJS.Platform;
  /** Injectable so tests never have to inspect a real process. */
  processIdentity?: (pid: number) => BrainProcessIdentity;
  readHeartbeat?: (runtimeDir: string) => BrainHeartbeat | null;
  writeBreadcrumb?: (breadcrumbArgs: {
    runtimeDir: string;
    heartbeat: BrainHeartbeat;
    ageMs: number;
    staleAfterMs: number;
    now: () => number;
  }) => void;
}): BrainWatchdogCheckResult {
  const now = args.now ?? Date.now;
  const staleAfterMs = args.staleAfterMs ?? resolveBrainHeartbeatStaleMs();
  const heartbeat = (args.readHeartbeat ?? readBrainHeartbeat)(args.runtimeDir);
  const verdict = evaluateBrainHeartbeat({
    heartbeat,
    nowMs: now(),
    staleAfterMs,
    selfPid: args.selfPid,
    pidAlive: args.pidAlive ?? brainPidAlive,
  });

  if (verdict.action === "absent") {
    return {
      ok: true,
      action: "absent",
      pid: null,
      ageMs: null,
      staleAfterMs,
      message: "No brain heartbeat to check.",
    };
  }
  if (verdict.action === "self") {
    return {
      ok: true,
      action: "self",
      pid: verdict.pid,
      ageMs: null,
      staleAfterMs,
      message: "The heartbeat belongs to this process.",
    };
  }
  if (verdict.action === "healthy") {
    return {
      ok: true,
      action: "healthy",
      pid: verdict.pid,
      ageMs: verdict.ageMs,
      staleAfterMs,
      message: `Brain pid ${verdict.pid} is alive — last beat ${verdict.ageMs}ms ago.`,
    };
  }
  if (verdict.action === "already_exited") {
    return {
      ok: true,
      action: "already_exited",
      pid: verdict.pid,
      ageMs: verdict.ageMs,
      staleAfterMs,
      message: `Brain pid ${verdict.pid} already exited — the service supervisor owns the restart.`,
    };
  }

  // Stale plus a live pid is only a wedge if that pid is still the process that
  // wrote the beat. On win32 nothing here can establish that -- and nothing has
  // to, because the supervisor loop stops its own wedged child through the
  // handle it already holds -- so this checker never kills there.
  const platform = args.platform ?? process.platform;
  const identity = platform === "win32"
    ? null
    : (args.processIdentity ?? ((pid: number) => defaultBrainProcessIdentity(pid, platform)))(
      verdict.pid,
    );
  // "Could not read the identity" and "read it, and it is someone else" are
  // different facts. Only the second is evidence, and only evidence may delete
  // the heartbeat -- deleting the beat of a live wedged brain erases the wedge
  // for good, and the next check would find nothing to judge.
  const identityRead = identity != null && Number.isFinite(identity.startedAtMs);
  if (!identityRead) {
    return {
      ok: true,
      action: "already_exited",
      pid: verdict.pid,
      ageMs: verdict.ageMs,
      staleAfterMs,
      message: platform === "win32"
        ? `Brain pid ${verdict.pid} stopped beating — the Windows supervisor owns the restart.`
        : `Brain pid ${verdict.pid} stopped beating, but there is no way to tell whether it is still the brain — left it alone.`,
    };
  }
  if (!brainProcessIdentityMatches(verdict.heartbeat, identity)) {
    // The heartbeat outlived its writer. Remove it: left in place it names a
    // recycled pid forever, and every later check would re-run this same probe
    // against a process that has nothing to do with ADE.
    try { fs.unlinkSync(brainHeartbeatPath(args.runtimeDir)); } catch { /* already gone */ }
    return {
      ok: true,
      action: "already_exited",
      pid: verdict.pid,
      ageMs: verdict.ageMs,
      staleAfterMs,
      message: `Brain pid ${verdict.pid} is no longer the brain that wrote this heartbeat — cleared the stale record instead of stopping it.`,
    };
  }

  // Wedged. Breadcrumb first, so the record survives even if the kill races.
  (args.writeBreadcrumb ?? writeWedgeBreadcrumb)({
    runtimeDir: args.runtimeDir,
    heartbeat: verdict.heartbeat,
    ageMs: verdict.ageMs,
    staleAfterMs,
    now,
  });
  const kill = args.kill ?? ((pid: number) => {
    // SIGKILL, not SIGTERM: a process whose event loop is dead cannot run a
    // signal handler, so anything catchable would simply be ignored and leave
    // the brain squatting the socket for another hour.
    process.kill(pid, "SIGKILL");
  });
  try {
    kill(verdict.pid);
  } catch (error) {
    return {
      ok: true,
      action: "kill_failed",
      pid: verdict.pid,
      ageMs: verdict.ageMs,
      staleAfterMs,
      message: `Brain pid ${verdict.pid} is stuck but could not be stopped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return {
    ok: true,
    action: "killed",
    pid: verdict.pid,
    ageMs: verdict.ageMs,
    staleAfterMs,
    message: `Brain pid ${verdict.pid} stopped responding for ${verdict.ageMs}ms — stopped it so the service restarts.`,
  };
}
