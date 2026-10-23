import { captureNotificationSentAnalytics } from "../../../../desktop/src/main/services/analytics/featureProductAnalytics";
import { customNotificationProblem } from "../../../../desktop/src/shared/types/attention";
import type { AdeRuntime } from "../../bootstrap";
import type { PushPublisherService } from "./pushPublisherService";

/** What `ade notify` answers when it ran inside a chat. */
export type ChatMessageNotifyResult = {
  /** True when a new message went out; false for a repeat of one just sent. */
  sent: boolean;
  delivery: "chat";
  sessionId: string;
  chatTitle: string | null;
  /** The same words were sent from this chat a moment ago; nothing new went out. */
  repeat?: true;
  /** Phones get it only when this machine is signed in to an ADE account. */
  accountSignedIn?: boolean;
  /** `--open` is ignored here: a chat's message opens that chat. */
  linkSkipped?: string;
};

/**
 * `ade notify` from inside a chat: the message becomes that chat's (see
 * `PushPublisherService.sendChatMessage`).
 *
 * Returns null when this brain does not hold the chat, so the caller sends the
 * plain push instead. Throws, in words the agent can act on, for bad input and
 * for the per-chat and per-machine limits.
 */
export async function sendNotifyAsChatMessage(args: {
  publisher: PushPublisherService;
  sessionId: string;
  args: Record<string, unknown>;
  callerScopeKey: string | null;
  analytics: AdeRuntime["productAnalyticsService"] | null | undefined;
}): Promise<ChatMessageNotifyResult | null> {
  const problem = customNotificationProblem({ title: args.args.title, body: args.args.body });
  if (problem) throw new Error(problem);
  const title = String(args.args.title).trim();
  const body = typeof args.args.body === "string" ? args.args.body.trim() || null : null;
  const result = await args.publisher.sendChatMessage({
    sessionId: args.sessionId,
    title,
    body,
    scopeKey: args.callerScopeKey,
  });
  if (!result) return null;
  const linkSkipped = typeof args.args.open === "string" && args.args.open.trim()
    ? { linkSkipped: "A message from a chat opens that chat." }
    : {};
  if (result.status === "rate_limited") {
    const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
    throw new Error(
      (result.scope === "chat"
        ? `This chat has sent ${result.limit} notifications in the last hour.`
        : `Chats on this computer have sent ${result.limit} notifications in the last hour.`)
        + ` Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    );
  }
  if (result.status === "repeat") {
    return {
      sent: false,
      delivery: "chat",
      sessionId: result.sessionId,
      chatTitle: null,
      repeat: true,
      ...linkSkipped,
    };
  }
  captureNotificationSentAnalytics({
    analytics: args.analytics,
    surface: "api",
    outcome: "completed",
  });
  return {
    sent: true,
    delivery: "chat",
    sessionId: result.sessionId,
    chatTitle: result.chatTitle,
    accountSignedIn: result.accountSignedIn,
    ...linkSkipped,
  };
}
