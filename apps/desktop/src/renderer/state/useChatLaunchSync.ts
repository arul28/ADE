import { useEffect, useRef } from "react";
import type { ChatLaunchEvent, OpenProjectBinding } from "../../shared/types";
import { isChatLaunchTerminal } from "../../shared/chatLaunch";
import { useAppStore } from "./appStore";
import {
  applyChatLaunchEvent,
  chatLaunchBindingKey,
  chatLaunchStore,
  hydrateChatLaunches,
  useChatLaunchSelector,
} from "./chatLaunchStore";

const sameString = (a: string, b: string) => a === b;

/**
 * Coalesces launch events to at most one store write per frame. The brain
 * emits up to ~8 snapshots a second per launch during checkout; with several
 * launches in flight they would otherwise each wake every subscriber
 * separately. Only the newest event per launch is kept (a removal replaces
 * any pending update), and a short timeout backs up `requestAnimationFrame`
 * so a hidden window — where frames stop — still advances its CLI launches.
 */
export function createChatLaunchEventCoalescer(
  apply: (binding: OpenProjectBinding | null, event: ChatLaunchEvent) => void,
  fallbackMs = 50,
): { push: (binding: OpenProjectBinding | null, event: ChatLaunchEvent) => void; flush: () => void; dispose: () => void } {
  const pending = new Map<string, { binding: OpenProjectBinding | null; event: ChatLaunchEvent }>();
  let frame: number | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const cancelScheduled = () => {
    if (frame != null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    if (timeout != null) clearTimeout(timeout);
    frame = null;
    timeout = null;
  };
  const flush = () => {
    cancelScheduled();
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    for (const { binding, event } of batch) apply(binding, event);
  };
  const push = (binding: OpenProjectBinding | null, event: ChatLaunchEvent) => {
    const launchId = event.type === "launch-updated" ? event.launch.launchId : event.launchId;
    const current = pending.get(launchId);
    if (
      current
      && current.event.type === "launch-updated"
      && event.type === "launch-updated"
      && current.event.launch.sequence > event.launch.sequence
    ) {
      return;
    }
    // Re-insert so the batch applies in arrival order of each launch's latest event.
    pending.delete(launchId);
    pending.set(launchId, { binding, event });
    if (frame == null && typeof requestAnimationFrame === "function") frame = requestAnimationFrame(flush);
    if (timeout == null) timeout = setTimeout(flush, fallbackMs);
  };
  return { push, flush, dispose: () => { cancelScheduled(); pending.clear(); } };
}

/**
 * The one live feed for new-lane launches. Mounted once in the app shell so
 * the thread card, the Work sidebar, the Launches slide-out and the CLI driver
 * share a single `chatLaunch.onEvent` subscription per project binding instead
 * of each pane opening its own.
 *
 * Subscribes to the active binding, plus any other binding that still holds a
 * launch in flight (a draft can launch on another machine without rebinding
 * the tab). Each subscription hydrates once with `chatLaunch.list` and then
 * follows events; a window that becomes visible again re-reads the list once
 * to cover anything dropped while hidden. There is no polling.
 *
 * The shell itself re-renders only when the SET of bindings to follow or the
 * set of freshly created lanes changes — never on a stage tick.
 */
export function useChatLaunchSync(): void {
  const projectBinding = useAppStore((s) => s.projectBinding);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const activeKey = chatLaunchBindingKey(projectBinding);

  const extraSignature = useChatLaunchSelector((state) => {
    const keys = new Set<string>();
    for (const entry of Object.values(state.entries)) {
      if (!entry.binding || entry.bindingKey === activeKey) continue;
      if (isChatLaunchTerminal(entry.snapshot.phase)) continue;
      keys.add(entry.bindingKey);
    }
    return [...keys].sort().join("\n");
  }, sameString);

  useEffect(() => {
    const api = window.ade?.chatLaunch;
    if (!api) return undefined;
    const targets: Array<{ binding: OpenProjectBinding | null; pin: OpenProjectBinding | null }> = [];
    if (projectBinding) targets.push({ binding: projectBinding, pin: null });
    const extraKeys = new Set(extraSignature ? extraSignature.split("\n") : []);
    const seen = new Set<string>();
    for (const entry of Object.values(chatLaunchStore.getState().entries)) {
      if (!entry.binding || !extraKeys.has(entry.bindingKey) || seen.has(entry.bindingKey)) continue;
      seen.add(entry.bindingKey);
      targets.push({ binding: entry.binding, pin: entry.binding });
    }
    if (targets.length === 0) return undefined;

    let disposed = false;
    const coalescer = createChatLaunchEventCoalescer((binding, event) => {
      if (!disposed) applyChatLaunchEvent(binding, event);
    });
    const hydrate = (binding: OpenProjectBinding | null, pin: OpenProjectBinding | null) => {
      let request: Promise<unknown>;
      try {
        request = api.list(pin ?? undefined);
      } catch {
        return;
      }
      void Promise.resolve(request).then((snapshots) => {
        if (disposed || !Array.isArray(snapshots)) return;
        // Apply buffered events first so the list lands on the newest state.
        coalescer.flush();
        hydrateChatLaunches(binding, snapshots);
      }).catch(() => {
        // A window with no runtime behind it has no launches to show.
      });
    };
    const unsubscribers = targets.map(({ binding, pin }) => {
      let unsubscribe: () => void = () => {};
      try {
        unsubscribe = api.onEvent((event) => {
          if (!disposed) coalescer.push(binding, event);
        }, pin ?? undefined);
      } catch {
        unsubscribe = () => {};
      }
      hydrate(binding, pin);
      return unsubscribe;
    });
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      for (const { binding, pin } of targets) hydrate(binding, pin);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      // Deliver what already arrived before letting go of the subscription.
      coalescer.flush();
      coalescer.dispose();
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          // ignore
        }
      }
    };
  }, [projectBinding, extraSignature]);

  // The lane a launch creates joins the active project's lane list the moment
  // the host reports it, so its sidebar group and lane chips resolve without
  // waiting for an unrelated refresh.
  const createdLaneSignature = useChatLaunchSelector((state) => (
    Object.values(state.entries)
      .filter((entry) => entry.snapshot.laneCreated && entry.bindingKey === activeKey)
      .map((entry) => entry.launchId)
      .sort()
      .join("\n")
  ), sameString);
  const refreshedLaunchIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ids = createdLaneSignature ? createdLaneSignature.split("\n") : [];
    const refreshed = refreshedLaunchIdsRef.current;
    let shouldRefresh = false;
    for (const id of ids) {
      if (refreshed.has(id)) continue;
      refreshed.add(id);
      shouldRefresh = true;
    }
    const live = new Set(ids);
    for (const id of [...refreshed]) {
      if (!live.has(id)) refreshed.delete(id);
    }
    if (shouldRefresh) void Promise.resolve(refreshLanes()).catch(() => undefined);
  }, [createdLaneSignature, refreshLanes]);
}
