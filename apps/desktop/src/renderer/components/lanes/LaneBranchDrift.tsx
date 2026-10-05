import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { GitBranch, Warning, X } from "@phosphor-icons/react";

import type { LaneBranchDrift, LaneBranchDriftResolution, LaneLifecycleEvent } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";
import { COMPOSER_STATUS_CHIP_ACTION_CLASS, COMPOSER_STATUS_CHIP_CLASS } from "../chat/ChatComposerStatusStrip";

// ---------------------------------------------------------------------------
// Drift state
// ---------------------------------------------------------------------------

/**
 * `branchDrift` is computed by the main process during the lane status refresh
 * (see `computeLaneStatus`), so reading it off the lane list costs nothing and
 * stays as fresh as the rest of the lane's git state.
 */
export function useLaneBranchDrift(laneId: string | null | undefined): LaneBranchDrift | null {
  return useAppStore((state) => {
    if (!laneId) return null;
    return state.lanes.find((lane) => lane.id === laneId)?.branchDrift ?? null;
  });
}

// ---------------------------------------------------------------------------
// Warning-strip arming
// ---------------------------------------------------------------------------

/**
 * The compact header chip is always visible while a lane is drifted; the full
 * warning strip is deliberately quieter and only appears once something is
 * about to act on the branch — a PR operation, or a new chat turn. Callers arm
 * it at that moment via `armLaneBranchDriftWarning`.
 */
const armedLaneIds = new Set<string>();
const armedListeners = new Set<() => void>();

function emitArmedChange(): void {
  for (const listener of [...armedListeners]) listener();
}

export function armLaneBranchDriftWarning(laneId: string | null | undefined): void {
  const id = (laneId ?? "").trim();
  if (!id || armedLaneIds.has(id)) return;
  armedLaneIds.add(id);
  emitArmedChange();
}

export function disarmLaneBranchDriftWarning(laneId: string | null | undefined): void {
  const id = (laneId ?? "").trim();
  if (!id || !armedLaneIds.has(id)) return;
  armedLaneIds.delete(id);
  emitArmedChange();
}

function subscribeArmed(listener: () => void): () => void {
  armedListeners.add(listener);
  return () => { armedListeners.delete(listener); };
}

/**
 * The host refuses a switch-back while the lane still has running sessions. Match
 * on that refusal so the strip can offer a confirm instead of stranding the user.
 */
function isActiveWorkRefusal(message: string): boolean {
  return /active sessions/i.test(message) && /confirm/i.test(message);
}

function useLaneBranchDriftArmed(laneId: string | null | undefined): boolean {
  const getSnapshot = useCallback(
    () => Boolean(laneId && armedLaneIds.has(laneId)),
    [laneId],
  );
  return useSyncExternalStore(subscribeArmed, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Branches ADE adopted on its own
// ---------------------------------------------------------------------------

/** How long the `Now on X · Switch back` chip stays after ADE adopts a branch. */
const ADOPTION_NOTICE_MS = 10 * 60_000;

type BranchAdoption = { previousBranchRef: string; branchRef: string; at: number };

const recentAdoptions = new Map<string, BranchAdoption>();
const adoptionListeners = new Set<() => void>();
let adoptionFeedDispose: (() => void) | null = null;

function emitAdoptionChange(): void {
  for (const listener of [...adoptionListeners]) listener();
}

/**
 * One app-wide subscription, started by the first strip that mounts, so an
 * adoption that lands while another chat is open is still shown on return.
 */
function ensureAdoptionFeed(): void {
  if (adoptionFeedDispose || typeof window === "undefined" || !window.ade?.lanes?.onLifecycleEvent) return;
  adoptionFeedDispose = window.ade.lanes.onLifecycleEvent((event: LaneLifecycleEvent) => {
    if (event.type !== "lane-branch-updated" || !event.previousBranchRef || !event.branchRef) return;
    if (event.adoptedByAgent) {
      recentAdoptions.set(event.laneId, {
        previousBranchRef: event.previousBranchRef,
        branchRef: event.branchRef,
        at: Date.now(),
      });
    } else {
      recentAdoptions.delete(event.laneId);
    }
    emitAdoptionChange();
  });
}

function dismissAdoption(laneId: string): void {
  if (recentAdoptions.delete(laneId)) emitAdoptionChange();
}

function subscribeAdoptions(listener: () => void): () => void {
  ensureAdoptionFeed();
  adoptionListeners.add(listener);
  return () => { adoptionListeners.delete(listener); };
}

function useRecentBranchAdoption(laneId: string | null | undefined, branchRef: string | null): BranchAdoption | null {
  const getSnapshot = useCallback(() => (laneId ? recentAdoptions.get(laneId) ?? null : null), [laneId]);
  const adoption = useSyncExternalStore(subscribeAdoptions, getSnapshot, getSnapshot);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!adoption) return undefined;
    const remaining = adoption.at + ADOPTION_NOTICE_MS - Date.now();
    if (remaining <= 0) return undefined;
    const id = window.setTimeout(() => setTick((tick) => tick + 1), remaining);
    return () => window.clearTimeout(id);
  }, [adoption]);
  if (!adoption || Date.now() - adoption.at > ADOPTION_NOTICE_MS) return null;
  // A later switch (back, or to a third branch) ends the notice.
  if (branchRef && branchRef !== adoption.branchRef) return null;
  return adoption;
}

/**
 * `⎇ Now on X · Switch back ×` after ADE moved the lane to the branch its agent
 * switched to. The lane's name stays; its PRs stay linked to the chat.
 */
function LaneBranchAdoptedChip({ laneId, adoption }: { laneId: string; adoption: BranchAdoption }) {
  const refreshLanes = useAppStore((state) => state.refreshLanes);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forceable, setForceable] = useState(false);
  const switchBack = async (acknowledgeActiveWork: boolean) => {
    setPending(true);
    setError(null);
    setForceable(false);
    try {
      await window.ade.lanes.switchBranch({
        laneId,
        branchName: adoption.previousBranchRef,
        mode: "existing",
        ...(acknowledgeActiveWork ? { acknowledgeActiveWork: true } : {}),
      });
      dismissAdoption(laneId);
      await refreshLanes({ includeStatus: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      if (isActiveWorkRefusal(message)) setForceable(true);
    } finally {
      setPending(false);
    }
  };
  const detail = `The agent switched this lane to ${adoption.branchRef}, so ADE moved the lane with it. The lane keeps its name, and the chat keeps the PR from ${adoption.previousBranchRef}.`;
  return (
    <div
      data-testid="lane-branch-adopted-chip"
      role="status"
      aria-label={detail}
      title={error ?? detail}
      className={COMPOSER_STATUS_CHIP_CLASS}
    >
      <GitBranch size={11} weight="bold" className="shrink-0 text-sky-300/80" aria-hidden />
      <span className="shrink-0 text-fg/55">Now on</span>
      <span className="min-w-0 truncate font-mono text-fg/80">{adoption.branchRef}</span>
      {error ? <Warning size={11} weight="fill" className="shrink-0 text-red-400/85" aria-hidden /> : null}
      <button
        type="button"
        className={COMPOSER_STATUS_CHIP_ACTION_CLASS}
        disabled={pending}
        title={`Check out ${adoption.previousBranchRef} again`}
        onClick={() => { void switchBack(forceable); }}
      >
        {pending ? "Switching…" : forceable ? "Switch anyway" : "Switch back"}
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-fg/40 transition-colors hover:bg-white/[0.08] hover:text-fg/80"
        onClick={() => dismissAdoption(laneId)}
      >
        <X size={9} weight="bold" aria-hidden />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header chip
// ---------------------------------------------------------------------------

/**
 * Compact always-on marker in the work surface header. Matches the header's
 * other pills (10px sans, 6px radius, hairline border) but tinted amber so it
 * reads as a warning without shouting.
 */
export function LaneBranchDriftChip({
  laneId,
  className,
}: {
  laneId: string | null | undefined;
  className?: string;
}) {
  const drift = useLaneBranchDrift(laneId);
  if (!drift) return null;
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-amber-200/20 bg-amber-300/[0.07] px-1.5 font-sans text-[10px] font-medium text-amber-100/80",
        className,
      )}
      title={`HEAD is ${drift.headBranchRef}, not ${drift.expectedBranchRef}`}
      data-testid="lane-branch-drift-chip"
    >
      <Warning size={10} weight="fill" className="text-amber-300/80" aria-hidden />
      drifted
    </span>
  );
}

// ---------------------------------------------------------------------------
// Composer warning strip
// ---------------------------------------------------------------------------

export function LaneBranchDriftStrip({
  laneId,
}: {
  laneId: string | null | undefined;
}) {
  const storeDrift = useLaneBranchDrift(laneId);
  const armed = useLaneBranchDriftArmed(laneId);
  // The lane list's status can be minutes old. Once something is about to act
  // on the branch, read HEAD now so a fresh switch is caught before it acts.
  const [freshDrift, setFreshDrift] = useState<{ laneId: string; drift: LaneBranchDrift | null } | null>(null);
  useEffect(() => {
    const readDrift = window.ade?.lanes?.getBranchDrift;
    if (!laneId || !armed || typeof readDrift !== "function") return undefined;
    let cancelled = false;
    void Promise.resolve(readDrift({ laneId }))
      .then((drift) => { if (!cancelled) setFreshDrift({ laneId, drift }); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [armed, laneId, storeDrift?.headBranchRef]);
  const drift = freshDrift && freshDrift.laneId === laneId ? freshDrift.drift : storeDrift;
  const laneBranchRef = useAppStore((state) =>
    laneId ? state.lanes.find((lane) => lane.id === laneId)?.branchRef ?? null : null);
  const adoption = useRecentBranchAdoption(laneId, laneBranchRef);
  const refreshLanes = useAppStore((state) => state.refreshLanes);
  const [pending, setPending] = useState<LaneBranchDriftResolution | null>(null);
  const [forceable, setForceable] = useState<LaneBranchDriftResolution | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visible = Boolean(laneId && drift && armed);

  useEffect(() => {
    if (!drift) {
      setError(null);
      setForceable(null);
      disarmLaneBranchDriftWarning(laneId);
    }
  }, [drift, laneId]);

  const resolve = useCallback(async (
    resolution: LaneBranchDriftResolution,
    acknowledgeActiveWork = false,
  ) => {
    if (!laneId || !drift) return;
    setPending(resolution);
    setError(null);
    setForceable(null);
    try {
      await window.ade.lanes.resolveBranchDrift({
        laneId,
        resolution,
        expectedHeadBranchRef: drift.headBranchRef,
        ...(acknowledgeActiveWork ? { acknowledgeActiveWork: true } : {}),
      });
      disarmLaneBranchDriftWarning(laneId);
      setFreshDrift(null);
      await refreshLanes({ includeStatus: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      // Switching back refuses while the lane still has running sessions, which is
      // the right default — but without a way through it is a dead end. Offer an
      // explicit confirm that retries with the acknowledgement, the same shape the
      // lane list uses for its own branch switch.
      if (isActiveWorkRefusal(message)) setForceable(resolution);
    } finally {
      setPending(null);
    }
  }, [drift, laneId, refreshLanes]);

  const message = useMemo(() => {
    if (!drift) return "";
    return `This lane's worktree is on ${drift.headBranchRef}, not ${drift.expectedBranchRef}. Lane diffs and PR actions still use ${drift.expectedBranchRef}.`;
  }, [drift]);

  if (!visible || !drift) {
    return adoption && laneId ? <LaneBranchAdoptedChip laneId={laneId} adoption={adoption} /> : null;
  }

  const busy = pending != null;
  return (
    <div
      data-testid="lane-branch-drift-strip"
      role="status"
      aria-label={message}
      title={error ?? message}
      className={cn(COMPOSER_STATUS_CHIP_CLASS, "border-amber-200/20 bg-amber-300/[0.06]")}
    >
      <GitBranch size={11} weight="bold" className="shrink-0 text-amber-300/80" aria-hidden />
      <span className="shrink-0 text-amber-100/75">On</span>
      <span className="min-w-0 truncate font-mono text-amber-50/85">{drift.headBranchRef}</span>
      {error ? <Warning size={11} weight="fill" className="shrink-0 text-red-400/85" aria-hidden /> : null}
      {forceable ? (
        <button
          type="button"
          className={COMPOSER_STATUS_CHIP_ACTION_CLASS}
          disabled={busy}
          onClick={() => { void resolve(forceable, true); }}
        >
          Switch anyway
        </button>
      ) : null}
      <button
        type="button"
        className={COMPOSER_STATUS_CHIP_ACTION_CLASS}
        disabled={busy}
        title={`Check out ${drift.expectedBranchRef} again`}
        onClick={() => { void resolve("switch-back"); }}
      >
        {pending === "switch-back" ? "Switching…" : "Switch back"}
      </button>
      <button
        type="button"
        className={COMPOSER_STATUS_CHIP_ACTION_CLASS}
        disabled={busy}
        title={`Make ${drift.headBranchRef} this lane's branch`}
        onClick={() => { void resolve("keep-head"); }}
      >
        {pending === "keep-head" ? "Keeping…" : "Keep"}
      </button>
    </div>
  );
}
