import { extractSignInCode } from "../messages/messageCodes";
import { cardWasDeclined, type CardRequestChatInput } from "../chat/chatCardRequest";
import { AdeExpectedError } from "../../../shared/expectedError";
import { MESSAGES_SEND_APPROVAL_METADATA_KEY } from "../../../shared/messagesSendApproval";
import type { MessagesIntegrationStatus } from "../../../shared/types/messagesIntegration";

/**
 * The brain's `messages` domain: what `ade messages …` and `ade code wait`
 * run. The texts themselves are read and sent by the desktop that the person
 * sits at (the browser bridge's `messages*` methods, which a cloud lane's
 * brain reaches on the person's Mac). Here: the send approval card, and
 * waiting for a sign-in code.
 */

export type MessagesBridge = {
  messagesStatus(): Promise<MessagesIntegrationStatus>;
  messagesRecent(input: Record<string, unknown>): Promise<unknown>;
  messagesChats(input: { limit?: number }): Promise<unknown>;
  messagesSend(input: { to: string; text: string }): Promise<{ sent: true; to: string }>;
};

type MessageRow = { text?: unknown; date?: unknown; fromMe?: unknown; handle?: unknown };

const DEFAULT_CODE_WAIT_MS = 2 * 60_000;
const MAX_CODE_WAIT_MS = 10 * 60_000;
const POLL_MS = 2_000;
/** A code that arrived just before the ask still counts (the site often sends it first). */
const CODE_LOOKBACK_MS = 30_000;
const MAX_TEXT_CHARS = 1_000;

function rowsOf(value: unknown): MessageRow[] {
  if (Array.isArray(value)) return value as MessageRow[];
  if (value && typeof value === "object" && Array.isArray((value as { messages?: unknown }).messages)) {
    return (value as { messages: MessageRow[] }).messages;
  }
  return [];
}

export function buildMessagesDomain(deps: {
  bridge: MessagesBridge;
  requestChatInput: CardRequestChatInput | null;
  /** The saved login's authenticator, when the site has one (`passwords.code`). */
  authenticatorCode?: (site: string) => Promise<{ code: string; secondsLeft: number; site: string } | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    status: () => deps.bridge.messagesStatus(),
    recent: (args?: unknown) => deps.bridge.messagesRecent(args && typeof args === "object" ? args as Record<string, unknown> : {}),
    chats: (args?: unknown) => deps.bridge.messagesChats({ limit: typeof (args as { limit?: unknown })?.limit === "number" ? (args as { limit: number }).limit : 20 }),

    /** One text: asked on a card in the agent's chat first, unless the person turned on Send Without Asking. */
    async send(args?: unknown): Promise<{ sent: boolean; to: string; declined?: true }> {
      const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
      const to = typeof input.to === "string" ? input.to.trim() : "";
      const text = typeof input.text === "string" ? input.text : "";
      if (!to || !text.trim()) throw new AdeExpectedError("A text needs --to (phone number or email) and the message.", "user");
      if (text.length > 4_000) throw new AdeExpectedError("That text is too long (4,000 characters at most).", "user");
      const status = await deps.bridge.messagesStatus();
      if (!status.sendWithoutAsking) {
        const chatSessionId = typeof input.chatSessionId === "string" ? input.chatSessionId : "";
        if (!chatSessionId || !deps.requestChatInput) {
          throw new AdeExpectedError("Sending a text needs the person's approval in a chat. Run `ade messages send` from inside an ADE chat.", "user");
        }
        const shown = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
        const response = await deps.requestChatInput({
          chatSessionId,
          title: `Send a text to ${to}?`,
          body: shown,
          timeoutMs: 30 * 60_000,
          allowsFreeform: false,
          eventDescription: `Text to ${to}`,
          providerMetadata: { [MESSAGES_SEND_APPROVAL_METADATA_KEY]: { to, text: shown } },
          questions: [{
            id: "messages_send",
            header: "Messages",
            question: `Send this text to ${to}?\n\n${shown}`,
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
      const from = input.from === "messages" || input.from === "authenticator" ? input.from : "any";
      const waitMs = Math.min(Math.max(typeof input.timeoutMs === "number" ? input.timeoutMs : DEFAULT_CODE_WAIT_MS, 5_000), MAX_CODE_WAIT_MS);
      if (site && from !== "messages" && deps.authenticatorCode) {
        const saved = await deps.authenticatorCode(site).catch(() => null);
        if (saved) return { code: saved.code, source: "authenticator", secondsLeft: saved.secondsLeft };
        if (from === "authenticator") throw new AdeExpectedError(`No saved authenticator for ${site}.`, "user");
      }
      const asked = typeof input.sinceMs === "number" ? input.sinceMs : now();
      const sinceMs = asked - CODE_LOOKBACK_MS;
      const siteWord = site ? site.replace(/^www\./, "").split(".")[0] : null;
      const deadline = now() + waitMs;
      for (;;) {
        const rows = rowsOf(await deps.bridge.messagesRecent({ sinceMs, limit: 30 }))
          .filter((row) => row.fromMe !== true && typeof row.text === "string");
        // A text that names the site first, then any text with a code; newest first.
        const ordered = siteWord
          ? [...rows.filter((row) => String(row.text).toLowerCase().includes(siteWord)), ...rows]
          : rows;
        for (const row of ordered) {
          const found = extractSignInCode(String(row.text));
          if (found) {
            return {
              code: found.code,
              source: "messages",
              from: typeof row.handle === "string" ? row.handle : null,
              ...(typeof row.date === "string" ? { receivedAt: row.date } : {}),
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
