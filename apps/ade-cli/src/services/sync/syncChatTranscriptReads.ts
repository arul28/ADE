import fs from "node:fs";
import path from "node:path";
import type {
  AgentChatEventEnvelope,
  AgentChatEventHistoryPage,
} from "../../../../desktop/src/shared/types";
import { parseAgentChatTranscript } from "../../../../desktop/src/shared/chatTranscript";
import {
  readHistoryFileRange,
  readHistoryFileSize,
  resolveReadableHistoryPath,
} from "../../../../desktop/src/main/services/storage/historyCompression";
import {
  readTranscriptHistoryPage,
  readTranscriptHistoryPageBeforeSequence,
} from "../../../../desktop/src/main/services/chat/chatTranscriptHistoryPager";

/**
 * Transcript reads shared by every sync ingress that serves a chat straight
 * from its JSONL file: the project sync host (personal and cross-project
 * subscriptions) and the brain fallback handler (which has no project runtime
 * at all). One implementation, so a roster socket parked on the fallback gets
 * byte-for-byte the pages and live rows a project host would send.
 */

export const SYNC_HOST_CHAT_TRANSCRIPT_DELTA_MAX_BYTES = 128 * 1024;
export const SYNC_HOST_CHAT_TRANSCRIPT_MAX_RECORD_BYTES = 2 * 1024 * 1024;

/**
 * The storage identity of a transcript, independent of whether it is currently
 * compressed. The history compressor swaps `<id>.jsonl` for `<id>.jsonl.gz`
 * (and a new turn reinflates it), so a path captured at subscribe time and one
 * resolved later can differ only by that suffix and still name the same log.
 */
export function transcriptStorageKey(transcriptPath: string): string {
  const resolved = path.resolve(transcriptPath);
  return resolved.endsWith(".gz") ? resolved.slice(0, -3) : resolved;
}

/**
 * The file to read right now for a transcript captured earlier: the plain
 * append target when it exists, else its gzip replacement, else the captured
 * path unchanged (a session registered before its first write).
 */
export function currentReadableTranscriptPath(transcriptPath: string): string {
  return resolveReadableHistoryPath(transcriptPath) ?? transcriptPath;
}

/** Logical (decompressed) size of a transcript, trying its gzip sibling too. */
export async function readTranscriptLogicalSize(transcriptPath: string | null): Promise<number> {
  if (!transcriptPath) return 0;
  const candidates = transcriptPath.endsWith(".gz")
    ? [transcriptPath]
    : [transcriptPath, `${transcriptPath}.gz`];
  for (const candidate of candidates) {
    try {
      return await readHistoryFileSize(candidate);
    } catch {
      // A session row normally points at the plain append target even after
      // storage compression. Try its transparent gzip sibling next.
    }
  }
  return 0;
}

/**
 * Reads a byte-capped TAIL snapshot of a chat transcript straight off disk —
 * the file-backed analogue of agentChatService.getChatEventHistory, used when
 * the session lives in a project this ingress has no runtime for. A leading
 * partial line at the cut point is dropped.
 */
export async function readTranscriptTailSnapshot(
  transcriptPath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{
  events: AgentChatEventEnvelope[];
  transcriptSize: number;
  truncated: boolean;
  tailStartOffset: number;
}> {
  try {
    const size = await readHistoryFileSize(transcriptPath);
    const start = Math.max(0, size - Math.max(1_024, maxBytes));
    if (size <= start) {
      return { events: [], transcriptSize: size, truncated: false, tailStartOffset: 0 };
    }
    const out = await readHistoryFileRange(
      transcriptPath,
      start,
      size - start,
      signal,
    );
    // Drop a leading partial line when starting mid-file so the parser never
    // sees a truncated JSON object as the first record. The first complete
    // line's logical offset becomes the paging seam; a page ending there can
    // recover the dropped straddling record without a gap.
    let sliceStart = 0;
    if (start > 0) {
      const firstNewline = out.indexOf(0x0a);
      sliceStart = firstNewline >= 0 ? firstNewline + 1 : out.length;
    }
    const raw = out.subarray(sliceStart).toString("utf8");
    const tailStartOffset = start + sliceStart;
    return {
      events: parseAgentChatTranscript(raw),
      transcriptSize: size,
      truncated: tailStartOffset > 0,
      tailStartOffset,
    };
  } catch (error) {
    signal?.throwIfAborted();
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      // The resolver already authorized and sandboxed this path. A session
      // may be registered just before its transcript is created (or rotate
      // between stat/read), so keep the subscription live and let the pump
      // discover the file when it appears.
      return { events: [], transcriptSize: 0, truncated: false, tailStartOffset: 0 };
    }
    throw error;
  }
}

/**
 * One older page of a subscribed transcript, by durable sequence
 * (`beforeSequence`, chatLogV2) or by byte cursor (`beforeOffset`). Reads
 * whichever file currently holds the log, so a transcript that was compressed
 * or reinflated since the subscribe still pages.
 */
export async function readSubscribedTranscriptHistoryPage(args: {
  transcriptPath: string;
  sessionId: string;
  beforeOffset: number;
  beforeSequence: number | null;
  maxBytes?: number | null;
  signal?: AbortSignal;
}): Promise<AgentChatEventHistoryPage> {
  const transcriptPath = currentReadableTranscriptPath(args.transcriptPath);
  const read = args.beforeSequence != null
    ? await readTranscriptHistoryPageBeforeSequence({
      transcriptPath,
      sessionId: args.sessionId,
      beforeSequence: args.beforeSequence,
      maxBytes: args.maxBytes,
      ...(args.signal ? { signal: args.signal } : {}),
    })
    : await readTranscriptHistoryPage({
      transcriptPath,
      sessionId: args.sessionId,
      beforeOffset: args.beforeOffset,
      maxBytes: args.maxBytes,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  return {
    sessionId: args.sessionId,
    events: read.envelopes,
    startOffset: read.startOffset,
    // Per-row locations, so a later `chat_tool_result` for a row on this page
    // can be answered by an exact read instead of a scan that may not reach
    // back this far.
    envelopeStartOffsets: read.envelopeStartOffsets,
    hasMore: read.hasMore,
    sessionFound: true,
  };
}

/**
 * Bounded incremental read of complete JSONL rows appended since
 * `startOffset` — the live-tail half of a file-backed chat subscription.
 * `scanOffset` carries a bounded scan for the newline of one oversized row.
 */
export async function readChatTranscriptEventsSince(
  transcriptPath: string,
  startOffset: number,
  scanOffset: number | null,
): Promise<{
  events: AgentChatEventEnvelope[];
  nextOffset: number;
  nextScanOffset: number | null;
  droppedOversizedRecordBytes: number | null;
}> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(transcriptPath, "r");
    const stat = await fh.stat();
    const size = stat.size;
    const durableStart = Math.max(0, Math.floor(startOffset));
    // A truncation/rotation invalidates both cursors. Restart from the new
    // EOF (the same recovery behavior as the old unbounded reader).
    if (size < durableStart || (scanOffset != null && size < scanOffset)) {
      return {
        events: [],
        nextOffset: size,
        nextScanOffset: null,
        droppedOversizedRecordBytes: null,
      };
    }
    const normalizedScanOffset = scanOffset == null
      ? null
      : Math.max(durableStart, Math.floor(scanOffset));
    const readStart = normalizedScanOffset ?? durableStart;
    if (size <= readStart) {
      return {
        events: [],
        nextOffset: durableStart,
        nextScanOffset: normalizedScanOffset,
        droppedOversizedRecordBytes: null,
      };
    }

    const readLength = Math.min(
      size - readStart,
      SYNC_HOST_CHAT_TRANSCRIPT_DELTA_MAX_BYTES,
    );
    const out = Buffer.alloc(readLength);
    const { bytesRead } = await fh.read(out, 0, out.length, readStart);
    const readSlice = out.subarray(0, bytesRead);
    if (normalizedScanOffset != null) {
      const firstNewline = readSlice.indexOf(0x0a);
      if (firstNewline < 0) {
        return {
          events: [],
          nextOffset: durableStart,
          nextScanOffset: readStart + bytesRead,
          droppedOversizedRecordBytes: null,
        };
      }
      const firstRecordEnd = readStart + firstNewline + 1;
      const firstRecordBytes = firstRecordEnd - durableStart;
      const lastNewline = readSlice.lastIndexOf(0x0a);
      if (firstRecordBytes <= SYNC_HOST_CHAT_TRANSCRIPT_MAX_RECORD_BYTES) {
        // The long record is still deliverable. Re-read it once, now that a
        // complete boundary is known, together with any later complete rows
        // already present in this bounded scan chunk.
        const completeEnd = readStart + lastNewline + 1;
        const completeBytes = completeEnd - durableStart;
        const completeSlice = Buffer.alloc(completeBytes);
        let rereadBytes = 0;
        while (rereadBytes < completeBytes) {
          const reread = await fh.read(
            completeSlice,
            rereadBytes,
            completeBytes - rereadBytes,
            durableStart + rereadBytes,
          );
          if (reread.bytesRead <= 0) break;
          rereadBytes += reread.bytesRead;
        }
        if (rereadBytes < completeBytes) {
          return {
            events: [],
            nextOffset: durableStart,
            nextScanOffset: normalizedScanOffset,
            droppedOversizedRecordBytes: null,
          };
        }
        return {
          events: parseAgentChatTranscript(completeSlice.toString("utf8")),
          nextOffset: durableStart + completeSlice.length,
          nextScanOffset: null,
          droppedOversizedRecordBytes: null,
        };
      }

      // A single record beyond the explicit one-record ceiling is not safe
      // to materialize. Drop exactly that complete row, surface a structured
      // warning, and recover at its newline; later complete rows still flow.
      const firstCompleteOffset = firstNewline + 1;
      const completeSlice = readSlice.subarray(firstCompleteOffset, lastNewline + 1);
      return {
        events: completeSlice.length > 0
          ? parseAgentChatTranscript(completeSlice.toString("utf8"))
          : [],
        nextOffset: readStart + lastNewline + 1,
        nextScanOffset: null,
        droppedOversizedRecordBytes: firstRecordBytes,
      };
    }

    const lastNewline = readSlice.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      const hitReadBound = bytesRead === SYNC_HOST_CHAT_TRANSCRIPT_DELTA_MAX_BYTES;
      return {
        events: [],
        nextOffset: durableStart,
        // A short trailing record may still be mid-write, so retain and
        // retry it. Once one record fills the normal cap, scan for its
        // newline in bounded chunks; a record within the separate hard
        // ceiling is then re-read and delivered intact.
        nextScanOffset: hitReadBound ? readStart + bytesRead : null,
        droppedOversizedRecordBytes: null,
      };
    }

    const completeSlice = readSlice.subarray(0, lastNewline + 1);
    const raw = completeSlice.toString("utf8");
    return {
      events: parseAgentChatTranscript(raw),
      nextOffset: durableStart + completeSlice.length,
      nextScanOffset: null,
      droppedOversizedRecordBytes: null,
    };
  } catch {
    return {
      events: [],
      nextOffset: Math.max(0, startOffset),
      nextScanOffset: scanOffset,
      droppedOversizedRecordBytes: null,
    };
  } finally {
    await fh?.close().catch(() => {});
  }
}
