import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types/chat";

/**
 * Streamed reply text or reasoning inside the turn the transcript is already
 * in. It adds words or a new prose row, which the transcript list shows from
 * the live store, and changes nothing else the chat pane derives (turn state,
 * approvals, tools, models, the composer), so the pane can leave it to the list.
 */
export function isStreamedContinuation(
  previous: AgentChatEvent | undefined,
  next: AgentChatEvent,
): boolean {
  if (!previous || (next.type !== "text" && next.type !== "reasoning")) return false;
  const turnId = next.turnId;
  return Boolean(turnId) && (previous as { turnId?: string }).turnId === turnId;
}

/**
 * The busy middle of a turn: tool calls and their results, activity, usage
 * meters, command output, file changes and progress. The transcript shows each
 * one as it lands; what the chat pane derives from them (the agents panel, the
 * sources list, the context meter) may trail by up to a second. Turn edges,
 * prompts, approvals, errors, notices and everything else commit at once.
 */
const PANE_LAGGED_EVENT_TYPES: ReadonlySet<AgentChatEvent["type"]> = new Set<AgentChatEvent["type"]>([
  "tool_call",
  "tool_result",
  "tool_use_summary",
  "activity",
  "context_usage",
  "codex_token_usage",
  "tokens",
  "step_boundary",
  "command",
  "command_lifecycle",
  "file_change",
  "web_search",
  "sources",
  "subagent_progress",
  "subagent.progress",
  "text",
  "reasoning",
]);

/**
 * How a batch of live events reaches the chat pane:
 * - "quiet": streamed reply words only; the pane never needs them.
 * - "lagged": the pane needs them, but within a second is soon enough.
 * - "now": something the pane must show this frame.
 */
export function classifyLiveEventBatch(
  existing: readonly AgentChatEventEnvelope[],
  queued: readonly AgentChatEventEnvelope[],
): "quiet" | "lagged" | "now" {
  if (!queued.length) return "now";
  let previous = existing[existing.length - 1]?.event;
  let result: "quiet" | "lagged" = "quiet";
  for (const envelope of queued) {
    const event = envelope.event;
    if (!isStreamedContinuation(previous, event)) {
      if (!PANE_LAGGED_EVENT_TYPES.has(event.type)) return "now";
      result = "lagged";
    }
    previous = event;
  }
  return result;
}

/**
 * The pane's live transcripts, readable without a pane render. Streamed
 * continuations land here first; the transcript list subscribes, and the pane
 * catches up on its next structural event or a trailing commit.
 */
export type ChatLiveEventsStore = {
  subscribe: (listener: () => void) => () => void;
  read: (sessionId: string) => AgentChatEventEnvelope[] | undefined;
  notify: () => void;
};

export function createChatLiveEventsStore(
  read: (sessionId: string) => AgentChatEventEnvelope[] | undefined,
): ChatLiveEventsStore {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read,
    notify() {
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The composer's text, outside React state; see AgentChatPane `draftStore`. */
export type ComposerDraftStore = {
  get: () => string;
  set: (next: string | ((current: string) => string)) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createComposerDraftStore(initial: string): ComposerDraftStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === "function" ? next(value) : next;
      if (resolved === value) return;
      value = resolved;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
