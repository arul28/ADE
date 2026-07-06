import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { buildDeeplink } from "../../../shared/deeplinks";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import type { AgentChatEventEnvelope } from "../../../shared/types/chat";
import type { LaneSummary } from "../../../shared/types/lanes";
import type { GitBranchSummary, GitCommitSummary } from "../../../shared/types/git";
import type { PrComment, PrDetail, PrSummary } from "../../../shared/types/prs";
import type { TerminalSessionSummary } from "../../../shared/types/sessions";
import type {
  SearchDocKind,
  SearchIndexStatus,
  SearchMatchRange,
  SearchQueryArgs,
  SearchQueryResult,
  SearchRebuildResult,
  SearchResultItem
} from "../../../shared/types/search";
import { SEARCH_DOC_KINDS, isSearchDocKind } from "../../../shared/types/search";
import type { Logger } from "../logging/logger";
import {
  SEARCH_INDEX_SCHEMA_VERSION,
  clearSearchIndex,
  openSearchIndexDb,
  type SearchIndexDb
} from "./searchIndexDb";
import {
  buildFtsMatchExpression,
  isMatchAllQuery,
  parseSearchQuery,
  type ParsedSearchQuery
} from "./searchQueryParser";
import {
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  extractSnippetRanges,
  rankCandidates,
  rankQueryText
} from "./searchRanking";
import { chunkTerminalTranscript, sanitizeIndexedText } from "./terminalChunking";

/**
 * Universal search over ADE state. Heavy text (chat messages, terminal
 * scrollback, PRs, commits, branches) is FTS5-indexed into the disposable
 * `.ade/cache/search-index.db`; cheap or fast-changing sources (lanes, files,
 * artifacts, Linear issues) are delegated to their owning service at query
 * time so results are always fresh. All index writes run on a debounced
 * background queue — never on the PTY/chat hot paths.
 */

const FTS_KINDS: readonly SearchDocKind[] = ["chat", "terminal", "pr", "commit", "branch"];

const FTS_CANDIDATE_LIMIT = 400;
const MATCH_ALL_LIMIT = 200;
const DELEGATED_FILE_LIMIT = 30;
const DELEGATED_ARTIFACT_LIMIT = 200;
const MAX_DOC_BODY_CHARS = 32_000;
const MAX_READ_BYTES_PER_PASS = 4 * 1024 * 1024;
const COMMITS_PER_LANE = 100;
const DEFAULT_QUERY_LIMIT = 50;
const BACKFILL_RETRY_MS = 60_000;
const MAX_QUERY_LIMIT = 200;

const DEBOUNCE_MS: Record<SourceKind, number> = {
  "chat-session": 300,
  "terminal-session": 1200,
  pr: 500,
  "pr-sweep": 1000,
  "lane-git": 1000
};

type SourceKind = "chat-session" | "terminal-session" | "pr" | "pr-sweep" | "lane-git";

type QueueEntry = {
  sourceKind: SourceKind;
  id: string;
  dueAt: number;
};

type DocRow = {
  doc_id: string;
  kind: string;
  lane_id: string | null;
  lane_name: string | null;
  session_id: string | null;
  title: string;
  rank_title: string | null;
  snippet_source: string | null;
  deep_link: string;
  updated_at: string;
};

type Candidate = {
  docId: string;
  kind: SearchDocKind;
  title: string;
  rankTitle: string;
  laneId: string | null;
  laneName: string | null;
  sessionId: string | null;
  deepLink: string;
  updatedAt: string;
  bm25: number;
  snippet: string;
  matchRanges: SearchMatchRange[];
};

export type SearchServiceDeps = {
  cacheDir: string;
  transcriptsDir: string;
  chatTranscriptsDir: string;
  logger?: Logger | null;
  sessions: {
    list: () => Promise<TerminalSessionSummary[]>;
    get?: (sessionId: string) => Promise<TerminalSessionSummary | null>;
  };
  lanes?: {
    list: () => Promise<LaneSummary[]>;
  } | null;
  prs?: {
    listAll: (args?: { laneId?: string }) => PrSummary[] | Promise<PrSummary[]>;
    getDetail: (prId: string) => Promise<PrDetail | null>;
    getComments: (prId: string) => Promise<PrComment[]>;
  } | null;
  git?: {
    listRecentCommits: (args: { laneId: string; limit?: number }) => Promise<GitCommitSummary[]>;
    listBranches: (args: { laneId: string }) => Promise<GitBranchSummary[]>;
  } | null;
  /** Pre-bound to the project; pass laneId to search that lane's workspace. */
  files?: {
    quickOpen: (query: string, limit: number, laneId?: string | null) => Promise<Array<{ path: string }>>;
    searchText: (
      query: string,
      limit: number,
      laneId?: string | null
    ) => Promise<Array<{ path: string; line: number; column: number; preview: string }>>;
  } | null;
  artifacts?: {
    list: (limit: number) => Array<{
      id: string;
      title: string | null;
      description: string | null;
      createdAt: string | null;
    }>;
  } | null;
  /**
   * Live network delegation — only consulted when the caller explicitly asks
   * for Linear results (`kind:linear` / kinds arg), never on the default path.
   */
  linear?: {
    searchIssues: (query: string) => Promise<{
      issues: Array<{
        identifier: string;
        title: string;
        description?: string | null;
        updatedAt?: string | null;
      }>;
    }>;
  } | null;
  now?: () => Date;
};

function isChatToolType(toolType: string | null | undefined): boolean {
  if (!toolType) return false;
  const normalized = toolType.trim().toLowerCase();
  // Cursor SDK chats are recorded as plain "cursor" (the CLI variant is
  // "cursor-cli"); every other chat provider uses a "-chat" suffix.
  return normalized === "cursor" || normalized.endsWith("-chat");
}

function clampBody(text: string): string {
  return text.length > MAX_DOC_BODY_CHARS ? text.slice(0, MAX_DOC_BODY_CHARS) : text;
}

function sessionUpdatedAt(session: TerminalSessionSummary): string {
  return session.lastActivityAt || session.endedAt || session.startedAt || "";
}

function sessionDeepLink(session: Pick<TerminalSessionSummary, "id" | "laneId">): string {
  try {
    return buildDeeplink(
      { kind: "session", sessionId: session.id, laneId: session.laneId || undefined },
      { form: "ade" }
    );
  } catch {
    return `ade://session/${encodeURIComponent(session.id)}`;
  }
}

function withQueryParam(link: string, key: string, value: string | number): string {
  return `${link}${link.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(String(value))}`;
}

function chatEventSearchText(envelope: AgentChatEventEnvelope): string | null {
  const event = envelope.event as { type?: string; text?: unknown; displayText?: unknown };
  if (!event || typeof event !== "object") return null;
  if (event.type === "user_message") {
    const display = typeof event.displayText === "string" ? event.displayText : "";
    const text = typeof event.text === "string" ? event.text : "";
    return display.trim() || text.trim() || null;
  }
  if (event.type === "text") {
    const text = typeof event.text === "string" ? event.text : "";
    return text.trim() || null;
  }
  return null;
}

export type SearchService = ReturnType<typeof createSearchService>;

export function createSearchService(deps: SearchServiceDeps) {
  const logger = deps.logger ?? null;
  const now = deps.now ?? (() => new Date());

  let index: SearchIndexDb | null = null;
  let disposed = false;
  let backfillComplete = false;
  let backfillStarted = false;

  const queue = new Map<string, QueueEntry>();
  let timer: NodeJS.Timeout | null = null;
  let timerDueAt = Number.POSITIVE_INFINITY;
  // All queue drains serialize through this chain so concurrent callers can
  // never lose freshly-enqueued work to an in-flight drain.
  let workChain: Promise<void> = Promise.resolve();

  const ensureDb = (): SearchIndexDb => {
    // A source processor resuming from an await after dispose() must not
    // re-open the just-closed database (handle leak + writes after teardown);
    // the throw is caught and logged by the queue drain's per-source catch.
    if (disposed) throw new Error("search index disposed");
    if (!index) index = openSearchIndexDb(deps.cacheDir);
    return index;
  };

  const run = (sql: string, params: Array<string | number | null> = []): void => {
    ensureDb().db.prepare(sql).run(...params);
  };

  const all = <T,>(sql: string, params: Array<string | number | null> = []): T[] => {
    return ensureDb().db.prepare(sql).all(...params) as T[];
  };

  const getRow = <T,>(sql: string, params: Array<string | number | null> = []): T | null => {
    return (ensureDb().db.prepare(sql).get(...params) as T | undefined) ?? null;
  };

  // ---------------------------------------------------------------------
  // Ingestion queue
  // ---------------------------------------------------------------------

  const armTimer = (dueAt: number): void => {
    // The queue lives on hot paths (PTY data, chat events): only re-arm when
    // the new work is due before the already-armed wakeup.
    if (disposed || dueAt >= timerDueAt) return;
    if (timer) clearTimeout(timer);
    timerDueAt = dueAt;
    timer = setTimeout(() => {
      timer = null;
      timerDueAt = Number.POSITIVE_INFINITY;
      void processQueue();
    }, Math.max(0, dueAt - Date.now()));
    timer.unref?.();
  };

  const scheduleTimer = (): void => {
    if (disposed || queue.size === 0) return;
    const nextDue = Math.min(...[...queue.values()].map((entry) => entry.dueAt));
    armTimer(nextDue);
  };

  const enqueue = (sourceKind: SourceKind, id: string, debounceMs?: number): void => {
    if (disposed) return;
    const key = `${sourceKind}:${id}`;
    const dueAt = Date.now() + (debounceMs ?? DEBOUNCE_MS[sourceKind]);
    const existing = queue.get(key);
    // Keep the earlier due time so a steady stream of events cannot starve
    // the source forever.
    const effectiveDueAt = existing ? Math.min(existing.dueAt, dueAt) : dueAt;
    if (existing) existing.dueAt = effectiveDueAt;
    else queue.set(key, { sourceKind, id, dueAt: effectiveDueAt });
    armTimer(effectiveDueAt);
  };

  const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  const drainDueEntries = async (): Promise<void> => {
    try {
      // Drain in passes: each pass takes the currently-due entries.
      for (;;) {
        if (disposed) return;
        const dueNow = [...queue.entries()].filter(([, entry]) => entry.dueAt <= Date.now());
        if (dueNow.length === 0) break;
        for (const [key, entry] of dueNow) {
          queue.delete(key);
          try {
            await processSource(entry);
          } catch (error) {
            logger?.warn("search.index_source_failed", {
              sourceKind: entry.sourceKind,
              id: entry.id,
              error: error instanceof Error ? error.message : String(error)
            });
          }
          if (disposed) return;
          await yieldLoop();
        }
      }
    } finally {
      scheduleTimer();
    }
  };

  const processQueue = (): Promise<void> => {
    workChain = workChain.then(drainDueEntries);
    return workChain;
  };

  const getSource = (sourceId: string): { cursor: number; docSeq: number; state: string | null } => {
    const row = getRow<{ cursor: number; doc_seq: number; state: string | null }>(
      "SELECT cursor, doc_seq, state FROM sources WHERE source_id = ?",
      [sourceId]
    );
    return row ? { cursor: row.cursor, docSeq: row.doc_seq, state: row.state } : { cursor: 0, docSeq: 0, state: null };
  };

  const putSource = (sourceId: string, kind: string, cursor: number, docSeq: number, state: string | null): void => {
    run(
      `INSERT INTO sources (source_id, kind, cursor, doc_seq, state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET cursor = excluded.cursor, doc_seq = excluded.doc_seq,
         state = excluded.state, updated_at = excluded.updated_at`,
      [sourceId, kind, cursor, docSeq, state, now().toISOString()]
    );
  };

  const upsertDoc = (doc: {
    docId: string;
    kind: SearchDocKind;
    laneId: string | null;
    laneName: string | null;
    sessionId: string | null;
    /** Owning chat session for attached terminals (terminal_sessions.chatSessionId). */
    ownerSessionId?: string | null;
    title: string;
    rankTitle: string | null;
    snippetSource: string | null;
    deepLink: string;
    updatedAt: string;
    body: string;
  }): void => {
    const db = ensureDb().db;
    const existing = db.prepare("SELECT id FROM docs WHERE doc_id = ?").get(doc.docId) as
      | { id: number }
      | undefined;
    if (existing) {
      db.prepare("DELETE FROM docs_fts WHERE rowid = ?").run(existing.id);
      db.prepare(
        `UPDATE docs SET kind = ?, lane_id = ?, lane_name = ?, session_id = ?, owner_session_id = ?, title = ?, rank_title = ?,
           snippet_source = ?, deep_link = ?, updated_at = ? WHERE id = ?`
      ).run(
        doc.kind,
        doc.laneId,
        doc.laneName,
        doc.sessionId,
        doc.ownerSessionId ?? null,
        doc.title,
        doc.rankTitle,
        doc.snippetSource,
        doc.deepLink,
        doc.updatedAt,
        existing.id
      );
      db.prepare("INSERT INTO docs_fts (rowid, rank_title, body) VALUES (?, ?, ?)").run(
        existing.id,
        doc.rankTitle ?? "",
        clampBody(doc.body)
      );
      return;
    }
    db.prepare(
      `INSERT INTO docs (doc_id, kind, lane_id, lane_name, session_id, owner_session_id, title, rank_title, snippet_source, deep_link, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      doc.docId,
      doc.kind,
      doc.laneId,
      doc.laneName,
      doc.sessionId,
      doc.ownerSessionId ?? null,
      doc.title,
      doc.rankTitle,
      doc.snippetSource,
      doc.deepLink,
      doc.updatedAt
    );
    const inserted = db.prepare("SELECT id FROM docs WHERE doc_id = ?").get(doc.docId) as { id: number };
    db.prepare("INSERT INTO docs_fts (rowid, rank_title, body) VALUES (?, ?, ?)").run(
      inserted.id,
      doc.rankTitle ?? "",
      clampBody(doc.body)
    );
  };

  const deleteDocsWhere = (where: string, params: Array<string | number>): void => {
    const db = ensureDb().db;
    const rows = db.prepare(`SELECT id FROM docs WHERE ${where}`).all(...params) as Array<{ id: number }>;
    if (rows.length === 0) return;
    const del = db.prepare("DELETE FROM docs_fts WHERE rowid = ?");
    for (const row of rows) del.run(row.id);
    db.prepare(`DELETE FROM docs WHERE ${where}`).run(...params);
  };

  const withTransaction = (fn: () => void): void => {
    const db = ensureDb().db;
    db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw error;
    }
  };

  // ---------------------------------------------------------------------
  // Source processors
  // ---------------------------------------------------------------------

  const resolveSession = async (sessionId: string): Promise<TerminalSessionSummary | null> => {
    if (deps.sessions.get) {
      try {
        const session = await deps.sessions.get(sessionId);
        if (session) return session;
      } catch {
        // fall through to list scan
      }
    }
    try {
      const sessions = await deps.sessions.list();
      return sessions.find((session) => session.id === sessionId) ?? null;
    } catch {
      return null;
    }
  };

  const upsertSessionMetaDoc = (session: TerminalSessionSummary, kind: "chat" | "terminal"): void => {
    const prefix = kind === "chat" ? "chat" : "term";
    const bodyParts = [session.title, session.goal ?? "", session.summary ?? ""].filter(Boolean);
    upsertDoc({
      docId: `${prefix}:${session.id}:meta`,
      kind,
      laneId: session.laneId || null,
      laneName: session.laneName || null,
      sessionId: session.id,
      ownerSessionId: kind === "terminal" ? session.chatSessionId ?? null : null,
      title: session.title,
      rankTitle: session.title,
      snippetSource: session.summary || session.lastOutputPreview || session.goal || null,
      deepLink: sessionDeepLink(session),
      updatedAt: sessionUpdatedAt(session),
      body: sanitizeIndexedText(bodyParts.join("\n"))
    });
  };

  const chatTranscriptPathFor = (session: TerminalSessionSummary): string | null => {
    const durable = path.join(deps.chatTranscriptsDir, `${session.id}.jsonl`);
    if (fs.existsSync(durable)) return durable;
    const legacy = path.join(deps.transcriptsDir, `${session.id}.chat.jsonl`);
    if (fs.existsSync(legacy)) return legacy;
    // Only trust the row's transcriptPath when it is a chat JSONL — terminal
    // sessions carry a .log path here.
    if (
      session.transcriptPath &&
      session.transcriptPath.endsWith(".jsonl") &&
      fs.existsSync(session.transcriptPath)
    ) {
      return session.transcriptPath;
    }
    return null;
  };

  /** Chat classification: known chat tool type, or a chat transcript on disk
   * (legacy rows persisted with toolType "other"). */
  const isChatSession = (session: TerminalSessionSummary): boolean => {
    if (isChatToolType(session.toolType)) return true;
    return chatTranscriptPathFor(session) !== null;
  };

  const processChatSession = async (sessionId: string): Promise<void> => {
    const session = await resolveSession(sessionId);
    if (!session) {
      removeSessionDocs(sessionId);
      return;
    }
    if (!isChatSession(session)) return;
    const sourceId = `chat:${sessionId}`;
    const filePath = chatTranscriptPathFor(session);
    withTransaction(() => upsertSessionMetaDoc(session, "chat"));
    if (!filePath) return;

    let source = getSource(sourceId);
    const priorState = source.state ? (JSON.parse(source.state) as { path?: string }) : null;
    if (priorState?.path && priorState.path !== filePath) {
      // Transcript moved (durable file appeared) — reindex from scratch.
      withTransaction(() => {
        deleteDocsWhere("session_id = ? AND kind = 'chat' AND doc_id NOT LIKE '%:meta'", [sessionId]);
      });
      source = { cursor: 0, docSeq: 0, state: null };
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return;
    }
    if (stat.size < source.cursor) {
      // Truncated/rewritten (e.g. storage compaction) — reindex from scratch.
      withTransaction(() => {
        deleteDocsWhere("session_id = ? AND kind = 'chat' AND doc_id NOT LIKE '%:meta'", [sessionId]);
      });
      source = { cursor: 0, docSeq: 0, state: null };
    }
    if (stat.size === source.cursor) {
      putSource(sourceId, "chat-session", source.cursor, source.docSeq, JSON.stringify({ path: filePath }));
      return;
    }

    const readEnd = Math.min(stat.size, source.cursor + MAX_READ_BYTES_PER_PASS);
    const buf = Buffer.alloc(readEnd - source.cursor);
    const handle = await fs.promises.open(filePath, "r");
    try {
      await handle.read(buf, 0, buf.length, source.cursor);
    } finally {
      await handle.close();
    }
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0 && readEnd < stat.size) {
      // A single line larger than the read window; skip past it defensively.
      putSource(sourceId, "chat-session", readEnd, source.docSeq, JSON.stringify({ path: filePath }));
      enqueue("chat-session", sessionId, 0);
      return;
    }
    // Never consume an unterminated tail: the writer appends whole
    // `JSON.stringify(envelope) + "\n"` lines, so a missing trailing newline
    // means a torn in-progress write — consuming it would advance the cursor
    // past a half-written event and permanently drop it from the index.
    const consumed = lastNewline >= 0 ? lastNewline + 1 : 0;
    if (consumed === 0) return;

    const envelopes = parseAgentChatTranscript(buf.subarray(0, consumed).toString("utf8"));
    const laneId = session.laneId || null;
    const laneName = session.laneName || null;
    const baseLink = sessionDeepLink(session);
    let docSeq = source.docSeq;

    withTransaction(() => {
      for (const envelope of envelopes) {
        const seq = docSeq;
        docSeq += 1;
        const text = chatEventSearchText(envelope);
        if (!text) continue;
        const sanitized = sanitizeIndexedText(text);
        upsertDoc({
          docId: `chat:${sessionId}:${seq}`,
          kind: "chat",
          laneId,
          laneName,
          sessionId,
          title: session.title,
          rankTitle: null,
          snippetSource: sanitized.slice(0, 240),
          deepLink: withQueryParam(baseLink, "event", seq),
          updatedAt: envelope.timestamp,
          body: sanitized
        });
      }
      putSource(sourceId, "chat-session", source.cursor + consumed, docSeq, JSON.stringify({ path: filePath }));
    });

    if (source.cursor + consumed < stat.size) enqueue("chat-session", sessionId, 0);
  };

  const terminalTranscriptPathFor = (session: TerminalSessionSummary): string | null => {
    if (session.transcriptPath && session.transcriptPath.endsWith(".log")) return session.transcriptPath;
    const fallback = path.join(deps.transcriptsDir, `${session.id}.log`);
    return fs.existsSync(fallback) ? fallback : null;
  };

  const processTerminalSession = async (sessionId: string): Promise<void> => {
    const session = await resolveSession(sessionId);
    if (!session) {
      removeSessionDocs(sessionId);
      return;
    }
    // A session with a chat transcript is a chat even when its toolType is a
    // legacy value like "other" — never index it as a terminal.
    if (isChatSession(session)) return;
    const sourceId = `term:${sessionId}`;
    withTransaction(() => upsertSessionMetaDoc(session, "terminal"));
    const filePath = terminalTranscriptPathFor(session);
    if (!filePath) return;

    let source = getSource(sourceId);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return;
    }
    if (stat.size < source.cursor) {
      withTransaction(() => {
        deleteDocsWhere("session_id = ? AND kind = 'terminal' AND doc_id NOT LIKE '%:meta'", [sessionId]);
      });
      source = { cursor: 0, docSeq: 0, state: null };
    }
    if (stat.size === source.cursor) return;

    const readEnd = Math.min(stat.size, source.cursor + MAX_READ_BYTES_PER_PASS);
    const buf = Buffer.alloc(readEnd - source.cursor);
    const handle = await fs.promises.open(filePath, "r");
    try {
      await handle.read(buf, 0, buf.length, source.cursor);
    } finally {
      await handle.close();
    }

    const force = session.status !== "running" && readEnd === stat.size;
    const { chunks, consumedBytes } = chunkTerminalTranscript(buf, source.cursor, { force });
    if (consumedBytes === 0) return;

    const baseLink = sessionDeepLink(session);
    let docSeq = source.docSeq;
    withTransaction(() => {
      for (const chunk of chunks) {
        const seq = docSeq;
        docSeq += 1;
        if (!chunk.text) continue;
        upsertDoc({
          docId: `term:${sessionId}:${seq}`,
          kind: "terminal",
          laneId: session.laneId || null,
          laneName: session.laneName || null,
          sessionId,
          ownerSessionId: session.chatSessionId ?? null,
          title: session.title,
          rankTitle: null,
          snippetSource: chunk.text.slice(0, 240),
          deepLink: withQueryParam(baseLink, "offset", chunk.startOffset),
          updatedAt: sessionUpdatedAt(session),
          body: chunk.text
        });
      }
      putSource(sourceId, "terminal-session", source.cursor + consumedBytes, docSeq, null);
    });

    if (source.cursor + consumedBytes < stat.size) enqueue("terminal-session", sessionId, 0);
  };

  const processPr = async (prId: string): Promise<void> => {
    if (!deps.prs) return;
    const summaries = await deps.prs.listAll();
    const summary = summaries.find((pr) => pr.id === prId);
    if (!summary) {
      withTransaction(() => deleteDocsWhere("doc_id = ?", [`pr:${prId}`]));
      return;
    }
    let detail: PrDetail | null = null;
    let comments: PrComment[] = [];
    try {
      detail = await deps.prs.getDetail(prId);
    } catch {
      // body unavailable — index what we have
    }
    try {
      comments = await deps.prs.getComments(prId);
    } catch {
      // comments unavailable
    }
    const commentText = comments
      .map((comment) => `${comment.author}: ${comment.body ?? ""}`)
      .filter((line) => line.trim().length > 0)
      .join("\n");
    const body = sanitizeIndexedText(
      [summary.title, detail?.body ?? "", commentText].filter(Boolean).join("\n")
    );
    let deepLink: string;
    try {
      deepLink = buildDeeplink(
        {
          kind: "pr",
          repoOwner: summary.repoOwner,
          repoName: summary.repoName,
          prNumber: summary.githubPrNumber
        },
        { form: "ade" }
      );
    } catch {
      deepLink = summary.githubUrl;
    }
    withTransaction(() => {
      upsertDoc({
        docId: `pr:${prId}`,
        kind: "pr",
        laneId: summary.laneId || null,
        laneName: null,
        sessionId: null,
        title: `#${summary.githubPrNumber} ${summary.title}`,
        rankTitle: summary.title,
        snippetSource: (detail?.body ?? summary.title).slice(0, 240),
        deepLink,
        updatedAt: summary.updatedAt,
        body
      });
      putSource(`pr:${prId}`, "pr", 0, 0, null);
    });
  };

  const processPrSweep = async (): Promise<void> => {
    if (!deps.prs) return;
    const summaries = await deps.prs.listAll();
    const liveIds = new Set(summaries.map((pr) => `pr:${pr.id}`));
    const indexed = all<{ doc_id: string }>("SELECT doc_id FROM docs WHERE kind = 'pr'");
    withTransaction(() => {
      for (const row of indexed) {
        if (!liveIds.has(row.doc_id)) deleteDocsWhere("doc_id = ?", [row.doc_id]);
      }
    });
    for (const summary of summaries) enqueue("pr", summary.id, 0);
  };

  const processLaneGit = async (laneId: string): Promise<void> => {
    if (!deps.git || !deps.lanes) return;
    const lanes = await deps.lanes.list();
    const lane = lanes.find((entry) => entry.id === laneId);
    if (!lane) {
      withTransaction(() => {
        deleteDocsWhere("lane_id = ? AND kind IN ('commit', 'branch')", [laneId]);
      });
      return;
    }
    let commits: GitCommitSummary[] = [];
    let branches: GitBranchSummary[] = [];
    try {
      commits = await deps.git.listRecentCommits({ laneId, limit: COMMITS_PER_LANE });
    } catch {
      // lane worktree may be unavailable
    }
    // listBranches returns every branch visible from the lane's repo, so
    // indexing it per lane would duplicate the whole branch list N times.
    // Branches are indexed once, from the primary lane.
    if (lane.laneType === "primary") {
      try {
        branches = await deps.git.listBranches({ laneId });
      } catch {
        // ignore
      }
    }
    let laneLink: string;
    try {
      laneLink = buildDeeplink({ kind: "lane", laneId }, { form: "ade" });
    } catch {
      laneLink = `ade://lane/${encodeURIComponent(laneId)}`;
    }
    withTransaction(() => {
      deleteDocsWhere("lane_id = ? AND kind IN ('commit', 'branch')", [laneId]);
      for (const commit of commits) {
        upsertDoc({
          docId: `commit:${laneId}:${commit.sha}`,
          kind: "commit",
          laneId,
          laneName: lane.name,
          sessionId: null,
          title: commit.subject,
          rankTitle: commit.subject,
          snippetSource: `${commit.shortSha} ${commit.authorName}`,
          deepLink: withQueryParam(laneLink, "commit", commit.sha),
          updatedAt: commit.authoredAt,
          body: sanitizeIndexedText(
            [commit.subject, commit.authorName, commit.sha, commit.shortSha].join("\n")
          )
        });
      }
      for (const branch of branches) {
        upsertDoc({
          docId: `branch:${laneId}:${branch.name}`,
          kind: "branch",
          laneId,
          laneName: lane.name,
          sessionId: null,
          title: branch.name,
          rankTitle: branch.name,
          snippetSource: branch.lastCommitMessage ?? null,
          deepLink: withQueryParam(laneLink, "branch", branch.name),
          updatedAt: lane.createdAt,
          body: sanitizeIndexedText([branch.name, branch.lastCommitMessage ?? ""].join("\n"))
        });
      }
      putSource(`lanegit:${laneId}`, "lane-git", 0, 0, null);
    });
  };

  const processSource = async (entry: QueueEntry): Promise<void> => {
    switch (entry.sourceKind) {
      case "chat-session":
        return processChatSession(entry.id);
      case "terminal-session":
        return processTerminalSession(entry.id);
      case "pr":
        return processPr(entry.id);
      case "pr-sweep":
        return processPrSweep();
      case "lane-git":
        return processLaneGit(entry.id);
    }
  };

  const removeSessionDocs = (sessionId: string): void => {
    withTransaction(() => {
      deleteDocsWhere("session_id = ?", [sessionId]);
      run("DELETE FROM sources WHERE source_id IN (?, ?)", [`chat:${sessionId}`, `term:${sessionId}`]);
    });
  };

  // ---------------------------------------------------------------------
  // Backfill
  // ---------------------------------------------------------------------

  const startBackfill = (): void => {
    if (backfillStarted || disposed) return;
    backfillStarted = true;
    void (async () => {
      try {
        const sessions = await deps.sessions.list();
        const liveIds = new Set(sessions.map((session) => session.id));
        // Reconcile deletions that happened while we were not running.
        const staleSessions = all<{ session_id: string }>(
          "SELECT DISTINCT session_id FROM docs WHERE session_id IS NOT NULL"
        );
        for (const row of staleSessions) {
          if (!liveIds.has(row.session_id)) removeSessionDocs(row.session_id);
        }
        for (const session of sessions) {
          if (isChatSession(session)) enqueue("chat-session", session.id, 0);
          if (!isChatToolType(session.toolType)) enqueue("terminal-session", session.id, 0);
        }
        if (deps.prs) enqueue("pr-sweep", "all", 0);
        if (deps.lanes && deps.git) {
          const lanes = await deps.lanes.list();
          for (const lane of lanes) {
            if (!lane.archivedAt) enqueue("lane-git", lane.id, 0);
          }
        }
        await processQueue();
        backfillComplete = true;
        run("INSERT OR REPLACE INTO meta (key, value) VALUES ('backfillComplete', '1')");
        logger?.info("search.backfill_complete", { docCount: countDocs() });
      } catch (error) {
        logger?.warn("search.backfill_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        // Allow a later attempt to enqueue the sources this pass missed
        // (source lists can be transiently unavailable during startup).
        backfillStarted = false;
        if (!disposed) {
          const retry = setTimeout(() => startBackfill(), BACKFILL_RETRY_MS);
          retry.unref?.();
        }
      }
    })();
  };

  const countDocs = (): number => {
    return getRow<{ n: number }>("SELECT COUNT(*) AS n FROM docs")?.n ?? 0;
  };

  // ---------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------

  const effectiveKinds = (args: SearchQueryArgs, parsed: ParsedSearchQuery): SearchDocKind[] => {
    const fromArgs = (args.kinds ?? []).filter(isSearchDocKind);
    const fromQuery = parsed.kinds;
    if (fromArgs.length > 0 && fromQuery.length > 0) {
      const intersection = fromArgs.filter((kind) => fromQuery.includes(kind));
      return intersection.length > 0 ? intersection : [];
    }
    if (fromArgs.length > 0) return fromArgs;
    if (fromQuery.length > 0) return fromQuery;
    // Linear delegation is opt-in: it can hit the network, so the default
    // kind set excludes it.
    return SEARCH_DOC_KINDS.filter((kind) => kind !== "linear");
  };

  const resolveLaneFilter = async (
    args: SearchQueryArgs,
    parsed: ParsedSearchQuery
  ): Promise<string | null> => {
    // Both the API arg and the inline lane: filter accept a lane id OR name.
    const requested = args.laneId?.trim() || parsed.lane;
    if (!requested) return null;
    if (!deps.lanes) return requested;
    try {
      const lanes = await deps.lanes.list();
      const needle = requested.toLowerCase();
      const match =
        lanes.find((lane) => lane.id === requested) ??
        lanes.find((lane) => lane.name.toLowerCase() === needle) ??
        lanes.find((lane) => lane.name.toLowerCase().includes(needle));
      return match?.id ?? requested;
    } catch {
      return requested;
    }
  };

  const docRowToCandidate = (row: DocRow, bm25: number, marked: string | null): Candidate => {
    const fromMarked = marked ? extractSnippetRanges(marked) : null;
    const snippet = fromMarked?.snippet?.trim()
      ? fromMarked.snippet
      : (row.snippet_source ?? "").slice(0, 240);
    return {
      docId: row.doc_id,
      kind: row.kind as SearchDocKind,
      title: row.title,
      rankTitle: row.rank_title ?? "",
      laneId: row.lane_id,
      laneName: row.lane_name,
      sessionId: row.session_id,
      deepLink: row.deep_link,
      updatedAt: row.updated_at,
      bm25,
      snippet,
      matchRanges: fromMarked?.snippet?.trim() ? fromMarked.matchRanges : []
    };
  };

  const queryFtsCandidates = (
    parsed: ParsedSearchQuery,
    kinds: SearchDocKind[],
    laneId: string | null,
    sessionId: string | null,
    scopeChatSessionId: string | null,
    excludeSessionContent: boolean
  ): { candidates: Candidate[]; totals: Partial<Record<SearchDocKind, number>> } => {
    const ftsKinds = kinds.filter((kind) => FTS_KINDS.includes(kind));
    if (ftsKinds.length === 0) return { candidates: [], totals: {} };

    const kindPlaceholders = ftsKinds.map(() => "?").join(", ");
    const filters: string[] = [`d.kind IN (${kindPlaceholders})`];
    const filterParams: Array<string | number> = [...ftsKinds];
    if (laneId) {
      filters.push("d.lane_id = ?");
      filterParams.push(laneId);
    }
    if (sessionId) {
      filters.push("(d.session_id = ? OR d.owner_session_id = ?)");
      filterParams.push(sessionId, sessionId);
    }
    if (excludeSessionContent) {
      // Unbound non-external agent roles get no session content at all
      // (chat.readTranscript denies these callers outright).
      filters.push("d.kind NOT IN ('chat', 'terminal')");
    } else if (scopeChatSessionId) {
      // Session-bound non-CTO callers may only see their own session's chat
      // and terminal content (mirrors scopeChatAdeActionArgs /
      // scopeTerminalAdeActionArgs on the direct read paths). Terminals owned
      // by the caller's chat (attached shells) match via owner_session_id,
      // the same owner path direct terminal reads authorize.
      filters.push(
        "(d.kind NOT IN ('chat', 'terminal') OR d.session_id = ? OR d.owner_session_id = ?)"
      );
      filterParams.push(scopeChatSessionId, scopeChatSessionId);
    }
    if (parsed.sinceIso) {
      filters.push("d.updated_at >= ?");
      filterParams.push(parsed.sinceIso);
    }

    const matchExpr = buildFtsMatchExpression(parsed);
    if (!matchExpr) {
      const rows = all<DocRow>(
        `SELECT d.doc_id, d.kind, d.lane_id, d.lane_name, d.session_id, d.title, d.rank_title,
                d.snippet_source, d.deep_link, d.updated_at
         FROM docs d
         WHERE ${filters.join(" AND ")}
         ORDER BY d.updated_at DESC, d.doc_id ASC
         LIMIT ${MATCH_ALL_LIMIT}`,
        filterParams
      );
      const totals: Partial<Record<SearchDocKind, number>> = {};
      const totalRows = all<{ kind: string; n: number }>(
        `SELECT d.kind, COUNT(*) AS n FROM docs d WHERE ${filters.join(" AND ")} GROUP BY d.kind`,
        filterParams
      );
      for (const row of totalRows) totals[row.kind as SearchDocKind] = row.n;
      return { candidates: rows.map((row) => docRowToCandidate(row, 0, null)), totals };
    }

    const candidateSql = `SELECT d.doc_id, d.kind, d.lane_id, d.lane_name, d.session_id, d.title, d.rank_title,
              d.snippet_source, d.deep_link, d.updated_at,
              bm25(docs_fts) AS score,
              snippet(docs_fts, 1, '${SNIPPET_MARK_START}', '${SNIPPET_MARK_END}', '…', 14) AS marked
       FROM docs_fts
       JOIN docs d ON d.id = docs_fts.rowid
       WHERE docs_fts MATCH ? AND ${filters.join(" AND ")}
       ORDER BY score ASC, d.updated_at DESC, d.doc_id ASC
       LIMIT ${FTS_CANDIDATE_LIMIT}`;
    const rows = all<DocRow & { score: number; marked: string }>(candidateSql, [
      matchExpr,
      ...filterParams
    ]);
    // The candidate window above is capped in bm25 order, so on very
    // high-frequency terms a strong TITLE match could fall outside it and
    // never reach the title-tier promotion. Union in a title-scoped candidate
    // set so the specified ranking (exact title > prefix > substring > body)
    // holds regardless of body-match volume.
    if (rows.length === FTS_CANDIDATE_LIMIT) {
      const titleExpr = buildFtsMatchExpression(parsed, { column: "rank_title" });
      if (titleExpr) {
        const seenDocIds = new Set(rows.map((row) => row.doc_id));
        for (const row of all<DocRow & { score: number; marked: string }>(candidateSql, [
          titleExpr,
          ...filterParams
        ])) {
          if (!seenDocIds.has(row.doc_id)) rows.push(row);
        }
      }
    }
    const totals: Partial<Record<SearchDocKind, number>> = {};
    const totalRows = all<{ kind: string; n: number }>(
      `SELECT d.kind, COUNT(*) AS n
       FROM docs_fts
       JOIN docs d ON d.id = docs_fts.rowid
       WHERE docs_fts MATCH ? AND ${filters.join(" AND ")}
       GROUP BY d.kind`,
      [matchExpr, ...filterParams]
    );
    for (const row of totalRows) totals[row.kind as SearchDocKind] = row.n;
    // The title-union above can surface docs the body-match COUNT didn't
    // include; keep totals >= visible candidates per kind so "show more"
    // affordances never under-count.
    const candidateCountByKind = new Map<string, number>();
    for (const row of rows) {
      candidateCountByKind.set(row.kind, (candidateCountByKind.get(row.kind) ?? 0) + 1);
    }
    for (const [kind, count] of candidateCountByKind) {
      const key = kind as SearchDocKind;
      totals[key] = Math.max(totals[key] ?? 0, count);
    }
    return { candidates: rows.map((row) => docRowToCandidate(row, row.score, row.marked)), totals };
  };

  const substringRanges = (text: string, needle: string): SearchMatchRange[] => {
    if (!needle) return [];
    const idx = text.toLowerCase().indexOf(needle.toLowerCase());
    return idx >= 0 ? [{ start: idx, end: idx + needle.length }] : [];
  };

  const matchesAllTerms = (haystack: string, parsed: ParsedSearchQuery): boolean => {
    const lower = haystack.toLowerCase();
    return (
      parsed.terms.every((term) => lower.includes(term.toLowerCase())) &&
      parsed.phrases.every((phrase) => lower.includes(phrase.toLowerCase()))
    );
  };

  const delegatedLaneCandidates = async (
    parsed: ParsedSearchQuery,
    matchAll: boolean
  ): Promise<Candidate[]> => {
    if (!deps.lanes) return [];
    let lanes: LaneSummary[] = [];
    try {
      lanes = await deps.lanes.list();
    } catch {
      return [];
    }
    const queryText = rankQueryText(parsed);
    const out: Candidate[] = [];
    for (const lane of lanes) {
      if (lane.archivedAt) continue;
      const haystack = `${lane.name}\n${lane.description ?? ""}\n${lane.branchRef}`;
      if (!matchAll && !matchesAllTerms(haystack, parsed)) continue;
      if (parsed.sinceIso && lane.createdAt < parsed.sinceIso) continue;
      let deepLink: string;
      try {
        deepLink = buildDeeplink({ kind: "lane", laneId: lane.id }, { form: "ade" });
      } catch {
        deepLink = `ade://lane/${encodeURIComponent(lane.id)}`;
      }
      const snippet = (lane.description || lane.branchRef).slice(0, 240);
      out.push({
        docId: `lane:${lane.id}`,
        kind: "lane",
        title: lane.name,
        rankTitle: lane.name,
        laneId: lane.id,
        laneName: lane.name,
        sessionId: null,
        deepLink,
        updatedAt: lane.createdAt,
        bm25: 0,
        snippet,
        matchRanges: substringRanges(snippet, queryText)
      });
    }
    return out;
  };

  const delegatedFileCandidates = async (
    parsed: ParsedSearchQuery,
    matchAll: boolean,
    laneId: string | null
  ): Promise<Candidate[]> => {
    if (!deps.files || matchAll) return [];
    // File hits carry no timestamps, so a since: filter cannot be honored for
    // them — skip rather than return results of unknown recency.
    if (parsed.sinceIso) return [];
    const queryText = rankQueryText(parsed);
    if (!queryText) return [];
    const out: Candidate[] = [];
    const seen = new Set<string>();
    try {
      const quick = await deps.files.quickOpen(queryText, DELEGATED_FILE_LIMIT, laneId);
      for (const item of quick) {
        const docId = `file:${item.path}`;
        if (seen.has(docId)) continue;
        seen.add(docId);
        out.push({
          docId,
          kind: "file",
          title: item.path,
          rankTitle: path.basename(item.path),
          laneId,
          laneName: null,
          sessionId: null,
          deepLink: `ade://files?path=${encodeURIComponent(item.path)}`,
          updatedAt: "",
          bm25: 0,
          snippet: item.path,
          matchRanges: substringRanges(item.path, queryText)
        });
      }
    } catch {
      // file index unavailable
    }
    try {
      const matches = await deps.files.searchText(queryText, DELEGATED_FILE_LIMIT, laneId);
      for (const match of matches) {
        const docId = `file:${match.path}:${match.line}`;
        if (seen.has(docId)) continue;
        seen.add(docId);
        out.push({
          docId,
          kind: "file",
          title: `${match.path}:${match.line}`,
          rankTitle: "",
          laneId,
          laneName: null,
          sessionId: null,
          deepLink: `ade://files?path=${encodeURIComponent(match.path)}&line=${match.line}`,
          updatedAt: "",
          bm25: 0,
          snippet: match.preview.slice(0, 240),
          matchRanges: substringRanges(match.preview.slice(0, 240), queryText)
        });
      }
    } catch {
      // content search unavailable
    }
    return out;
  };

  const delegatedArtifactCandidates = (parsed: ParsedSearchQuery, matchAll: boolean): Candidate[] => {
    if (!deps.artifacts) return [];
    let artifacts: ReturnType<NonNullable<SearchServiceDeps["artifacts"]>["list"]>;
    try {
      artifacts = deps.artifacts.list(DELEGATED_ARTIFACT_LIMIT);
    } catch {
      return [];
    }
    const queryText = rankQueryText(parsed);
    const out: Candidate[] = [];
    for (const artifact of artifacts) {
      const title = artifact.title || artifact.id;
      const haystack = `${title}\n${artifact.description ?? ""}`;
      if (!matchAll && !matchesAllTerms(haystack, parsed)) continue;
      if (parsed.sinceIso && (artifact.createdAt ?? "") < parsed.sinceIso) continue;
      const snippet = (artifact.description || title).slice(0, 240);
      out.push({
        docId: `artifact:${artifact.id}`,
        kind: "artifact",
        title,
        rankTitle: title,
        laneId: null,
        laneName: null,
        sessionId: null,
        deepLink: `ade://proof?artifactId=${encodeURIComponent(artifact.id)}`,
        updatedAt: artifact.createdAt ?? "",
        bm25: 0,
        snippet,
        matchRanges: substringRanges(snippet, queryText)
      });
    }
    return out;
  };

  const delegatedLinearCandidates = async (parsed: ParsedSearchQuery): Promise<Candidate[]> => {
    if (!deps.linear) return [];
    const queryText = rankQueryText(parsed);
    if (!queryText) return [];
    try {
      const { issues } = await deps.linear.searchIssues(queryText);
      const recentEnough = parsed.sinceIso
        ? issues.filter((issue) => (issue.updatedAt ?? "") >= parsed.sinceIso!)
        : issues;
      return recentEnough.map((issue) => {
        let deepLink: string;
        try {
          deepLink = buildDeeplink(
            { kind: "linear-issue", issueIdentifier: issue.identifier },
            { form: "ade" }
          );
        } catch {
          deepLink = `ade://linear-issue/${encodeURIComponent(issue.identifier)}`;
        }
        const snippet = (issue.description ?? issue.title).slice(0, 240);
        return {
          docId: `linear:${issue.identifier}`,
          kind: "linear" as const,
          title: `${issue.identifier} ${issue.title}`,
          rankTitle: issue.title,
          laneId: null,
          laneName: null,
          sessionId: null,
          deepLink,
          updatedAt: issue.updatedAt ?? "",
          bm25: 0,
          snippet,
          matchRanges: substringRanges(snippet, queryText)
        };
      });
    } catch {
      return [];
    }
  };

  const decodeCursor = (cursor: string | undefined): number => {
    if (!cursor) return 0;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as { offset?: number };
      return Number.isInteger(parsed.offset) && parsed.offset! >= 0 ? parsed.offset! : 0;
    } catch {
      return 0;
    }
  };

  const encodeCursor = (offset: number): string => {
    return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64");
  };

  const query = async (args: SearchQueryArgs): Promise<SearchQueryResult> => {
    const parsed = parseSearchQuery(args.query ?? "", { now: now() });
    // A typoed inline filter (kind:bogus, since:whenever) must not silently
    // broaden into a match-all across every kind — reject deterministically.
    if (parsed.invalidFilters.length > 0) {
      return { results: [], totalByKind: {}, nextCursor: null };
    }
    const kinds = effectiveKinds(args, parsed);
    if (kinds.length === 0) return { results: [], totalByKind: {}, nextCursor: null };
    const matchAll = isMatchAllQuery(parsed);
    const laneId = await resolveLaneFilter(args, parsed);
    const limit = Math.max(1, Math.min(args.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT));
    const offset = decodeCursor(args.cursor);

    const scopeChatSessionId = args.callerScope?.chatSessionId?.trim() || null;
    const excludeSessionContent = args.callerScope?.excludeSessionContent === true;
    const { candidates: ftsCandidates, totals } = queryFtsCandidates(
      parsed,
      kinds,
      laneId,
      parsed.sessionId,
      scopeChatSessionId,
      excludeSessionContent
    );

    const delegated: Candidate[] = [];
    if (!parsed.sessionId) {
      if (kinds.includes("lane") && !laneId) {
        delegated.push(...(await delegatedLaneCandidates(parsed, matchAll)));
      }
      if (kinds.includes("file")) {
        delegated.push(...(await delegatedFileCandidates(parsed, matchAll, laneId)));
      }
      if (kinds.includes("artifact") && !laneId) {
        delegated.push(...delegatedArtifactCandidates(parsed, matchAll));
      }
      if (kinds.includes("linear") && !matchAll) {
        delegated.push(...(await delegatedLinearCandidates(parsed)));
      }
    }

    for (const candidate of delegated) {
      totals[candidate.kind] = (totals[candidate.kind] ?? 0) + 1;
    }

    const tiered = rankCandidates([...ftsCandidates, ...delegated], parsed);

    const page = tiered.slice(offset, offset + limit);
    const results: SearchResultItem[] = page.map((candidate) => ({
      kind: candidate.kind,
      id: candidate.docId,
      title: candidate.title,
      snippet: candidate.snippet,
      matchRanges: candidate.matchRanges,
      laneId: candidate.laneId,
      laneName: candidate.laneName,
      sessionId: candidate.sessionId,
      deepLink: candidate.deepLink,
      updatedAt: candidate.updatedAt
    }));

    return {
      results,
      totalByKind: totals,
      nextCursor: offset + limit < tiered.length ? encodeCursor(offset + limit) : null
    };
  };

  // ---------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------

  return {
    query,

    indexStatus(): SearchIndexStatus {
      const db = ensureDb();
      const byKind: Partial<Record<SearchDocKind, number>> = {};
      for (const row of all<{ kind: string; n: number }>(
        "SELECT kind, COUNT(*) AS n FROM docs GROUP BY kind"
      )) {
        byKind[row.kind as SearchDocKind] = row.n;
      }
      const lastUpdated = getRow<{ v: string | null }>("SELECT MAX(updated_at) AS v FROM sources");
      const persistedBackfill = getRow<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'backfillComplete'"
      );
      return {
        ready: true,
        schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
        docCount: countDocs(),
        docCountByKind: byKind,
        pendingSources: queue.size,
        backfillComplete: backfillComplete || persistedBackfill?.value === "1",
        lastUpdatedAt: lastUpdated?.v ?? null,
        indexPath: db.path
      };
    },

    rebuildIndex(): SearchRebuildResult {
      if (disposed) return { started: false };
      queue.clear();
      // Serialize the clear behind any in-flight source processor: clearing
      // mid-source would let that processor resume, write only its later
      // chunk, and persist an advanced cursor into the freshly cleared index.
      workChain = workChain.then(() => {
        if (disposed) return;
        clearSearchIndex(ensureDb().db);
        backfillComplete = false;
        backfillStarted = false;
        startBackfill();
      });
      return { started: true };
    },

    startBackfill,

    /** Hook: a chat event was committed for this session. */
    notifyChatEvent(sessionId: string): void {
      enqueue("chat-session", sessionId);
    },

    /** Hook: PTY output was appended to this session's transcript. */
    notifyTerminalData(sessionId: string): void {
      enqueue("terminal-session", sessionId);
    },

    /** Hook: session meta changed or the session was deleted. */
    notifySessionChanged(sessionId: string, reason: "meta-updated" | "deleted"): void {
      if (reason === "deleted") {
        try {
          removeSessionDocs(sessionId);
        } catch (error) {
          logger?.warn("search.session_delete_failed", {
            sessionId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }
      // Re-resolve tool type at process time.
      enqueue("chat-session", sessionId);
      enqueue("terminal-session", sessionId);
    },

    /** Hook: a PR was refreshed (or, with no id, the PR set changed). */
    notifyPrChanged(prId?: string): void {
      if (prId) enqueue("pr", prId);
      else enqueue("pr-sweep", "all");
    },

    /** Hook: lane commits/branches likely changed. */
    notifyLaneActivity(laneId: string): void {
      enqueue("lane-git", laneId);
    },

    /** Drain the ingestion queue now (tests + rebuild). */
    async processPendingNow(): Promise<void> {
      for (const entry of queue.values()) entry.dueAt = 0;
      await processQueue();
    },

    dispose(): void {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      queue.clear();
      index?.close();
      index = null;
    }
  };
}
