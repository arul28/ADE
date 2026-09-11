/**
 * One-shot "somebody asked for this" channels, shared by every surface that
 * needs one.
 *
 * The pattern: a request is broadcast to whoever is listening AND held, so a
 * consumer that has not mounted yet (the handler navigated to its route, and
 * the route is still rendering) can drain it on mount. A live consumer clears
 * the hold once it has acted, so the next mount does not re-open something
 * nobody asked for.
 *
 * Two shapes had each grown several hand-rolled copies, every one of them
 * re-learning that rule in its own comment:
 *
 * - `createPendingRequestChannel` — broadcast + one held request + a nonce
 *   counter. Backs `workToolRequests`, `filesOpenRequests` and
 *   `linearIssueQuickViewNavigation`.
 * - `createKeyedPendingStore` — no listeners, one held value PER KEY, taken by
 *   the surface that owns that key when it mounts. Backs `pendingReveals`
 *   (keyed by path) and `pendingSessionAnchors` (keyed by session id).
 *
 * The two are not one primitive: the keyed store has no broadcast, no single
 * "current" request to clear, and no nonce — a second reveal for the same path
 * replaces the first rather than racing it.
 *
 * The nonce is what makes asking twice for the same thing two requests rather
 * than one swallowed duplicate. It is minted here so callers cannot invent
 * colliding ones, either up front via `nextNonce` (for callers that build the
 * whole request object before sending it) or by `request` itself.
 */
export type PendingRequestChannel<T> = {
  /**
   * Broadcast and hold. Returns the request that was sent. A nonce is minted
   * unless the payload already carries one from `nextNonce`, in which case the
   * caller's object is broadcast as-is.
   */
  request: (payload: T) => T & { nonce: string };
  /** Mint a nonce without sending, for callers that assemble the request themselves. */
  nextNonce: () => string;
  /** Drain a request made before the consumer mounted; null when there is none. */
  takePending: () => (T & { nonce: string }) | null;
  /** Drop the hold — called by a live consumer that has already acted on it. */
  clearPending: () => void;
  subscribe: (listener: (request: T & { nonce: string }) => void) => () => void;
  /** Test seam: drops queued state so one test cannot leak into the next. */
  resetForTests: () => void;
};

export function createPendingRequestChannel<T>(noncePrefix: string): PendingRequestChannel<T> {
  type Request = T & { nonce: string };
  const listeners = new Set<(request: Request) => void>();
  let pendingRequest: Request | null = null;
  let nonceCounter = 0;

  const nextNonce = (): string => {
    nonceCounter += 1;
    return `${noncePrefix}-${nonceCounter}`;
  };

  return {
    request: (payload) => {
      const carried = (payload as unknown as { nonce?: unknown }).nonce;
      const next = (typeof carried === "string" && carried.length > 0
        ? payload
        : { ...payload, nonce: nextNonce() }) as Request;
      pendingRequest = next;
      for (const listener of listeners) listener(next);
      return next;
    },
    nextNonce,
    takePending: () => {
      const request = pendingRequest;
      pendingRequest = null;
      return request;
    },
    clearPending: () => {
      pendingRequest = null;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    resetForTests: () => {
      listeners.clear();
      pendingRequest = null;
      nonceCounter = 0;
    },
  };
}

/**
 * The keyed sibling: a value parked under a key for whichever surface owns that
 * key to claim when it next mounts. No broadcast, because the consumer is
 * identified by the key rather than by having subscribed.
 */
export type KeyedPendingStore<T> = {
  set: (key: string, value: T) => void;
  /** Claim and remove; null when nothing is parked under `key`. */
  take: (key: string) => T | null;
  /** Non-consuming read, for callers that need to check before the surface mounts. */
  peek: (key: string) => T | null;
  /** Test seam: drops queued state so one test cannot leak into the next. */
  resetForTests: () => void;
};

export function createKeyedPendingStore<T>(): KeyedPendingStore<T> {
  const pending = new Map<string, T>();

  return {
    set: (key, value) => {
      pending.set(key, value);
    },
    take: (key) => {
      const value = pending.get(key);
      if (value == null) return null;
      pending.delete(key);
      return value;
    },
    peek: (key) => pending.get(key) ?? null,
    resetForTests: () => {
      pending.clear();
    },
  };
}
