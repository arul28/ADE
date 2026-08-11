/**
 * The one subscription to the host's usage snapshot.
 *
 * The top-bar popover and the quota band inside it each used to own a private
 * copy of this: a `snapshotRef`, a binding-generation guard, an `applySnapshot`
 * ordered by `shouldApplyUsageSnapshot`, the `getSnapshot`/`onUpdate`/
 * `onProjectBindingChanged` triad, and a refresh path — and then the child
 * handed its snapshot back up through an `onSnapshotChange` callback so the
 * parent's own copy was only ever overwritten. Two readers, two guards, one
 * number: the arrangement where a late response can be discarded by one and
 * accepted by the other. Now the popover owns this and passes the snapshot
 * down.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageSnapshot } from "../../../shared/types";
import { shouldApplyUsageSnapshot } from "./usageSnapshotOrdering";

/** What a refresh actually did, so a Retry can report an outcome. */
export type UsageRefreshOutcome = {
  ok: boolean;
  snapshot: UsageSnapshot | null;
  error: string | null;
};

export type UsageSnapshotSource = {
  snapshot: UsageSnapshot | null;
  /** True when this window has no usage bridge at all (browser preview). */
  bridgeMissing: boolean;
  /** A user-initiated refresh is in flight. */
  refreshing: boolean;
  /**
   * Bumped whenever the project binding changes, for reads that must re-run
   * alongside the snapshot but are not part of it (provider connections).
   */
  bindingRevision: number;
  refreshNow: () => Promise<UsageRefreshOutcome>;
};

export function useUsageSnapshot({
  readSnapshot = true,
  noteDemand = false,
}: {
  /** Perform the initial cached read. False keeps a closed surface silent. */
  readSnapshot?: boolean;
  /**
   * Also tell the adaptive scheduler this surface is on screen. Demand only
   * schedules a *non-interactive* provider refresh — it never forces auth — so
   * it is safe to raise whenever the surface is genuinely visible.
   */
  noteDemand?: boolean;
} = {}): UsageSnapshotSource {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [bindingRevision, setBindingRevision] = useState(0);
  const snapshotRef = useRef<UsageSnapshot | null>(null);
  const bindingGenerationRef = useRef(0);

  const applySnapshot = useCallback((next: UsageSnapshot | null) => {
    if (!shouldApplyUsageSnapshot(next, snapshotRef.current)) return;
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  // Render cached numbers instantly, subscribe to live updates, and rebind when
  // the project changes. A failed read changes nothing already shown.
  useEffect(() => {
    if (!window.ade?.usage) {
      setBridgeMissing(true);
      return;
    }
    const bridge = window.ade.usage;
    let cancelled = false;
    const unsubscribe = bridge.onUpdate?.((next) => {
      if (!cancelled) applySnapshot(next);
    });

    const load = async () => {
      const requestedGeneration = bindingGenerationRef.current;
      let current: UsageSnapshot | null = null;
      try {
        current = await bridge.getSnapshot();
      } catch {
        // Keep whatever is already on screen: a read that threw is not news
        // that the numbers went away.
        current = null;
      }
      if (cancelled || requestedGeneration !== bindingGenerationRef.current) return;
      if (current) applySnapshot(current);
      if (!noteDemand) return;
      try {
        const demanded = await bridge.noteDemand?.();
        if (!cancelled && requestedGeneration === bindingGenerationRef.current && demanded) {
          applySnapshot(demanded);
        }
      } catch {
        // Quiet — demand only schedules a non-interactive provider refresh.
      }
    };
    if (readSnapshot) void load();

    const unsubscribeBinding = window.ade?.app?.onProjectBindingChanged?.(() => {
      bindingGenerationRef.current += 1;
      snapshotRef.current = null;
      setSnapshot(null);
      setBindingRevision((revision) => revision + 1);
      if (readSnapshot) void load();
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      unsubscribeBinding?.();
    };
  }, [applySnapshot, noteDemand, readSnapshot]);

  /**
   * Force a provider poll and say what came back.
   *
   * An earlier version swallowed both failure modes: a throw from the bridge
   * and a `null` return (which is what `usage:refresh` yields when the host has
   * no usage service, and what a remote runtime can yield for an unsupported
   * action). Either way the caller saw nothing at all, so a Retry wired to it
   * was indistinguishable from a dead button. The outcome is returned instead
   * of thrown away.
   */
  const refreshNow = useCallback(async (): Promise<UsageRefreshOutcome> => {
    const bridgeRefresh = window.ade?.usage?.refresh;
    if (!bridgeRefresh) {
      return { ok: false, snapshot: null, error: "Usage isn't available in this window." };
    }
    const requestedGeneration = bindingGenerationRef.current;
    setRefreshing(true);
    try {
      const next = await bridgeRefresh();
      if (requestedGeneration !== bindingGenerationRef.current) {
        return { ok: false, snapshot: null, error: null };
      }
      if (!next) {
        return { ok: false, snapshot: null, error: "The host returned no usage data." };
      }
      applySnapshot(next);
      return { ok: true, snapshot: next, error: null };
    } catch (error) {
      // The service preserves last-good data and records the provider state;
      // this branch is the bridge itself failing, which nothing else reports.
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, snapshot: null, error: detail || "The refresh request failed." };
    } finally {
      setRefreshing(false);
    }
  }, [applySnapshot]);

  return { snapshot, bridgeMissing, refreshing, bindingRevision, refreshNow };
}
