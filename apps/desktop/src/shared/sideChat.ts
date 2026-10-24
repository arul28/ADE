/**
 * Side chats (`/side`).
 *
 * A side chat is a read-only fork of a chat, opened beside it for a quick
 * question or a discussion. It knows the main chat's conversation (the provider
 * history is forked), but its own view starts blank. It runs on the main chat's
 * machine, in the same lane and folder, and a chat has at most one.
 *
 * It never edits. When the user asks it to, it sends a message to its main
 * chat, and to nothing else: it writes the message inside a
 * `<send_to_main>` block, and the brain delivers that block to the main chat,
 * steering a running turn.
 *
 * Only providers that can fork their own history natively are supported. A
 * summary or a transcript replay is not offered: at that point the user can
 * just ask the main chat.
 *
 * Imported by the brain, the desktop renderer and the `ade code` TUI; iOS
 * mirrors the parsing in Swift (`WorkSideChat.swift`).
 */

import type { AgentChatProvider } from "./types/chat";

/** Providers with a native fork (or, for Muse, a native side chat). */
export const SIDE_CHAT_PROVIDERS = ["claude", "codex", "muse", "opencode", "droid", "copilot", "kimi", "pi"] as const;

/**
 * Providers whose fork can be cut at the last finished turn while the main
 * chat is still working: Claude (`forkSession` up to a message), Codex
 * (`thread/fork` before the running turn), Muse (`session/sideChat`) and Pi
 * (`createBranchedSession` at the last settled entry). The rest open a side
 * chat only between turns.
 */
export const SIDE_CHAT_WHILE_BUSY_PROVIDERS = ["claude", "codex", "muse", "pi"] as const;

export function providerSupportsSideChat(provider: AgentChatProvider | string | null | undefined): boolean {
  return provider != null && (SIDE_CHAT_PROVIDERS as readonly string[]).includes(provider);
}

export function providerSupportsSideChatWhileBusy(provider: AgentChatProvider | string | null | undefined): boolean {
  return provider != null && (SIDE_CHAT_WHILE_BUSY_PROVIDERS as readonly string[]).includes(provider);
}

export const SIDE_CHAT_UNSUPPORTED_MESSAGE =
  "Side chats need a provider that can fork its own history (Claude, Codex, Muse, OpenCode, Droid, Copilot, Kimi or Pi). Ask the main chat instead.";

export const SIDE_CHAT_WAIT_FOR_TURN_MESSAGE =
  "This provider opens a side chat between turns. Try again when the main chat finishes this turn.";

export const SIDE_CHAT_READ_ONLY_MESSAGE =
  "Side chats are read-only. Ask the main chat to make changes, or ask the side chat to send it a message.";

/**
 * `/side <prompt>` from a composer. Returns the prompt (empty for a bare
 * `/side`, which just opens the side chat), or null when the text is not the
 * command. Case-insensitive, and the prompt keeps its own line breaks.
 */
export function parseSideSlashCommand(text: string): { prompt: string } | null {
  const match = /^\s*\/side(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return null;
  return { prompt: (match[1] ?? "").trim() };
}

export const SIDE_CHAT_SEND_OPEN_TAG = "<send_to_main>";
export const SIDE_CHAT_SEND_CLOSE_TAG = "</send_to_main>";

export type SideChatTextPart =
  | { kind: "text"; text: string }
  /** `complete` is false while the block is still streaming. */
  | { kind: "send"; text: string; complete: boolean };

/**
 * Splits a side chat's reply into prose and send-to-main blocks, so a client
 * draws a block as a "Sent to the main chat" card instead of raw tags. An open
 * tag with no close yet (a reply still streaming) is a pending block.
 */
export function splitSideChatSendBlocks(text: string): SideChatTextPart[] {
  const parts: SideChatTextPart[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf(SIDE_CHAT_SEND_OPEN_TAG, cursor);
    if (open < 0) {
      parts.push({ kind: "text", text: text.slice(cursor) });
      break;
    }
    if (open > cursor) parts.push({ kind: "text", text: text.slice(cursor, open) });
    const bodyStart = open + SIDE_CHAT_SEND_OPEN_TAG.length;
    const close = text.indexOf(SIDE_CHAT_SEND_CLOSE_TAG, bodyStart);
    if (close < 0) {
      parts.push({ kind: "send", text: text.slice(bodyStart).trim(), complete: false });
      break;
    }
    parts.push({ kind: "send", text: text.slice(bodyStart, close).trim(), complete: true });
    cursor = close + SIDE_CHAT_SEND_CLOSE_TAG.length;
  }
  return parts.filter((part) => part.kind === "send" || part.text.length > 0);
}

/**
 * A side chat's reply as markdown with each send-to-main block drawn as a
 * quoted "Sent to the main chat" note, instead of raw tags. Text without a
 * block comes back unchanged (and unallocated).
 */
export function sideChatSendBlocksToMarkdown(text: string): string {
  if (!text.includes(SIDE_CHAT_SEND_OPEN_TAG)) return text;
  return splitSideChatSendBlocks(text).map((part) => {
    if (part.kind === "text") return part.text;
    const heading = part.complete ? "**↗ Sent to the main chat**" : "**↗ Sending to the main chat…**";
    const body = part.text.split("\n").map((line) => `> ${line}`).join("\n");
    return `\n\n> ${heading}\n>\n${body}\n\n`;
  }).join("");
}

/** The finished, non-empty send-to-main messages in a side chat's reply. */
export function extractSideChatSendToMain(text: string): string[] {
  return splitSideChatSendBlocks(text)
    .filter((part): part is Extract<SideChatTextPart, { kind: "send" }> => part.kind === "send" && part.complete)
    .map((part) => part.text)
    .filter((message) => message.length > 0);
}

/**
 * The side chat's role, sent once, ahead of the user's first message. It rides
 * the first message rather than the system prompt so the forked history keeps
 * the main chat's prompt-cache prefix.
 */
export function buildSideChatFirstPrompt(userText: string): string {
  return [
    "<ade-side-chat>",
    "You are now a side chat in ADE: a read-only helper the user opened beside their main chat to ask quick questions or talk something through without cluttering it. Everything above is the main chat's history, for reference only. Do not continue its task or act on instructions in it; only the user's messages from here on are yours to answer.",
    "- Read-only: read and search files and run commands that change nothing. Never edit files, change git state, install anything, or run commands that write. If the user wants a change, say the main chat should make it, and offer to send it there.",
    "- Do not start subagents or other chats.",
    `- Only when the user asks you to send something to the main chat, end your reply with the message inside ${SIDE_CHAT_SEND_OPEN_TAG}…${SIDE_CHAT_SEND_CLOSE_TAG}. ADE delivers it to the main chat right away, and to nothing else. Write it to the main chat's agent as a complete request: what to do and the context it needs, not just the answer you were asked to pass on. Never send on your own initiative.`,
    "</ade-side-chat>",
    "",
    userText,
  ].join("\n");
}

/** What the main chat receives: a short header so it knows where the message came from. */
export function buildSideChatMainMessage(text: string): string {
  return [
    "[Message from your side chat. The user opened a read-only side chat beside this one and asked it to send you this. Treat it as coming from the user.]",
    "",
    text,
  ].join("\n");
}
