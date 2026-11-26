import { createContext, useContext, useState, type CSSProperties } from "react";
import type { CloudChatQueuedMessage } from "../../../../../account-directory/src/cloud/contract";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types/chat";
import { Banner } from "../ui/notice";

const FAILED_FALLBACK = "ADE couldn't send this message.";

/** A failed message put back in a message box: words the person is typing stay, and the message goes after them. */
export function draftWithPutBack(current: string, text: string): string {
  return current.trim().length ? `${current.replace(/\s+$/, "")}\n${text}` : text;
}

const ROW_BUTTON = "shrink-0 underline-offset-2 hover:underline disabled:opacity-50";

/**
 * The `user_message.metadata` key of a bubble that stands for a message in the
 * account's queue (`cloudQueuedMessageEnvelope`). Window only: no host writes it.
 */
const CLOUD_QUEUED_METADATA_KEY = "cloudQueuedMessage";

type CloudQueuedBubbleFacts = { messageId: string; state: CloudChatQueuedMessage["state"] };

function cloudQueuedBubbleFacts(event: Extract<AgentChatEvent, { type: "user_message" }>): CloudQueuedBubbleFacts | null {
  const value = event.metadata?.[CLOUD_QUEUED_METADATA_KEY] as Partial<CloudQueuedBubbleFacts> | undefined;
  return value && typeof value.messageId === "string" && typeof value.state === "string"
    ? { messageId: value.messageId, state: value.state }
    : null;
}

/**
 * A message the account's queue holds for an ADE Cloud chat whose computer
 * is asleep or being set up, as the chat's own sent bubble. The real message
 * replaces it once the computer has sent it. `timestamp` is the bubble's
 * time: the send's own bubble keeps its row (and plays no second entrance)
 * when the pane passes that bubble's time.
 */
export function cloudQueuedMessageEnvelope(
  message: CloudChatQueuedMessage,
  sessionId: string,
  timestamp: string,
): AgentChatEventEnvelope {
  const names = message.attachments.map((attachment) => attachment.name).filter(Boolean);
  const text = message.text.trim() || (names.length ? `Attached: ${names.join(", ")}` : "");
  return {
    sessionId,
    timestamp,
    event: {
      type: "user_message",
      text,
      deliveryState: "queued",
      metadata: { [CLOUD_QUEUED_METADATA_KEY]: { messageId: message.messageId, state: message.state } satisfies CloudQueuedBubbleFacts },
    },
  };
}

/** Takes a queued message back (the pane's `useAdeCloudChatQueue().cancel`). Null: the list shows no Cancel. */
export const CloudQueuedBubbleContext = createContext<((messageId: string) => Promise<void>) | null>(null);

/**
 * The line under a queued bubble: a quiet Cancel while it waits, or what it
 * waits for when that is not the computer (a sign-in). The working line under
 * the chat says that the computer wakes. Nothing for any other bubble.
 */
export function CloudQueuedBubbleStatus({ event }: { event: Extract<AgentChatEvent, { type: "user_message" }> }) {
  const cancel = useContext(CloudQueuedBubbleContext);
  const facts = cloudQueuedBubbleFacts(event);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!facts) return null;
  if (facts.state === "waiting_for_sign_in") {
    return (
      <div className="mt-1 flex max-w-[82%] justify-end px-1 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] leading-4 text-amber-200/80" data-testid="cloud-queued-bubble-status">
        Waits for a sign-in on the computer
      </div>
    );
  }
  if (facts.state !== "queued" || !cancel) return null;
  return (
    <div className="mt-1 flex max-w-[82%] items-center justify-end gap-2 px-1 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] leading-4 text-fg/45" data-testid="cloud-queued-bubble-status">
      {error ? <span className="min-w-0 truncate text-amber-200/80" title={error}>{error}</span> : null}
      <button
        type="button"
        className={ROW_BUTTON}
        disabled={cancelling}
        onClick={() => {
          setCancelling(true);
          setError(null);
          void cancel(facts.messageId)
            .catch((err: unknown) => setError(err instanceof Error && err.message ? err.message : "ADE couldn't cancel that message."))
            .finally(() => setCancelling(false));
        }}
      >
        {cancelling ? "Cancelling…" : "Cancel"}
      </button>
    </div>
  );
}

/**
 * The messages the account's queue could not send for an ADE Cloud chat
 * (`useAdeCloudChatQueue().failed`). Each stays, with the server's sentence,
 * until the person puts its text back in the box or dismisses it. A message
 * that still waits shows as its own bubble in the chat
 * (`cloudQueuedMessageEnvelope`), not here. Account level, by the chat's
 * machine key: no pin.
 */
export function CloudQueuedMessages({
  failed,
  style,
  onPutBack,
  onDismiss,
}: {
  /** Messages the server could not send (`state: "failed"`), oldest first. */
  failed: CloudChatQueuedMessage[];
  style?: CSSProperties;
  /** Puts a failed message's text back in the box; the caller then drops the row. */
  onPutBack: (message: CloudChatQueuedMessage) => void;
  onDismiss: (messageId: string) => void;
}) {
  if (failed.length === 0) return null;
  return (
    <Banner
      layout="inline"
      style={style}
      model={{
        id: "chat-cloud-failed-messages",
        tone: "warning",
        title: failed.length === 1 ? "A message didn't reach your ADE Cloud computer." : `${failed.length} messages didn't reach your ADE Cloud computer.`,
        report: false,
        extra: (
          <ul className="mt-1 flex flex-col gap-1.5" aria-label="Messages that didn't send">
            {failed.map((message) => (
              <li key={message.messageId} className="flex flex-col gap-0.5 text-[12px]">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" title={message.text}>{message.text}</span>
                  <button type="button" className={ROW_BUTTON} onClick={() => onPutBack(message)}>Put back</button>
                  <button type="button" className={ROW_BUTTON} onClick={() => onDismiss(message.messageId)}>Dismiss</button>
                </div>
                <span className="opacity-80">{message.error?.trim() || FAILED_FALLBACK}</span>
              </li>
            ))}
          </ul>
        ),
      }}
    />
  );
}
