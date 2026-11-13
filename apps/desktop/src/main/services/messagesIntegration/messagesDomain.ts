import { extractSignInCode } from "../messages/messageCodes";
import { captureError } from "../../../shared/sentry/capture";
import { cardWasDeclined, type CardRequestChatInput } from "../chat/chatCardRequest";
import { AdeExpectedError } from "../../../shared/expectedError";
import { MESSAGES_SEND_APPROVAL_METADATA_KEY } from "../../../shared/messagesSendApproval";
import type { MessagesIntegrationStatus } from "../../../shared/types/messagesIntegration";
import type { ChatRecord, MessageRecord, ReadRecentMessagesOptions } from "../messages";

/**
 * The brain's `messages` domain: what `ade messages …` and `ade code wait`
 * run. The texts themselves are read and sent by the desktop that the person
 * sits at (the browser bridge's `messages*` methods, which a cloud lane's
 * brain reaches on the person's Mac). Here: the send approval card, and
 * waiting for a sign-in code.
 */

export type MessagesBridge = {
  messagesStatus(): Promise<MessagesIntegrationStatus>;
  messagesRecent(input: ReadRecentMessagesOptions): Promise<MessageRecord[]>;
  messagesChats(input: { limit?: number }): Promise<ChatRecord[]>;
  messagesSend(input: { to: string; text: string }): Promise<{ sent: true; to: string }>;
};

const DEFAULT_CODE_WAIT_MS = 2 * 60_000;
const MAX_CODE_WAIT_MS = 10 * 60_000;
const POLL_MS = 2_000;
/** A code that arrived just before the ask still counts (the site often sends it first). */
const CODE_LOOKBACK_MS = 30_000;
/** The longest text an agent may send; the approval card shows every character of it. */
const MAX_TEXT_CHARS = 4_000;

/** `ade messages recent`'s arguments, read once. */
function recentOptions(args: unknown): ReadRecentMessagesOptions {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  return {
    ...(typeof input.sinceMs === "number" ? { sinceMs: input.sinceMs } : {}),
    ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
    ...(typeof input.handle === "string" && input.handle.trim() ? { handle: input.handle.trim() } : {}),
    ...(typeof input.chatGuid === "string" && input.chatGuid.trim() ? { chatGuid: input.chatGuid.trim() } : {}),
    ...(input.fromMeToo === true ? { fromMeToo: true } : {}),
  };
}

export function buildMessagesDomain(deps: {
  bridge: MessagesBridge;
  requestChatInput: CardRequestChatInput | null;
  /** The saved login's authenticator, when the site has one (`passwords.code`). */
  /** The site's saved authenticator code; `username` picks the account when the site has several. */
  authenticatorCode?: (site: string, username: string | null) => Promise<{ code: string; secondsLeft: number; site: string } | null>;
}) {
  const now = () => Date.now();
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  return {
    status: () => deps.bridge.messagesStatus(),
    recent: (args?: unknown) => deps.bridge.messagesRecent(recentOptions(args)),
    chats: (args?: unknown) => deps.bridge.messagesChats({ limit: typeof (args as { limit?: unknown })?.limit === "number" ? (args as { limit: number }).limit : 20 }),

    /** One text: asked on a card in the agent's chat first, unless the person turned on Send Without Asking. */
    async send(args?: unknown): Promise<{ sent: boolean; to: string; declined?: true }> {
      const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
      const to = typeof input.to === "string" ? input.to.trim() : "";
      const text = typeof input.text === "string" ? input.text : "";
      if (!to || !text.trim()) throw new AdeExpectedError("A text needs --to (phone number or email) and the message.", "user");
      if (text.length > MAX_TEXT_CHARS) throw new AdeExpectedError("That text is too long (4,000 characters at most).", "user");
      const status = await deps.bridge.messagesStatus();
      if (!status.sendWithoutAsking) {
        const chatSessionId = typeof input.chatSessionId === "string" ? input.chatSessionId : "";
        if (!chatSessionId || !deps.requestChatInput) {
          throw new AdeExpectedError("Sending a text needs the person's approval in a chat. Run `ade messages send` from inside an ADE chat.", "user");
        }
        const response = await deps.requestChatInput({
          chatSessionId,
          title: `Send a text to ${to}?`,
          // The whole text: what the person approves is exactly what is sent.
          body: text,
          timeoutMs: 30 * 60_000,
          allowsFreeform: false,
          eventDescription: `Text to ${to}`,
          providerMetadata: { [MESSAGES_SEND_APPROVAL_METADATA_KEY]: { to, text } },
          questions: [{
            id: "messages_send",
            header: "Messages",
            question: `Send this text to ${to}?\n\n${text}`,
            allowsFreeform: false,
            options: [
              { label: "Send", value: "send", recommended: true },
              { label: "Don't send", value: "cancel" },
            ],
          }],
        });
        if (response.timedOut || cardWasDeclined(response) || response.answers.messages_send?.[0] !== "send") {
          return { sent: false, to, declined: true };
        }
      }
      return await deps.bridge.messagesSend({ to, text });
    },

    /**
     * Wait for a sign-in code: the site's saved authenticator when it has one
     * (`from` any or authenticator), else the newest code texted after the ask.
     */
    async codeWait(args?: unknown): Promise<{ code: string; source: "authenticator" | "messages"; from?: string | null; receivedAt?: string; secondsLeft?: number }> {
      const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
      const site = typeof input.site === "string" && input.site.trim() ? input.site.trim().toLowerCase() : null;
      const username = typeof input.username === "string" && input.username.trim() ? input.username.trim() : null;
      const from = input.from === "messages" || input.from === "authenticator" ? input.from : "any";
      const waitMs = Math.min(Math.max(typeof input.timeoutMs === "number" ? input.timeoutMs : DEFAULT_CODE_WAIT_MS, 5_000), MAX_CODE_WAIT_MS);
      if (site && from !== "messages" && deps.authenticatorCode) {
        const saved = await deps.authenticatorCode(site, username).catch((error: unknown) => {
          // Falls through to the texted code.
          captureError(error, { tags: { area: "passwords", op: "code_authenticator" } });
          return null;
        });
        if (saved) return { code: saved.code, source: "authenticator", secondsLeft: saved.secondsLeft };
        if (from === "authenticator") throw new AdeExpectedError(`No saved authenticator for ${site}.`, "user");
      }
      const asked = typeof input.sinceMs === "number" ? input.sinceMs : now();
      const sinceMs = asked - CODE_LOOKBACK_MS;
      const siteWord = site ? site.replace(/^www\./, "").split(".")[0] : null;
      const deadline = now() + waitMs;
      for (;;) {
        const rows = (await deps.bridge.messagesRecent({ sinceMs, limit: 30 })).filter((row) => !row.fromMe && row.text);
        // A text that names the site first, then any text with a code; newest first.
        const ordered = siteWord
          ? [...rows.filter((row) => row.text.toLowerCase().includes(siteWord)), ...rows]
          : rows;
        for (const row of ordered) {
          const found = extractSignInCode(row.text);
          if (found) {
            return {
              code: found.code,
              source: "messages",
              from: row.handle,
              ...(row.date ? { receivedAt: row.date } : {}),
            };
          }
        }
        if (now() >= deadline) {
          throw new AdeExpectedError(`No code arrived in Messages${site ? ` for ${site}` : ""} within ${Math.round(waitMs / 1000)} s.`, "user");
        }
        await sleep(POLL_MS);
      }
    },
  };
}
