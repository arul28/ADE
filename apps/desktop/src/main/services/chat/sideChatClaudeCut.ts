import { findClaudePromptIndex, type ClaudePromptEntry } from "./chatRerunLastTurn";
import { sessionEntryChain } from "./sessionEntryChain";

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

/** `runningPromptText` is the text ADE sent for the running turn (never its display text). */
export function claudeSideChatCut(jsonl: string, runningPromptText: string): ClaudeSideChatCut {
  // A rewind or a compaction leaves other branches in the file; the leaf is
  // the last main-thread message.
  const chain = sessionEntryChain(
    parseEntries(jsonl),
    (entry) => entry.uuid,
    (entry) => entry.parentUuid,
    (entry) => !entry.isSidechain && (entry.type === "user" || entry.type === "assistant"),
  );
  const conversation = chain
    .map((entry, chainIndex) => ({ entry, chainIndex }))
    .filter(({ entry }) => entry.type === "user" || entry.type === "assistant");
  const messages: ClaudePromptEntry[] = conversation.map(({ entry }) => ({
    type: entry.type as ClaudePromptEntry["type"],
    message: entry.message,
    parent_tool_use_id: null,
  }));
  const promptIndex = findClaudePromptIndex(messages, runningPromptText);
  if (promptIndex < 0) return { kind: "full" };
  const chainIndex = conversation[promptIndex]!.chainIndex;
  if (chainIndex === 0 || promptIndex === 0) return { kind: "no_finished_turn" };
  return { kind: "cut", uuid: chain[chainIndex - 1]!.uuid };
}
