import type { SessionMessage as ClaudeSdkSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { findClaudePromptIndex } from "./chatRerunLastTurn";

/**
 * Where a side chat forks a Claude session whose main chat is mid-turn.
 *
 * The side chat must start from finished turns only, so the fork keeps the
 * history up to the entry just before the running turn's prompt
 * (`resumeSessionAt`). The session file is read here rather than through the
 * Agent SDK's `getSessionMessages`, because that reads this process's Claude
 * home, and a chat on another Claude account keeps its sessions in its own.
 *
 * - `full`: the running turn's prompt is not in the file yet, so everything
 *   there is finished. Fork it whole.
 * - `cut`: fork through `uuid`.
 * - `no_finished_turn`: the running turn is the chat's first. There is nothing
 *   to fork yet.
 */
export type ClaudeSideChatCut =
  | { kind: "full" }
  | { kind: "cut"; uuid: string }
  | { kind: "no_finished_turn" };

type JsonlEntry = {
  uuid: string;
  parentUuid: string | null;
  type: string;
  isSidechain: boolean;
  message: unknown;
};

function parseEntries(jsonl: string): JsonlEntry[] {
  const entries: JsonlEntry[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.uuid !== "string" || !record.uuid) continue;
    const attachment = record.attachment && typeof record.attachment === "object"
      ? record.attachment as Record<string, unknown>
      : null;
    // A message that arrives while Claude Code is already working is stored
    // as a queued-command attachment, not a user entry, yet it is that turn's
    // prompt all the same.
    const queuedPrompt = record.type === "attachment" && attachment?.type === "queued_command"
      ? attachment.prompt
      : undefined;
    entries.push({
      uuid: record.uuid,
      parentUuid: typeof record.parentUuid === "string" && record.parentUuid ? record.parentUuid : null,
      type: queuedPrompt !== undefined ? "user" : typeof record.type === "string" ? record.type : "",
      isSidechain: record.isSidechain === true,
      message: queuedPrompt !== undefined ? { role: "user", content: queuedPrompt } : record.message ?? null,
    });
  }
  return entries;
}

/**
 * The conversation the session resumes: the chain from its last main-thread
 * message back to the root. A rewind or a compaction leaves other branches in
 * the file; they are not part of it.
 */
function mainChain(entries: readonly JsonlEntry[]): JsonlEntry[] {
  const byUuid = new Map(entries.map((entry) => [entry.uuid, entry]));
  let leaf: JsonlEntry | null = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (!entry.isSidechain && (entry.type === "user" || entry.type === "assistant")) {
      leaf = entry;
      break;
    }
  }
  const chain: JsonlEntry[] = [];
  const seen = new Set<string>();
  for (let cursor = leaf; cursor && !seen.has(cursor.uuid); cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) ?? null : null) {
    seen.add(cursor.uuid);
    chain.push(cursor);
  }
  return chain.reverse();
}

/** `runningPromptText` is the text ADE sent for the running turn (never its display text). */
export function claudeSideChatCut(jsonl: string, runningPromptText: string): ClaudeSideChatCut {
  const chain = mainChain(parseEntries(jsonl));
  const conversation = chain
    .map((entry, chainIndex) => ({ entry, chainIndex }))
    .filter(({ entry }) => entry.type === "user" || entry.type === "assistant");
  const messages = conversation.map(({ entry }) => ({
    type: entry.type,
    uuid: entry.uuid,
    message: entry.message,
    parent_tool_use_id: null,
  }) as unknown as ClaudeSdkSessionMessage);
  const promptIndex = findClaudePromptIndex(messages, runningPromptText);
  if (promptIndex < 0) return { kind: "full" };
  const chainIndex = conversation[promptIndex]!.chainIndex;
  if (chainIndex === 0 || promptIndex === 0) return { kind: "no_finished_turn" };
  return { kind: "cut", uuid: chain[chainIndex - 1]!.uuid };
}
