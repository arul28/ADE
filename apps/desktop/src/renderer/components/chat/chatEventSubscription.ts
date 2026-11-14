import type { AgentChatApi } from "./agentChatApi";

/** Waits between looks for the chat API: about 30 s in all, then it stops. */
const CHAT_EVENT_API_RETRY_MS = [100, 250, 500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

function readyChatEventApi(readApi: () => AgentChatApi | null | undefined): AgentChatApi | null {
  const api = readApi();
  return typeof api?.onEvent === "function" ? api : null;
}

/**
 * Subscribes through the chat API's `onEvent` as soon as the API has it.
 *
 * ADE Web can render a chat pane before its bridge has the chat API
 * (ADE-WEB-7). A bounded retry attaches the feed when the API appears, so the
 * pane does not stay without live events until a pin or visibility change.
 * On the desktop the API is always there: this subscribes at once and sets no
 * timer. The returned function unsubscribes, and stops a retry still waiting.
 */
export function subscribeWhenChatApiReady(
  readApi: () => AgentChatApi | null | undefined,
  attach: (api: AgentChatApi) => () => void,
): () => void {
  const now = readyChatEventApi(readApi);
  if (now) return attach(now);

  let detach: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const lookAgain = (attempt: number): void => {
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      const api = readyChatEventApi(readApi);
      if (!api) {
        if (attempt + 1 < CHAT_EVENT_API_RETRY_MS.length) {
          lookAgain(attempt + 1);
        } else {
          console.warn("[chat] live events are off: the chat API did not become available");
        }
        return;
      }
      try {
        detach = attach(api);
      } catch (error) {
        // A throw from a timer is uncaught; the pane's own recovery reads the
        // transcript again.
        console.warn("[chat] live events could not start", error);
      }
    }, CHAT_EVENT_API_RETRY_MS[attempt]);
  };
  lookAgain(0);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    const current = detach;
    detach = null;
    current?.();
  };
}
