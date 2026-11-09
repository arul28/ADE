import { useMemo, useSyncExternalStore } from "react";
import { selectActiveProjectStateKey, useAppStore } from "../state/appStore";

/**
 * Lanes that are being created right now, for the lane lists to show.
 *
 * A create runs in the background: the dialog that asked for it is closed and
 * the page that held it can be gone. The lane lists read this store to show a
 * "Creating…" row until the lane exists, and "Setting up…" on the real row
 * while its template or environment setup runs. Nothing here outlives the
 * window; the create itself runs on the lane's machine and does not need it.
 */
export type PendingLaneCreate = {
  id: string;
  name: string;
  /**
   * The project tab that started the create (`selectActiveProjectStateKey`).
   * A list shows only its own tab's: two tabs can hold one path on two machines.
   */
  scopeKey: string | null;
  /** The lane's machine when it is not the tab's own; null for the tab's machine. */
  machineId: string | null;
  /** `creating`: no lane yet. `setup`: the lane exists and its setup is running. */
  phase: "creating" | "setup";
  /** Set once the lane exists. Only meaningful on the lane's machine. */
  laneId: string | null;
  /** True while Stop can still reach the git checkout of the create. */
  canStop: boolean;
};

const pending = new Map<string, PendingLaneCreate>();
const stopHandlers = new Map<string, () => void>();
const listeners = new Set<() => void>();
let snapshot: PendingLaneCreate[] = [];

function emit(): void {
  snapshot = [...pending.values()];
  for (const listener of [...listeners]) listener();
}

function patch(id: string, next: Partial<PendingLaneCreate>): void {
  const current = pending.get(id);
  if (!current) return;
  pending.set(id, { ...current, ...next });
  emit();
}

/** Record a create that is starting. `stop` asks the lane's machine to stop it. */
export function beginPendingLaneCreate(args: {
  name: string;
  scopeKey: string | null;
  machineId?: string | null;
  stop?: () => void;
}): string {
  const id = crypto.randomUUID();
  pending.set(id, {
    id,
    name: args.name,
    scopeKey: args.scopeKey,
    machineId: args.machineId ?? null,
    phase: "creating",
    laneId: null,
    canStop: Boolean(args.stop),
  });
  if (args.stop) stopHandlers.set(id, args.stop);
  emit();
  return id;
}

/** The lane exists now; its row takes over from the placeholder. */
export function markPendingLaneCreateSetup(id: string, laneId: string): void {
  stopHandlers.delete(id);
  patch(id, { phase: "setup", laneId, canStop: false });
}

/** The create is over: done, failed, or stopped. */
export function endPendingLaneCreate(id: string): void {
  stopHandlers.delete(id);
  if (pending.delete(id)) emit();
}

/** Ask to stop a create. The Stop button goes away until the machine answers. */
export function stopPendingLaneCreate(id: string): void {
  const stop = stopHandlers.get(id);
  if (!stop) return;
  patch(id, { canStop: false });
  stop();
}

/** The machine refused the stop (the create is past git, or not there yet). */
export function allowPendingLaneCreateStop(id: string): void {
  if (stopHandlers.has(id) && pending.get(id)?.phase === "creating") patch(id, { canStop: true });
}

/** Show a "Creating…" row for as long as `run` takes. */
export async function trackPendingLaneCreate<T>(
  args: { name: string; scopeKey: string | null },
  run: () => Promise<T>,
): Promise<T> {
  const id = beginPendingLaneCreate(args);
  try {
    return await run();
  } finally {
    endPendingLaneCreate(id);
  }
}

/** Is the project tab that started a create the one on screen? The global store follows the active tab. */
export function isProjectTabOnScreen(scopeKey: string | null): boolean {
  return selectActiveProjectStateKey(useAppStore.getState()) === scopeKey;
}

/** The sticky "Could not create" toast of one lane name in one tab; a later create of that name clears it. */
export function laneCreateFailureToastId(scopeKey: string | null, name: string): string {
  return `lane-create-failed:${scopeKey ?? ""}:${name}`;
}

/** The id `useLaneEventToasts` gives its "Lane created" toast, so a second one for the lane replaces it. */
export function laneCreatedToastId(laneId: string): string {
  return `lane-lane-created-${laneId}`;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PendingLaneCreate[] {
  return snapshot;
}

/** The creates in flight for one project tab. The array is stable until one changes. */
export function usePendingLaneCreates(scopeKey: string | null): PendingLaneCreate[] {
  const all = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(
    () => (all.length === 0 ? all : all.filter((entry) => entry.scopeKey === scopeKey)),
    [all, scopeKey],
  );
}
