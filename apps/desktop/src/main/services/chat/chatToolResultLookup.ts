import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types/chat";
import { readTranscriptHistoryPage } from "./chatTranscriptHistoryPager";
import { readHistoryFileSize } from "../storage/historyCompression";

/**
 * Find one stored `tool_result` in a transcript by the id its row is keyed on.
 *
 * This backs the phone's "Show full result": the slim mobile wire sends a
 * bounded head slice of every tool result (`shared/chatMobileSlim.ts`), and the
 * full payload is fetched only for the row the user actually expanded.
 *
 * The scan runs BACKWARDS from the end of the file in the same byte windows the
 * history pager already uses, because a result the user can see is a result
 * near the tail — the snapshot that delivered the slice is itself a tail read.
 * It is bounded twice over (a byte budget and a page count) so a request for an
 * id that is not there costs a fixed amount of I/O instead of a full file read.
 *
 * Reading from the transcript rather than from a live in-memory index is
 * deliberate: the transcript is what survives a restart, and a tool result the
 * phone can see in its own history must still be fetchable hours later.
 */
export const CHAT_TOOL_RESULT_LOOKUP_MAX_BYTES = 8 * 1024 * 1024;
export const CHAT_TOOL_RESULT_LOOKUP_MAX_PAGES = 32;

export type ChatToolResultLookupHit = {
  event: Extract<AgentChatEvent, { type: "tool_result" }>;
  envelope: AgentChatEventEnvelope;
};

/** The id a tool_call/tool_result pair is correlated on, everywhere. */
export function chatToolResultRowId(event: AgentChatEvent): string | null {
  if (event.type !== "tool_result") return null;
  const logical = typeof event.logicalItemId === "string" ? event.logicalItemId.trim() : "";
  if (logical) return logical;
  const itemId = typeof event.itemId === "string" ? event.itemId.trim() : "";
  return itemId || null;
}

export async function findStoredToolResult(options: {
  transcriptPath: string;
  sessionId: string;
  itemId: string;
  signal?: AbortSignal;
}): Promise<ChatToolResultLookupHit | null> {
  const wantedId = options.itemId.trim();
  if (!wantedId) return null;
  let beforeOffset = await readHistoryFileSize(options.transcriptPath);
  let scannedBytes = 0;
  for (let page = 0; page < CHAT_TOOL_RESULT_LOOKUP_MAX_PAGES; page += 1) {
    if (options.signal?.aborted) return null;
    if (beforeOffset <= 0) return null;
    const read = await readTranscriptHistoryPage({
      transcriptPath: options.transcriptPath,
      sessionId: options.sessionId,
      beforeOffset,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // The pager guarantees `startOffset < beforeOffset` whenever there is
    // anything left to read, so this loop always terminates.
    const windowBytes = Math.max(0, beforeOffset - read.startOffset);
    // Newest first within the page: the match the user tapped is the newest
    // one for that id, and an id can legitimately repeat after a retry.
    for (let index = read.envelopes.length - 1; index >= 0; index -= 1) {
      const envelope = read.envelopes[index]!;
      const event = envelope.event;
      if (!event || event.type !== "tool_result") continue;
      if (chatToolResultRowId(event) !== wantedId) continue;
      return { event, envelope };
    }
    scannedBytes += windowBytes;
    if (!read.hasMore) return null;
    if (scannedBytes >= CHAT_TOOL_RESULT_LOOKUP_MAX_BYTES) return null;
    beforeOffset = read.startOffset;
  }
  return null;
}
