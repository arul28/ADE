import { useCallback, useSyncExternalStore } from "react";
import type { CloneProjectInput } from "../../../shared/types";
import { isWebClientMode } from "../../lib/webClientMode";
import { showToast } from "../app/toast/toastStore";
import {
  describeCopyFailure,
  isUserFixableCopyFailure,
  type CopyFailure,
  type CopyOpenTarget,
} from "./projectCopies";

/**
 * The clones that put a copy of a repository on a machine, one job per
 * repository and machine, for the whole window.
 *
 * Every surface that adds a copy (the Add project form, the copies menu on a
 * tab, the start page) starts and reads its jobs here, so:
 * - a second start for a repository and machine whose clone still runs joins
 *   it instead of cloning twice (a form closed and opened again shows the
 *   clones it started);
 * - each job keeps its machine: a retry goes to the machine the first try
 *   went to;
 * - one job failing never touches another.
 *
 * A job lives while something shows it. When a job ends with nothing showing
 * its repository, a failure is told with a toast that names the machine, and
 * the job is dropped; when the last surface showing a repository closes, the
 * finished jobs of that repository are dropped.
 */

export type CopyJobStatus = "cloning" | "ready" | "failed";

export type CopyJobMachine = {
  machineId: string;
  name: string;
  /** Null for this computer. Every call of the job goes to this target. */
  targetId: string | null;
};

export type CopyJob = {
  key: string;
  repoKey: string;
  url: string;
  /** Folder name on the machine. */
  name: string;
  /** Parent folder on the machine; null lets the machine use its default. */
  parentDir: string | null;
  displayName: string;
  machine: CopyJobMachine;
  status: CopyJobStatus;
  failure: CopyFailure | null;
  result: CopyOpenTarget | null;
};

export type StartCopyJobInput = Omit<CopyJob, "key" | "status" | "failure" | "result">;

type ReadyCallback = (target: CopyOpenTarget) => void;

const jobs = new Map<string, CopyJob>();
/** Which run of a job is current, so a stale run's answer is ignored. */
const runIds = new Map<string, number>();
const readyCallbacks = new Map<string, Set<ReadyCallback>>();
const watchersByRepo = new Map<string, number>();
const listeners = new Set<() => void>();
const readyListeners = new Set<(job: CopyJob) => void>();
const EMPTY: readonly CopyJob[] = Object.freeze([]);
let listsByRepo = new Map<string, readonly CopyJob[]>();
let nextRunId = 1;

export function copyJobKey(repoKey: string, machineId: string): string {
  return `${repoKey}\u0000${machineId}`;
}

function emit(): void {
  const next = new Map<string, CopyJob[]>();
  for (const job of jobs.values()) {
    const list = next.get(job.repoKey);
    if (list) list.push(job);
    else next.set(job.repoKey, [job]);
  }
  listsByRepo = new Map([...next].map(([repoKey, list]) => [repoKey, Object.freeze(list)]));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isWatched(repoKey: string): boolean {
  return (watchersByRepo.get(repoKey) ?? 0) > 0;
}

function dropJob(key: string): void {
  jobs.delete(key);
  runIds.delete(key);
  readyCallbacks.delete(key);
}

async function cloneOnMachine(job: CopyJob): Promise<CopyOpenTarget> {
  const input: CloneProjectInput = {
    url: job.url,
    parentDir: job.parentDir ?? "",
    name: job.name,
  };
  const targetId = job.machine.targetId;
  if (targetId) {
    // The hosted web client reaches each machine through its own session and
    // has no clone call for another machine.
    if (isWebClientMode()) throw new Error("copy_web_unsupported: cloning to a machine needs the desktop app.");
    const clone = window.ade?.remoteRuntime?.cloneProject;
    if (typeof clone !== "function") throw new Error("copy_unsupported: this ADE cannot clone on another machine.");
    const record = await clone(targetId, input);
    if (record.githubSignInMissing) {
      // The clone used this computer's GitHub sign-in once; nothing of it stays there.
      showToast({
        id: `project-copy-github:${job.key}`,
        tone: "warning",
        title: `${job.machine.name} has no GitHub sign-in of its own, so fetch and push there won't sign in until you connect GitHub on it.`,
      });
    }
    return {
      kind: "remote",
      targetId,
      projectId: record.projectId,
      rootPath: record.rootPath,
      displayName: record.displayName || job.displayName,
    };
  }
  const clone = window.ade?.project?.clone;
  if (typeof clone !== "function") throw new Error("copy_web_unsupported: cloning needs the desktop app.");
  const result = await clone(input);
  return { kind: "local", rootPath: result.rootPath, displayName: job.displayName };
}

/** Whether the job's machine is still connected; asked once, when a clone fails. */
async function machineStillOnline(job: CopyJob): Promise<boolean> {
  const targetId = job.machine.targetId;
  if (!targetId) return true;
  try {
    const snapshot = await window.ade.remoteRuntime.getConnectionSnapshot();
    return snapshot.connections.find((entry) => entry.target.id === targetId)?.state === "connected";
  } catch {
    return true;
  }
}

function runJob(job: CopyJob): void {
  const runId = nextRunId++;
  runIds.set(job.key, runId);
  const current = () => runIds.get(job.key) === runId;
  void cloneOnMachine(job).then(
    (result) => {
      if (!current()) return;
      const done: CopyJob = { ...job, status: "ready", result, failure: null };
      const callbacks = [...(readyCallbacks.get(job.key) ?? [])];
      readyCallbacks.delete(job.key);
      if (isWatched(job.repoKey)) jobs.set(job.key, done);
      else dropJob(job.key);
      emit();
      for (const listener of readyListeners) listener(done);
      for (const callback of callbacks) {
        try {
          callback(result);
        } catch {
          // An open that throws is the opener's to report.
        }
      }
    },
    async (error: unknown) => {
      const online = await machineStillOnline(job);
      if (!current()) return;
      const failure = describeCopyFailure(error, online);
      if (isWatched(job.repoKey)) {
        jobs.set(job.key, { ...job, status: "failed", failure, result: null });
      } else {
        dropJob(job.key);
        showToast({
          id: `project-copy:${job.key}`,
          tone: "error",
          title: `Couldn't add a copy on ${job.machine.name}`,
          message: failure.reason,
          report: isUserFixableCopyFailure(failure.kind)
            ? false
            : { surface: "project_copy", code: failure.kind, technicalDetail: failure.detail },
        });
      }
      emit();
    },
  );
}

/**
 * Starts the clone of a repository on one machine, or joins the one that is
 * already running there. A finished copy is not cloned again; a failed one is
 * tried again. `onReady` runs once the copy is there (at once when it already is).
 */
export function startCopyJob(input: StartCopyJobInput, onReady?: ReadyCallback): CopyJob {
  const key = copyJobKey(input.repoKey, input.machine.machineId);
  const existing = jobs.get(key);
  if (existing?.status === "cloning") {
    if (onReady) addReadyCallback(key, onReady);
    return existing;
  }
  if (existing?.status === "ready" && existing.result) {
    onReady?.(existing.result);
    return existing;
  }
  const job: CopyJob = { ...input, key, status: "cloning", failure: null, result: null };
  jobs.set(key, job);
  if (onReady) addReadyCallback(key, onReady);
  runJob(job);
  emit();
  return job;
}

/**
 * Tries a failed job again, on the same machine. `parentDir` changes the
 * folder first (the person picked another one); without it the folder stays.
 */
export function retryCopyJob(key: string, change: { parentDir?: string | null } = {}): void {
  const existing = jobs.get(key);
  if (!existing || existing.status !== "failed") return;
  const job: CopyJob = {
    ...existing,
    ...(change.parentDir !== undefined ? { parentDir: change.parentDir } : {}),
    status: "cloning",
    failure: null,
    result: null,
  };
  jobs.set(key, job);
  runJob(job);
  emit();
}

function addReadyCallback(key: string, callback: ReadyCallback): void {
  const set = readyCallbacks.get(key) ?? new Set<ReadyCallback>();
  set.add(callback);
  readyCallbacks.set(key, set);
}

/** Runs `callback` when the job's copy is there; at once when it already is. */
export function whenCopyJobReady(key: string, callback: ReadyCallback): void {
  const job = jobs.get(key);
  if (job?.status === "ready" && job.result) {
    callback(job.result);
    return;
  }
  if (job) addReadyCallback(key, callback);
}

/**
 * Marks a repository as shown, for as long as the returned function is not
 * called. Finished jobs of a repository nobody shows are dropped.
 */
export function watchCopyJobs(repoKey: string): () => void {
  watchersByRepo.set(repoKey, (watchersByRepo.get(repoKey) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (watchersByRepo.get(repoKey) ?? 1) - 1;
    if (left > 0) {
      watchersByRepo.set(repoKey, left);
      return;
    }
    watchersByRepo.delete(repoKey);
    let changed = false;
    for (const job of [...jobs.values()]) {
      if (job.repoKey !== repoKey || job.status === "cloning") continue;
      dropJob(job.key);
      changed = true;
    }
    if (changed) emit();
  };
}

/** Called with each job that finishes with its copy in place. */
export function subscribeCopyJobReady(listener: (job: CopyJob) => void): () => void {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

/** The jobs of one repository now, outside React. */
export function listCopyJobs(repoKey: string): readonly CopyJob[] {
  return listsByRepo.get(repoKey) ?? EMPTY;
}

/** The jobs of one repository, live. */
export function useCopyJobs(repoKey: string | null): readonly CopyJob[] {
  const getSnapshot = useCallback(
    () => (repoKey ? listsByRepo.get(repoKey) ?? EMPTY : EMPTY),
    [repoKey],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
