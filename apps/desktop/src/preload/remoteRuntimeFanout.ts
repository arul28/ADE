/**
 * One registration per remote runtime event domain.
 *
 * Every domain the renderer can receive over a remote (or pinned-local)
 * runtime binding used to be four hand-copied edits in four places: a `Set` of
 * callbacks, a clause in `hasRemoteRuntimeEventSubscribers`, an
 * `if (toWrappedEvent(…))` block in the dispatcher, and a `subscribeRemote*`
 * function. Thirty-four domains meant two independently hand-maintained lists
 * of thirty-four — and a domain missing from the `has…` list silently stops the
 * event pump for that domain with nothing failing anywhere.
 *
 * A fanout is the single place that knows the shape, so the two lists become
 * one array and adding a domain is one entry in it.
 */
export type RemoteRuntimeFanoutEntry = {
  /** Wire discriminator this domain answers to; also its identity in tests. */
  readonly eventType: string;
  /** True while at least one renderer callback is registered. */
  readonly hasSubscribers: boolean;
  /** Delivers the payload if it belongs to this domain. Returns whether it matched. */
  dispatch: (payload: Record<string, unknown>) => boolean;
};

export type RemoteRuntimeFanout<T> = RemoteRuntimeFanoutEntry & {
  subscribe: (cb: (payload: T) => void) => () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createRemoteRuntimeFanout<T>(args: {
  eventType: string;
  /** Name used when a renderer listener throws, e.g. "lane rebase". */
  label: string;
  /** Runs whenever a callback is added — the shared runtime event pump. */
  onSubscribe?: () => void;
  /**
   * Pulls the domain payload out of the runtime envelope. Defaults to the
   * `{ type, event }` wrapper every ordinary domain uses; the few that carry a
   * different shape (auth status, sync/usage snapshots, automations) pass their
   * own.
   */
  extract?: (payload: Record<string, unknown>) => T | null;
  /** Renderer caches this event invalidates. Runs once per matched event, before delivery. */
  invalidate?: () => void;
  /** Last word on delivery after extraction (the per-id pty_data subscription filter). */
  shouldDeliver?: (event: T) => boolean;
}): RemoteRuntimeFanout<T> {
  const callbacks = new Set<(payload: T) => void>();
  const extract = args.extract
    ?? ((payload: Record<string, unknown>): T | null => (
      payload.type === args.eventType && isRecord(payload.event)
        ? (payload.event as T)
        : null
    ));

  return {
    eventType: args.eventType,
    get hasSubscribers() {
      return callbacks.size > 0;
    },
    subscribe(cb) {
      callbacks.add(cb);
      args.onSubscribe?.();
      return () => {
        callbacks.delete(cb);
      };
    },
    dispatch(payload) {
      const event = extract(payload);
      if (event == null) return false;
      // Cache invalidation is the domain's, not the subscriber's: it has to
      // happen even when nothing is currently listening, or a later read of a
      // project-scoped cache serves state this event already superseded.
      args.invalidate?.();
      if (args.shouldDeliver && !args.shouldDeliver(event)) return true;
      for (const cb of [...callbacks]) {
        try {
          cb(event);
        } catch (error) {
          console.error(`preload remote ${args.label} listener failed`, error);
        }
      }
      return true;
    },
  };
}

/** True when any domain has a listener, i.e. the runtime event pump is worth running. */
export function hasRemoteRuntimeFanoutSubscribers(
  fanouts: readonly RemoteRuntimeFanoutEntry[],
): boolean {
  return fanouts.some((fanout) => fanout.hasSubscribers);
}

/**
 * Offers one runtime payload to every domain.
 *
 * Every fanout is offered the payload rather than stopping at the first match:
 * the hand-written dispatcher did the same, and a payload that two domains both
 * recognise (a wrapper type plus a snapshot shape) must reach both.
 */
export function dispatchRemoteRuntimeFanouts(
  fanouts: readonly RemoteRuntimeFanoutEntry[],
  payload: Record<string, unknown>,
): void {
  for (const fanout of fanouts) fanout.dispatch(payload);
}
