import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types/chat";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import { readTranscriptHistoryPage } from "./chatTranscriptHistoryPager";
import { readHistoryFileRange, readHistoryFileSize } from "../storage/historyCompression";

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
/**
 * Window read forward from a client's `sourceOffset` hint. One row, plus room
 * for a long one — the wire caps a stored result well below this.
 */
export const CHAT_TOOL_RESULT_HINT_MAX_BYTES = 2 * 1024 * 1024;

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
  /**
   * Exact transcript sequence of the row being expanded. Present, it is part
   * of the identity: a retry reuses the item id, so matching the id alone
   * answers an older row with a newer retry's result. Absent (an older
   * client), the newest match wins, which is the behaviour those clients
   * already have.
   */
  resultSequence?: number;
  /**
   * Timestamp of that same envelope, when the caller has it. `sequence` is not
   * unique over a transcript's whole life — older hosts restarted it at 1 on
   * every rehydration — so a legacy file can hold two generations under one
   * number. With both named, both must match. Sequence alone keeps the
   * newest-first scan, so the newest of a tie wins.
   */
  resultTimestamp?: string;
  /**
   * Byte offset the client saw this row at, from a `chat_history` page.
   *
   * The scan below is bounded to a fixed window back from the tail so an id
   * that is not in the file costs fixed I/O. A reader can page much further
   * back than that window, though, so a row they can see may sit outside it
   * and read as "no longer in the transcript". This hint turns that case into
   * one exact read. It is never trusted on its own: the row found there must
   * still match the id (and the generation, when named), and anything else
   * falls through to the scan.
   */
  sourceOffset?: number;
  signal?: AbortSignal;
}): Promise<ChatToolResultLookupHit | null> {
  const wantedId = options.itemId.trim();
  if (!wantedId) return null;
  const wantedSequence = typeof options.resultSequence === "number" && Number.isFinite(options.resultSequence)
    ? options.resultSequence
    : null;
  const wantedTimestamp = typeof options.resultTimestamp === "string" && options.resultTimestamp.trim()
    ? options.resultTimestamp.trim()
    : null;
  const hinted = await readHintedToolResult({
    transcriptPath: options.transcriptPath,
    sessionId: options.sessionId,
    sourceOffset: options.sourceOffset,
    wantedId,
    wantedSequence,
    wantedTimestamp,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (hinted) return hinted;

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
      // A named generation must match exactly. Answering with the nearest
      // other generation would be worse than "not found": the row would show
      // another attempt's output as its own.
      if (wantedSequence !== null && envelope.sequence !== wantedSequence) continue;
      // Legacy transcripts can repeat a sequence across host restarts, so the
      // timestamp disambiguates when the row names one. Sequence alone falls
      // back to this newest-first scan, where the newest of a tie wins.
      if (wantedTimestamp !== null && envelope.timestamp !== wantedTimestamp) continue;
      return { event, envelope };
    }
    scannedBytes += windowBytes;
    if (!read.hasMore) return null;
    if (scannedBytes >= CHAT_TOOL_RESULT_LOOKUP_MAX_BYTES) return null;
    beforeOffset = read.startOffset;
  }
  return null;
}

/**
 * The one row at `sourceOffset`, when the client told us where it saw it.
 *
 * Reads a single bounded window forward from that byte and takes the first
 * complete line, which is the row itself — the offsets the pager hands out
 * always land on a line start. Everything about the hit is then verified
 * against what was asked for, so a stale or misaligned hint returns null and
 * the caller scans as before rather than answering with the wrong row.
 */
async function readHintedToolResult(args: {
  transcriptPath: string;
  sessionId: string;
  sourceOffset: number | undefined;
  wantedId: string;
  wantedSequence: number | null;
  wantedTimestamp: string | null;
  signal?: AbortSignal;
}): Promise<ChatToolResultLookupHit | null> {
  const { sourceOffset } = args;
  if (typeof sourceOffset !== "number" || !Number.isFinite(sourceOffset) || sourceOffset < 0) {
    return null;
  }
  if (args.signal?.aborted) return null;
  try {
    const buffer = await readHistoryFileRange(
      args.transcriptPath,
      sourceOffset,
      CHAT_TOOL_RESULT_HINT_MAX_BYTES,
      args.signal,
    );
    const text = buffer.toString("utf8");
    const newline = text.indexOf("\n");
    // No terminator inside the window means the row is larger than the hint
    // budget; the scan reads it through the pager's own oversized-row path.
    if (newline < 0) return null;
    const line = text.slice(0, newline).trim();
    if (!line) return null;
    const [envelope] = parseAgentChatTranscript(line);
    if (!envelope) return null;
    // The hint names a byte in THIS session's file, so a row for another
    // session means the offset is stale or came from somewhere else.
    if (envelope.sessionId !== args.sessionId) return null;
    const event = envelope.event;
    if (!event || event.type !== "tool_result") return null;
    if (chatToolResultRowId(event) !== args.wantedId) return null;
    if (args.wantedSequence !== null && envelope.sequence !== args.wantedSequence) return null;
    if (args.wantedTimestamp !== null && envelope.timestamp !== args.wantedTimestamp) return null;
    return { event, envelope };
  } catch {
    // A bad hint is only ever a missed hint.
    return null;
  }
}
