import { useEffect, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { LaneCatchUpPromptInput } from "../../lib/laneCatchUpPrompt";
import type { LaneRebaseLine } from "./laneRebaseNeeds";

/**
 * What a lane's Catch up menu offers. "Ask an agent" is always there; the two
 * direct ways are offered only when they are safe:
 *
 * - **Rebase now**: nothing uncommitted, no rebase or merge in progress, a
 *   conflict check that found none, and the branch was never pushed (a
 *   rebase would rewrite pushed history).
 * - **Merge <base> in**: nothing uncommitted, nothing in progress, a conflict
 *   check that found none. It rewrites nothing, so a pushed branch is fine.
 *
 * An unknown conflict answer (`conflictPredicted: null`) is not safe: the
 * direct ways wait for the check. When neither is safe, `blocker` names why,
 * in a few words.
 */
export type LaneCatchUpFacts = {
  line: Pick<LaneRebaseLine, "conflictPredicted" | "conflictingFiles">;
  /** The menu's conflict check, run on the lane's machine when it opens. */
  conflictCheck: "checking" | "done" | "failed";
  dirty: boolean;
  /** A rebase or merge is in progress in the lane. */
  inProgress: boolean;
  /** Whether the branch is on the remote. Null until known. */
  pushed: boolean | null;
  /** The lane's machine can run the merge (`git.mergeBaseIn`). */
  mergeAvailable: boolean;
};

export type LaneCatchUpOptions = {
  rebase: boolean;
  merge: boolean;
  blocker: string | null;
};

export function laneCatchUpOptions(facts: LaneCatchUpFacts): LaneCatchUpOptions {
  const conflictCount = facts.line.conflictingFiles.length;
  const shared = facts.inProgress
    ? "A rebase or merge is in progress"
    : facts.line.conflictPredicted === true
      ? conflictCount > 0
        ? `Conflicts expected in ${conflictCount} file${conflictCount === 1 ? "" : "s"}`
        : "Conflicts expected"
      : facts.dirty
        ? "Uncommitted changes"
        : facts.line.conflictPredicted !== false
          ? facts.conflictCheck === "checking"
            ? "Checking for conflicts…"
            : "Couldn't check for conflicts"
          : null;
  const rebase = shared == null && facts.pushed === false;
  const merge = shared == null && facts.mergeAvailable;
  if (rebase || merge) return { rebase, merge, blocker: null };
  return {
    rebase,
    merge,
    blocker: shared ?? (facts.pushed === true ? "Already pushed — rebasing would rewrite it" : null),
  };
}

/* ---- Per-lane run state, shared by every trigger of the same lane ---- */

export type LaneCatchUpFailure = {
  action: "rebase" | "merge";
  message: string;
  laneId: string;
  pin: OpenProjectBinding | null;
  prompt: LaneCatchUpPromptInput;
};

type LaneCatchUpState = {
  busy: "rebase" | "merge" | null;
  failure: LaneCatchUpFailure | null;
};

const IDLE: LaneCatchUpState = { busy: null, failure: null };
const states = new Map<string, LaneCatchUpState>();
/** How many inline hosts (a lane's overview) show each lane's failure. */
const hosts = new Map<string, number>();
const listeners = new Set<() => void>();

/** One key per lane per machine: lane ids are only unique on their machine. */
export function laneCatchUpKey(laneId: string, pin: OpenProjectBinding | null): string {
  return `${pin?.key ?? "tab"}::${laneId}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readLaneCatchUp(key: string): LaneCatchUpState {
  return states.get(key) ?? IDLE;
}

export function patchLaneCatchUp(key: string, patch: Partial<LaneCatchUpState>): void {
  const next = { ...readLaneCatchUp(key), ...patch };
  if (next.busy == null && next.failure == null) states.delete(key);
  else states.set(key, next);
  emit();
}

/** Whether a lane overview is on screen to show this lane's failure inline. */
export function laneCatchUpHasInlineHost(key: string): boolean {
  return (hosts.get(key) ?? 0) > 0;
}

export function useLaneCatchUpState(key: string | null): LaneCatchUpState {
  return useSyncExternalStore(subscribe, () => (key ? readLaneCatchUp(key) : IDLE), () => IDLE);
}

/**
 * The lane's failure, for the surface that shows it inline. Mounting this
 * marks the lane as hosted, so a failure from the sidebar shows here instead
 * of in a toast.
 */
export function useLaneCatchUpFailureHost(key: string | null): LaneCatchUpFailure | null {
  useEffect(() => {
    if (!key) return;
    hosts.set(key, (hosts.get(key) ?? 0) + 1);
    return () => {
      const count = (hosts.get(key) ?? 1) - 1;
      if (count <= 0) hosts.delete(key);
      else hosts.set(key, count);
    };
  }, [key]);
  return useLaneCatchUpState(key).failure;
}
