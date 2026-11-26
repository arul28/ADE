import { createContext, useContext } from "react";
import { captureError } from "../../../shared/sentry/capture";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";

export type AgentChatPromptHistoryEntry = {
  text: string;
  eventKey: string;
  /**
   * Sent from another chat (this computer's prompt list). It has no row in
   * the open transcript, so recalling it scrolls nothing.
   */
  fromOtherChat?: true;
};

/**
 * Stable identity shared by the composer and transcript rows for a sent user
 * message. Do not serialize the whole event here: transcript rendering may
 * add display-only metadata to a row (for example, a resolved steer receipt)
 * without changing the underlying prompt.
 */
export function promptHistoryEventKey(entry: {
  timestamp: string;
  event: Extract<AgentChatEvent, { type: "user_message" }>;
}): string {
  const messageId = entry.event.messageId?.trim();
  if (messageId) return `${entry.timestamp}#user_message#message:${messageId}`;
  const steerId = entry.event.steerId?.trim();
  if (steerId) return `${entry.timestamp}#user_message#steer:${steerId}`;
  const turnId = entry.event.turnId?.trim();
  if (turnId) return `${entry.timestamp}#user_message#turn:${turnId}#${entry.event.text}`;
  // Older transcripts may not have any runtime identity. The envelope
  // timestamp plus the canonical prompt text is the least lossy fallback and
  // remains unchanged when the renderer decorates the row.
  return `${entry.timestamp}#user_message#text:${entry.event.text}`;
}

/** Collect only visible, delivered prompts from the transcript passed in. */
export function collectAgentChatPromptHistory(
  events: readonly AgentChatEventEnvelope[],
): AgentChatPromptHistoryEntry[] {
  return events.flatMap((envelope) => {
    const event = envelope.event;
    if (event.type !== "user_message") return [];
    if (event.deliveryState === "queued" && event.steerId) return [];
    if (event.metadata?.hideFullPrompt === true && !event.displayText?.trim()) return [];
    // ADE's hand-off to a rebuilt thread was never typed by the user.
    if (event.metadata?.kind === "continuity_recovery") return [];
    const displayText = event.displayText?.trim();
    const text = displayText?.length ? displayText : event.text.trim();
    if (!text) return [];
    return [{ text, eventKey: promptHistoryEventKey({ timestamp: envelope.timestamp, event }) }];
  });
}

/**
 * Every prompt sent from this computer, newest last, for ↑/↓ recall and
 * Ctrl+R search across chats. A chat's own transcript stays the source for
 * its own prompts (it also holds what was sent from a phone or another
 * computer); this list adds what was sent in every other chat. Kept in this
 * computer's localStorage only: prompts are private text, and nothing here
 * is worth sending to a server.
 */
type SentPromptRecord = { text: string; at: string };

const SENT_PROMPTS_STORAGE_KEY = "ade.chat.sentPrompts.v1";
const SENT_PROMPTS_LIMIT = 300;
/** A prompt longer than this is kept whole in its chat, not in the list. */
const SENT_PROMPT_MAX_CHARS = 20_000;

const EMPTY_SENT_PROMPTS: readonly SentPromptRecord[] = [];
const SENT_PROMPTS_MAX_CHARS = 500_000;

function capSentPrompts(rows: readonly SentPromptRecord[]): SentPromptRecord[] {
  let chars = 0;
  let first = rows.length;
  while (first > 0 && rows.length - first < SENT_PROMPTS_LIMIT) {
    chars += rows[first - 1]!.text.length;
    if (chars > SENT_PROMPTS_MAX_CHARS) break;
    first--;
  }
  return rows.slice(first);
}

export function createSentPromptHistory(storageKey: string | null) {
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_SENT_PROMPTS;
  let lastRaw: string | null | undefined;

  function refresh() {
    if (!storageKey || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === lastRaw) return;
      lastRaw = raw;
      const value: unknown = raw ? JSON.parse(raw) : [];
      snapshot = Array.isArray(value)
        ? capSentPrompts(value.filter((row): row is SentPromptRecord =>
          typeof row?.text === "string" && typeof row?.at === "string"))
        : EMPTY_SENT_PROMPTS;
    } catch (error) {
      snapshot = EMPTY_SENT_PROMPTS;
      captureError(error, { handled: true, fingerprint: ["prompt-history-read"] });
    }
  }

  function onStorage(event: StorageEvent) {
    if (event.key !== storageKey && event.key !== null) return;
    const previous = snapshot;
    refresh();
    if (snapshot !== previous) listeners.forEach((listener) => listener());
  }

  return {
    getSnapshot() {
      if (!listeners.size) refresh();
      return snapshot;
    },
    subscribe(listener: () => void) {
      if (!storageKey || typeof window === "undefined") return () => {};
      if (!listeners.size) {
        window.addEventListener("storage", onStorage);
        refresh();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) window.removeEventListener("storage", onStorage);
      };
    },
    record(text: string) {
      const trimmed = text.trim();
      if (!storageKey || !trimmed || trimmed.length > SENT_PROMPT_MAX_CHARS) return;
      const write = () => {
        // A window may have missed storage events while its composer was closed.
        refresh();
        snapshot = capSentPrompts([
          ...snapshot.filter((row) => row.text !== trimmed),
          { text: trimmed, at: new Date().toISOString() },
        ]);
        try {
          const raw = JSON.stringify(snapshot);
          window.localStorage.setItem(storageKey, raw);
          lastRaw = raw;
        } catch (error) {
          captureError(error, { handled: true, fingerprint: ["prompt-history-write"] });
        }
        listeners.forEach((listener) => listener());
      };
      // Serialize read-modify-write across windows when the browser supports it.
      if (window.navigator.locks) {
        void window.navigator.locks.request(storageKey, write).catch((error: unknown) => {
          captureError(error, { handled: true, fingerprint: ["prompt-history-lock"] });
        });
      } else {
        write();
      }
    },
  };
}

export const SentPromptHistoryContext = createContext(createSentPromptHistory(SENT_PROMPTS_STORAGE_KEY));

export function createAccountSentPromptHistory(accountId: string | null) {
  // The legacy web key is unowned and cannot be attributed safely.
  return createSentPromptHistory(accountId ? `${SENT_PROMPTS_STORAGE_KEY}:account:${encodeURIComponent(accountId)}` : null);
}

export function useSentPromptHistory() {
  return useContext(SentPromptHistoryContext);
}

/**
 * The list ↑ walks, oldest first: other chats' prompts, then this chat's.
 * ↑ therefore goes through this chat's prompts first (newest to oldest) and
 * then on into the rest of this computer's history, as a terminal's shell
 * history does. A prompt already in this chat is not repeated.
 */
export function mergePromptHistory(
  chatPrompts: readonly AgentChatPromptHistoryEntry[],
  sentPrompts: readonly SentPromptRecord[],
): readonly AgentChatPromptHistoryEntry[] {
  if (!sentPrompts.length) return chatPrompts;
  const inChat = new Set(chatPrompts.map((entry) => entry.text.trim()));
  const others: AgentChatPromptHistoryEntry[] = [];
  for (const row of sentPrompts) {
    if (inChat.has(row.text)) continue;
    others.push({ text: row.text, eventKey: `sent#${row.at}#${row.text}`, fromOtherChat: true });
  }
  return others.length ? [...others, ...chatPrompts] : chatPrompts;
}

/**
 * Opens prompt search from the composer. Ctrl+R as in a shell, Claude Code
 * and Codex; on Windows and Linux the window menu owns Ctrl+R (reload), so
 * there it is Ctrl+Shift+R.
 */
export function isPromptSearchShortcut(
  event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  mac: boolean,
): boolean {
  if (event.key.toLowerCase() !== "r" || !event.ctrlKey || event.metaKey || event.altKey) return false;
  return mac ? !event.shiftKey : event.shiftKey;
}

export function promptSearchShortcutLabel(mac: boolean): string {
  return mac ? "Ctrl+R" : "Ctrl+Shift+R";
}
