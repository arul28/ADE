import { useSyncExternalStore } from "react";
import type { CloudLaneJobSnapshot, CloudLaneWithoutComputer } from "../../../shared/cloudLaneLife";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { cloudLaneLifeAvailable, listCloudLaneJobs, listCloudLanesWithoutComputer } from "./cloudLaneActions";

/**
 * Two shared reads for every surface that shows a cloud lane's computer:
 *
 * - the tier changes and moves (`listJobs` once, then `onLaneJob` events);
 * - the lanes kept without a computer (`lanesWithoutComputer`, read when the
 *   first surface opens, on window focus and when the account's computers
 *   change; this computer keeps the last answer so a chat on a removed
 *   computer says so before any read).
 *
 * One read however many surfaces show them; no timer, no poll. Both are
 * account level (main process, no pin) and empty where this ADE can't ask.
 */

// ---------------------------------------------------------------------------
// Tier changes and moves
// ---------------------------------------------------------------------------

/** How long a finished job's card stays in view after it ends. */
const FINISHED_JOB_VISIBLE_MS = 2 * 60_000;

let jobs: ReadonlyMap<string, CloudLaneJobSnapshot> = new Map();
const jobListeners = new Set<() => void>();
let stopJobs: (() => void) | null = null;

function publishJobs(next: ReadonlyMap<string, CloudLaneJobSnapshot>): void {
  jobs = next;
  for (const listener of jobListeners) listener();
}

function noteJob(job: CloudLaneJobSnapshot): void {
  const previous = jobs.get(job.jobId);
  if (previous && previous.updatedAt > job.updatedAt) return;
  const next = new Map(jobs);
  next.set(job.jobId, job);
  publishJobs(next);
}

function startJobs(): void {
  if (stopJobs || !cloudLaneLifeAvailable()) return;
  const off = window.ade.cloud?.onLaneJob?.(noteJob) ?? null;
  stopJobs = () => {
    off?.();
    stopJobs = null;
  };
  void listCloudLaneJobs().then((list) => {
    const next = new Map(jobs);
    for (const job of list) {
      const previous = next.get(job.jobId);
      if (!previous || previous.updatedAt <= job.updatedAt) next.set(job.jobId, job);
    }
    publishJobs(next);
  }, () => undefined);
}

function subscribeJobs(listener: () => void): () => void {
  jobListeners.add(listener);
  startJobs();
  return () => {
    jobListeners.delete(listener);
    if (jobListeners.size === 0) stopJobs?.();
  };
}

const readJobs = () => jobs;
const NO_JOBS: ReadonlyMap<string, CloudLaneJobSnapshot> = new Map();
const readNoJobs = () => NO_JOBS;
const subscribeNoJobs = () => () => undefined;

/** Every tier change and move this app knows, by job id. `enabled` false reads nothing. */
export function useCloudLaneJobs(enabled = true): ReadonlyMap<string, CloudLaneJobSnapshot> {
  return useSyncExternalStore(enabled ? subscribeJobs : subscribeNoJobs, enabled ? readJobs : readNoJobs, readNoJobs);
}

function cloudLaneJobIsLive(job: CloudLaneJobSnapshot): boolean {
  return job.phase === "waiting" || job.phase === "running";
}

/** A failed job waits for Retry this long before its card leaves the view. */
const FAILED_JOB_VISIBLE_MS = 24 * 60 * 60_000;

/** Live, ended in the last two minutes, or failed in the last day (waiting for Retry). */
export function cloudLaneJobVisible(job: CloudLaneJobSnapshot, now = Date.now()): boolean {
  if (cloudLaneJobIsLive(job)) return true;
  const endedAt = Date.parse(job.endedAt ?? job.updatedAt);
  if (!Number.isFinite(endedAt)) return false;
  return now - endedAt <= (job.phase === "failed" ? FAILED_JOB_VISIBLE_MS : FINISHED_JOB_VISIBLE_MS);
}

/**
 * The job to show for a computer: the newest visible one (live, just online,
 * or failed and waiting for Retry).
 * Matches the computer the lane is on now and the one a move started from.
 */
export function cloudLaneJobFor(
  all: ReadonlyMap<string, CloudLaneJobSnapshot>,
  match: { instanceId?: string | null; laneId?: string | null },
  now = Date.now(),
): CloudLaneJobSnapshot | null {
  let best: CloudLaneJobSnapshot | null = null;
  for (const job of all.values()) {
    const hit = (match.instanceId && (job.instanceId === match.instanceId || job.fromInstanceId === match.instanceId))
      || (match.laneId && job.laneId === match.laneId);
    if (!hit) continue;
    if (!cloudLaneJobVisible(job, now)) continue;
    if (!best || job.updatedAt > best.updatedAt) best = job;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Lanes without a computer
// ---------------------------------------------------------------------------

const WITHOUT_STORAGE_KEY = "ade.cloudLanesWithoutComputer.v1";

type WithoutState = { lanes: readonly CloudLaneWithoutComputer[]; known: boolean; loading: boolean };

let without: WithoutState = readSavedWithout();
const withoutListeners = new Set<() => void>();
let stopWithout: (() => void) | null = null;
let withoutGeneration = 0;

function readSavedWithout(): WithoutState {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(WITHOUT_STORAGE_KEY) : null;
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (!Array.isArray(parsed)) return { lanes: [], known: false, loading: false };
    const lanes = parsed.filter((row): row is CloudLaneWithoutComputer => Boolean(row)
      && typeof (row as CloudLaneWithoutComputer).laneId === "string"
      && typeof (row as CloudLaneWithoutComputer).laneName === "string"
      && typeof (row as CloudLaneWithoutComputer).formerInstanceId === "string");
    return { lanes, known: true, loading: false };
  } catch {
    return { lanes: [], known: false, loading: false };
  }
}

function publishWithout(next: Partial<WithoutState>): void {
  without = { ...without, ...next };
  for (const listener of withoutListeners) listener();
}

/** Reads the list again. Every surface that shows it calls this after a change it made. */
export function refreshCloudLanesWithoutComputer(): void {
  if (!cloudLaneLifeAvailable()) return;
  const current = ++withoutGeneration;
  publishWithout({ loading: true });
  void listCloudLanesWithoutComputer().then(
    (lanes) => {
      if (current !== withoutGeneration) return;
      publishWithout({ lanes, known: true, loading: false });
      try {
        window.localStorage.setItem(WITHOUT_STORAGE_KEY, JSON.stringify(lanes));
      } catch {
        // This computer's copy is a convenience; the next read fills it again.
      }
    },
    () => {
      if (current === withoutGeneration) publishWithout({ loading: false });
    },
  );
}

function startWithout(): void {
  if (stopWithout || typeof window === "undefined") return;
  const offStatus = window.ade?.cloud?.onStatusChanged?.(refreshCloudLanesWithoutComputer) ?? null;
  window.addEventListener("focus", refreshCloudLanesWithoutComputer);
  stopWithout = () => {
    offStatus?.();
    window.removeEventListener("focus", refreshCloudLanesWithoutComputer);
    stopWithout = null;
  };
  refreshCloudLanesWithoutComputer();
}

function subscribeWithout(listener: () => void): () => void {
  withoutListeners.add(listener);
  startWithout();
  return () => {
    withoutListeners.delete(listener);
    if (withoutListeners.size === 0) stopWithout?.();
  };
}

const readWithout = () => without;
const EMPTY_WITHOUT: WithoutState = { lanes: [], known: false, loading: false };
const subscribeNothing = () => () => undefined;
const readEmptyWithout = () => EMPTY_WITHOUT;

/** The account's lanes kept without a computer. `enabled` false reads nothing. */
export function useCloudLanesWithoutComputer(enabled = true): WithoutState {
  return useSyncExternalStore(
    enabled ? subscribeWithout : subscribeNothing,
    enabled ? readWithout : readEmptyWithout,
    readEmptyWithout,
  );
}

/**
 * The lane without a computer a chat's binding pointed at: the chat ran on
 * that lane's former computer (its remote target carries the computer's id
 * as host name, or the target is filed under its machine key).
 */
export function cloudLaneWithoutComputerForBinding(
  binding: OpenProjectBinding | null | undefined,
  lanes: readonly CloudLaneWithoutComputer[],
): CloudLaneWithoutComputer | null {
  if (!binding || binding.kind !== "remote") return null;
  const host = binding.hostname?.trim().toLowerCase() ?? "";
  const target = binding.targetId?.trim() ?? "";
  return lanes.find((lane) => (host && lane.formerInstanceId.toLowerCase() === host)
    || (lane.formerMachineKey != null && lane.formerMachineKey === target)) ?? null;
}
