import { useEffect, useSyncExternalStore } from "react";
import { cloudLaneJobIsLive, type CloudLaneJobSnapshot, type CloudLaneWithoutComputer } from "../../../shared/cloudLaneLife";
import { savedChatsMachineKey } from "../../../shared/cloudSavedChats";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { useAdeCloudLaneComputers, useAdeCloudLaneForBinding } from "../../state/adeCloudLaneIndex";
import { accountScopedCopy } from "../../state/accountScopedStorage";
import { cloudLaneLifeAvailable, listCloudLaneJobs, listCloudLanesWithoutComputer } from "./cloudLaneActions";

/**
 * Two shared reads for every surface that shows a cloud lane's computer:
 *
 * - the tier changes and moves (`listJobs` once, then `onLaneJob` events);
 * - the lanes kept without a computer (`lanesWithoutComputer`, read when the
 *   first surface opens, on window focus and when the account's computers
 *   change; this computer keeps the last answer, for the account signed in
 *   here only, so a chat on a removed computer says so before any read;
 *   ADE Web keeps it in memory).
 *
 * One read however many surfaces show them; no timer, no poll. Both are
 * account level (main process, no pin) and empty where this ADE can't ask.
 * Also this window's state of each job's bar above a chat's prompt box.
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

/**
 * What this window saw of each job, recorded as the events arrive (never
 * while rendering): whether it was ever waiting or running here, and a turn
 * that moves each time it fails or starts again (a retry keeps the job id).
 */
export type CloudLaneJobMark = { seenLive: boolean; turn: number };
const jobMarks = new Map<string, CloudLaneJobMark>();

function markJob(previous: CloudLaneJobSnapshot | undefined, job: CloudLaneJobSnapshot): void {
  const mark = jobMarks.get(job.jobId) ?? { seenLive: false, turn: 0 };
  const live = cloudLaneJobIsLive(job);
  if (previous && previous.phase !== job.phase && (job.phase === "failed" || (live && !cloudLaneJobIsLive(previous)))) {
    mark.turn += 1;
  }
  if (live) mark.seenLive = true;
  jobMarks.set(job.jobId, mark);
}

/** This window's marks of the jobs, by job id (see `CloudLaneJobMark`). */
export function cloudLaneJobMarks(): ReadonlyMap<string, CloudLaneJobMark> {
  return jobMarks;
}

function noteJob(job: CloudLaneJobSnapshot): void {
  const previous = jobs.get(job.jobId);
  if (previous && previous.updatedAt > job.updatedAt) return;
  markJob(previous, job);
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
      if (!previous || previous.updatedAt <= job.updatedAt) {
        markJob(previous, job);
        next.set(job.jobId, job);
      }
    }
    publishJobs(next);
  }, () => undefined);
}

/** The job store's own subscription, for a reader that needs less than the whole map (the app shell). */
export function subscribeCloudLaneJobs(listener: () => void): () => void {
  return subscribeJobs(listener);
}

/** The jobs as the store holds them now. */
export function cloudLaneJobsNow(): ReadonlyMap<string, CloudLaneJobSnapshot> {
  return jobs;
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

/** A failed job waits for Retry this long before its card leaves the view. */
const FAILED_JOB_VISIBLE_MS = 24 * 60 * 60_000;

/** Live, ended in the last two minutes, or failed in the last day (waiting for Retry), unless its card was closed. */
export function cloudLaneJobVisible(job: CloudLaneJobSnapshot, now = Date.now()): boolean {
  if (cloudLaneJobIsLive(job)) return true;
  // Closed by the person (or replaced by a newer change of the lane): gone from every view.
  if (job.dismissedAt) return false;
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

/**
 * The size change or move of a chat's ADE Cloud lane that shows now, or null:
 * one answer for the chat's bar above the prompt box and for its Send (which
 * goes to the account's queue while the job holds sends). The chat's own
 * binding finds its lane computer (the one it is on, or the one a move
 * started from); its lane id finds the lane's job while the binding names a
 * computer this window never reached, or one a move replaced.
 */
export function useChatCloudLaneJob(binding: OpenProjectBinding | null, laneId: string | null): CloudLaneJobSnapshot | null {
  const lane = useAdeCloudLaneForBinding(binding);
  const { computers } = useAdeCloudLaneComputers();
  const onCloud = lane != null || (laneId != null && (binding?.kind === "remote" || computers.some((computer) => computer.laneId === laneId)));
  const all = useCloudLaneJobs(onCloud);
  if (!onCloud) return null;
  return cloudLaneJobFor(all, { instanceId: lane?.instanceId ?? null, laneId: lane?.laneId ?? laneId });
}

// ---------------------------------------------------------------------------
// A job's bar above a chat's prompt box, in this window
// ---------------------------------------------------------------------------

/** `open`: its steps show. `hidden`: closed while the job runs (the job goes on; a failure shows it again). */
export type CloudLaneJobBarState = { open: boolean; hidden: boolean };

const BAR_DEFAULT: CloudLaneJobBarState = { open: false, hidden: false };
let bars: ReadonlyMap<string, CloudLaneJobBarState> = new Map();
const barListeners = new Set<() => void>();
/** How many bars of each job are on screen now. */
const barsShown = new Map<string, number>();

function subscribeBars(listener: () => void): () => void {
  barListeners.add(listener);
  return () => {
    barListeners.delete(listener);
  };
}

export function setCloudLaneJobBar(jobId: string, patch: Partial<CloudLaneJobBarState>): void {
  const current = bars.get(jobId) ?? BAR_DEFAULT;
  const next = { ...current, ...patch };
  if (next.open === current.open && next.hidden === current.hidden) return;
  const map = new Map(bars);
  map.set(jobId, next);
  bars = map;
  for (const listener of barListeners) listener();
}

/**
 * "Show the steps" from the chat's cloud button: that job's bar opens on its
 * steps, and shows again if it was closed. False when no bar of it is on
 * screen (the caller shows the steps elsewhere).
 */
export function openCloudLaneJobBar(jobId: string): boolean {
  setCloudLaneJobBar(jobId, { open: true, hidden: false });
  return (barsShown.get(jobId) ?? 0) > 0;
}

/** One job's bar state, for the bar on screen. */
export function useCloudLaneJobBar(jobId: string): CloudLaneJobBarState {
  useEffect(() => {
    barsShown.set(jobId, (barsShown.get(jobId) ?? 0) + 1);
    return () => {
      const left = (barsShown.get(jobId) ?? 1) - 1;
      if (left > 0) barsShown.set(jobId, left);
      else barsShown.delete(jobId);
    };
  }, [jobId]);
  return useSyncExternalStore(subscribeBars, () => bars.get(jobId) ?? BAR_DEFAULT, () => BAR_DEFAULT);
}

// ---------------------------------------------------------------------------
// Lanes without a computer
// ---------------------------------------------------------------------------

const WITHOUT_STORAGE_KEY = "ade.cloudLanesWithoutComputer.v1";

type WithoutState = { lanes: readonly CloudLaneWithoutComputer[]; known: boolean; loading: boolean };

const EMPTY_WITHOUT: WithoutState = { lanes: [], known: false, loading: false };
let without: WithoutState = EMPTY_WITHOUT;
const withoutListeners = new Set<() => void>();
let stopWithout: (() => void) | null = null;
let withoutGeneration = 0;

function parseSavedWithout(value: unknown): CloudLaneWithoutComputer[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((row): row is CloudLaneWithoutComputer => Boolean(row)
    && typeof (row as CloudLaneWithoutComputer).laneId === "string"
    && typeof (row as CloudLaneWithoutComputer).laneName === "string"
    && typeof (row as CloudLaneWithoutComputer).formerInstanceId === "string");
}

// This computer's copy, for the account signed in here only (`accountScopedStorage.ts`):
// one account's kept lanes never show for the next one, and ADE Web keeps none.
const savedWithout = accountScopedCopy({
  key: WITHOUT_STORAGE_KEY,
  restore: (value) => {
    const lanes = parseSavedWithout(value);
    // A read in this window already answered: that list is newer.
    if (!lanes || without.known) return;
    publishWithout({ lanes, known: true });
  },
  forget: () => {
    // A read the last account started lands nowhere.
    withoutGeneration += 1;
    publishWithout({ ...EMPTY_WITHOUT });
    if (withoutListeners.size > 0) refreshCloudLanesWithoutComputer();
  },
});

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
      saveWithout(lanes);
    },
    () => {
      if (current === withoutGeneration) publishWithout({ loading: false });
    },
  );
}

function saveWithout(lanes: readonly CloudLaneWithoutComputer[]): void {
  savedWithout.save(lanes);
}

/**
 * The server deleted this lane's record: it leaves the list now, here and in
 * this computer's copy, and a read that started before the delete is dropped
 * (it would bring the lane back). Then the list is read again. A read that
 * fails keeps the list without it.
 */
export function dropCloudLaneWithoutComputer(laneId: string): void {
  withoutGeneration += 1;
  const lanes = without.lanes.filter((lane) => lane.laneId !== laneId);
  publishWithout({ lanes, loading: false });
  saveWithout(lanes);
  refreshCloudLanesWithoutComputer();
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
  // A saved chat's pin names its old computer as `cloud-saved:<machine key>`.
  const target = (savedChatsMachineKey(binding.targetId) ?? binding.targetId?.trim() ?? "").toLowerCase();
  return lanes.find((lane) => (host && lane.formerInstanceId.toLowerCase() === host)
    || (target && lane.formerMachineKey?.toLowerCase() === target)) ?? null;
}
