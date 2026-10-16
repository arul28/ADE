import { randomUUID } from "node:crypto";
import {
  initialPrWatchState,
  type PrChatWatchSummary,
  type PrWatchArmedBy,
  type PrWatchMode,
  type PrWatchState,
  type PrWatchStopReason,
} from "../../../shared/prWatch";
import type { Logger } from "../logging/logger";
import type { AdeDb, SqlValue } from "../state/kvDb";
import { getErrorMessage, nowIso } from "../shared/utils";

/**
 * Owns `pull_request_chat_watches` (one row per chat watching a PR) and
 * `pull_request_ade_comments` (comments ADE posted, which never wake a watch).
 *
 * Both tables are machine-local, never CRRs: the watch wakes a chat that runs
 * on this machine, and a synced copy on another machine would wake its own
 * copy of the chat a second time. Clients learn a chat's watch through the
 * `prs.getChatWatches` action and the `pr-chat-watch-changed` event instead.
 */
export type PrChatWatchRecord = {
  id: string;
  prId: string;
  sessionId: string;
  mode: PrWatchMode;
  armedBy: PrWatchArmedBy;
  state: PrWatchState;
  startedAt: string;
  stoppedAt: string | null;
  stopReason: PrWatchStopReason | null;
  lastToldAt: string | null;
  lastToldSummary: string | null;
  updatedAt: string;
};

type WatchRow = {
  id: string;
  pr_id: string;
  session_id: string;
  mode: string;
  armed_by: string;
  state_json: string;
  started_at: string;
  stopped_at: string | null;
  stop_reason: string | null;
  last_told_at: string | null;
  last_told_summary: string | null;
  updated_at: string;
};

/** How many ADE-authored comment ids to keep per PR. */
const ADE_COMMENT_IDS_PER_PR_CAP = 500;

function parseState(raw: string, fallbackStartedAt: string): PrWatchState {
  try {
    const parsed = JSON.parse(raw) as Partial<PrWatchState>;
    const base = initialPrWatchState(fallbackStartedAt, null);
    return {
      ...base,
      ...parsed,
      failedChecks: Array.isArray(parsed.failedChecks) ? parsed.failedChecks.map(String) : [],
      remarkIds: Array.isArray(parsed.remarkIds) ? parsed.remarkIds.map(String) : [],
      held: Array.isArray(parsed.held) ? parsed.held : [],
    };
  } catch {
    return initialPrWatchState(fallbackStartedAt, null);
  }
}

function rowToRecord(row: WatchRow): PrChatWatchRecord {
  return {
    id: row.id,
    prId: row.pr_id,
    sessionId: row.session_id,
    mode: row.mode === "ship" ? "ship" : "watch",
    armedBy: row.armed_by === "agent" ? "agent" : "user",
    state: parseState(row.state_json, row.started_at),
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    stopReason: (row.stop_reason as PrWatchStopReason | null) ?? null,
    lastToldAt: row.last_told_at,
    lastToldSummary: row.last_told_summary,
    updatedAt: row.updated_at,
  };
}

export function prChatWatchSummary(
  record: PrChatWatchRecord,
  extras: { githubPrNumber: number | null },
): PrChatWatchSummary {
  return {
    watchId: record.id,
    prId: record.prId,
    sessionId: record.sessionId,
    githubPrNumber: extras.githubPrNumber,
    mode: record.mode,
    armedBy: record.armedBy,
    status: record.stoppedAt ? "stopped" : "active",
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    stopReason: record.stopReason,
    lastToldAt: record.lastToldAt,
    lastToldSummary: record.lastToldSummary,
    holding: record.state.held.length > 0,
  };
}

export type PrChatWatchStore = ReturnType<typeof createPrChatWatchStore>;

export function createPrChatWatchStore(args: { db: AdeDb; projectId: string; logger: Logger }) {
  const { db, projectId, logger } = args;

  const SELECT = `
    select id, pr_id, session_id, mode, armed_by, state_json, started_at,
           stopped_at, stop_reason, last_told_at, last_told_summary, updated_at
      from pull_request_chat_watches
  `;

  const safeAll = (sql: string, params: SqlValue[]): WatchRow[] => {
    try {
      return db.all<WatchRow>(sql, params);
    } catch (error) {
      logger.warn("prs.chat_watch_read_failed", { error: getErrorMessage(error) });
      return [];
    }
  };

  /** The latest row for a (PR, chat) pair, live or stopped. */
  const getForPair = (prId: string, sessionId: string): PrChatWatchRecord | null => {
    const row = safeAll(
      `${SELECT} where project_id = ? and pr_id = ? and session_id = ? order by updated_at desc limit 1`,
      [projectId, prId, sessionId],
    )[0];
    return row ? rowToRecord(row) : null;
  };

  const get = (watchId: string): PrChatWatchRecord | null => {
    const row = safeAll(`${SELECT} where project_id = ? and id = ? limit 1`, [projectId, watchId])[0];
    return row ? rowToRecord(row) : null;
  };

  /** Every watch row for a chat or PR, newest first. Stopped rows included. */
  const list = (filter: { sessionId?: string; prId?: string; activeOnly?: boolean }): PrChatWatchRecord[] => {
    const clauses = ["project_id = ?"];
    const params: SqlValue[] = [projectId];
    if (filter.sessionId) {
      clauses.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.prId) {
      clauses.push("pr_id = ?");
      params.push(filter.prId);
    }
    if (filter.activeOnly) clauses.push("stopped_at is null");
    return safeAll(`${SELECT} where ${clauses.join(" and ")} order by updated_at desc`, params).map(rowToRecord);
  };

  /**
   * Start, switch, or restart a watch. Switching Watch ↔ Ship keeps what the
   * agent was already told, so the switch itself is not news.
   */
  const arm = (input: {
    prId: string;
    sessionId: string;
    mode: PrWatchMode;
    armedBy: PrWatchArmedBy;
    headSha: string | null;
  }): PrChatWatchRecord => {
    const now = nowIso();
    const existing = getForPair(input.prId, input.sessionId);
    if (existing && !existing.stoppedAt) {
      db.run(
        `update pull_request_chat_watches
            set mode = ?, armed_by = ?, updated_at = ?
          where id = ? and project_id = ?`,
        [input.mode, input.armedBy, now, existing.id, projectId],
      );
      return get(existing.id) ?? existing;
    }
    const id = existing?.id ?? randomUUID();
    const state = initialPrWatchState(now, input.headSha);
    if (existing) {
      db.run(
        `update pull_request_chat_watches
            set mode = ?, armed_by = ?, state_json = ?, started_at = ?, stopped_at = null,
                stop_reason = null, last_told_at = null, last_told_summary = null, updated_at = ?
          where id = ? and project_id = ?`,
        [input.mode, input.armedBy, JSON.stringify(state), now, now, id, projectId],
      );
    } else {
      db.run(
        `insert into pull_request_chat_watches(
           id, project_id, pr_id, session_id, mode, armed_by, state_json, started_at,
           stopped_at, stop_reason, last_told_at, last_told_summary, updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, ?)`,
        [id, projectId, input.prId, input.sessionId, input.mode, input.armedBy, JSON.stringify(state), now, now],
      );
    }
    return get(id)!;
  };

  const stop = (watchId: string, reason: PrWatchStopReason): PrChatWatchRecord | null => {
    const now = nowIso();
    db.run(
      `update pull_request_chat_watches
          set stopped_at = ?, stop_reason = ?, updated_at = ?
        where id = ? and project_id = ? and stopped_at is null`,
      [now, reason, now, watchId, projectId],
    );
    return get(watchId);
  };

  /**
   * Record what the agent was told. Guarded on `expectedStartedAt`: a watch
   * stopped or restarted while the reactor was reading GitHub must not take the
   * stale pass's state. A mode switch meanwhile keeps the watch, so the told
   * state still lands and the news is not told twice.
   */
  const commitPass = (input: {
    watchId: string;
    expectedStartedAt: string;
    state: PrWatchState;
    told?: { summary: string; at: string } | null;
    stopReason?: PrWatchStopReason | null;
  }): boolean => {
    const now = nowIso();
    const sets = ["state_json = ?", "updated_at = ?"];
    const params: SqlValue[] = [JSON.stringify(input.state), now];
    if (input.told) {
      sets.push("last_told_at = ?", "last_told_summary = ?");
      params.push(input.told.at, input.told.summary);
    }
    if (input.stopReason) {
      sets.push("stopped_at = ?", "stop_reason = ?");
      params.push(now, input.stopReason);
    }
    const before = get(input.watchId);
    if (!before || before.stoppedAt || before.startedAt !== input.expectedStartedAt) return false;
    return db.runChanged(
      `update pull_request_chat_watches set ${sets.join(", ")}
        where id = ? and project_id = ? and started_at = ? and stopped_at is null`,
      [...params, input.watchId, projectId, input.expectedStartedAt],
    ) > 0;
  };

  const recordAdeComment = (prId: string, commentId: string | null | undefined): void => {
    const id = String(commentId ?? "").trim();
    if (!prId || !id) return;
    try {
      db.run(
        `insert or ignore into pull_request_ade_comments(comment_key, project_id, pr_id, comment_id, created_at)
         values (?, ?, ?, ?, ?)`,
        [`${prId}:${id}`, projectId, prId, id, nowIso()],
      );
      db.run(
        `delete from pull_request_ade_comments
          where project_id = ? and pr_id = ? and comment_key not in (
            select comment_key from pull_request_ade_comments
             where project_id = ? and pr_id = ?
             order by created_at desc limit ?
          )`,
        [projectId, prId, projectId, prId, ADE_COMMENT_IDS_PER_PR_CAP],
      );
    } catch (error) {
      logger.warn("prs.ade_comment_record_failed", { prId, error: getErrorMessage(error) });
    }
  };

  const adeCommentIds = (prId: string): Set<string> => {
    try {
      return new Set(
        db.all<{ comment_id: string }>(
          "select comment_id from pull_request_ade_comments where project_id = ? and pr_id = ?",
          [projectId, prId],
        ).map((row) => row.comment_id),
      );
    } catch {
      return new Set();
    }
  };

  return { get, getForPair, list, arm, stop, commitPass, recordAdeComment, adeCommentIds };
}
