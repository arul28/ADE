/**
 * Lane, PR and chat-session changes, on their way to plugins.
 *
 * ## The gap this closes
 *
 * `ade.events.on("lane.changed" | "pr.changed" | "session.changed", …)` was
 * typed, validated by `isPluginEventName`, accepted by the host's subscription
 * handler, documented in the plugin skill — and emitted by nothing. Only
 * `install.changed` had a producer. A plugin that subscribed to any of the
 * other three registered a listener, got no error, and never heard anything;
 * the skill's own "row badges from CI" recipe is `pr.changed`, so copying it
 * produced a plugin that published nothing, forever, silently.
 *
 * ## Why a module-level bus, a third time
 *
 * The same argument {@link ./pluginRuntimeHooks} makes. The producers are a
 * project's `laneService`, its PR event fan-out and its `agentChatService`, all
 * constructed in `bootstrap.ts` long before anyone knows whether a plugin is
 * running; the consumer is the machine-scoped plugin host. Threading a host
 * handle down into three services would put a plugin dependency inside the lane
 * write path and grow each constructor an argument. A module-level bus matches
 * the process's lifetime and costs an emitter one function call into an empty
 * listener set when no host is listening.
 *
 * ## The invariants
 *
 * 1. **Emission is fire-and-forget and never awaited.** Every call site here is
 *    inside a write path a user is waiting on — a lane rebase, a PR poll, the
 *    end of a turn. {@link emitPluginEntityChange} returns void, swallows every
 *    listener failure, and does no I/O.
 * 2. **Identity and lifecycle position, never content.** An emission carries
 *    entity ids, the checkout they happened in, and — where the producer knows
 *    it — where each id moved FROM and TO. No titles, no branch names, no diff,
 *    no message text. The event means "this family moved, re-read it" and a
 *    plugin that wants detail asks for it through the ordinary read actions,
 *    under the ordinary gates.
 * 3. **`projectRoot`, not a project id.** A lane service knows which checkout it
 *    serves and does not know the id the plugin host binds that checkout under.
 *    The host holds the bindings, so it does the translation on the way out —
 *    and a change in a project no host has attached resolves to a null
 *    `projectId` rather than to a guess.
 *
 * Coalescing, the id cap and the `overflow` flag are the HOST's job, not this
 * bus's: `install.changed` already has all three, and a second implementation
 * of the same debounce would be a second set of numbers to keep in step.
 */

import type { PluginPrTransition } from "../../../shared/plugins/sdk";

/** The three entity families the SDK's change events name. */
export type PluginEntityChangeFamily = "lane" | "pr" | "session";

/** What a producer reports; the host turns this into a wire payload. */
export type PluginEntityChangeEmission = {
  family: PluginEntityChangeFamily;
  /**
   * Ids that moved. May be empty — "something in this family changed and the
   * producer cannot name what" is a legitimate refetch signal, and a producer
   * must never invent an id to fill this.
   */
  ids: readonly string[];
  /** Absolute checkout it happened in. The host maps it to a project id. */
  projectRoot: string | null;
  /**
   * What some of those ids DID, for the producers that know.
   *
   * The ONE narrowing of invariant 2 above, and it is narrow on purpose: a
   * transition carries lifecycle position and nothing else — no title, no
   * branch, no author, no body. It is here because "this pull request just
   * merged" is a fact only the producer holds (it is comparing against the
   * previous poll) and one every consumer would otherwise re-derive by reading
   * each PR back, racily and once per plugin.
   *
   * Optional, and a producer with no previous state to compare against must
   * omit it rather than inventing a `from`. Every id named here must also
   * appear in `ids`; the host does not add ids from this list.
   */
  transitions?: readonly PluginPrTransition[];
};

const listeners = new Set<(emission: PluginEntityChangeEmission) => void>();

/**
 * Whether anything is listening at all.
 *
 * Checked by a producer before it does any bookkeeping an emission needs, so a
 * process with no plugin host attached — every headless CLI invocation, every
 * test — pays one set-size read and nothing else.
 */
export function hasPluginEntityChangeListeners(): boolean {
  return listeners.size > 0;
}

/**
 * Publish one change. Never throws and never blocks: the caller is mid-write,
 * and a subscriber's failure must not become the write's failure.
 */
export function emitPluginEntityChange(emission: PluginEntityChangeEmission): void {
  if (listeners.size === 0) return;
  for (const listener of [...listeners]) {
    try {
      listener(emission);
    } catch {
      // A broken subscriber loses its notification, not the caller's write.
    }
  }
}

/**
 * Turn one PR poll's changes into the transitions a `pr.changed` should carry.
 *
 * Pure, and exported so the mapping is testable without an Electron main
 * process: the call site is one arrow inside `main.ts`'s
 * `onPullRequestsChanged`, which is where the previous state and the project
 * root meet and nowhere a test can reach.
 *
 * A change whose `previousState` the poller never saw is DROPPED rather than
 * reported with its current state as the `from`. The first tick after a
 * restart, and the tick that discovers a PR, both have no history — and a
 * transition reading `merged → merged` would say "it did not move" and suppress
 * exactly the merge a plugin is waiting for.
 */
export function prTransitionsFromChanges(
  changes: readonly {
    pr: { id: string; state: string };
    previousState: string | null;
  }[],
): PluginPrTransition[] {
  const transitions: PluginPrTransition[] = [];
  for (const change of changes) {
    const previousState = change.previousState;
    if (previousState === null || previousState === undefined) continue;
    const id = change.pr.id?.trim();
    if (!id) continue;
    transitions.push({
      id,
      from: { state: previousState, merged: previousState === "merged" },
      to: { state: change.pr.state, merged: change.pr.state === "merged" },
    });
  }
  return transitions;
}

/** Subscribe; call the returned function to detach (the host does, on dispose). */
export function subscribeToPluginEntityChanges(
  listener: (emission: PluginEntityChangeEmission) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. Production code has no reason to drop another host's subscriber. */
export function resetPluginEntityChangeListenersForTests(): void {
  listeners.clear();
}
