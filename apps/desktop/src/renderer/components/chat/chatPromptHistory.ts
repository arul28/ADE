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

let sentPromptsCache: readonly SentPromptRecord[] | null = null;
const sentPromptListeners = new Set<() => void>();

function readSentPrompts(): readonly SentPromptRecord[] {
  if (sentPromptsCache) return sentPromptsCache;
  let parsed: SentPromptRecord[] = [];
  try {
    const raw = window.localStorage.getItem(SENT_PROMPTS_STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(value)) {
      parsed = value.filter((row): row is SentPromptRecord =>
        Boolean(row)
        && typeof row === "object"
        && typeof (row as SentPromptRecord).text === "string"
        && typeof (row as SentPromptRecord).at === "string");
    }
  } catch {
    parsed = [];
  }
  sentPromptsCache = parsed.slice(-SENT_PROMPTS_LIMIT);
  return sentPromptsCache;
}

function notifySentPromptListeners(): void {
  for (const listener of [...sentPromptListeners]) listener();
}

/** Add a sent prompt; sending the same text again moves it to the newest. */
export function recordSentPrompt(text: string): void {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > SENT_PROMPT_MAX_CHARS) return;
  const next = [
    ...readSentPrompts().filter((row) => row.text !== trimmed),
    { text: trimmed, at: new Date().toISOString() },
  ].slice(-SENT_PROMPTS_LIMIT);
  sentPromptsCache = next;
  try {
    window.localStorage.setItem(SENT_PROMPTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full store keeps the list for this window's life.
  }
  notifySentPromptListeners();
}

/** `useSyncExternalStore` source: this computer's sent prompts, oldest first. */
export function subscribeSentPrompts(listener: () => void): () => void {
  if (sentPromptListeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", handleSentPromptsStorage);
  }
  sentPromptListeners.add(listener);
  return () => {
    sentPromptListeners.delete(listener);
    if (sentPromptListeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", handleSentPromptsStorage);
    }
  };
}

export function getSentPromptsSnapshot(): readonly SentPromptRecord[] {
  return readSentPrompts();
}

/** Another ADE window sent a prompt. */
function handleSentPromptsStorage(event: StorageEvent): void {
  if (event.key !== SENT_PROMPTS_STORAGE_KEY) return;
  sentPromptsCache = null;
  notifySentPromptListeners();
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
): AgentChatPromptHistoryEntry[] {
  if (!sentPrompts.length) return chatPrompts as AgentChatPromptHistoryEntry[];
  const inChat = new Set(chatPrompts.map((entry) => entry.text.trim()));
  const others: AgentChatPromptHistoryEntry[] = [];
  for (const row of sentPrompts) {
    if (inChat.has(row.text)) continue;
    others.push({ text: row.text, eventKey: `sent#${row.at}#${row.text}`, fromOtherChat: true });
  }
  return others.length ? [...others, ...chatPrompts] : (chatPrompts as AgentChatPromptHistoryEntry[]);
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
