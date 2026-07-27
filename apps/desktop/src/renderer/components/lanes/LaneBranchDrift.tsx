import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Warning } from "@phosphor-icons/react";

import type { LaneBranchDrift, LaneBranchDriftResolution } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";

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
  className,
}: {
  laneId: string | null | undefined;
  className?: string;
}) {
  const drift = useLaneBranchDrift(laneId);
  const armed = useLaneBranchDriftArmed(laneId);
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
    return `HEAD is ${drift.headBranchRef}. A PR from this lane would target the wrong branch.`;
  }, [drift]);

  if (!visible || !drift) return null;

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-t border-amber-200/[0.08] bg-amber-300/[0.055] px-3 py-1.5 font-sans text-[11px] text-amber-100/75",
        className,
      )}
      role="status"
      data-testid="lane-branch-drift-strip"
    >
      <Warning size={12} weight="fill" className="shrink-0 text-amber-300/80" aria-hidden />
      <span className="min-w-0 flex-1 truncate" title={message}>
        {error ? error : message}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {forceable ? (
          <button
            type="button"
            disabled={pending != null}
            className="rounded px-1.5 py-0.5 font-medium text-amber-100/90 underline-offset-2 hover:bg-amber-200/10 hover:underline disabled:opacity-40"
            onClick={() => { void resolve(forceable, true); }}
          >
            Switch anyway
          </button>
        ) : null}
        <button
          type="button"
          disabled={pending != null}
          className="rounded px-1.5 py-0.5 text-amber-200/70 underline-offset-2 hover:bg-amber-200/10 hover:text-amber-100 hover:underline disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:no-underline"
          onClick={() => { void resolve("switch-back"); }}
        >
          Switch back
        </button>
        <button
          type="button"
          disabled={pending != null}
          className="rounded px-1.5 py-0.5 text-amber-200/70 underline-offset-2 hover:bg-amber-200/10 hover:text-amber-100 hover:underline disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:no-underline"
          onClick={() => { void resolve("keep-head"); }}
        >
          Keep {drift.headBranchRef}
        </button>
      </span>
    </div>
  );
}
