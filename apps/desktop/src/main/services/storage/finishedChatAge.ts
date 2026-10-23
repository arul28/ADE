import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { CompressionCandidate } from "./historyCompression";
import { chatSessionIdOfTranscript } from "./legacyChatTranscripts";

/**
 * Finished chats are compressed sooner than the default idle age: an archived
 * chat once it has been quiet an hour, a chat settled for three days, and a
 * transcript whose session row is gone (its chat or lane was deleted) after a
 * day. Every other file keeps the compressor's default age.
 */
const FINISHED_CHAT_IDLE_MS = 60 * 60_000;
const SETTLED_CHAT_COMPRESS_AFTER_MS = 3 * 24 * 60 * 60_000;
const ROWLESS_CHAT_IDLE_MS = 24 * 60 * 60_000;
const SESSION_STATE_TTL_MS = 60_000;

type ChatState = { archivedAt: string | null; settledAt: string | null };

/** The compressor's `minAgeMsFor` hook for a project's chat transcripts. */
export function createFinishedChatAgePolicy(deps: {
  db: AdeDb;
  logger: Logger;
  transcriptsDir: string;
  chatTranscriptsDir: string;
  now?: () => number;
}): (filePath: string, kind: CompressionCandidate["kind"]) => number | null {
  const now = deps.now ?? Date.now;
  // One read of the session table per candidate listing, not one query per file.
  let snapshot: { takenAt: number; rows: Map<string, ChatState> } | null = null;
  let readFailureLoggedAt = 0;
  const chatStates = (): Map<string, ChatState> => {
    if (snapshot && now() - snapshot.takenAt < SESSION_STATE_TTL_MS) return snapshot.rows;
    const rows = new Map<string, ChatState>();
    for (const row of deps.db.all<{ id: string; archived_at: string | null; settled_at: string | null }>(
      "select id, archived_at, settled_at from terminal_sessions",
    )) {
      rows.set(row.id, { archivedAt: row.archived_at, settledAt: row.settled_at });
    }
    snapshot = { takenAt: now(), rows };
    return rows;
  };

  return (filePath) => {
    const sessionId = chatSessionIdOfTranscript(filePath, deps);
    if (!sessionId) return null;
    let rows: Map<string, ChatState>;
    try {
      rows = chatStates();
    } catch (error) {
      // Unreadable session table: every file keeps the default age. Once per
      // snapshot window, not once per candidate file.
      if (!readFailureLoggedAt || now() - readFailureLoggedAt >= SESSION_STATE_TTL_MS) {
        readFailureLoggedAt = now();
        deps.logger.warn("storage.finished_chat_age_read_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }
    const state = rows.get(sessionId);
    // An empty session table (a fresh or unreadable database) must not make
    // every transcript look deleted.
    if (!state) return rows.size > 0 ? ROWLESS_CHAT_IDLE_MS : null;
    if (state.archivedAt) return FINISHED_CHAT_IDLE_MS;
    const settledAt = state.settledAt ? Date.parse(state.settledAt) : Number.NaN;
    return Number.isFinite(settledAt) && now() - settledAt >= SETTLED_CHAT_COMPRESS_AFTER_MS
      ? FINISHED_CHAT_IDLE_MS
      : null;
  };
}
