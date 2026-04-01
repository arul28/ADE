import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import type {
  ConvergenceRoundStat,
  ConvergenceStatus,
  ConvergenceRuntimeState,
  IssueInventoryItem,
  IssueInventorySnapshot,
  IssueInventoryState,
  IssueSource,
  PipelineSettings,
  PrCheck,
  PrComment,
  PrReviewThread,
} from "../../../shared/types";
import { DEFAULT_CONVERGENCE_RUNTIME_STATE, DEFAULT_PIPELINE_SETTINGS } from "../../../shared/types";
import { isNoisyIssueComment } from "./resolverUtils";
import { nowIso } from "../shared/utils";

// ---------------------------------------------------------------------------
// Source detection — maps GitHub comment authors to known review bot sources
// ---------------------------------------------------------------------------

const SOURCE_PATTERNS: Array<{ pattern: RegExp; source: IssueSource }> = [
  { pattern: /^coderabbitai(\[bot\])?$/i, source: "coderabbit" },
  { pattern: /^chatgpt-codex-connector(\[bot\])?$/i, source: "codex" },
  { pattern: /^codex(\[bot\])?$/i, source: "codex" },
  { pattern: /^copilot(\[bot\])?$/i, source: "copilot" },
  { pattern: /^github-copilot(\[bot\])?$/i, source: "copilot" },
  { pattern: /^ade-review(\[bot\])?$/i, source: "ade" },
];

function detectSource(author: string | null | undefined): IssueSource {
  const name = (author ?? "").trim();
  if (!name) return "unknown";
  for (const { pattern, source } of SOURCE_PATTERNS) {
    if (pattern.test(name)) return source;
  }
  if (/\[bot\]/i.test(name) || /\bbot\b/i.test(name)) return "unknown";
  return "human";
}

// ---------------------------------------------------------------------------
// Severity extraction — reuses the same pattern as prIssueResolver.ts
// ---------------------------------------------------------------------------

function extractSeverity(value: string): "critical" | "major" | "minor" | null {
  // Match explicit severity words
  const wordMatch = value.match(/\b(Critical|Major|Minor)\b/i);
  if (wordMatch?.[1]) return wordMatch[1].toLowerCase() as "critical" | "major" | "minor";
  // Match Codex P1/P2/P3 priority labels
  if (/\bP1\b/.test(value)) return "critical";
  if (/\bP2\b/.test(value)) return "major";
  if (/\bP3\b/.test(value)) return "minor";
  // Match emoji severity indicators (CodeRabbit uses 🔴 🟠 etc.)
  if (/🔴/.test(value)) return "critical";
  if (/🟠|⚠️/.test(value)) return "major";
  if (/🟡/.test(value)) return "minor";
  // Match "[severity]" bracket patterns
  const bracketMatch = value.match(/\[(critical|major|minor|bug|error|warning|nitpick|nit)\]/i);
  if (bracketMatch?.[1]) {
    const label = bracketMatch[1].toLowerCase();
    if (label === "bug" || label === "error" || label === "critical") return "critical";
    if (label === "warning" || label === "major") return "major";
    return "minor";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Headline extraction — compact summary for display
// ---------------------------------------------------------------------------

function stripEmojiNoise(value: string): string {
  return value
    .replace(/[⚠️🔴🟠🟡🟢🔵⭐🐰🤖💡📝🚨✅❌⬆️🧹🛑✨💥🧪]/g, "")
    .replace(/Potential issue\s*\|?\s*/gi, "")
    .replace(/\*\*(Critical|Major|Minor|Bug|Suggestion|Nitpick|Nit)\*\*\s*[:|]?\s*/gi, "")
    .replace(/^\s*[:|]\s*/, "")
    .trim();
}

function extractHeadline(body: string | null | undefined, fallback: string): string {
  const raw = (body ?? "").trim();
  if (!raw) return fallback;
  // Try to extract a bold title like **Some Title**
  const boldMatch = raw.match(/\*\*([^*]+)\*\*/);
  if (boldMatch?.[1]) {
    const title = stripEmojiNoise(boldMatch[1].trim());
    if (title.length > 0 && title.length <= 120) return title;
  }
  // Fall back to first line, stripped of markdown noise and emoji
  const firstLine = stripEmojiNoise(
    raw.split(/\r?\n/)[0]
      .replace(/[#*>`_~]/g, "")
      .trim(),
  );
  if (firstLine.length > 0) {
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// DB row shape
// ---------------------------------------------------------------------------

type InventoryRow = {
  id: string;
  pr_id: string;
  source: string;
  type: string;
  external_id: string;
  state: string;
  round: number;
  file_path: string | null;
  line: number | null;
  severity: string | null;
  headline: string;
  body: string | null;
  author: string | null;
  url: string | null;
  dismiss_reason: string | null;
  agent_session_id: string | null;
  thread_comment_count: number | null;
  thread_latest_comment_id: string | null;
  thread_latest_comment_author: string | null;
  thread_latest_comment_at: string | null;
  thread_latest_comment_source: string | null;
  created_at: string;
  updated_at: string;
};

function rowToItem(row: InventoryRow): IssueInventoryItem {
  return {
    id: row.id,
    prId: row.pr_id,
    source: row.source as IssueSource,
    type: row.type as IssueInventoryItem["type"],
    externalId: row.external_id,
    state: row.state as IssueInventoryState,
    round: row.round,
    filePath: row.file_path,
    line: row.line,
    severity: row.severity as IssueInventoryItem["severity"],
    headline: row.headline,
    body: row.body,
    author: row.author,
    url: row.url,
    dismissReason: row.dismiss_reason,
    agentSessionId: row.agent_session_id,
    threadCommentCount: row.thread_comment_count,
    threadLatestCommentId: row.thread_latest_comment_id,
    threadLatestCommentAuthor: row.thread_latest_comment_author,
    threadLatestCommentAt: row.thread_latest_comment_at,
    threadLatestCommentSource: row.thread_latest_comment_source as IssueSource | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Convergence helpers
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ROUNDS = 5;

function computeConvergenceStatus(items: IssueInventoryItem[], maxRounds: number = DEFAULT_MAX_ROUNDS): ConvergenceStatus {
  let totalNew = 0;
  let totalFixed = 0;
  let totalDismissed = 0;
  let totalEscalated = 0;
  let totalSentToAgent = 0;
  let currentRound = 0;

  const roundMap = new Map<number, ConvergenceRoundStat>();
  for (const item of items) {
    switch (item.state) {
      case "new": totalNew++; break;
      case "fixed": totalFixed++; break;
      case "dismissed": totalDismissed++; break;
      case "escalated": totalEscalated++; break;
      case "sent_to_agent": totalSentToAgent++; break;
    }

    if (item.round > currentRound) currentRound = item.round;

    if (item.round > 0) {
      const stat = roundMap.get(item.round) ?? { round: item.round, newCount: 0, fixedCount: 0, dismissedCount: 0 };
      switch (item.state) {
        case "new": case "sent_to_agent": stat.newCount++; break;
        case "fixed": stat.fixedCount++; break;
        case "dismissed": stat.dismissedCount++; break;
      }
      roundMap.set(item.round, stat);
    }
  }

  const issuesPerRound = Array.from(roundMap.values()).sort((a, b) => a.round - b.round);
  const lastRoundStat = issuesPerRound.at(-1);
  const isConverging = lastRoundStat != null && (lastRoundStat.fixedCount + lastRoundStat.dismissedCount) > 0;
  const canAutoAdvance = totalNew > 0 && currentRound < maxRounds;

  return {
    currentRound,
    maxRounds,
    issuesPerRound,
    totalNew,
    totalFixed,
    totalDismissed,
    totalEscalated,
    totalSentToAgent,
    isConverging,
    canAutoAdvance,
  };
}

type ConvergenceRuntimeRow = {
  pr_id: string;
  auto_converge_enabled: number;
  status: string;
  poller_status: string;
  current_round: number;
  active_session_id: string | null;
  active_lane_id: string | null;
  active_href: string | null;
  pause_reason: string | null;
  error_message: string | null;
  last_started_at: string | null;
  last_polled_at: string | null;
  last_paused_at: string | null;
  last_stopped_at: string | null;
  created_at: string;
  updated_at: string;
};

function buildDefaultRuntimeState(prId: string): ConvergenceRuntimeState {
  const now = nowIso();
  return {
    prId,
    ...DEFAULT_CONVERGENCE_RUNTIME_STATE,
    createdAt: now,
    updatedAt: now,
  };
}

function rowToConvergenceRuntime(row: ConvergenceRuntimeRow): ConvergenceRuntimeState {
  return {
    prId: row.pr_id,
    autoConvergeEnabled: row.auto_converge_enabled === 1,
    status: row.status as ConvergenceRuntimeState["status"],
    pollerStatus: row.poller_status as ConvergenceRuntimeState["pollerStatus"],
    currentRound: row.current_round,
    activeSessionId: row.active_session_id,
    activeLaneId: row.active_lane_id,
    activeHref: row.active_href,
    pauseReason: row.pause_reason,
    errorMessage: row.error_message,
    lastStartedAt: row.last_started_at,
    lastPolledAt: row.last_polled_at,
    lastPausedAt: row.last_paused_at,
    lastStoppedAt: row.last_stopped_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createIssueInventoryService(deps: { db: AdeDb }) {
  const { db } = deps;

  function getAllRows(prId: string): InventoryRow[] {
    return db.all<InventoryRow>(
      "select * from pr_issue_inventory where pr_id = ? order by created_at asc",
      [prId],
    );
  }

  function getItemsByState(prId: string, state: IssueInventoryState): IssueInventoryItem[] {
    return db.all<InventoryRow>(
      "select * from pr_issue_inventory where pr_id = ? and state = ? order by created_at asc",
      [prId, state],
    ).map(rowToItem);
  }

  function readPipelineSettings(prId: string): PipelineSettings {
    const row = db.get<{
      auto_merge: number;
      merge_method: string;
      max_rounds: number;
      on_rebase_needed: string;
    }>("select auto_merge, merge_method, max_rounds, on_rebase_needed from pr_pipeline_settings where pr_id = ?", [prId]);
    if (!row) return { ...DEFAULT_PIPELINE_SETTINGS };
    return {
      autoMerge: row.auto_merge === 1,
      mergeMethod: row.merge_method as PipelineSettings["mergeMethod"],
      maxRounds: row.max_rounds,
      onRebaseNeeded: row.on_rebase_needed as PipelineSettings["onRebaseNeeded"],
    };
  }


  function upsertItem(
    prId: string,
    externalId: string,
    data: {
      source: IssueSource;
      type: IssueInventoryItem["type"];
      filePath: string | null;
      line: number | null;
      severity: IssueInventoryItem["severity"];
      headline: string;
      body: string | null;
      author: string | null;
      url: string | null;
      threadCommentCount?: number | null;
      threadLatestCommentId?: string | null;
      threadLatestCommentAuthor?: string | null;
      threadLatestCommentAt?: string | null;
      threadLatestCommentSource?: IssueSource | null;
    },
    options: {
      state?: IssueInventoryState;
      round?: number;
      dismissReason?: string | null;
      agentSessionId?: string | null;
    } = {},
  ): void {
    const now = nowIso();
    const existing = db.get<InventoryRow>(
      "select * from pr_issue_inventory where pr_id = ? and external_id = ?",
      [prId, externalId],
    );
    const nextState = options.state ?? existing?.state ?? "new";
    const nextRound = options.round ?? existing?.round ?? 0;
    const nextDismissReason = options.dismissReason !== undefined
      ? options.dismissReason
      : existing?.dismiss_reason ?? null;
    const nextAgentSessionId = options.agentSessionId !== undefined
      ? options.agentSessionId
      : existing?.agent_session_id ?? null;
    const nextThreadCommentCount = data.threadCommentCount ?? existing?.thread_comment_count ?? null;
    const nextThreadLatestCommentId = data.threadLatestCommentId ?? existing?.thread_latest_comment_id ?? null;
    const nextThreadLatestCommentAuthor = data.threadLatestCommentAuthor ?? existing?.thread_latest_comment_author ?? null;
    const nextThreadLatestCommentAt = data.threadLatestCommentAt ?? existing?.thread_latest_comment_at ?? null;
    const nextThreadLatestCommentSource = data.threadLatestCommentSource ?? (existing?.thread_latest_comment_source as IssueSource | null) ?? null;

    if (existing) {
      db.run(
        `update pr_issue_inventory
         set headline = ?, body = ?, severity = ?, file_path = ?, line = ?,
             author = ?, url = ?, source = ?, state = ?, round = ?, dismiss_reason = ?,
             agent_session_id = ?, thread_comment_count = ?, thread_latest_comment_id = ?,
             thread_latest_comment_author = ?, thread_latest_comment_at = ?,
             thread_latest_comment_source = ?, updated_at = ?
         where id = ?`,
        [
          data.headline,
          data.body,
          data.severity,
          data.filePath,
          data.line,
          data.author,
          data.url,
          data.source,
          nextState,
          nextRound,
          nextDismissReason,
          nextAgentSessionId,
          nextThreadCommentCount,
          nextThreadLatestCommentId,
          nextThreadLatestCommentAuthor,
          nextThreadLatestCommentAt,
          nextThreadLatestCommentSource,
          now,
          existing.id,
        ],
      );
    } else {
      db.run(
        `insert into pr_issue_inventory
           (id, pr_id, source, type, external_id, state, round, file_path, line,
            severity, headline, body, author, url, dismiss_reason, agent_session_id,
            thread_comment_count, thread_latest_comment_id, thread_latest_comment_author,
            thread_latest_comment_at, thread_latest_comment_source, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          prId,
          data.source,
          data.type,
          externalId,
          nextState,
          nextRound,
          data.filePath,
          data.line,
          data.severity,
          data.headline,
          data.body,
          data.author,
          data.url,
          nextDismissReason,
          nextAgentSessionId,
          nextThreadCommentCount,
          nextThreadLatestCommentId,
          nextThreadLatestCommentAuthor,
          nextThreadLatestCommentAt,
          nextThreadLatestCommentSource,
          now,
          now,
        ],
      );
    }
  }

  function getConvergenceRuntimeRow(prId: string): ConvergenceRuntimeRow | null {
    return db.get<ConvergenceRuntimeRow>(
      "select * from pr_convergence_state where pr_id = ?",
      [prId],
    );
  }

  function saveConvergenceRuntimeState(prId: string, state: Partial<ConvergenceRuntimeState>): ConvergenceRuntimeState {
    const existing = readConvergenceRuntime(prId);
    const merged: ConvergenceRuntimeState = {
      ...(existing ?? buildDefaultRuntimeState(prId)),
      ...state,
      prId,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };

    db.run(
      `insert into pr_convergence_state
         (pr_id, auto_converge_enabled, status, poller_status, current_round, active_session_id,
          active_lane_id, active_href, pause_reason, error_message, last_started_at, last_polled_at,
          last_paused_at, last_stopped_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(pr_id) do update set
         auto_converge_enabled = excluded.auto_converge_enabled,
         status = excluded.status,
         poller_status = excluded.poller_status,
         current_round = excluded.current_round,
         active_session_id = excluded.active_session_id,
         active_lane_id = excluded.active_lane_id,
         active_href = excluded.active_href,
         pause_reason = excluded.pause_reason,
         error_message = excluded.error_message,
         last_started_at = excluded.last_started_at,
         last_polled_at = excluded.last_polled_at,
         last_paused_at = excluded.last_paused_at,
         last_stopped_at = excluded.last_stopped_at,
         updated_at = excluded.updated_at`,
      [
        merged.prId,
        merged.autoConvergeEnabled ? 1 : 0,
        merged.status,
        merged.pollerStatus,
        merged.currentRound,
        merged.activeSessionId,
        merged.activeLaneId,
        merged.activeHref,
        merged.pauseReason,
        merged.errorMessage,
        merged.lastStartedAt,
        merged.lastPolledAt,
        merged.lastPausedAt,
        merged.lastStoppedAt,
        merged.createdAt,
        merged.updatedAt,
      ],
    );

    return merged;
  }

  function readConvergenceRuntime(prId: string): ConvergenceRuntimeState {
    const row = getConvergenceRuntimeRow(prId);
    return row ? rowToConvergenceRuntime(row) : buildDefaultRuntimeState(prId);
  }

  function buildSnapshot(prId: string): IssueInventorySnapshot {
    const items = getAllRows(prId).map(rowToItem);
    const { maxRounds } = readPipelineSettings(prId);
    const convergence = computeConvergenceStatus(items, maxRounds);
    const runtime = readConvergenceRuntime(prId);
    return {
      prId,
      items,
      convergence,
      runtime: {
        ...runtime,
        currentRound: Math.max(runtime.currentRound, convergence.currentRound),
      },
    };
  }

  return {
    syncFromPrData(
      prId: string,
      checks: PrCheck[],
      reviewThreads: PrReviewThread[],
      comments: PrComment[],
    ): IssueInventorySnapshot {
      const existingRows = getAllRows(prId);
      const existingByExternalId = new Map(existingRows.map((row) => [row.external_id, row] as const));
      const activeFailingChecks = new Set<string>();

      // Sync failing checks
      for (const check of checks) {
        if (check.conclusion !== "failure") continue;
        const externalId = `check:${check.name}`;
        activeFailingChecks.add(externalId);
        const existing = existingByExternalId.get(externalId) ?? null;
        upsertItem(prId, externalId, {
          source: "unknown",
          type: "check_failure",
          filePath: null,
          line: null,
          severity: "major",
          headline: `CI check "${check.name}" failing`,
          body: check.detailsUrl ? `Details: ${check.detailsUrl}` : null,
          author: null,
          url: check.detailsUrl,
        }, existing?.state === "fixed" ? {
          state: "new",
          round: 0,
          dismissReason: null,
          agentSessionId: null,
        } : {
          state: existing?.state as IssueInventoryState | undefined,
        });
      }

      for (const existing of existingRows) {
        if (existing.type !== "check_failure") continue;
        if (activeFailingChecks.has(existing.external_id)) continue;
        if (existing.state === "fixed" || existing.state === "dismissed") continue;
        db.run(
          "update pr_issue_inventory set state = 'fixed', updated_at = ? where id = ?",
          [nowIso(), existing.id],
        );
      }

      // Sync review threads using the latest reply in the conversation.
      for (const thread of reviewThreads) {
        const externalId = `thread:${thread.id}`;
        const latestComment = thread.comments.at(-1) ?? null;
        const commentCount = thread.comments.length;
        const author = latestComment?.author ?? null;
        const body = latestComment?.body ?? null;
        const source = detectSource(author);
        const existing = existingByExternalId.get(externalId) ?? null;

        if (thread.isResolved || thread.isOutdated) {
          if (!existing) continue;
          upsertItem(prId, externalId, {
            source,
            type: "review_thread",
            filePath: thread.path,
            line: thread.line,
            severity: extractSeverity(body ?? ""),
            headline: extractHeadline(body, `Review thread at ${thread.path ?? "unknown"}`),
            body,
            author,
            url: thread.url ?? latestComment?.url ?? null,
            threadCommentCount: commentCount,
            threadLatestCommentId: latestComment?.id ?? existing.thread_latest_comment_id,
            threadLatestCommentAuthor: author,
            threadLatestCommentAt: latestComment?.updatedAt ?? latestComment?.createdAt ?? thread.updatedAt,
            threadLatestCommentSource: source,
          }, {
            state: "fixed",
            round: existing.round,
            dismissReason: null,
            agentSessionId: existing.agent_session_id,
          });
          continue;
        }

        const threadChanged = existing != null
          && (
            commentCount > (existing.thread_comment_count ?? 0)
            || (latestComment?.id != null && latestComment.id !== existing.thread_latest_comment_id)
          );
        const shouldReopen = !existing || (threadChanged && source !== "ade");

        upsertItem(prId, externalId, {
          source,
          type: "review_thread",
          filePath: thread.path,
          line: thread.line,
          severity: extractSeverity(body ?? ""),
          headline: extractHeadline(body, `Review thread at ${thread.path ?? "unknown"}`),
          body,
          author,
          url: thread.url ?? latestComment?.url ?? null,
          threadCommentCount: commentCount,
          threadLatestCommentId: latestComment?.id ?? existing?.thread_latest_comment_id ?? null,
          threadLatestCommentAuthor: author,
          threadLatestCommentAt: latestComment?.updatedAt ?? latestComment?.createdAt ?? thread.updatedAt,
          threadLatestCommentSource: source,
        }, shouldReopen ? {
          state: "new",
          round: existing?.round ?? 0,
          dismissReason: null,
          agentSessionId: null,
        } : {
          state: existing?.state as IssueInventoryState | undefined,
          round: existing?.round,
          dismissReason: existing?.dismiss_reason,
          agentSessionId: existing?.agent_session_id,
        });
      }

      for (const comment of comments) {
        if (comment.source !== "issue") continue;
        if (isNoisyIssueComment(comment)) continue;
        const body = comment.body ?? "";
        upsertItem(prId, `comment:${comment.id}`, {
          source: detectSource(comment.author),
          type: "issue_comment",
          filePath: comment.path,
          line: comment.line,
          severity: extractSeverity(body),
          headline: extractHeadline(body, `Comment by ${comment.author}`),
          body,
          author: comment.author,
          url: comment.url,
        });
      }

      return buildSnapshot(prId);
    },

    getInventory(prId: string): IssueInventorySnapshot {
      return buildSnapshot(prId);
    },

    getNewItems(prId: string): IssueInventoryItem[] {
      return getItemsByState(prId, "new");
    },

    markSentToAgent(prId: string, itemIds: string[], sessionId: string, round: number): void {
      const now = nowIso();
      for (const id of itemIds) {
        db.run(
          `update pr_issue_inventory
           set state = 'sent_to_agent', round = ?, agent_session_id = ?, updated_at = ?
           where id = ? and pr_id = ?`,
          [round, sessionId, now, id, prId],
        );
      }
    },

    markFixed(prId: string, itemIds: string[]): void {
      const now = nowIso();
      for (const id of itemIds) {
        db.run(
          "update pr_issue_inventory set state = 'fixed', updated_at = ? where id = ? and pr_id = ?",
          [now, id, prId],
        );
      }
    },

    markDismissed(prId: string, itemIds: string[], reason: string): void {
      const now = nowIso();
      for (const id of itemIds) {
        db.run(
          "update pr_issue_inventory set state = 'dismissed', dismiss_reason = ?, updated_at = ? where id = ? and pr_id = ?",
          [reason, now, id, prId],
        );
      }
    },

    markEscalated(prId: string, itemIds: string[]): void {
      const now = nowIso();
      for (const id of itemIds) {
        db.run(
          "update pr_issue_inventory set state = 'escalated', updated_at = ? where id = ? and pr_id = ?",
          [now, id, prId],
        );
      }
    },

    getConvergenceStatus(prId: string): ConvergenceStatus {
      const items = getAllRows(prId).map(rowToItem);
      const { maxRounds } = readPipelineSettings(prId);
      return computeConvergenceStatus(items, maxRounds);
    },

    resetInventory(prId: string): void {
      db.run("delete from pr_issue_inventory where pr_id = ?", [prId]);
      db.run("delete from pr_convergence_state where pr_id = ?", [prId]);
    },

    getConvergenceRuntime(prId: string): ConvergenceRuntimeState {
      return readConvergenceRuntime(prId);
    },

    saveConvergenceRuntime(prId: string, state: Partial<ConvergenceRuntimeState>): ConvergenceRuntimeState {
      return saveConvergenceRuntimeState(prId, state);
    },

    resetConvergenceRuntime(prId: string): void {
      db.run("delete from pr_convergence_state where pr_id = ?", [prId]);
    },

    // ----- Pipeline settings (auto-converge / auto-merge) -----

    getPipelineSettings(prId: string): PipelineSettings {
      return readPipelineSettings(prId);
    },

    savePipelineSettings(prId: string, settings: Partial<PipelineSettings>): void {
      const current = readPipelineSettings(prId);
      const merged = { ...current, ...settings };
      const now = nowIso();
      db.run(
        `insert into pr_pipeline_settings (pr_id, auto_merge, merge_method, max_rounds, on_rebase_needed, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(pr_id) do update set
           auto_merge = excluded.auto_merge,
           merge_method = excluded.merge_method,
           max_rounds = excluded.max_rounds,
           on_rebase_needed = excluded.on_rebase_needed,
           updated_at = excluded.updated_at`,
        [prId, merged.autoMerge ? 1 : 0, merged.mergeMethod, merged.maxRounds, merged.onRebaseNeeded, now],
      );
    },

    deletePipelineSettings(prId: string): void {
      db.run("delete from pr_pipeline_settings where pr_id = ?", [prId]);
    },
  };
}
