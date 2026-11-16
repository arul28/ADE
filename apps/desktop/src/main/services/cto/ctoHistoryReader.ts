import { transcriptEntriesFromEnvelopes } from "../chat/chatTranscriptEntries";
import {
  CHAT_EVENT_HISTORY_PAGE_DEFAULT_BYTES,
  readTranscriptHistoryPage,
} from "../chat/chatTranscriptHistoryPager";
import { readHistoryFileSize } from "../storage/historyCompression";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../shared/types/chat";
import type { CtoHistoryEntry, CtoHistoryPage, CtoReadHistoryArgs } from "../../../shared/types/cto";

/* ── readHistory: the CTO's whole conversation, across every CTO session ── */

const CTO_HISTORY_TEXT_MAX_CHARS = 600;
const CTO_HISTORY_CACHE_MAX_SESSIONS = 12;
/**
 * Transcript bytes one readHistory call may parse going back. A page or a
 * search that runs out hands back a cursor to continue from, so a long
 * history never stalls one call.
 */
const CTO_HISTORY_CALL_BYTE_BUDGET = 8 * 1024 * 1024;
type CtoHistoryRow = CtoHistoryEntry & { offset: number };
/**
 * One CTO session's messages parsed so far: transcript bytes [start, end),
 * oldest first, each keyed by the byte offset of its first row. `start` is
 * 0 or a person's message, where the transcript parser starts fresh, so an
 * older chunk joins on without splitting a message. An ended session's
 * file never changes, so its rows are kept as they are; the live one only
 * parses again from its newest person message (`tailFrom`) when it grows.
 */
type CtoHistoryState = { path: string; start: number; end: number; tailFrom: number; rows: CtoHistoryRow[] };

export type CtoHistoryReaderDeps = {
  /** Every CTO session of this project, newest first. */
  listCtoSessions: () => Promise<Array<Pick<AgentChatSessionSummary, "sessionId" | "status">>>;
  /** The session's transcript file, or null when it has none. */
  resolveTranscriptPath: (sessionId: string) => Promise<string | null>;
};

const isFreshTranscriptStart = (envelope: AgentChatEventEnvelope): boolean =>
  envelope.event.type === "user_message" && !envelope.event.steerId?.trim();

/** Rows of one transcript read back from `before` through the byte pager until `stop` says enough. */
const readCtoTranscriptBack = async (
  sessionId: string,
  transcriptPath: string,
  before: number,
  stop: (rows: Array<{ envelope: AgentChatEventEnvelope; offset: number }>, startOffset: number) => boolean,
): Promise<{ rows: Array<{ envelope: AgentChatEventEnvelope; offset: number }>; startOffset: number }> => {
  const rows: Array<{ envelope: AgentChatEventEnvelope; offset: number }> = [];
  let cursor = before;
  while (cursor > 0) {
    const page = await readTranscriptHistoryPage({
      transcriptPath,
      sessionId,
      beforeOffset: cursor,
      maxBytes: CHAT_EVENT_HISTORY_PAGE_DEFAULT_BYTES,
    });
    rows.unshift(...page.envelopes.map((envelope, index) => ({
      envelope,
      offset: page.envelopeStartOffsets[index] ?? page.startOffset,
    })));
    cursor = page.startOffset;
    if (stop(rows, cursor)) break;
  }
  return { rows, startOffset: cursor };
};

const ctoHistoryRowsFrom = (
  sessionId: string,
  rows: Array<{ envelope: AgentChatEventEnvelope; offset: number }>,
): CtoHistoryRow[] => {
  const offsetByEnvelope = new WeakMap<AgentChatEventEnvelope, number>();
  for (const row of rows) offsetByEnvelope.set(row.envelope, row.offset);
  const offsets: Array<number | null> = [];
  const entries = transcriptEntriesFromEnvelopes(sessionId, rows.map((row) => row.envelope), {
    sourceOffsetForEnvelope: (envelope) => offsetByEnvelope.get(envelope) ?? null,
    onEntrySourceOffset: (offset) => offsets.push(offset),
  });
  const fallbackOffset = rows[0]?.offset ?? 0;
  return entries
    .map((entry, index): CtoHistoryRow => {
      const text = (entry.role === "user" ? entry.displayText?.trim() || entry.text : entry.text).replace(/\s+/g, " ").trim();
      return {
        role: entry.role,
        text: text.length > CTO_HISTORY_TEXT_MAX_CHARS ? `${text.slice(0, CTO_HISTORY_TEXT_MAX_CHARS - 1)}…` : text,
        at: entry.timestamp,
        sessionId,
        offset: offsets[index] ?? fallbackOffset,
      };
    })
    .filter((entry) => entry.text.length > 0)
    .sort((a, b) => a.offset - b.offset);
};

/**
 * Parses the chunk before `state.start`, back to the nearest person message
 * (or the file's head, or the budget), and puts its rows in front. Returns
 * how many rows it added.
 */
const extendCtoHistoryBack = async (
  sessionId: string,
  state: CtoHistoryState,
  budget: { bytes: number },
): Promise<number> => {
  if (state.start <= 0 || budget.bytes <= 0) return 0;
  const before = state.start;
  const read = await readCtoTranscriptBack(sessionId, state.path, before, (rows, startOffset) =>
    startOffset === 0
    || before - startOffset >= budget.bytes
    || rows.some((row) => isFreshTranscriptStart(row.envelope)));
  budget.bytes -= before - read.startOffset;
  // Past the budget with no person message in reach, the chunk is taken as
  // it is; a message that started before it reads as two.
  const boundary = read.startOffset === 0
    ? 0
    : read.rows.find((row) => isFreshTranscriptStart(row.envelope))?.offset ?? read.startOffset;
  const chunk = read.rows.filter((row) => row.offset >= boundary);
  const added = ctoHistoryRowsFrom(sessionId, chunk);
  if (state.start === state.end) {
    const lastFresh = [...chunk].reverse().find((row) => isFreshTranscriptStart(row.envelope));
    state.tailFrom = lastFresh?.offset ?? boundary;
  }
  state.rows = [...added, ...state.rows];
  state.start = boundary;
  return added.length;
};

const ctoHistoryCursor = (sessionId: string, offset: number): string => `${sessionId}@${offset}`;

/**
 * The CTO's history reader. It keeps the parsed state of the most recent CTO
 * sessions between calls, so one instance lives as long as the chat service.
 */
export function createCtoHistoryReader({ listCtoSessions, resolveTranscriptPath }: CtoHistoryReaderDeps) {
  const ctoHistoryCache = new Map<string, CtoHistoryState>();
  let ctoHistoryQueue: Promise<unknown> = Promise.resolve();

  /** A session's parsed state, its live tail brought up to date. Null when it has no transcript. */
  const loadCtoHistoryState = async (sessionId: string, live: boolean): Promise<CtoHistoryState | null> => {
    let state = ctoHistoryCache.get(sessionId) ?? null;
    if (!state || live) {
      const transcriptPath = await resolveTranscriptPath(sessionId);
      if (!transcriptPath) return null;
      let size: number;
      try {
        size = await readHistoryFileSize(transcriptPath);
      } catch {
        return null;
      }
      if (!state || state.path !== transcriptPath || size < state.end) {
        state = { path: transcriptPath, start: size, end: size, tailFrom: size, rows: [] };
      } else if (size > state.end) {
        if (state.start === state.end) {
          state.start = state.end = state.tailFrom = size;
        } else {
          // Parse again from the newest person message: the turn it opened may
          // have streamed more of a message the last read already holds.
          const tailFrom = state.tailFrom;
          const tail = await readCtoTranscriptBack(sessionId, transcriptPath, size, (_rows, startOffset) => startOffset <= tailFrom);
          const tailRows = tail.rows.filter((row) => row.offset >= tailFrom);
          const lastFresh = [...tailRows].reverse().find((row) => isFreshTranscriptStart(row.envelope));
          state.rows = [...state.rows.filter((row) => row.offset < tailFrom), ...ctoHistoryRowsFrom(sessionId, tailRows)];
          state.tailFrom = lastFresh?.offset ?? tailFrom;
          state.end = size;
        }
      }
    }
    ctoHistoryCache.delete(sessionId);
    ctoHistoryCache.set(sessionId, state);
    while (ctoHistoryCache.size > CTO_HISTORY_CACHE_MAX_SESSIONS) {
      const oldest = ctoHistoryCache.keys().next().value;
      if (oldest === undefined) break;
      ctoHistoryCache.delete(oldest);
    }
    return state;
  };

  /**
   * Page or search the CTO's conversation: the current CTO session and every
   * older one of this project, newest first. The cursor names a session and
   * a byte offset in its transcript, so entries written between two calls do
   * not shift the next page. A call parses at most
   * `CTO_HISTORY_CALL_BYTE_BUDGET` of older transcript; past it, the page
   * ends early with a cursor to go on from.
   */
  const readCtoHistoryNow = async (args: CtoReadHistoryArgs): Promise<CtoHistoryPage> => {
    const limit = Math.max(1, Math.min(50, Math.floor(args.limit ?? 20)));
    const sessions = await listCtoSessions();
    const before = args.before?.trim() || null;
    let startIndex = 0;
    let bound = Number.POSITIVE_INFINITY;
    if (before) {
      const at = before.lastIndexOf("@");
      const cursorSessionId = at > 0 ? before.slice(0, at) : "";
      const offset = at > 0 ? Number(before.slice(at + 1)) : Number.NaN;
      startIndex = sessions.findIndex((session) => session.sessionId === cursorSessionId);
      if (startIndex < 0 || !Number.isFinite(offset)) return { entries: [], nextBefore: null };
      bound = offset;
    }
    const budget = { bytes: CTO_HISTORY_CALL_BYTE_BUDGET };
    const strip = ({ offset: _offset, ...entry }: CtoHistoryRow): CtoHistoryEntry => entry;
    const countBefore = (rows: CtoHistoryRow[], limitOffset: number): number => {
      let count = 0;
      while (count < rows.length && rows[count]!.offset < limitOffset) count += 1;
      return count;
    };
    const words = (args.query ?? "").toLowerCase().split(/\s+/).filter((word) => word.length > 0);

    if (!words.length) {
      const out: CtoHistoryRow[] = [];
      for (let index = startIndex; index < sessions.length; index += 1) {
        const session = sessions[index]!;
        const state = await loadCtoHistoryState(session.sessionId, session.status !== "ended");
        if (!state) continue;
        const sessionBound = index === startIndex ? bound : Number.POSITIVE_INFINITY;
        while (countBefore(state.rows, sessionBound) < limit - out.length && state.start > 0 && budget.bytes > 0) {
          await extendCtoHistoryBack(session.sessionId, state, budget);
        }
        const available = countBefore(state.rows, sessionBound);
        const take = Math.min(limit - out.length, available);
        out.push(...state.rows.slice(available - take, available).reverse());
        if (out.length >= limit) {
          const more = available > take || state.start > 0 || index < sessions.length - 1;
          return { entries: out.map(strip), nextBefore: more ? ctoHistoryCursor(session.sessionId, out[out.length - 1]!.offset) : null };
        }
        if (state.start > 0) {
          // Out of budget before this session's head: go on from here next call.
          const oldest = out[out.length - 1];
          return {
            entries: out.map(strip),
            nextBefore: oldest && oldest.sessionId === session.sessionId
              ? ctoHistoryCursor(session.sessionId, oldest.offset)
              : ctoHistoryCursor(session.sessionId, state.start),
          };
        }
      }
      return { entries: out.map(strip), nextBefore: null };
    }

    const out: CtoHistoryEntry[] = [];
    const shown = new Set<string>();
    let hits = 0;
    let lastHit: string | null = null;
    for (let index = startIndex; index < sessions.length; index += 1) {
      const session = sessions[index]!;
      const state = await loadCtoHistoryState(session.sessionId, session.status !== "ended");
      if (!state) continue;
      const sessionBound = index === startIndex ? bound : Number.POSITIVE_INFINITY;
      let at = countBefore(state.rows, sessionBound) - 1;
      while (true) {
        // Keep the entry before a hit in reach for its neighbour line.
        if (at <= 0 && state.start > 0 && budget.bytes > 0) {
          at += await extendCtoHistoryBack(session.sessionId, state, budget);
          if (at <= 0 && state.start > 0 && budget.bytes > 0) continue;
        }
        if (at < 0) break;
        const entry = state.rows[at]!;
        const haystack = entry.text.toLowerCase();
        if (words.every((word) => haystack.includes(word))) {
          if (hits >= limit) return { entries: out, nextBefore: lastHit };
          hits += 1;
          lastHit = ctoHistoryCursor(session.sessionId, entry.offset);
          for (const near of [at + 1, at, at - 1]) {
            const neighbour = state.rows[near];
            if (!neighbour || neighbour.offset >= sessionBound) continue;
            const key = ctoHistoryCursor(session.sessionId, neighbour.offset);
            if (shown.has(key)) continue;
            shown.add(key);
            out.push({ ...strip(neighbour), match: near === at });
          }
        }
        at -= 1;
      }
      if (state.start > 0) {
        // Out of budget: everything from `start` on in this session was searched.
        return { entries: out, nextBefore: ctoHistoryCursor(session.sessionId, state.start) };
      }
    }
    return { entries: out, nextBefore: null };
  };

  /** One readHistory at a time: calls share the parsed states they extend. */
  const readCtoHistory = (args: CtoReadHistoryArgs = {}): Promise<CtoHistoryPage> => {
    const run = ctoHistoryQueue.then(() => readCtoHistoryNow(args));
    ctoHistoryQueue = run.catch(() => undefined);
    return run;
  };

  return { readCtoHistory };
}
