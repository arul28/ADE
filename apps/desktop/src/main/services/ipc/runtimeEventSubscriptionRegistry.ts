import type { WebContents } from "electron";

export type RuntimeEventWindowSubscription = {
  sender: WebContents;
  bindingKey: string;
  requestKey: string;
  /** Owned by the registry: attached only via `attachRuntimeEventSubscriptionCleanup`. */
  readonly cleanup: (() => void) | null;
  lastRequestedAtMs: number;
};

type RuntimeEventWindowSubscriptionInput = Omit<
  RuntimeEventWindowSubscription,
  "lastRequestedAtMs"
>;

// A renderer runs several independent event pumps at once (the active binding
// pump, one pinned PTY pump per foreign lane, one pinned chat pump), each with
// its own category/replay shape. They must each hold their own subscription, so
// subscriptions are keyed by (sender, requestKey) rather than by sender alone.
//
// Keying by sender alone used to double as garbage collection: a pump with a
// different requestKey tore the previous one down. Independent subscriptions
// remove that, so a stale (sender, requestKey) is reclaimed by idle expiry.
// Every live pump refreshes its subscription on each poll (750ms..5s normally,
// 30s at the slowest failure backoff).
const RUNTIME_EVENT_SUBSCRIPTION_IDLE_MS = 60_000;
const RUNTIME_EVENT_SUBSCRIPTION_SWEEP_MS = 20_000;

export function createRuntimeEventSubscriptionRegistry() {
  const subscriptions = new Map<
    number,
    Map<string, RuntimeEventWindowSubscription>
  >();
  const watchedSenders = new Set<number>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  function getRuntimeEventSubscription(
    senderId: number,
    requestKey: string,
  ): RuntimeEventWindowSubscription | null {
    return subscriptions.get(senderId)?.get(requestKey) ?? null;
  }

  function disposeRuntimeEventSubscription(
    subscription: RuntimeEventWindowSubscription,
  ): void {
    try {
      subscription.cleanup?.();
    } catch {
      // Best-effort subscription cleanup.
    }
  }

  function stopRuntimeEventSubscriptionSweeper(): void {
    if (!sweepTimer) return;
    clearInterval(sweepTimer);
    sweepTimer = null;
  }

  // The one way a subscription leaves the registry. Every caller — renderer
  // release, ended callback, remote disconnect, sender death, and idle sweep —
  // goes through it so disposal and registry pruning cannot drift apart.
  function removeRuntimeEventSubscription(
    senderId: number,
    requestKey: string,
    expected?: RuntimeEventWindowSubscription,
  ): boolean {
    const bySender = subscriptions.get(senderId);
    const subscription = bySender?.get(requestKey);
    if (!bySender || !subscription) return false;
    if (expected && subscription !== expected) return false;
    bySender.delete(requestKey);
    if (bySender.size === 0) subscriptions.delete(senderId);
    if (subscriptions.size === 0) stopRuntimeEventSubscriptionSweeper();
    disposeRuntimeEventSubscription(subscription);
    return true;
  }

  function cleanupRuntimeEventSubscriptions(
    senderId: number,
    predicate?: (subscription: RuntimeEventWindowSubscription) => boolean,
  ): number {
    const bySender = subscriptions.get(senderId);
    if (!bySender) return 0;
    let released = 0;
    for (const [requestKey, subscription] of [...bySender]) {
      if (predicate && !predicate(subscription)) continue;
      if (removeRuntimeEventSubscription(senderId, requestKey, subscription)) {
        released += 1;
      }
    }
    return released;
  }

  function sweepRuntimeEventSubscriptions(): void {
    const now = Date.now();
    for (const [senderId, bySender] of [...subscriptions]) {
      for (const [requestKey, subscription] of [...bySender]) {
        const expired =
          subscription.sender.isDestroyed() ||
          now - subscription.lastRequestedAtMs >=
            RUNTIME_EVENT_SUBSCRIPTION_IDLE_MS;
        if (expired) {
          removeRuntimeEventSubscription(senderId, requestKey, subscription);
        }
      }
    }
  }

  function startRuntimeEventSubscriptionSweeper(): void {
    if (sweepTimer) return;
    sweepTimer = setInterval(
      sweepRuntimeEventSubscriptions,
      RUNTIME_EVENT_SUBSCRIPTION_SWEEP_MS,
    );
    sweepTimer.unref?.();
  }

  function watchRuntimeEventSender(sender: WebContents): void {
    if (watchedSenders.has(sender.id)) return;
    watchedSenders.add(sender.id);
    sender.once("destroyed", () => {
      watchedSenders.delete(sender.id);
      cleanupRuntimeEventSubscriptions(sender.id);
    });
  }

  function addRuntimeEventSubscription(
    input: RuntimeEventWindowSubscriptionInput,
  ): RuntimeEventWindowSubscription {
    watchRuntimeEventSender(input.sender);
    const subscription: RuntimeEventWindowSubscription = {
      ...input,
      lastRequestedAtMs: Date.now(),
    };
    const bySender = subscriptions.get(input.sender.id) ??
      new Map<string, RuntimeEventWindowSubscription>();
    bySender.set(input.requestKey, subscription);
    subscriptions.set(input.sender.id, bySender);
    startRuntimeEventSubscriptionSweeper();
    return subscription;
  }

  function refreshRuntimeEventSubscription(
    senderId: number,
    requestKey: string,
  ): RuntimeEventWindowSubscription | null {
    const subscription = getRuntimeEventSubscription(senderId, requestKey);
    if (!subscription) return null;
    subscription.lastRequestedAtMs = Date.now();
    return subscription;
  }

  // Cleanup ownership stays inside the registry. The subscribe flow attaches
  // its disposer through this atomic check, so a subscription that was
  // replaced mid-flight or whose sender died never adopts a cleanup the
  // registry would then be unable to run; the caller keeps responsibility for
  // disposing the orphaned cleanup when this returns false.
  function attachRuntimeEventSubscriptionCleanup(
    senderId: number,
    requestKey: string,
    expected: RuntimeEventWindowSubscription,
    cleanup: () => void,
  ): boolean {
    const current = getRuntimeEventSubscription(senderId, requestKey);
    if (current !== expected || expected.sender.isDestroyed()) return false;
    (expected as { cleanup: (() => void) | null }).cleanup = cleanup;
    return true;
  }

  return {
    getRuntimeEventSubscription,
    addRuntimeEventSubscription,
    attachRuntimeEventSubscriptionCleanup,
    refreshRuntimeEventSubscription,
    removeRuntimeEventSubscription,
    cleanupRuntimeEventSubscriptions,
  };
}
