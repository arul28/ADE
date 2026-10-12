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
import type { OpenProjectBinding, UsageSnapshot } from "../../../shared/types";
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

/** How often a pinned reader re-reads the machine's cached snapshot while visible. */
const PINNED_SNAPSHOT_REREAD_MS = 60_000;

export function useUsageSnapshot({
  readSnapshot = true,
  noteDemand = false,
  pin = null,
}: {
  /** Perform the initial cached read. False keeps a closed surface silent. */
  readSnapshot?: boolean;
  /**
   * Also tell the adaptive scheduler this surface is on screen. Demand only
   * schedules a *non-interactive* provider refresh — it never forces auth — so
   * it is safe to raise whenever the surface is genuinely visible.
   */
  noteDemand?: boolean;
  /**
   * Read ONE machine's snapshot instead of the tab's binding: a Settings page
   * for that machine shows its accounts, so its numbers must come from the
   * same machine. Pushes follow the tab's binding, so a pinned reader ignores
   * them and re-reads the machine's cached snapshot instead.
   */
  pin?: OpenProjectBinding | null;
} = {}): UsageSnapshotSource {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [bindingRevision, setBindingRevision] = useState(0);
  const snapshotRef = useRef<UsageSnapshot | null>(null);
  const bindingGenerationRef = useRef(0);
  const pinRef = useRef(pin);

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
    // Reads in flight for the previous machine or binding are discarded.
    const dropSnapshot = () => {
      bindingGenerationRef.current += 1;
      snapshotRef.current = null;
      setSnapshot(null);
    };
    if (pinRef.current !== pin) {
      // Another machine's numbers must not stay up under this one's accounts.
      pinRef.current = pin;
      dropSnapshot();
    }
    const unsubscribe = pin ? undefined : bridge.onUpdate?.((next) => {
      if (!cancelled) applySnapshot(next);
    });

    /**
     * Read the host's cached snapshot. Not a provider poll — the host answers
     * from the machine-scoped tracker it already has — so it is cheap enough to
     * repeat on a wake.
     */
    const readCached = async () => {
      const requestedGeneration = bindingGenerationRef.current;
      let current: UsageSnapshot | null = null;
      try {
        current = await bridge.getSnapshot(pin);
      } catch {
        // Keep whatever is already on screen: a read that threw is not news
        // that the numbers went away.
        current = null;
      }
      if (cancelled || requestedGeneration !== bindingGenerationRef.current) return;
      if (current) applySnapshot(current);
    };

    const load = async () => {
      const requestedGeneration = bindingGenerationRef.current;
      await readCached();
      if (cancelled || requestedGeneration !== bindingGenerationRef.current) return;
      // Demand answers with the tab's machine, not the pinned one.
      if (!noteDemand || pin) return;
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

    const unsubscribeBinding = pin ? undefined : window.ade?.app?.onProjectBindingChanged?.(() => {
      dropSnapshot();
      setBindingRevision((revision) => revision + 1);
      if (readSnapshot) void load();
    });

    /**
     * Catch up when the window wakes.
     *
     * A background window is throttled and its runtime event subscription can
     * be swept, so the pushes that keep this in step can simply stop arriving —
     * and nothing else re-reads. That is the second half of "two windows, one
     * machine, different numbers": whichever window was in the background is
     * the one showing the older figure. Waking re-reads the host's cached
     * snapshot; the ordering guard drops it if it is not newer.
     *
     * A read, never a poll — no interval is added here. Coalesced on the read
     * itself, because a single wake fires `visibilitychange` and `focus`
     * together.
     */
    let wakeReadPending = false;
    const readOnWake = () => {
      if (!readSnapshot || cancelled || wakeReadPending) return;
      wakeReadPending = true;
      void readCached().finally(() => {
        wakeReadPending = false;
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") readOnWake();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", readOnWake);
    // A cached read, never a provider poll, and only while the page is shown.
    const pinnedReread = pin
      ? window.setInterval(() => {
        if (document.visibilityState === "visible") readOnWake();
      }, PINNED_SNAPSHOT_REREAD_MS)
      : null;

    return () => {
      cancelled = true;
      if (pinnedReread !== null) window.clearInterval(pinnedReread);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", readOnWake);
      unsubscribe?.();
      unsubscribeBinding?.();
    };
  }, [applySnapshot, noteDemand, pin, readSnapshot]);

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
      const next = await bridgeRefresh(pin);
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
  }, [applySnapshot, pin]);

  return { snapshot, bridgeMissing, refreshing, bindingRevision, refreshNow };
}
