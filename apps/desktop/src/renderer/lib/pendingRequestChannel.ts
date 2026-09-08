/**
 * A one-shot "somebody asked for this" channel, shared by every surface that
 * needs one.
 *
 * The pattern: a request is broadcast to whoever is listening AND held, so a
 * consumer that has not mounted yet (the handler navigated to its route, and
 * the route is still rendering) can drain it on mount. A live consumer clears
 * the hold once it has acted, so the next mount does not re-open something
 * nobody asked for.
 *
 * Four modules had grown their own copy of exactly this — a `Set` of listeners,
 * one held request, a nonce counter, `take`/`clear`/`subscribe`, and a test
 * reset — each re-learning the "clear the hold after a live delivery" rule in a
 * comment. One implementation enforces it in one place.
 *
 * The nonce is what makes asking twice for the same thing two requests rather
 * than one swallowed duplicate, so it is minted here and never by the caller.
 */
export type PendingRequestChannel<T> = {
  /** Broadcast and hold. Returns the request that was sent. */
  request: (payload: T) => T & { nonce: string };
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

  return {
    request: (payload) => {
      nonceCounter += 1;
      const next = { ...payload, nonce: `${noncePrefix}-${nonceCounter}` } as Request;
      pendingRequest = next;
      for (const listener of listeners) listener(next);
      return next;
    },
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
