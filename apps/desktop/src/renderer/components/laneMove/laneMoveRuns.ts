import { useSyncExternalStore } from "react";
import type {
  AgentChatCrossMachineBatchMoveRecord,
  OpenProjectBinding,
} from "../../../shared/types";
import type { CloudKeptLaneRestoreRecord } from "../../../shared/cloudKeptLaneRestore";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { showToast } from "../app/toast/toastStore";
import { deleteCloudLane } from "../cloudLane/cloudLaneActions";

/**
 * The lane moves this window started, and what each one is doing now.
 *
 * A live move is the source brain's batch move; a move from saved copies is
 * the destination brain's kept-lane restore. Neither brain sends an event for
 * the whole move, so a run reads its record on a short timer while it runs
 * and stops at the end (each chat's own banner shows its part as it goes).
 *
 * A live move off an ADE Cloud computer ends with deleting that computer, and
 * only after the move is done and checked: every lane and chat arrived. A
 * failure keeps the computer, so nothing is lost. A move off an asleep one
 * (`fromComputer`) is the destination brain's restore, which deletes that
 * computer first, only while its saved copy holds all the lane's work. An unfinished run is saved in this
 * window's storage, so a reload picks it up and still deletes the computer.
 */

export type LaneMovePhase =
  /** The move runs. */
  | "moving"
  /** Moved and checked; the ADE Cloud computer is being deleted. */
  | "deleting"
  | "done"
  /** Moved, but the ADE Cloud computer could not be deleted. */
  | "deleteFailed"
  /** Part of it, or none of it, arrived. Nothing was deleted. */
  | "failed";

type LaneMoveRunBase = {
  id: string;
  /** The lane as its source knows it (the kept lane's id for a move from saved copies). */
  laneId: string;
  laneName: string;
  /** Where the lane goes. */
  targetName: string;
  /** The lane's ADE Cloud computer, deleted once the move is done and checked. */
  cloudInstanceId: string | null;
  phase: LaneMovePhase;
  error: string | null;
  startedAtMs: number;
};

export type LaneMoveRun =
  | (LaneMoveRunBase & {
      kind: "live";
      /** The source brain, which runs the batch. */
      pin: OpenProjectBinding;
      record: AgentChatCrossMachineBatchMoveRecord | null;
    })
  | (LaneMoveRunBase & {
      kind: "restore";
      /** The destination brain, which restores the lane. */
      pin: OpenProjectBinding;
      record: CloudKeptLaneRestoreRecord | null;
      /** The lane's asleep ADE Cloud computer, which the restore deletes first with no wake. */
      fromComputer?: string | null;
    });

const STORAGE_KEY = "ade.laneMoveRuns.v1";
/** Reads come quickly at first, when a small lane is done in seconds, then slower. */
const FAST_READ_MS = 2_000;
const SLOW_READ_MS = 6_000;
const FAST_READS_FOR_MS = 60_000;
/** A move still running after this long stops being read and offers Try again. */
const READ_FOR_MS = 2 * 60 * 60_000;
/** A run that ended stays in the list this long, so its dialog can show the result. */
const KEEP_ENDED_MS = 10 * 60_000;

let runs: LaneMoveRun[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const listener of listeners) listener();
}

function save(): void {
  try {
    const unfinished = runs.filter((run) => run.phase === "moving" || run.phase === "deleting" || run.phase === "deleteFailed");
    if (unfinished.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(unfinished.map((run) => ({ ...run, record: null }))));
  } catch {
    // Storage full or blocked: the run still goes on in this window.
  }
}

function update(id: string, change: (run: LaneMoveRun) => LaneMoveRun): LaneMoveRun | null {
  let next: LaneMoveRun | null = null;
  runs = runs.map((run) => {
    if (run.id !== id) return run;
    next = change(run);
    return next;
  });
  save();
  emit();
  return next;
}

/**
 * The kept-lane restore calls. A window whose ADE has no `cloud` bridge
 * (an older brain behind ADE Web) can't run a move from saved copies.
 */
export function keptLaneRestoreApi() {
  const api = window.ade.cloud;
  if (!api?.previewKeptLaneRestore || !api.restoreKeptLane || !api.getKeptLaneRestore) {
    throw new Error("This ADE can't bring a lane back from ADE Cloud's saved copies. Update ADE, then try again.");
  }
  return {
    preview: api.previewKeptLaneRestore,
    restore: api.restoreKeptLane,
    get: api.getKeptLaneRestore,
  };
}

function errorText(error: unknown): string {
  return stripElectronErrorWrapper(error instanceof Error ? error.message : String(error));
}

/** Every lane and chat of the batch arrived where it was sent. */
function batchArrived(record: AgentChatCrossMachineBatchMoveRecord): boolean {
  return record.state === "completed"
    && record.items.length > 0
    && record.items.some((item) => item.kind === "lane")
    && record.items.every((item) => item.state === "continued"
      && Boolean(item.kind === "lane" ? item.destinationLaneId : item.destinationSessionId));
}

function batchEnded(record: AgentChatCrossMachineBatchMoveRecord): boolean {
  return record.state === "completed" || record.state === "partial" || record.state === "cancelled";
}

function batchFailure(record: AgentChatCrossMachineBatchMoveRecord): string {
  const failed = record.items.filter((item) => item.state !== "continued");
  const first = failed.find((item) => item.error)?.error;
  if (record.state === "cancelled") return "The move was cancelled.";
  return first ?? `${failed.length} of ${record.items.length} parts did not arrive.`;
}

function schedule(id: string, run: LaneMoveRun): void {
  clearTimeout(timers.get(id));
  const age = Date.now() - run.startedAtMs;
  if (age > READ_FOR_MS) {
    // Too long to keep reading. Nothing is deleted; Try again asks the same
    // machine again, and it goes on from what already arrived.
    timers.delete(id);
    update(id, (entry) => ({
      ...entry,
      phase: "failed",
      error: `ADE stopped checking this move. Open the lane on ${entry.targetName} to see what arrived.`,
    }));
    return;
  }
  timers.set(id, setTimeout(() => void read(id), age < FAST_READS_FOR_MS ? FAST_READ_MS : SLOW_READ_MS));
}

function forgetLater(id: string): void {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    runs = runs.filter((run) => run.id !== id);
    emit();
  }, KEEP_ENDED_MS));
}

async function deleteComputer(id: string): Promise<void> {
  const run = runs.find((entry) => entry.id === id);
  if (!run?.cloudInstanceId) return;
  update(id, (entry) => ({ ...entry, phase: "deleting", error: null }));
  try {
    // The move carried the work and every chat, and the check above passed:
    // the work check would only find what already arrived, so it is skipped.
    const done = await deleteCloudLane(run.cloudInstanceId, { skipCheck: true, keepChats: false });
    if (!done.ok) throw new Error(done.message || "ADE Cloud did not delete the computer.");
    update(id, (entry) => ({ ...entry, phase: "done" }));
    showToast({
      tone: "success",
      title: `Moved ${run.laneName} to ${run.targetName}`,
      message: "Its ADE Cloud computer is deleted.",
    });
    forgetLater(id);
  } catch (error) {
    const message = errorText(error);
    update(id, (entry) => ({ ...entry, phase: "deleteFailed", error: message }));
    showToast({
      tone: "warning",
      title: `Moved ${run.laneName}, but its ADE Cloud computer is still there`,
      message: `${message} Open the lane's machine menu to delete it.`,
      durationMs: 18_000,
    });
  }
}

function finish(id: string, arrived: boolean, failure: string | null): void {
  const run = runs.find((entry) => entry.id === id);
  if (!run) return;
  if (!arrived) {
    const failed = update(id, (entry) => ({ ...entry, phase: "failed", error: failure }));
    const wakesInstead = failed ? laneMoveWakesInstead(failed) : false;
    showToast({
      tone: "warning",
      title: wakesInstead
        ? `Couldn't move ${run.laneName} from its saved copy`
        : `Couldn't move all of ${run.laneName} to ${run.targetName}`,
      message: wakesInstead
        ? `${failure ?? ""} Nothing was deleted. Wake the ADE Cloud computer to move the lane from there.`.trim()
        : run.cloudInstanceId
        ? `${failure ?? ""} Its ADE Cloud computer is kept, so nothing is lost.`.trim()
        : failure ?? "Open the lane's machine menu to try again.",
      durationMs: 18_000,
    });
    forgetLater(id);
    return;
  }
  if (run.cloudInstanceId) {
    void deleteComputer(id);
    return;
  }
  update(id, (entry) => ({ ...entry, phase: "done" }));
  showToast({
    tone: "success",
    title: `Moved ${run.laneName} to ${run.targetName}`,
    ...(run.kind === "restore" && run.fromComputer ? { message: "Its ADE Cloud computer is deleted." } : {}),
  });
  forgetLater(id);
}

async function read(id: string): Promise<void> {
  const run = runs.find((entry) => entry.id === id);
  if (!run || run.phase !== "moving") return;
  try {
    if (run.kind === "live") {
      const record = await window.ade.agentChat.getCrossMachineBatchMove({ batchId: run.id }, run.pin);
      if (!record) throw new Error("The lane's machine no longer knows this move.");
      const next = update(id, (entry) => (entry.kind === "live" ? { ...entry, record } : entry));
      if (batchEnded(record)) finish(id, batchArrived(record), batchArrived(record) ? null : batchFailure(record));
      else if (next) schedule(id, next);
    } else {
      const record = await keptLaneRestoreApi().get({ restoreId: run.id }, run.pin);
      if (!record) throw new Error("This machine no longer knows this move.");
      const next = update(id, (entry) => (entry.kind === "restore" ? { ...entry, record } : entry));
      // The restore forgets the kept lane itself, and only once every chat came back.
      if (record.state === "completed") finish(id, true, null);
      else if (record.state === "failed") finish(id, false, record.error ?? "Part of the lane did not come back.");
      else if (next) schedule(id, next);
    }
  } catch (error) {
    // A machine that is briefly unreachable is read again; the move goes on there.
    const message = errorText(error);
    const next = update(id, (entry) => ({ ...entry, error: message }));
    if (next) schedule(id, next);
  }
}

function add(run: LaneMoveRun): void {
  runs = [...runs.filter((entry) => entry.id !== run.id), run];
  save();
  emit();
  void read(run.id);
}

/** Starts following a batch move this window started. */
export function followLiveLaneMove(input: {
  record: AgentChatCrossMachineBatchMoveRecord;
  pin: OpenProjectBinding;
  laneId: string;
  laneName: string;
  cloudInstanceId: string | null;
}): string {
  add({
    kind: "live",
    id: input.record.batchId,
    pin: input.pin,
    record: input.record,
    laneId: input.laneId,
    laneName: input.laneName,
    targetName: input.record.machineName,
    cloudInstanceId: input.cloudInstanceId,
    phase: "moving",
    error: null,
    startedAtMs: Date.now(),
  });
  return input.record.batchId;
}

/** Starts following a restore from saved copies this window started. */
export function followRestoreLaneMove(input: {
  record: CloudKeptLaneRestoreRecord;
  pin: OpenProjectBinding;
  targetName: string;
  cloudInstanceId: string | null;
  fromComputer?: string | null;
}): string {
  add({
    kind: "restore",
    fromComputer: input.fromComputer ?? null,
    id: input.record.restoreId,
    pin: input.pin,
    record: input.record,
    laneId: input.record.laneId,
    laneName: input.record.laneName,
    targetName: input.targetName,
    cloudInstanceId: input.cloudInstanceId,
    phase: "moving",
    error: null,
    startedAtMs: Date.now(),
  });
  return input.record.restoreId;
}

/**
 * A move from an asleep computer's saved copy that deleted nothing, because
 * the copy isn't complete or the computer woke: the person wakes it and
 * moves the lane live.
 */
export function laneMoveWakesInstead(run: LaneMoveRun): boolean {
  return run.kind === "restore" && run.phase === "failed" && run.record?.wakeInstead === true;
}

/** Tries the ADE Cloud computer's delete again, after a move that arrived. */
export function retryLaneMoveDelete(id: string): void {
  void deleteComputer(id);
}

/** Stops showing an ended run. */
export function dismissLaneMove(id: string): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  runs = runs.filter((run) => run.id !== id);
  save();
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): LaneMoveRun[] {
  return runs;
}

export function useLaneMoveRuns(): LaneMoveRun[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The newest run of a lane, while it runs or just ended; for the lane's machine menu. */
export function useLaneMoveRunForLane(laneId: string | null): LaneMoveRun | null {
  const all = useLaneMoveRuns();
  if (!laneId) return null;
  for (let index = all.length - 1; index >= 0; index -= 1) {
    if (all[index]!.laneId === laneId) return all[index]!;
  }
  return null;
}

/** One run by its id, for the dialog that follows it. */
export function useLaneMoveRun(id: string | null): LaneMoveRun | null {
  const all = useLaneMoveRuns();
  return id ? all.find((run) => run.id === id) ?? null : null;
}

/** Picks up the runs a reload left unfinished. Called once, when this module loads. */
function resume(): void {
  if (typeof window === "undefined") return;
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as LaneMoveRun[];
    if (!Array.isArray(saved)) return;
    for (const run of saved) {
      if (!run?.id || !run.pin) continue;
      // A delete cut off by the reload is tried again: the move had arrived.
      const phase: LaneMovePhase = run.phase === "deleting" ? "deleteFailed" : run.phase;
      runs.push({ ...run, phase });
      if (phase === "moving") schedule(run.id, run);
    }
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
  }
}

resume();
