/**
 * The message queue of an existing cloud chat (`POST/GET/DELETE
 * /cloud/chats/:machine/:chat/messages`), as the desktop and the web client
 * both call it through `window.ade.adeCloud`.
 *
 * A send to a chat whose computer rests goes to the account server. The
 * server keeps the message, wakes the computer (or launches a new one for a
 * deleted computer), and the computer sends it. The send returns at once.
 */

import type {
  CloudChatQueuedMessage,
  CloudProjectOverview,
  CloudSessionRow,
} from "../../../../account-directory/src/cloud/contract";

/** A write's answer: the server's result, or its refusal as data (the code decides what else to offer). */
export type AdeCloudQueueSendAnswer<T> =
  | { ok: true; result: T }
  | { ok: false; code: string; status: number; message: string };

export type AdeCloudChatAddress = { machineKey: string; chatId: string };

/**
 * `window.ade.adeCloud`: account reads for ADE with no computer, and taking a
 * queued message back. The send itself is `window.ade.cloud.sendChatMessage`
 * (`CloudChatSendRequest` in `shared/adeCloudMachine.ts`). Optional: an
 * older ADE has none.
 */
export type AdeCloudBridge = {
  /** Null from an older server (no queue). */
  chatMessages: (address: AdeCloudChatAddress) => Promise<CloudChatQueuedMessage[] | null>;
  cancelChatMessage: (address: AdeCloudChatAddress & { messageId: string }) => Promise<AdeCloudQueueSendAnswer<CloudChatQueuedMessage>>;
  /** Null from an older server, or while signed out. */
  projectOverview: (args: { origin: string }) => Promise<CloudProjectOverview | null>;
  savedSessions: (args: { machineKey?: string | null; projectKey?: string | null; cursor?: string | null }) =>
    Promise<{ sessions: CloudSessionRow[]; nextCursor: string | null } | null>;
};

/** A message the chat still shows as its own row: not delivered, not taken back. */
export function queuedMessageOpen(message: Pick<CloudChatQueuedMessage, "state">): boolean {
  return message.state === "queued" || message.state === "sending" || message.state === "waiting_for_sign_in";
}

/** A send id the server takes (1 to 64 of `A-Za-z0-9_-`). */
export function newClientSendId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `send_${random.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64);
}
