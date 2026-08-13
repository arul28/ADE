/**
 * Runtime hooks — the chat runtime's turn lifecycle, on its way to plugins.
 *
 * ## Why a module-level bus, again
 *
 * The same argument {@link ./pluginEvents} makes, with the direction reversed.
 * There the producers were inside the host; here the producer is a *project's*
 * `agentChatService`, constructed in `bootstrap.ts` long before anyone knows
 * whether a plugin is running, while the consumer is the machine-scoped plugin
 * host. Threading a host handle down into the chat service would put a plugin
 * dependency in the middle of the turn loop and make the chat service's
 * constructor grow an argument per capability. A module-level bus matches the
 * process's lifetime, costs the emitter one function call into an empty
 * listener set when no host is listening, and keeps `agentChatService`'s
 * knowledge of plugins to "something may be watching".
 *
 * ## The one invariant
 *
 * **Emission is fire-and-forget and never awaited.** {@link emitPluginRuntimeHook}
 * is called from inside the chat event commit path — the hot path that also
 * writes the transcript and feeds the renderer — so it returns void, swallows
 * every listener failure, and does no I/O of its own. The host's own listener
 * is required to be equally cheap: it queues, it does not write, and it drops
 * rather than backpressures (see `pluginHostService`). A plugin cannot slow a
 * turn down, and a plugin that has stopped reading its stdin cannot slow it
 * down either.
 *
 * ## What the payload carries
 *
 * Metadata, never content. The reasoning is on
 * {@link PLUGIN_RUNTIME_HOOK_EVENTS} in the SDK, and this bus is deliberately
 * typed so it cannot carry more: there is no field on
 * {@link PluginRuntimeHookEmission} for message text, tool arguments or paths,
 * so widening the exposure is a visible change to a shared type rather than an
 * extra property somebody adds at a call site.
 *
 * `projectRoot` rather than a project id: the chat service knows which checkout
 * it serves and does not know the id the plugin host binds that checkout under.
 * The host owns that mapping — it holds the bindings — so it does the
 * translation on the way out, and a turn in a project no host has attached
 * resolves to a null `projectId` rather than to a guess.
 */

import type { PluginRuntimeHookName, PluginTurnOutcome } from "../../../shared/plugins/sdk";

/** What the chat runtime reports; the host turns this into a wire payload. */
export type PluginRuntimeHookEmission = {
  event: PluginRuntimeHookName;
  sessionId: string;
  /** Absolute checkout the chat runs in. The host maps it to a project id. */
  projectRoot: string | null;
  /** `claude`, `codex`, `cursor`, `droid`, `pi`, `opencode`. */
  runtime: string;
  /** `turn.start` only. */
  model?: string;
  /** `turn.end` only. */
  outcome?: PluginTurnOutcome;
  /** `turn.end` only, and only when the matching start was seen. */
  durationMs?: number;
  /** `tool.before` only. */
  toolName?: string;
};

const listeners = new Set<(emission: PluginRuntimeHookEmission) => void>();

/**
 * Whether anything is listening at all.
 *
 * The emitter checks this before doing the small amount of bookkeeping a hook
 * needs (resolving the runtime, timing a turn), so a machine with no plugin
 * host attached — every headless CLI invocation, every test — pays one set
 * size read per chat event and nothing else.
 */
export function hasPluginRuntimeHookListeners(): boolean {
  return listeners.size > 0;
}

/**
 * Publish one hook. Never throws and never blocks: the caller is mid-turn, and
 * a subscriber's failure must not become the turn's failure.
 */
export function emitPluginRuntimeHook(emission: PluginRuntimeHookEmission): void {
  if (!listeners.size) return;
  for (const listener of [...listeners]) {
    try {
      listener(emission);
    } catch {
      // A broken subscriber loses its notification, not the user's turn.
    }
  }
}

/** Subscribe; call the returned function to detach (the host does, on dispose). */
export function subscribeToPluginRuntimeHooks(
  listener: (emission: PluginRuntimeHookEmission) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam. Production code has no reason to drop another host's subscriber. */
export function resetPluginRuntimeHookListenersForTests(): void {
  listeners.clear();
}
