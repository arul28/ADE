import { useSyncExternalStore } from "react";

/**
 * The running git action of each lane scope (busy action, notice, error),
 * shared by the lane Git pane, which runs the actions, and the chat git
 * toolbar, which shows them.
 *
 * Its own module so the chat toolbar can read it without importing the Git
 * pane, which carries the diff viewer, commit timeline, and dialogs.
 */
export type LaneGitActionRuntimeState = {
  version: number;
  busyAction: string | null;
  notice: string | null;
  error: string | null;
};

const EMPTY_LANE_GIT_ACTION_RUNTIME_STATE: LaneGitActionRuntimeState = {
  version: 0,
  busyAction: null,
  notice: null,
  error: null,
};

const laneGitActionRuntimeByScope = new Map<string, LaneGitActionRuntimeState>();
const laneGitActionRuntimeListeners = new Set<() => void>();

function emitLaneGitActionRuntimeChange(): void {
  for (const listener of laneGitActionRuntimeListeners) {
    listener();
  }
}

function readLaneGitActionRuntimeState(scopeKey: string | null): LaneGitActionRuntimeState {
  if (!scopeKey) return EMPTY_LANE_GIT_ACTION_RUNTIME_STATE;
  return laneGitActionRuntimeByScope.get(scopeKey) ?? EMPTY_LANE_GIT_ACTION_RUNTIME_STATE;
}

function writeLaneGitActionRuntimeState(
  scopeKey: string | null,
  next: LaneGitActionRuntimeState,
): LaneGitActionRuntimeState {
  if (!scopeKey) return EMPTY_LANE_GIT_ACTION_RUNTIME_STATE;
  if (!next.busyAction && !next.notice && !next.error) {
    laneGitActionRuntimeByScope.delete(scopeKey);
  } else {
    laneGitActionRuntimeByScope.set(scopeKey, next);
  }
  emitLaneGitActionRuntimeChange();
  return next;
}

export function patchLaneGitActionRuntimeState(
  scopeKey: string | null,
  patch: Partial<LaneGitActionRuntimeState>,
): LaneGitActionRuntimeState {
  const prev = readLaneGitActionRuntimeState(scopeKey);
  return writeLaneGitActionRuntimeState(scopeKey, { ...prev, ...patch });
}

export function beginLaneGitActionRuntime(
  scopeKey: string | null,
  patch: Pick<LaneGitActionRuntimeState, "busyAction" | "notice" | "error">,
): number {
  const nextVersion = readLaneGitActionRuntimeState(scopeKey).version + 1;
  writeLaneGitActionRuntimeState(scopeKey, { ...patch, version: nextVersion });
  return nextVersion;
}

export function patchLaneGitActionRuntimeStateIfCurrent(
  scopeKey: string | null,
  version: number,
  patch: Partial<LaneGitActionRuntimeState>,
): LaneGitActionRuntimeState {
  const current = readLaneGitActionRuntimeState(scopeKey);
  if (current.version !== version) return current;
  return writeLaneGitActionRuntimeState(scopeKey, { ...current, ...patch, version });
}

export function scheduleLaneGitActionRuntimeClear(
  scopeKey: string | null,
  version: number,
  delayMs: number,
  patch: Partial<LaneGitActionRuntimeState>,
): void {
  window.setTimeout(() => {
    patchLaneGitActionRuntimeStateIfCurrent(scopeKey, version, patch);
  }, delayMs);
}

export function useLaneGitActionRuntimeState(scopeKey: string | null): LaneGitActionRuntimeState {
  return useSyncExternalStore(
    (listener) => {
      laneGitActionRuntimeListeners.add(listener);
      return () => {
        laneGitActionRuntimeListeners.delete(listener);
      };
    },
    () => readLaneGitActionRuntimeState(scopeKey),
    () => EMPTY_LANE_GIT_ACTION_RUNTIME_STATE,
  );
}

/** Drops every lane's runtime state; the Git pane's test reset calls it. */
export function clearLaneGitActionRuntimeState(): void {
  laneGitActionRuntimeByScope.clear();
  emitLaneGitActionRuntimeChange();
}
