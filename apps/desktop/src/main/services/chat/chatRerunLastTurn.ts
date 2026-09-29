import fs from "node:fs";
import type { SessionMessage as ClaudeSdkSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";

/**
 * The pure parts of "run the last user turn again" (`rerunLastTurn` in
 * `agentChatService.ts`): which message is the last turn, where the Claude SDK
 * session holds its prompt, and where the durable transcript is cut. The
 * service keeps only the orchestration.
 */

const READ_CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;
/** The part of the user's text a Claude prompt is matched on. */
const CLAUDE_PROMPT_MATCH_CHARS = 200;

type UserMessageEvent = Extract<AgentChatEvent, { type: "user_message" }>;

export type LastTurnUserMessage = {
  envelope: AgentChatEventEnvelope & { sequence: number };
  event: UserMessageEvent;
  /**
   * Whether the provider took the turn: a `status: started` that carries a
   * turn id, some output (text, reasoning, a tool or command, a file change),
   * or a `done` that did not fail follows the message. A turn the provider
   * accepted and then failed (a rate limit, a model error) counts. A send that
   * failed before the provider took it leaves only an `error`, a failed
   * `status` and a failed `done`, and there is then nothing to roll back.
   */
  delivered: boolean;
  /**
   * The turn's id: the message's own, else the first one the provider issued
   * (on a started `status` or on output). Null when none names one. A failed
   * send's `error`, `status` and `done` carry an id ADE made up, so they are
   * never read.
   */
  turnId: string | null;
};

const PROVIDER_OUTPUT_EVENT_TYPES: ReadonlySet<AgentChatEvent["type"]> = new Set([
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "command",
  "file_change",
  "web_search",
  "plan",
]);

/**
 * An event only a turn the provider took produces. A `status: started` counts
 * only with a turn id: the optimistic one a Codex send writes first has none,
 * and a real `turn/start` writes it again with the provider's id.
 */
function showsProviderTookTurn(event: AgentChatEvent): boolean {
  if (PROVIDER_OUTPUT_EVENT_TYPES.has(event.type)) return true;
  if (event.type === "status") return event.turnStatus === "started" && Boolean(event.turnId?.trim());
  return event.type === "done" && event.status !== "failed";
}

/**
 * The last user message that opened a turn. A steer rides inside its turn, so
 * it is not a turn of its own. Null when there is none, or when the message has
 * no `sequence` to cut the history at.
 */
export function findLastTurnUserMessage(envelopes: readonly AgentChatEventEnvelope[]): LastTurnUserMessage | null {
  for (let index = envelopes.length - 1; index >= 0; index -= 1) {
    const envelope = envelopes[index]!;
    const event = envelope.event;
    if (event.type !== "user_message" || event.steerId) continue;
    if (typeof envelope.sequence !== "number") return null;
    let turnId = event.turnId?.trim() || null;
    let delivered = false;
    for (let later = index + 1; later < envelopes.length && !(delivered && turnId); later += 1) {
      const laterEvent = envelopes[later]!.event;
      if (!showsProviderTookTurn(laterEvent)) continue;
      delivered = true;
      const candidate = (laterEvent as { turnId?: unknown }).turnId;
      if (!turnId && typeof candidate === "string" && candidate.trim()) turnId = candidate.trim();
    }
    return { envelope: envelope as LastTurnUserMessage["envelope"], event, delivered, turnId };
  }
  return null;
}

/** The content of a top-level Claude SDK user entry, or null for any other entry. */
function claudeSdkUserContent(message: ClaudeSdkSessionMessage): { content: unknown } | null {
  if (message.type !== "user" || message.parent_tool_use_id) return null;
  return { content: (message.message as { content?: unknown } | null)?.content };
}

/** The text of a Claude SDK user entry, or null for a tool result or an entry with no text. */
function claudeSdkUserPromptText(message: ClaudeSdkSessionMessage): string | null {
  const content = claudeSdkUserContent(message)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block) && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text);
  return parts.length ? parts.join("\n") : null;
}

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ");

/** A top-level user entry that is not only tool results: a prompt, with or without text. */
function isClaudeSdkUserPrompt(message: ClaudeSdkSessionMessage): boolean {
  const entry = claudeSdkUserContent(message);
  if (!entry) return false;
  const content = entry.content;
  if (!Array.isArray(content)) return true;
  return !content.every((block) =>
    Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "tool_result");
}

/**
 * The index of the last Claude SDK user entry that carried `promptText`, or -1.
 *
 * ADE wraps the user's text in context before Claude receives it, so the match
 * is on the start of the text ADE sent (the event's `text`, never its
 * `displayText`), with whitespace collapsed on both sides.
 *
 * An empty `promptText` (an attachment-only message) cannot be matched by
 * text, and any text entry could belong to an earlier turn. It matches only
 * the last prompt entry, and only when that entry has no text of its own;
 * otherwise -1.
 */
export function findClaudePromptIndex(messages: readonly ClaudeSdkSessionMessage[], promptText: string): number {
  const needle = collapseWhitespace(promptText).trim().slice(0, CLAUDE_PROMPT_MATCH_CHARS);
  if (!needle) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (!isClaudeSdkUserPrompt(message)) continue;
      return claudeSdkUserPromptText(message) == null ? index : -1;
    }
    return -1;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = claudeSdkUserPromptText(messages[index]!);
    if (text != null && collapseWhitespace(text).includes(needle)) return index;
  }
  return -1;
}

function envelopeSequence(line: Buffer): number | null {
  if (line.length === 0) return null;
  try {
    const parsed = JSON.parse(line.toString("utf8")) as { sequence?: unknown };
    return typeof parsed.sequence === "number" && Number.isFinite(parsed.sequence) ? parsed.sequence : null;
  } catch {
    return null;
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * The byte offset of the first line of an append-only JSONL transcript whose
 * envelope `sequence` is `fromSequence` or later.
 *
 * Reads backwards from the end in fixed chunks and stops at the first envelope
 * older than `fromSequence`, so the cost is the size of the tail, not of the
 * file. Lines with no `sequence` inside the tail belong to it. The offset is a
 * line start, so the part before it still ends with a newline.
 */
function findCutOffset(fd: number, fromSequence: number): number | null {
  let position = fs.fstatSync(fd).size;
  // Bytes of the line that continues past the start of the chunk read next.
  let carry = Buffer.alloc(0);
  let cut: number | null = null;
  while (position > 0) {
    const readSize = Math.min(READ_CHUNK_BYTES, position);
    position -= readSize;
    const chunk = Buffer.alloc(readSize);
    fs.readSync(fd, chunk, 0, readSize, position);
    const buffer = carry.length ? Buffer.concat([chunk, carry]) : chunk;
    let lineEnd = buffer.length;
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      if (buffer[index] !== NEWLINE) continue;
      const sequence = envelopeSequence(buffer.subarray(index + 1, lineEnd));
      if (sequence != null && sequence < fromSequence) return cut;
      if (sequence != null) cut = position + index + 1;
      lineEnd = index;
    }
    if (position === 0) {
      const sequence = envelopeSequence(buffer.subarray(0, lineEnd));
      if (sequence != null && sequence >= fromSequence) cut = 0;
    }
    carry = buffer.subarray(0, lineEnd);
  }
  return cut;
}

/**
 * Whether the plain transcript at `filePath` holds an envelope at or after
 * `fromSequence`. Opened for writing, as the cut will be, so a file the cut
 * could not change fails here, before anything changed. False when the file
 * does not exist; any other failure (a lock, a permission error) throws, so a
 * caller never mistakes "cannot cut" for "nothing to cut".
 */
export function transcriptHoldsSequenceSync(filePath: string, fromSequence: number): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r+");
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
  try {
    return findCutOffset(fd, fromSequence) != null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Cut the plain transcript at `filePath` back to just before its first
 * envelope at or after `fromSequence`.
 *
 * Returns the number of bytes removed, or null when the file does not exist or
 * holds no such envelope. Any other failure to open or cut throws.
 */
export function truncateTranscriptFromSequenceSync(filePath: string, fromSequence: number): number | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r+");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const cut = findCutOffset(fd, fromSequence);
    if (cut == null) return null;
    fs.ftruncateSync(fd, cut);
    return size - cut;
  } finally {
    fs.closeSync(fd);
  }
}
