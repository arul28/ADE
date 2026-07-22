import type {
  PersonalChatAction,
  PersonalChatCallArgs,
  PersonalChatCallResponse,
  PersonalChatStreamEventsArgs,
  PersonalChatStreamEventsResult,
  RemoteRuntimeBufferedEvent,
} from "../../../shared/types";
import type { SyncChatEventPayload } from "../../../shared/types/sync";
import { chatEventDedupKey } from "./infra/chatEventDedup";
import type { AdapterInfra, AdeNamespace } from "./types";

function fallbackFor(action: PersonalChatAction): unknown {
  if (action === "list" || action === "models") return [];
  if (action === "modelCatalog") return { providers: [], models: [] };
  if (action === "getEventHistory") {
    return { sessionId: "", events: [], truncated: false, sessionFound: false };
  }
  if (action === "getEventHistoryPage") {
    return { sessionId: "", events: [], nextBeforeOffset: null, hasMore: false };
  }
  return null;
}

export function createPersonalChatsNamespace(infra: AdapterInfra): AdeNamespace<"personalChats"> {
  const { client, commands } = infra;
  const subscriptions = new Map<string, () => void>();
  const buffered: RemoteRuntimeBufferedEvent[] = [];
  const delivered = new Set<string>();
  const deliveredOrder: string[] = [];
  let nextEventId = 1;

  const pushEvent = (payload: SyncChatEventPayload) => {
    const key = chatEventDedupKey(payload);
    if (delivered.has(key)) return;
    delivered.add(key);
    deliveredOrder.push(key);
    while (deliveredOrder.length > 2_000) {
      const oldest = deliveredOrder.shift();
      if (oldest) delivered.delete(oldest);
    }
    buffered.push({
      id: nextEventId++,
      timestamp: payload.timestamp,
      category: "runtime",
      payload: payload as unknown as Record<string, unknown>,
    });
    while (buffered.length > 2_000) buffered.shift();
  };

  const ensureSubscription = (sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId || subscriptions.has(sessionId)) return;
    subscriptions.set(sessionId, client.subscribeChat(
      sessionId,
      { chatScope: "personal", maxBytes: 4 * 1024 * 1024 },
      {
        snapshot: (snapshot) => snapshot.events.forEach((event) => pushEvent(event as SyncChatEventPayload)),
        event: pushEvent,
      },
    ));
  };

  const ensureFromResult = (result: unknown): void => {
    if (Array.isArray(result)) {
      result.forEach(ensureFromResult);
      return;
    }
    if (!result || typeof result !== "object") return;
    const record = result as Record<string, unknown>;
    ensureSubscription(record.sessionId ?? record.id);
  };

  infra.addDispose(() => {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    subscriptions.clear();
  });

  return {
    call: async (request: PersonalChatCallArgs): Promise<PersonalChatCallResponse> => {
      const result = await commands.call<unknown>(
        `personalChats.${request.action}`,
        (request.args ?? {}) as Record<string, unknown>,
        {
          fallback: fallbackFor(request.action),
          idempotent: request.action === "list"
            || request.action === "getSummary"
            || request.action === "read"
            || request.action === "models"
            || request.action === "modelCatalog"
            || request.action === "getEventHistory"
            || request.action === "getEventHistoryPage",
          requireProject: false,
        },
      );
      ensureFromResult(result);
      return { action: request.action, result };
    },
    streamEvents: async (request: PersonalChatStreamEventsArgs = {}): Promise<PersonalChatStreamEventsResult> => {
      if (commands.hasAction("personalChats.streamEvents")) {
        return await commands.call<PersonalChatStreamEventsResult>("personalChats.streamEvents", request, {
          fallback: { events: [], nextCursor: request.cursor ?? 0, hasMore: false },
          idempotent: true,
          requireProject: false,
        });
      }
      const cursor = typeof request.cursor === "number" ? Math.max(0, Math.floor(request.cursor)) : 0;
      const limit = typeof request.limit === "number" ? Math.max(1, Math.min(500, Math.floor(request.limit))) : 100;
      const pending = buffered.filter((event) => event.id > cursor);
      const events = pending.slice(0, limit);
      return {
        events,
        nextCursor: events.at(-1)?.id ?? cursor,
        hasMore: pending.length > events.length,
      };
    },
  };
}
