import { IPC } from "../shared/ipc";
import type { OpenProjectBinding } from "../shared/types/core";
import type { PtyDataEvent, PtyExitEvent } from "../shared/types/sessions";
import type {
  RemoteRuntimeBufferedEvent,
  RemoteRuntimeEventCategory,
  RemoteRuntimeStreamEventsRequest,
  RemoteRuntimeStreamEventsResult,
  RuntimeEventsReleaseRequest,
  RuntimeEventsReleaseResult,
} from "../shared/types/remoteRuntime";

type IpcRendererLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};

export const REMOTE_RUNTIME_EVENT_ACTIVE_POLL_MS = 750;
export const REMOTE_RUNTIME_EVENT_IDLE_POLL_MS = 5_000;
export const REMOTE_RUNTIME_EVENT_CATCH_UP_POLL_MS = 50;
const PINNED_RUNTIME_EVENT_FAILURE_BASE_POLL_MS = 2_000;
const PINNED_RUNTIME_EVENT_FAILURE_MAX_POLL_MS = 30_000;

export function normalizePinnedRuntimeEventEpoch(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pinnedRuntimeBatchDelayMs(
  batch: RemoteRuntimeStreamEventsResult,
): number {
  if (batch.hasMore) return REMOTE_RUNTIME_EVENT_CATCH_UP_POLL_MS;
  return batch.events?.length
    ? REMOTE_RUNTIME_EVENT_ACTIVE_POLL_MS
    : REMOTE_RUNTIME_EVENT_IDLE_POLL_MS;
}

function pinnedRuntimeFailureDelayMs(consecutiveFailures: number): number {
  return Math.min(
    PINNED_RUNTIME_EVENT_FAILURE_BASE_POLL_MS * 2 ** (consecutiveFailures - 1),
    PINNED_RUNTIME_EVENT_FAILURE_MAX_POLL_MS,
  );
}

// A pinned pump that starts mid-stream must not replay history the view has
// already rendered locally; drop anything stamped before the pump existed.
export function isPinnedRuntimeEventStale(
  startedAtMs: number,
  timestamp: string,
): boolean {
  if (startedAtMs <= 0) return false;
  const eventTime = Date.parse(timestamp);
  return Number.isFinite(eventTime) && eventTime < startedAtMs - 1_000;
}

// Returns false when the id was already delivered. The ring is capped so a
// long-lived pump cannot grow the set without bound.
export function rememberPinnedRuntimeEventId(
  seenEventIds: Set<number>,
  id: number,
): boolean {
  if (seenEventIds.has(id)) return false;
  seenEventIds.add(id);
  while (seenEventIds.size > 1_000) {
    const oldest = seenEventIds.values().next().value;
    if (typeof oldest !== "number") break;
    seenEventIds.delete(oldest);
  }
  return true;
}

type PinnedPtyEventState = {
  pin: OpenProjectBinding;
  dataCallbacks: Set<(payload: PtyDataEvent) => void>;
  exitCallbacks: Set<(payload: PtyExitEvent) => void>;
  dataSubscriptionsConfigured: boolean;
  subscribedPtyDataIds: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  cursor: number;
  eventEpoch: string | null;
  replaySuppressed: boolean;
  startedAtMs: number;
  consecutiveFailures: number;
  seenEventIds: Set<number>;
  // Bumped every time an epoch change rewinds the cursor. A poll that was in
  // flight across the rewind must discard its result instead of restoring the
  // pre-rewind cursor, which would silently cancel the replay-from-zero.
  epochGeneration: number;
  cancelled: boolean;
};

type PinnedRuntimeEventPumpOptions = {
  pin: OpenProjectBinding;
  /** Used only in the polling-failure warning. */
  label: string;
  /** Initial value, and the value restored when an epoch change rewinds. */
  suppressReplay: boolean;
  dispatch: (event: RemoteRuntimeBufferedEvent) => void;
};

type PinnedRuntimeEventsDeps = {
  ipcRenderer: IpcRendererLike;
  /** Unwraps a `{ type, event }` runtime payload; shared with the active pump. */
  toWrappedEvent: <T>(payload: unknown, type: string) => T | null;
  /**
   * Pushes the union of the active binding's PTY id filter and every pinned
   * pump's filter to main. Preload owns the active half, so it owns the call.
   */
  syncPtyDataSubscriptions: () => Promise<void>;
  /** True once the active path opted into main-side PTY id filtering. */
  isPtyDataFilteringConfigured: () => boolean;
};

/**
 * The pinned runtime event subsystem: every event pump that reads a binding the
 * window is *not* bound to. Three pumps live here — the shared per-binding PTY
 * pump, the per-listener generic pump, and the helpers both share with the
 * active-binding pump that stays in preload.ts.
 */
export function createPinnedRuntimeEvents(deps: PinnedRuntimeEventsDeps) {
  const { ipcRenderer, toWrappedEvent } = deps;

  // The active-binding event pump intentionally has one mutable cursor. Foreign
  // PTYs cannot share it: switching the window binding would reset their cursor,
  // while polling two machines through it would cross-contaminate epoch/dedup
  // state. Each explicit binding therefore owns one lazy, shared PTY pump.
  const pinnedPtyEventStates = new Map<string, PinnedPtyEventState>();

  // Main keys one subscription per (sender, binding, category), so several pumps
  // on the same binding and category share one. Release it only when the last of
  // them goes away, otherwise one teardown would silence its siblings.
  const pinnedSubscriptionRefs = new Map<string, number>();

  const subscriptionRefKey = (
    pin: OpenProjectBinding,
    category?: RemoteRuntimeEventCategory,
  ): string => `${pin.key}:${category ?? "*"}`;

  // Main derives the same request key from this descriptor that it derived when
  // the pump subscribed, so the renderer never has to guess the key itself.
  const sendRuntimeEventRelease = (
    pin: OpenProjectBinding,
    category?: RemoteRuntimeEventCategory,
  ): void => {
    const request: RuntimeEventsReleaseRequest = pin.kind === "remote"
      ? { id: pin.targetId, projectId: pin.projectId, ...(category ? { category } : {}) }
      : { rootPath: pin.rootPath, ...(category ? { category } : {}) };
    const release = ipcRenderer.invoke(
      IPC.runtimeEventsRelease,
      request,
    ) as Promise<RuntimeEventsReleaseResult>;
    void release.catch(() => {
      // Idle expiry is the backstop when the release cannot be delivered.
    });
  };

  const retainRuntimeEventSubscription = (
    pin: OpenProjectBinding,
    category?: RemoteRuntimeEventCategory,
  ): void => {
    const key = subscriptionRefKey(pin, category);
    pinnedSubscriptionRefs.set(key, (pinnedSubscriptionRefs.get(key) ?? 0) + 1);
  };

  const releaseRuntimeEventSubscription = (
    pin: OpenProjectBinding,
    category?: RemoteRuntimeEventCategory,
  ): void => {
    const key = subscriptionRefKey(pin, category);
    const remaining = (pinnedSubscriptionRefs.get(key) ?? 0) - 1;
    if (remaining > 0) {
      pinnedSubscriptionRefs.set(key, remaining);
      return;
    }
    pinnedSubscriptionRefs.delete(key);
    sendRuntimeEventRelease(pin, category);
  };

  // The active pump never retains a subscription, so it must not release one a
  // pinned pump on the same binding is still reading.
  const releaseRuntimeEventSubscriptionIfUnpinned = (
    binding: OpenProjectBinding,
    category?: RemoteRuntimeEventCategory,
  ): void => {
    if (pinnedSubscriptionRefs.has(subscriptionRefKey(binding, category))) return;
    sendRuntimeEventRelease(binding, category);
  };

  // Every pinned pump reaches its runtime the same way: the channel and argument
  // shape follow from the binding kind alone, never from what is being polled.
  const invokePinnedRuntimeStreamEvents = (
    pin: OpenProjectBinding,
    request: RemoteRuntimeStreamEventsRequest,
  ): Promise<RemoteRuntimeStreamEventsResult> =>
    ipcRenderer.invoke(
      pin.kind === "remote"
        ? IPC.remoteRuntimeStreamEvents
        : IPC.localRuntimeStreamEvents,
      pin.kind === "remote"
        ? { id: pin.targetId, projectId: pin.projectId, request }
        : { rootPath: pin.rootPath, request },
    ) as Promise<RemoteRuntimeStreamEventsResult>;

  // Cursor/epoch/replay/backoff state machine for the per-listener pinned pumps.
  // The PTY pump deliberately does not use this: it is shared across listeners of
  // one binding, fed by push notifications as well as polling, and therefore
  // carries in-flight and epoch-generation state this loop has no use for.
  const startPinnedRuntimeEventPump = ({
    pin,
    label,
    suppressReplay,
    dispatch,
  }: PinnedRuntimeEventPumpOptions): (() => void) => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cursor = 0;
    let eventEpoch: string | null = null;
    let replaySuppressed = suppressReplay;
    let consecutiveFailures = 0;
    retainRuntimeEventSubscription(pin);

    const poll = async (): Promise<void> => {
      let delay = REMOTE_RUNTIME_EVENT_IDLE_POLL_MS;
      try {
        const request = {
          cursor,
          limit: 200,
          ...(replaySuppressed && cursor === 0 ? { replay: false } : {}),
        } satisfies RemoteRuntimeStreamEventsRequest;
        const batch = await invokePinnedRuntimeStreamEvents(pin, request);
        if (cancelled) return;
        consecutiveFailures = 0;
        const batchEpoch = normalizePinnedRuntimeEventEpoch(batch.eventEpoch);
        const epochChanged = batchEpoch
          ? eventEpoch
            ? batchEpoch !== eventEpoch
            : cursor > 0
          : false;
        if (batchEpoch) eventEpoch = batchEpoch;
        if (epochChanged) {
          // The runtime restarted its buffer. What happens next is driven by
          // the caller's `suppressReplay` option, restored here: `false` (the
          // chat pump on a local pin) replays the new epoch from cursor 0;
          // `true` (remote chat pins, and the generic pump on every pin) sends
          // `{ cursor: 0, replay: false }`, which re-anchors to the live head
          // without replaying the pre-restart transcript.
          cursor = 0;
          replaySuppressed = suppressReplay;
          delay = 0;
        } else {
          cursor = Number.isFinite(batch.nextCursor)
            ? Math.max(0, Math.floor(batch.nextCursor))
            : cursor;
          if (request.replay === false) replaySuppressed = false;
          for (const event of batch.events ?? []) dispatch(event);
          delay = pinnedRuntimeBatchDelayMs(batch);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn(`ADE pinned ${label} event polling failed`, error);
        }
        consecutiveFailures = Math.min(consecutiveFailures + 1, 5);
        delay = pinnedRuntimeFailureDelayMs(consecutiveFailures);
      }
      if (!cancelled) timer = setTimeout(() => void poll(), delay);
    };

    void poll();
    return () => {
      if (cancelled) return;
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      // This uncategorized release can also tear down the active pump's shared
      // main-side subscription after a tab switch. Its next poll re-subscribes
      // from the active cursor, so only push latency (750ms–5s) is lost; buffered
      // events are not.
      releaseRuntimeEventSubscription(pin);
    };
  };

  const hasPinnedPtyEventListeners = (state: PinnedPtyEventState): boolean =>
    state.dataCallbacks.size > 0 || state.exitCallbacks.size > 0;

  const canPollPinnedPtyEvents = (state: PinnedPtyEventState): boolean =>
    hasPinnedPtyEventListeners(state) &&
    (state.dataCallbacks.size === 0 ||
      state.dataSubscriptionsConfigured ||
      !deps.isPtyDataFilteringConfigured());

  const createPinnedPtyEventState = (
    pin: OpenProjectBinding,
  ): PinnedPtyEventState => ({
    pin,
    dataCallbacks: new Set(),
    exitCallbacks: new Set(),
    dataSubscriptionsConfigured: false,
    subscribedPtyDataIds: new Set(),
    timer: null,
    inFlight: false,
    cursor: 0,
    eventEpoch: null,
    replaySuppressed: pin.kind === "remote",
    startedAtMs: pin.kind === "local" ? Date.now() : 0,
    consecutiveFailures: 0,
    seenEventIds: new Set(),
    epochGeneration: 0,
    cancelled: false,
  });

  const getOrCreatePinnedPtyEventState = (
    pin: OpenProjectBinding,
  ): PinnedPtyEventState => {
    const existing = pinnedPtyEventStates.get(pin.key);
    if (existing) return existing;
    const state = createPinnedPtyEventState(pin);
    pinnedPtyEventStates.set(pin.key, state);
    retainRuntimeEventSubscription(pin, "pty");
    return state;
  };

  const collectPinnedPtyDataSubscriptionIds = (): string[] => {
    const ids: string[] = [];
    for (const state of pinnedPtyEventStates.values()) {
      if (!state.dataSubscriptionsConfigured) continue;
      for (const ptyId of state.subscribedPtyDataIds) ids.push(ptyId);
    }
    return ids;
  };

  const setPinnedPtyDataSubscriptions = async (
    pin: OpenProjectBinding,
    ptyIds: Set<string>,
  ): Promise<void> => {
    const state = getOrCreatePinnedPtyEventState(pin);
    // Update before any await so a view that subscribes first cannot lose the
    // first live chunk to the previous filter while the IPC call is in flight.
    state.dataSubscriptionsConfigured = true;
    state.subscribedPtyDataIds = ptyIds;
    await deps.syncPtyDataSubscriptions();
    ensurePinnedPtyEventPump(state);
    releasePinnedPtyEventStateIfUnused(state);
  };

  const resetPinnedPtyEventDedup = (state: PinnedPtyEventState): void => {
    state.seenEventIds.clear();
  };

  const updatePinnedPtyEventEpoch = (
    state: PinnedPtyEventState,
    value: unknown,
  ): boolean => {
    const eventEpoch = normalizePinnedRuntimeEventEpoch(value);
    if (!eventEpoch) return false;
    const epochChanged = state.eventEpoch
      ? eventEpoch !== state.eventEpoch
      : state.cursor > 0 || state.seenEventIds.size > 0;
    state.eventEpoch = eventEpoch;
    if (!epochChanged) return false;
    state.cursor = 0;
    state.epochGeneration += 1;
    state.replaySuppressed = state.pin.kind === "remote";
    resetPinnedPtyEventDedup(state);
    return true;
  };

  const dispatchPinnedPtyRuntimeEvent = (
    state: PinnedPtyEventState,
    event: RemoteRuntimeBufferedEvent,
  ): void => {
    if (state.cancelled) return;
    const ptyDataEvent = toWrappedEvent<PtyDataEvent>(event.payload, "pty_data");
    const ptyExitEvent = toWrappedEvent<PtyExitEvent>(event.payload, "pty_exit");
    if (!ptyDataEvent && !ptyExitEvent) return;
    if (isPinnedRuntimeEventStale(state.startedAtMs, event.timestamp)) return;
    if (!rememberPinnedRuntimeEventId(state.seenEventIds, event.id)) return;
    state.cursor = Math.max(state.cursor, event.id);

    if (
      ptyDataEvent &&
      (!state.dataSubscriptionsConfigured ||
        state.subscribedPtyDataIds.has(ptyDataEvent.ptyId))
    ) {
      for (const cb of [...state.dataCallbacks]) {
        try {
          cb(ptyDataEvent);
        } catch (error) {
          console.error("preload pinned pty data listener failed", error);
        }
      }
    }

    if (ptyExitEvent) {
      for (const cb of [...state.exitCallbacks]) {
        try {
          cb(ptyExitEvent);
        } catch (error) {
          console.error("preload pinned pty exit listener failed", error);
        }
      }
    }
  };

  function ensurePinnedPtyEventPump(state: PinnedPtyEventState): void {
    if (state.cancelled || !canPollPinnedPtyEvents(state)) return;
    if (state.timer || state.inFlight) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void pollPinnedPtyEvents(state);
    }, 0);
  }

  function schedulePinnedPtyEventPoll(
    state: PinnedPtyEventState,
    delayMs: number,
  ): void {
    if (state.cancelled || !canPollPinnedPtyEvents(state)) return;
    if (state.timer || state.inFlight) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void pollPinnedPtyEvents(state);
    }, delayMs);
  }

  // Preempts whatever idle delay is pending. An in-flight poll needs no help: it
  // already re-polls at once when it notices the epoch generation moved.
  const repollPinnedPtyEventsNow = (state: PinnedPtyEventState): void => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    schedulePinnedPtyEventPoll(state, 0);
  };

  async function pollPinnedPtyEvents(state: PinnedPtyEventState): Promise<void> {
    if (
      state.cancelled ||
      state.inFlight ||
      !canPollPinnedPtyEvents(state)
    ) {
      return;
    }
    state.inFlight = true;
    let nextDelayMs: number | null = null;
    const pollEpochGeneration = state.epochGeneration;
    try {
      const request = {
        cursor: state.cursor,
        limit: 200,
        category: "pty",
        ...(state.replaySuppressed && state.cursor === 0
          ? { replay: false }
          : {}),
      } satisfies RemoteRuntimeStreamEventsRequest;
      const pin = state.pin;
      const batch = await invokePinnedRuntimeStreamEvents(pin, request);
      if (state.cancelled || pinnedPtyEventStates.get(pin.key) !== state) return;
      state.consecutiveFailures = 0;
      if (state.epochGeneration !== pollEpochGeneration) {
        // A push notification rewound the cursor while this poll was in flight.
        // The batch (and its epoch stamp) predates the rewind, so applying either
        // would restore the stale cursor and drop the replay. Re-poll from zero.
        nextDelayMs = 0;
        return;
      }
      const resetForEpochChange = updatePinnedPtyEventEpoch(
        state,
        batch.eventEpoch,
      );
      if (resetForEpochChange) {
        nextDelayMs = 0;
      } else {
        state.cursor = Number.isFinite(batch.nextCursor)
          ? Math.max(state.cursor, 0, Math.floor(batch.nextCursor))
          : state.cursor;
        if (request.replay === false) state.replaySuppressed = false;
        if (batch.gap === true) resetPinnedPtyEventDedup(state);
        for (const event of batch.events ?? []) {
          dispatchPinnedPtyRuntimeEvent(state, event);
        }
        nextDelayMs = pinnedRuntimeBatchDelayMs(batch);
      }
    } catch (error) {
      if (!state.cancelled) {
        console.warn("ADE pinned PTY event polling failed", error);
        state.consecutiveFailures = Math.min(state.consecutiveFailures + 1, 5);
        nextDelayMs = pinnedRuntimeFailureDelayMs(state.consecutiveFailures);
      }
    } finally {
      state.inFlight = false;
      if (nextDelayMs != null) {
        schedulePinnedPtyEventPoll(state, nextDelayMs);
      }
    }
  }

  const releasePinnedPtyEventStateIfUnused = (
    state: PinnedPtyEventState,
  ): void => {
    if (state.cancelled || hasPinnedPtyEventListeners(state)) return;
    state.cancelled = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.seenEventIds.clear();
    state.subscribedPtyDataIds.clear();
    pinnedPtyEventStates.delete(state.pin.key);
    // Main keeps streaming this binding until idle expiry otherwise, and the
    // events would only be discarded by a preload that no longer has listeners.
    releaseRuntimeEventSubscription(state.pin, "pty");
    if (state.dataSubscriptionsConfigured) {
      // Main owns one sender-wide PTY filter, so remove this pin's ids from the
      // union as soon as its final listener leaves. Teardown stays synchronous.
      void deps.syncPtyDataSubscriptions().catch((error) => {
        console.warn("ADE pinned PTY subscription cleanup failed", error);
      });
    }
  };

  const subscribePinnedPtyDataEvents = (
    pin: OpenProjectBinding,
    cb: (payload: PtyDataEvent) => void,
  ): (() => void) => {
    const state = getOrCreatePinnedPtyEventState(pin);
    if (!hasPinnedPtyEventListeners(state)) {
      state.startedAtMs = pin.kind === "local" ? Date.now() : 0;
    }
    state.dataCallbacks.add(cb);
    ensurePinnedPtyEventPump(state);
    return () => {
      state.dataCallbacks.delete(cb);
      releasePinnedPtyEventStateIfUnused(state);
    };
  };

  const subscribePinnedPtyExitEvents = (
    pin: OpenProjectBinding,
    cb: (payload: PtyExitEvent) => void,
  ): (() => void) => {
    const state = getOrCreatePinnedPtyEventState(pin);
    if (!hasPinnedPtyEventListeners(state)) {
      state.startedAtMs = pin.kind === "local" ? Date.now() : 0;
    }
    state.exitCallbacks.add(cb);
    ensurePinnedPtyEventPump(state);
    return () => {
      state.exitCallbacks.delete(cb);
      releasePinnedPtyEventStateIfUnused(state);
    };
  };

  /**
   * Push delivery for the shared PTY pump. A pushed event that carries a *new*
   * epoch must not be dispatched: `updatePinnedPtyEventEpoch` rewinds the cursor
   * to 0. Local pins then replay the restarted buffer; remote pins re-issue
   * `{ cursor: 0, replay: false }` so the server re-anchors them to the live head.
   * Dispatching the announcing push would advance the cursor before either path
   * can establish its intended post-restart position.
   */
  const handlePinnedPtyRuntimeEventNotification = (
    bindingKey: string,
    eventEpoch: unknown,
    event: RemoteRuntimeBufferedEvent,
  ): void => {
    const state = pinnedPtyEventStates.get(bindingKey);
    if (!state || !hasPinnedPtyEventListeners(state)) return;
    if (updatePinnedPtyEventEpoch(state, eventEpoch)) {
      repollPinnedPtyEventsNow(state);
      return;
    }
    dispatchPinnedPtyRuntimeEvent(state, event);
  };

  return {
    startPinnedRuntimeEventPump,
    collectPinnedPtyDataSubscriptionIds,
    setPinnedPtyDataSubscriptions,
    subscribePinnedPtyDataEvents,
    subscribePinnedPtyExitEvents,
    handlePinnedPtyRuntimeEventNotification,
    releaseRuntimeEventSubscriptionIfUnpinned,
  };
}
