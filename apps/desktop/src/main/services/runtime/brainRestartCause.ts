import fs from "node:fs";
import path from "node:path";

import {
  sanitizeUpdateRequestedBy,
  type RestartCause,
  type RestartMemoryFacts,
  type UpdateRequestedBy,
} from "../../../shared/chatAutoResume";

/**
 * Why the previous brain on this endpoint ended, decided once per brain start
 * from facts the previous brain and the machine left on disk. The continue
 * prompts and the reopened-CLI line name it (`restartResumePrompt`,
 * `cliReopenedNotice`).
 *
 * The facts, each read once at start before anything rewrites it:
 * - the previous brain's run record (`brain-run/<endpoint>.json`): its start,
 *   build, and, after an orderly stop, when it stopped and the stop intent;
 * - this computer's boot time (`os.uptime()`);
 * - the previous brain's last heartbeat (`heartbeat.json`, same pid);
 * - the watchdog breadcrumb this start recovered (`last-wedge.json`);
 * - the resource-pressure record (`resource-pressure.json`) as the previous
 *   brain left it;
 * - the remote update request the previous brain received (`update-request.json`).
 *
 * Pure: the caller reads the files.
 */

/** A memory breach this long before the previous brain's last sign of life still explains its end. */
export const RESTART_MEMORY_CONTEXT_WINDOW_MS = 15 * 60_000;
/** A remote update request older than this, or from before the previous brain started, names nobody. */
export const RESTART_UPDATE_REQUEST_MAX_AGE_MS = 2 * 60 * 60_000;
/** Clock slack between the files of one brain (heartbeats every 15 s, samples every 5 min). */
const SAME_RUN_SLACK_MS = 60_000;

export type PreviousBrainRun = {
  pid: number;
  startedAtMs: number;
  build: string | null;
  stoppedAtMs: number | null;
  stoppedBy: string | null;
  /** The intent the stopping brain took (`noteBrainStopIntent`), when it stopped on purpose. */
  stopIntent: "accepted_update" | "stop_for_good" | null;
};

export type BrainRestartCauseFacts = {
  nowMs: number;
  /** When this computer booted (epoch ms). */
  bootMs: number;
  currentBuild: string | null;
  currentVersion: string | null;
  /** Null on the first start on this endpoint. */
  previous: PreviousBrainRun | null;
  /** The previous brain's last heartbeat; null when it wrote none or another pid did. */
  lastHeartbeatMs: number | null;
  /** The watchdog breadcrumb this start recovered, when there was one. */
  wedge: { atMs: number; freezeCause: "self" | "memory" | "drive" | null } | null;
  /** The last memory or swap breach the resource-pressure monitor recorded, with its facts. */
  memoryPressure: {
    lastBreachAtMs: number;
    memory: Pick<RestartMemoryFacts, "totalMb" | "swapUsedMb" | "swapTotalMb"> | null;
    simulatorMb: number | null;
  } | null;
  /** The last `machine.updateAndRestart` the previous brain received. */
  updateRequest: { atMs: number; requestedBy: UpdateRequestedBy | null } | null;
};

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The cause, or null when there is nothing to name: the first start on this
 * endpoint, or a previous run another brain already took over (an app-owned
 * brain marks it `next_brain_started` and resumes its work itself).
 */
export function deriveBrainRestartCause(facts: BrainRestartCauseFacts): RestartCause | null {
  const previous = facts.previous;
  if (!previous || !finite(previous.startedAtMs)) return null;
  if (previous.stoppedBy === "next_brain_started") return null;

  // The previous brain's last sign of life: its heartbeat, or the watchdog's
  // kill, never earlier than its own start.
  const heartbeat = finite(facts.lastHeartbeatMs) && facts.lastHeartbeatMs >= previous.startedAtMs - SAME_RUN_SLACK_MS
    ? facts.lastHeartbeatMs
    : null;
  const wedgeAtMs = facts.wedge && finite(facts.wedge.atMs) && facts.wedge.atMs >= previous.startedAtMs - SAME_RUN_SLACK_MS
    ? facts.wedge.atMs
    : null;
  const lastAliveMs = Math.max(previous.startedAtMs, heartbeat ?? 0, wedgeAtMs ?? 0);

  const memory = (): RestartMemoryFacts | null => {
    const pressure = facts.memoryPressure;
    if (!pressure || !finite(pressure.lastBreachAtMs)) return null;
    // A breach in the minutes before the end, from this run (a sample can
    // land a little after the last heartbeat it is compared with).
    if (pressure.lastBreachAtMs < lastAliveMs - RESTART_MEMORY_CONTEXT_WINDOW_MS) return null;
    if (pressure.lastBreachAtMs > lastAliveMs + SAME_RUN_SLACK_MS * 6) return null;
    return {
      totalMb: pressure.memory?.totalMb ?? null,
      swapUsedMb: pressure.memory?.swapUsedMb ?? null,
      swapTotalMb: pressure.memory?.swapTotalMb ?? null,
      simulatorMb: pressure.simulatorMb ?? null,
    };
  };

  const buildChanged = Boolean(previous.build && facts.currentBuild && previous.build !== facts.currentBuild);
  const update = (endedAtMs: number | null): RestartCause => {
    const request = facts.updateRequest;
    const requestFresh = request
      && finite(request.atMs)
      && request.atMs >= previous.startedAtMs - SAME_RUN_SLACK_MS
      && facts.nowMs - request.atMs <= RESTART_UPDATE_REQUEST_MAX_AGE_MS;
    return {
      kind: "update",
      endedAtMs,
      version: buildChanged ? facts.currentVersion : null,
      requestedBy: requestFresh ? request.requestedBy : null,
    };
  };

  if (finite(previous.stoppedAtMs)) {
    // An orderly stop.
    if (previous.stopIntent === "accepted_update" || buildChanged) return update(previous.stoppedAtMs);
    if (previous.stoppedAtMs < facts.bootMs) {
      return { kind: "computer_restarted", endedAtMs: previous.stoppedAtMs, planned: true };
    }
    return { kind: "service_restarted", endedAtMs: previous.stoppedAtMs };
  }

  // No orderly stop: a crash, a kill, a power loss or a computer restart.
  if (lastAliveMs < facts.bootMs) {
    return { kind: "computer_restarted", endedAtMs: lastAliveMs, planned: false, memory: memory() };
  }
  if (wedgeAtMs != null) {
    return {
      kind: "service_restarted_by_watchdog",
      endedAtMs: wedgeAtMs,
      freezeCause: facts.wedge?.freezeCause ?? null,
      memory: memory(),
    };
  }
  // A new build with no orderly stop: an update whose stop was a kill.
  if (buildChanged) return update(lastAliveMs);
  return { kind: "unknown", endedAtMs: lastAliveMs, memory: memory() };
}

/** The cause as a log line's fields: kinds, times and counts only. */
export function restartCauseLogFields(cause: RestartCause | null): Record<string, unknown> {
  if (!cause) return { kind: null };
  return {
    kind: cause.kind,
    endedAt: finite(cause.endedAtMs) ? new Date(cause.endedAtMs).toISOString() : null,
    version: cause.version ?? null,
    requestedByKind: cause.requestedBy?.clientKind ?? null,
    requestedByName: cause.requestedBy?.machineName ?? null,
    freezeCause: cause.freezeCause ?? null,
    planned: cause.planned ?? null,
    memoryLow: Boolean(cause.memory),
    swapUsedMb: cause.memory?.swapUsedMb ?? null,
    simulatorMb: cause.memory?.simulatorMb ?? null,
  };
}

const UPDATE_REQUEST_FILE = "update-request.json";

/**
 * The brain received `machine.updateAndRestart`: keep who asked, so the next
 * start can name them. One small file in the machine's runtime folder,
 * replaced by each request. Never throws.
 */
export function writeBrainUpdateRequest(
  runtimeDir: string,
  request: { targetVersion: string | null; requestedBy: UpdateRequestedBy | null },
  nowMs = Date.now(),
): void {
  const filePath = path.join(runtimeDir, UPDATE_REQUEST_FILE);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify({
      version: 1,
      at: new Date(nowMs).toISOString(),
      targetVersion: request.targetVersion,
      requestedBy: request.requestedBy,
    }), { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch {
    fs.rmSync(tmpPath, { force: true });
    // Without it the next start says "an update" and names nobody.
  }
}

/** The last update request on this machine, or null. Never throws. */
export function readBrainUpdateRequest(runtimeDir: string): BrainRestartCauseFacts["updateRequest"] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(runtimeDir, UPDATE_REQUEST_FILE), "utf8")) as {
      at?: unknown;
      requestedBy?: unknown;
    };
    const atMs = typeof parsed?.at === "string" ? Date.parse(parsed.at) : Number.NaN;
    if (!Number.isFinite(atMs)) return null;
    return { atMs, requestedBy: sanitizeUpdateRequestedBy(parsed.requestedBy) };
  } catch {
    return null;
  }
}
