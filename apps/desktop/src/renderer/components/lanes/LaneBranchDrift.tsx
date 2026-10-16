import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { GitBranch, Warning } from "@phosphor-icons/react";

import type {
  LaneBranchDrift,
  LaneBranchDriftKind,
  LaneBranchDriftResolution,
  LaneLifecycleEvent,
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";
import { cn } from "../ui/cn";
import { StatusChip, type StatusChipAction } from "../ui/notice";

function toastSwitchFailure(laneId: string, message: string, action: "switch" | "keep" = "switch"): void {
  showToast({
    id: `lane-branch-switch:${laneId}`,
    tone: "error",
    title: action === "keep" ? "Could not update the lane's branch" : "Could not switch the branch",
    message,
  });
}

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
// Composer chip arming
// ---------------------------------------------------------------------------

/**
 * The compact header chip is always visible while a lane is drifted; the full
 * composer chip is deliberately quieter and only appears once something is
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
 * on that refusal so the chip can offer a confirm instead of stranding the user.
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
let adoptionFeedStarted = false;

function emitAdoptionChange(): void {
  for (const listener of [...adoptionListeners]) listener();
}

/**
 * One app-wide subscription, started by the first chip that mounts, so an
 * adoption that lands while another chat is open is still shown on return.
 */
function ensureAdoptionFeed(): void {
  if (adoptionFeedStarted || typeof window === "undefined" || !window.ade?.lanes?.onLifecycleEvent) return;
  adoptionFeedStarted = true;
  window.ade.lanes.onLifecycleEvent((event: LaneLifecycleEvent) => {
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
  const [forceable, setForceable] = useState(false);
  const switchBack = async (acknowledgeActiveWork: boolean) => {
    setPending(true);
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
      if (isActiveWorkRefusal(message)) setForceable(true);
      else toastSwitchFailure(laneId, message);
    } finally {
      setPending(false);
    }
  };
  return (
    <StatusChip
      testId="lane-branch-adopted-chip"
      tone="info"
      icon={<GitBranch size={11} weight="bold" />}
      label="Now on"
      detail={adoption.branchRef}
      detailMono
      tooltip={`The agent switched this lane to ${adoption.branchRef}, so ADE moved the lane with it. The lane keeps its name, and the chat keeps the PR from ${adoption.previousBranchRef}.`}
      actions={[{
        label: pending ? "Switching…" : forceable ? "Switch anyway" : "Switch back",
        title: forceable
          ? "A chat is still running in this lane; switch anyway"
          : `Check out ${adoption.previousBranchRef} again`,
        disabled: pending,
        onClick: () => { void switchBack(forceable); },
      }]}
      onDismiss={() => dismissAdoption(laneId)}
    />
  );
}

// ---------------------------------------------------------------------------
// Header chip
// ---------------------------------------------------------------------------

/**
 * Compact always-on marker in the work surface header. Matches the header's
 * other pills (10px sans, 6px radius, hairline border) but tinted amber so it
 * reads as a warning without shouting. The wording says which kind of drift it
 * is — "renamed" and "branch missing" are not fixable by switching back.
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
  const kind: LaneBranchDriftKind = drift.kind ?? "switched";
  const label = kind === "renamed" ? "renamed" : kind === "missing" ? "branch missing" : "drifted";
  const title =
    kind === "renamed"
      ? `${drift.expectedBranchRef} was renamed to ${drift.headBranchRef}`
      : kind === "missing"
        ? `${drift.expectedBranchRef} no longer exists; the worktree is on ${drift.headBranchRef}`
        : `HEAD is ${drift.headBranchRef}, not ${drift.expectedBranchRef}`;
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-amber-200/20 bg-amber-300/[0.07] px-1.5 font-sans text-[10px] font-medium text-amber-100/80",
        className,
      )}
      title={title}
      data-testid="lane-branch-drift-chip"
    >
      <Warning size={10} weight="fill" className="text-amber-300/80" aria-hidden />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Composer chip
// ---------------------------------------------------------------------------

/**
 * This lane's branch status in the composer status strip: `⎇ On X · Switch
 * back · Keep` once something is about to act on a branch the lane does not
 * record, `⎇ Branch renamed to X · Update lane` when the recorded branch was
 * renamed to the one the worktree is on — switching back is impossible there,
 * and `⎇ X no longer exists · Update lane` when it was deleted. `⎇ Now on X ·
 * Switch back` shows for a while after ADE adopted a branch its agent switched
 * to.
 */
export function LaneBranchComposerChip({
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
  // `switched` is the shape every reader saw before kinds existed, so it stays
  // the fallback: the recorded branch exists and switching back is a real way
  // out.
  const driftKind: LaneBranchDriftKind = drift?.kind ?? "switched";
  const laneBranchRef = useAppStore((state) =>
    laneId ? state.lanes.find((lane) => lane.id === laneId)?.branchRef ?? null : null);
  const adoption = useRecentBranchAdoption(laneId, laneBranchRef);
  const refreshLanes = useAppStore((state) => state.refreshLanes);
  const [pending, setPending] = useState<LaneBranchDriftResolution | null>(null);
  const [forceable, setForceable] = useState<LaneBranchDriftResolution | null>(null);

  const visible = Boolean(laneId && drift && armed);

  useEffect(() => {
    if (!drift) {
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
      // Switching back refuses while the lane still has running sessions, which is
      // the right default — but without a way through it is a dead end. Offer an
      // explicit confirm that retries with the acknowledgement, the same shape the
      // lane list uses for its own branch switch.
      if (isActiveWorkRefusal(message)) setForceable(resolution);
      else toastSwitchFailure(laneId, message, resolution === "keep-head" ? "keep" : "switch");
    } finally {
      setPending(null);
    }
  }, [drift, laneId, refreshLanes]);

  const message = useMemo(() => {
    if (!drift) return "";
    if (driftKind === "renamed") {
      return `${drift.expectedBranchRef} was renamed to ${drift.headBranchRef}. This lane still records the old name, so lane diffs and PR actions use it. Update lane points the lane at ${drift.headBranchRef} — the worktree is already on it.`;
    }
    if (driftKind === "missing") {
      return `${drift.expectedBranchRef} no longer exists, so this lane cannot be switched back to it. The worktree is on ${drift.headBranchRef}; Update lane makes that this lane's branch.`;
    }
    return `This lane's worktree is on ${drift.headBranchRef}, not ${drift.expectedBranchRef}. Lane diffs and PR actions still use ${drift.expectedBranchRef}.`;
  }, [drift, driftKind]);

  if (!visible || !drift) {
    return adoption && laneId ? <LaneBranchAdoptedChip laneId={laneId} adoption={adoption} /> : null;
  }

  const busy = pending != null;
  const actions: StatusChipAction[] = [];
  if (driftKind === "switched") {
    if (forceable) {
      actions.push({
        label: "Switch anyway",
        title: "A chat is still running in this lane; switch anyway",
        disabled: busy,
        onClick: () => { void resolve(forceable, true); },
      });
    }
    actions.push(
      {
        label: pending === "switch-back" ? "Switching…" : "Switch back",
        title: `Check out ${drift.expectedBranchRef} again`,
        disabled: busy,
        onClick: () => { void resolve("switch-back"); },
      },
      {
        label: pending === "keep-head" ? "Keeping…" : "Keep",
        title: `Make ${drift.headBranchRef} this lane's branch`,
        disabled: busy,
        onClick: () => { void resolve("keep-head"); },
      },
    );
  } else {
    // One way forward: the recorded branch is gone, so the lane has to move to
    // the branch the worktree is on. No checkout happens — it is already there.
    actions.push({
      label: pending === "keep-head" ? "Updating…" : "Update lane",
      title: `Make ${drift.headBranchRef} this lane's branch`,
      disabled: busy,
      onClick: () => { void resolve("keep-head"); },
    });
  }
  return (
    <StatusChip
      testId="lane-branch-drift-strip"
      dataAttributes={{ "data-lane-branch-drift-kind": driftKind }}
      tone={driftKind === "renamed" ? "info" : "warning"}
      icon={<GitBranch size={11} weight="bold" />}
      label={
        driftKind === "renamed"
          ? "Branch renamed to"
          : driftKind === "missing"
            ? `${drift.expectedBranchRef} no longer exists`
            : "On"
      }
      detail={drift.headBranchRef}
      detailMono
      tooltip={message}
      actions={actions}
    />
  );
}
