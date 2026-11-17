import { useState, type CSSProperties } from "react";
import type { CloudChatQueuedMessage } from "../../../../../account-directory/src/cloud/contract";
import { Banner } from "../ui/notice";

/** A queued message's state, in the chat's words. */
function rowState(message: CloudChatQueuedMessage): string {
  if (message.state === "sending") return "Sending…";
  if (message.state === "waiting_for_sign_in") return "Waits for a sign-in";
  return "Queued";
}

const FAILED_FALLBACK = "ADE couldn't send this message.";
const ROW_BUTTON = "shrink-0 underline-offset-2 hover:underline disabled:opacity-50";

/**
 * The messages an ADE Cloud chat holds in the account's queue while its
 * computer is asleep or a new one is set up (`useAdeCloudChatQueue`). Each
 * one shows here until the live chat has it, and a queued one can be
 * cancelled. A message the server could not send shows below with its
 * sentence until the person acts. Account level, by the chat's machine key:
 * no pin.
 */
export function CloudQueuedMessages({
  messages,
  failed = [],
  waking,
  style,
  onCancel,
  onPutBack,
  onDismiss,
}: {
  messages: CloudChatQueuedMessage[];
  /** Messages the server could not send (`state: "failed"`), oldest first. */
  failed?: CloudChatQueuedMessage[];
  /** The computer wakes for these (not a new computer: the launch card shows that). */
  waking: boolean;
  style?: CSSProperties;
  onCancel: (messageId: string) => Promise<void>;
  /** Puts a failed message's text back in the box; the caller then drops the row. */
  onPutBack?: (message: CloudChatQueuedMessage) => void;
  onDismiss?: (messageId: string) => void;
}) {
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failedRows = onPutBack && onDismiss && failed.length > 0
    ? <FailedQueuedMessages failed={failed} style={style} onPutBack={onPutBack} onDismiss={onDismiss} />
    : null;
  if (messages.length === 0) return failedRows;
  const count = messages.length === 1 ? "1 message waits" : `${messages.length} messages wait`;
  const cancel = (messageId: string) => {
    if (cancelling) return;
    setCancelling(messageId);
    setError(null);
    void onCancel(messageId)
      .catch((err: unknown) => setError(err instanceof Error && err.message ? err.message : "ADE couldn't cancel that message."))
      .finally(() => setCancelling(null));
  };
  return (
    <>
    <Banner
      layout="inline"
      style={style}
      model={{
        id: "chat-cloud-queued-messages",
        tone: "info",
        busy: waking,
        title: waking ? `Waking your ADE Cloud computer… ${count} for it.` : `${count} for your ADE Cloud computer.`,
        detail: error ?? "The agent gets them in order when the computer is up.",
        report: false,
        extra: (
          <ul className="mt-1 flex flex-col gap-1" aria-label="Queued messages">
            {messages.map((message) => (
              <li key={message.messageId} className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate" title={message.text}>{message.text}</span>
                <span className="shrink-0 opacity-70">{rowState(message)}</span>
                {message.state === "queued" ? (
                  <button
                    type="button"
                    className={ROW_BUTTON}
                    disabled={cancelling !== null}
                    onClick={() => cancel(message.messageId)}
                  >
                    {cancelling === message.messageId ? "Cancelling…" : "Cancel"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ),
      }}
    />
    {failedRows}
    </>
  );
}

/**
 * The messages the server could not send. Each stays, with the server's
 * sentence, until the person puts its text back in the box or dismisses it.
 */
function FailedQueuedMessages({
  failed,
  style,
  onPutBack,
  onDismiss,
}: {
  failed: CloudChatQueuedMessage[];
  style?: CSSProperties;
  onPutBack: (message: CloudChatQueuedMessage) => void;
  onDismiss: (messageId: string) => void;
}) {
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
