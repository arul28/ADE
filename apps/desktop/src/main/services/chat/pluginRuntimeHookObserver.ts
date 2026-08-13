/**
 * The chat runtime's half of the plugin runtime hooks.
 *
 * `agentChatService` commits every event from every runtime through one
 * funnel, so this maps that funnel's vocabulary onto the three plugin-facing
 * hooks and does nothing else. It lives beside the chat service rather than
 * inside `services/plugins/` because it is the only piece that needs to know
 * ADE's transcript vocabulary — keeping it here means the plugin bus type
 * never learns what an `AgentChatEvent` is, and widening what plugins observe
 * is a change to this file rather than to the plugin platform.
 *
 * Three things are load-bearing:
 *
 * 1. **It is called from the hot path, so it does no work when nobody is
 *    listening.** `hasPluginRuntimeHookListeners()` is checked first, which is
 *    the common case: a headless CLI, a test, any machine with no plugin
 *    subscribed to a hook.
 * 2. **It never throws.** A malformed event or a bookkeeping bug must not take
 *    down the commit that was writing the user's transcript.
 * 3. **Its bookkeeping is bounded.** Turn timing and end-dedupe both need
 *    memory, and a runtime that opens turns it never closes (a crash mid-turn,
 *    an abandoned session) must not grow either one forever.
 */

import type { AgentChatEvent } from "../../../shared/types";
import type { PluginTurnOutcome } from "../../../shared/plugins/sdk";
import { emitPluginRuntimeHook, hasPluginRuntimeHookListeners } from "../plugins/pluginRuntimeHooks";

/**
 * Sessions with a turn in flight, and turns whose end has been told.
 *
 * A chat runs one turn at a time, so the first bounds *chats mid-turn* across
 * the machine — a busy Work grid runs a handful at once, and an entry is a
 * string and a number. Past either cap the oldest is dropped, which costs that
 * turn's `turn.end` its `durationMs` and nothing else.
 */
const PLUGIN_HOOK_OPEN_TURN_MAX = 512;
const PLUGIN_HOOK_ENDED_TURN_MAX = 512;

/**
 * One hook per turn, however many times the transcript says so.
 *
 * Both halves of a turn boundary get announced more than once by real
 * runtimes, and neither repetition is a bug in them — the repeats mean
 * different things to the transcript and the same thing to a plugin:
 *
 * - **Codex opens a turn twice.** Once when ADE dispatches the message (a
 *   `status: started` carrying no turn id yet, so the UI can show the turn as
 *   live immediately) and again when the runtime answers with the id it
 *   assigned. Passed through verbatim, a plugin counting turns would count
 *   every Codex turn twice and a cost guard would fire at half its budget.
 * - **A `done` can arrive more than once for one turn.** The chat service
 *   keeps its own bounded set of already-settled turns for exactly this reason
 *   (`notifiedSettledTurns`), and a hook that did not would report a turn
 *   ending twice, the second time with a duration that means nothing.
 *
 * So: a start with no id opens the session's turn, the id that arrives next
 * ADOPTS that open turn rather than starting a second one, and an end is told
 * once per turn id.
 */
export type PluginRuntimeHookObserver = {
  /**
   * Offer one committed chat event. Events that are not a turn boundary or a
   * tool call are ignored, which is nearly all of them.
   */
  observe(args: {
    sessionId: string;
    runtime: string;
    model: string | null;
    event: AgentChatEvent;
  }): void;
  /** Forget a session's open turn — its chat is gone. */
  forgetSession(sessionId: string): void;
};

function turnOutcome(status: "completed" | "interrupted" | "failed"): PluginTurnOutcome {
  if (status === "failed") return "error";
  if (status === "interrupted") return "cancelled";
  return "completed";
}

function evictOldest(entries: Map<string, unknown> | Set<string>, max: number): void {
  while (entries.size > max) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

export function createPluginRuntimeHookObserver(args: {
  projectRoot: string | null;
  /** Test seam for deterministic durations. */
  now?: () => number;
}): PluginRuntimeHookObserver {
  const emit = emitPluginRuntimeHook;
  const now = args.now ?? (() => Date.now());
  /** One entry per session with a turn in flight. */
  const openTurns = new Map<string, { turnId: string | null; startedAt: number }>();
  /**
   * Turns already reported ended, keyed session-then-turn.
   *
   * `\u0000` as the joiner is the house idiom for a composite key (see
   * `pluginHostService.ts`): it is the one character neither half can contain,
   * so no pair of ids can collide by spelling the separator themselves. Written
   * as the six-character escape, never as the byte — a literal NUL in a source
   * file makes it binary to git and invisible to `rg`.
   */
  const endedTurns = new Set<string>();

  /** Whether this start opens a NEW turn, or merely restates the open one. */
  const openTurnIfNew = (sessionId: string, turnId: string | undefined): boolean => {
    const open = openTurns.get(sessionId);
    if (open) {
      // The runtime naming the turn it already announced: adopt the id so the
      // matching `done` can be timed, and stay quiet.
      if (open.turnId === null && turnId) {
        open.turnId = turnId;
        return false;
      }
      // The same turn said twice, or a bare restatement of the open one.
      if (!turnId || open.turnId === turnId) return false;
      // A different id while one is open means the previous turn never ended.
      // The new one is real, so it replaces the old rather than being dropped.
    }
    // Re-setting moves the session to the end of the insertion order, so a chat
    // in a long turn is not evicted by the chats that started after it.
    openTurns.delete(sessionId);
    openTurns.set(sessionId, { turnId: turnId ?? null, startedAt: now() });
    evictOldest(openTurns, PLUGIN_HOOK_OPEN_TURN_MAX);
    return true;
  };

  /** `null` when this end is a repeat and must not be told again. */
  const closeTurn = (sessionId: string, turnId: string): { durationMs: number | null } | null => {
    const endedKey = `${sessionId}\u0000${turnId}`;
    if (endedTurns.has(endedKey)) return null;
    endedTurns.add(endedKey);
    evictOldest(endedTurns, PLUGIN_HOOK_ENDED_TURN_MAX);
    const open = openTurns.get(sessionId);
    // An open turn with no id yet IS this one: the runtime ended it before it
    // ever named the id to the transcript.
    if (!open || (open.turnId !== null && open.turnId !== turnId)) return { durationMs: null };
    openTurns.delete(sessionId);
    return { durationMs: Math.max(0, now() - open.startedAt) };
  };

  return {
    observe({ sessionId, runtime, model, event }) {
      if (!hasPluginRuntimeHookListeners()) return;
      try {
        if (event.type === "status" && event.turnStatus === "started") {
          if (!openTurnIfNew(sessionId, event.turnId)) return;
          emit({
            event: "turn.start",
            sessionId,
            projectRoot: args.projectRoot,
            runtime,
            ...(model ? { model } : {}),
          });
          return;
        }

        if (event.type === "done") {
          const closed = closeTurn(sessionId, event.turnId);
          if (!closed) return;
          emit({
            event: "turn.end",
            sessionId,
            projectRoot: args.projectRoot,
            runtime,
            outcome: turnOutcome(event.status),
            ...(closed.durationMs != null ? { durationMs: closed.durationMs } : {}),
          });
          return;
        }

        if (event.type === "tool_call") {
          emit({
            event: "tool.before",
            sessionId,
            projectRoot: args.projectRoot,
            runtime,
            // The name only. `event.args` is deliberately not read here — see
            // PLUGIN_RUNTIME_HOOK_EVENTS on why the observe tier carries no
            // content, and note that a tool's arguments are the single richest
            // content in a turn (file paths, patches, shell commands).
            toolName: event.tool,
          });
        }
      } catch {
        // Observing a turn must never be able to fail the turn.
      }
    },

    forgetSession(sessionId) {
      openTurns.delete(sessionId);
    },
  };
}
