import { randomUUID } from "node:crypto";
import type {
  AdeUsageActivitySummary,
  AdeUsageAgentModelSummary,
  AdeUsageAgentProviderSummary,
  AdeUsageClientSummary,
  AdeUsageClientSurface,
  AdeUsageDailyPoint,
  AdeUsageFeatureSummary,
  AdeUsageLaneSummary,
  AdeUsageModelSummary,
  AdeUsageProviderSummary,
} from "../../../shared/types";
import type { AdeDb, SqlValue } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import { localDayKey, localDayOffset, localDayOrdinal } from "./localDay";
import {
  decodeActiveDayKeys,
  type LaneUsageTombstoneRow,
} from "../lanes/laneUsageTombstone";

const DAILY_BUCKET_SCAN_MAX_ROWS = 250_000;

export type AdeUsageStatsRange = {
  since: string | null;
  until: string;
};

export type AdeDatabaseUsageStats = {
  summary: {
    trackedAdeTokens: number;
    trackedAdeInputTokens: number;
    trackedAdeOutputTokens: number;
    trackedAdeCalls: number;
    trackedAdeDurationMs: number;
    chatSessions: number;
    terminalSessions: number;
    activeLanes: number;
    lanesCreated: number;
    lanesArchived: number;
    lanesDeleted: number;
    commitsCreated: number;
    pushOperations: number;
    prLandings: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
    artifactsCaptured: number;
    automationRuns: number;
    workerRuns: number;
    totalInteractions: number;
    activeDays: number;
    currentStreakDays: number;
    longestStreakDays: number;
    longestSessionMs: number;
  };
  providers: AdeUsageProviderSummary[];
  models: AdeUsageModelSummary[];
  agentProviders: AdeUsageAgentProviderSummary[];
  agentModels: AdeUsageAgentModelSummary[];
  features: AdeUsageFeatureSummary[];
  lanes: AdeUsageLaneSummary[];
  activities: AdeUsageActivitySummary[];
  clients: AdeUsageClientSummary[];
  daily: Array<Partial<AdeUsageDailyPoint> & Pick<AdeUsageDailyPoint, "date">>;
};

const MEANINGFUL_ACTIONS = new Set([
  "chat.create",
  "chat.launch",
  "chat.send",
  "chat.steer",
  "chat.approve",
  "chat.respondToInput",
  "chat.restart",
  "chat.handoff",
  "chat.rewindFiles",
  "chat.createPromptStash",
  "chat.createScheduledWork",
  "chat.cancelScheduledWork",
  "chat.delete",
  "chat.archive",
  "chat.unarchive",
  "work.startCliSession",
  "work.resumeCliSession",
  "work.importExternalSession",
  "work.runQuickCommand",
  "work.sendToSession",
  "work.stopRuntime",
  "work.settleSession",
  "work.unsettleSession",
  "work.snoozeSession",
  "work.wakeSession",
  "lanes.create",
  "lanes.createChild",
  "lanes.createFromUnstaged",
  "lanes.importBranch",
  "lanes.attach",
  "lanes.rename",
  "lanes.reparent",
  "lanes.archive",
  "lanes.archiveAndReclaim",
  "lanes.unarchive",
  "lanes.delete",
  "lanes.rebaseStart",
  "lanes.rebasePush",
  "files.writeTextAtomic",
  "files.writeText",
  "files.createFile",
  "files.createDirectory",
  "files.rename",
  "files.delete",
  "git.stageFile",
  "git.stageAll",
  "git.unstageFile",
  "git.unstageAll",
  "git.discardFile",
  "git.restoreStagedFile",
  "git.commit",
  "git.push",
  "git.pull",
  "git.sync",
  "git.checkoutBranch",
  "git.cherryPick",
  "git.revert",
  "git.stashPush",
  "git.stashApply",
  "git.stashPop",
  "orchestration.runCreate",
  "prs.createFromLane",
  "prs.land",
  "prs.updateDescription",
  "prs.updateBranch",
  "prs.retargetBase",
  "prs.delete",
  "prs.close",
  "prs.reopen",
  "prs.addComment",
  "prs.submitReview",
  "prs.rerunChecks",
  // Deleting a merged PR's branch. It sat outside this set while it was
  // reachable only from a lane-mapped PR; the branch that removed that gate
  // made it an offer on every merged row, and a destructive mutation the user
  // asks for is exactly what this ledger is for. One row per click on a
  // terminal PR — as low-frequency as an action gets.
  "prs.cleanupBranch",
  "automations.triggerManually",
]);

export function usageActionFromIpcChannel(channel: string): string {
  const action = channel.replace(/^ade\./, "");
  if (action.startsWith("agentChat.")) {
    const chatAction = action.slice("agentChat.".length);
    const aliases: Record<string, string> = {
      "promptStashes.create": "createPromptStash",
      "scheduledWork.create": "createScheduledWork",
      "scheduledWork.cancel": "cancelScheduledWork",
    };
    return `chat.${aliases[chatAction] ?? chatAction}`;
  }
  if (action === "pty.create") return "work.startCliSession";
  if (action === "pty.resumeSession") return "work.resumeCliSession";
  if (action === "pty.sendToSession") return "work.sendToSession";
  if (action === "externalSessions.import") return "work.importExternalSession";
  // Settle lifecycle: single + bulk collapse to one coarse action each.
  if (action === "sessions.settle" || action === "sessions.settleMany") return "work.settleSession";
  if (action === "sessions.unsettle" || action === "sessions.unsettleMany") return "work.unsettleSession";
  if (action === "sessions.snooze" || action === "sessions.snoozeMany") return "work.snoozeSession";
  if (action === "sessions.wake" || action === "sessions.wakeMany") return "work.wakeSession";
  return action;
}

export function usageActionFromRpcDomain(domain: string, action: string): string {
  if (domain === "lane") return `lanes.${action}`;
  if (domain === "pr") {
    const aliases: Record<string, string> = {
      closePr: "close",
      reopenPr: "reopen",
      postReviewComment: "addComment",
    };
    return `prs.${aliases[action] ?? action}`;
  }
  if (domain === "file") {
    const aliases: Record<string, string> = {
      deletePath: "delete",
      writeWorkspaceText: "writeText",
    };
    return `files.${aliases[action] ?? action}`;
  }
  if (domain === "pty") {
    if (action === "create") return "work.startCliSession";
    if (action === "resumeSession") return "work.resumeCliSession";
    if (action === "sendToSession") return "work.sendToSession";
    if (action === "dispose") return "work.stopRuntime";
  }
  if (domain === "terminal") {
    if (action === "reattachChatCli") return "work.resumeCliSession";
    if (action === "signal") return "work.stopRuntime";
  }
  if (domain === "external-sessions" && action === "import") return "work.importExternalSession";
  if (domain === "chat") {
    const aliases: Record<string, string> = {
      createSession: "create",
      launchCli: "launch",
      launchHeadless: "launch",
      sendMessage: "send",
      messageSession: "send",
      approveToolUse: "approve",
      archiveSession: "archive",
      unarchiveSession: "unarchive",
      deleteSession: "delete",
      handoffSession: "handoff",
    };
    return `chat.${aliases[action] ?? action}`;
  }
  if (domain === "git") {
    const aliases: Record<string, string> = {
      cherryPickCommit: "cherryPick",
      revertCommit: "revert",
    };
    return `git.${aliases[action] ?? action}`;
  }
  if (domain === "session") {
    if (action === "settleSession" || action === "settleSessions") return "work.settleSession";
    if (action === "unsettleSession" || action === "unsettleSessions") return "work.unsettleSession";
    // Bulk and single snooze/wake collapse to one usage action each: the count
    // that matters is "how often was work filed away", not the batch shape.
    if (action === "snoozeSession" || action === "snoozeSessions") return "work.snoozeSession";
    if (action === "wakeSession" || action === "wakeSessions") return "work.wakeSession";
  }
  return `${domain}.${action}`;
}

export function isMeaningfulUsageAction(action: string): boolean {
  return MEANINGFUL_ACTIONS.has(action);
}

export function usageClientSurfaceFromRpcName(clientName: string | null | undefined): AdeUsageClientSurface {
  const normalized = clientName?.trim().toLowerCase() ?? "";
  if (normalized.includes("ade-desktop")) return "desktop";
  if (normalized.includes("ade-code") || normalized === "ade-cli") return "tui";
  if (normalized.includes("web")) return "web";
  return "api";
}

export function usageClientSurfaceFromPeer(deviceType: string | null | undefined, platform?: string | null): AdeUsageClientSurface {
  const normalized = `${deviceType ?? ""} ${platform ?? ""}`.toLowerCase();
  if (normalized.includes("browser") || normalized.includes("web")) return "web";
  if (normalized.includes("phone") || normalized.includes("ios") || normalized.includes("mobile")) return "mobile";
  if (normalized.includes("desktop") || normalized.includes("mac")) return "desktop";
  return "api";
}

export function recordUsageInteraction(
  db: AdeDb | null | undefined,
  args: {
    projectId?: string | null;
    client: AdeUsageClientSurface;
    action: string;
    feature?: string | null;
    sessionId?: string | null;
    occurredAt?: string;
    /** False preserves local stats while permanently excluding this row from product export. */
    analyticsEligible?: boolean;
  },
): void {
  if (!db || !isMeaningfulUsageAction(args.action)) return;
  try {
    db.run(
      `insert into usage_events(
        id, project_id, client_surface, action, feature, session_id, occurred_at, analytics_exported_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        args.projectId?.trim() || "local",
        args.client,
        args.action,
        args.feature?.trim() || args.action.split(".", 1)[0] || "other",
        args.sessionId?.trim() || null,
        args.occurredAt ?? new Date().toISOString(),
        args.analyticsEligible === false ? "suppressed:analytics_inactive" : null,
      ],
    );
  } catch {
    // Usage accounting must never break the action it observes. Older runtimes
    // may receive a call before their schema migration has completed.
  }
}

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function int(value: unknown): number {
  return Math.max(0, Math.floor(finite(value)));
}

function safeAll<T extends Record<string, unknown>>(db: AdeDb, sql: string, params: SqlValue[] = []): T[] {
  try {
    return db.all<T>(sql, params);
  } catch {
    return [];
  }
}

function safeGet<T extends Record<string, unknown>>(db: AdeDb, sql: string, params: SqlValue[] = []): T | null {
  try {
    return db.get<T>(sql, params);
  } catch {
    return null;
  }
}

function rangeClause(column: string, range: AdeUsageStatsRange): { sql: string; params: SqlValue[] } {
  if (range.since) {
    return { sql: `${column} >= ? and ${column} <= ?`, params: [range.since, range.until] };
  }
  return { sql: `${column} <= ?`, params: [range.until] };
}

function providerFromToolType(toolType: unknown): string {
  const value = typeof toolType === "string" ? toolType.toLowerCase() : "";
  if (value.includes("codex")) return "codex";
  if (value.includes("claude")) return "claude";
  if (value.includes("cursor")) return "cursor";
  if (value.includes("opencode")) return "opencode";
  if (value.includes("droid")) return "droid";
  return value.includes("shell") ? "shell" : "other";
}

function sessionRuntime(row: { tool_type: string | null; resume_metadata_json: string | null }): { provider: string; model: string } {
  let metadata: Record<string, unknown> | null = null;
  try {
    const decoded = row.resume_metadata_json ? JSON.parse(row.resume_metadata_json) : null;
    metadata = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded as Record<string, unknown> : null;
  } catch {
    metadata = null;
  }
  const launch = metadata?.launch && typeof metadata.launch === "object" && !Array.isArray(metadata.launch)
    ? metadata.launch as Record<string, unknown>
    : null;
  const provider = typeof metadata?.provider === "string" && metadata.provider.trim()
    ? metadata.provider.trim()
    : providerFromToolType(row.tool_type);
  const model = typeof launch?.model === "string" && launch.model.trim() ? launch.model.trim() : provider;
  return { provider, model };
}

function isChatSession(row: { tool_type: string | null; chat_session_id: string | null }): boolean {
  const toolType = row.tool_type?.toLowerCase() ?? "";
  return Boolean(row.chat_session_id) || toolType.endsWith("-chat");
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return localDayKey(value) || null;
}

function calculateStreaks(activeDateValues: Iterable<string>, until: string): { activeDays: number; current: number; longest: number } {
  const activeDates = new Set(activeDateValues);
  const ordered = [...activeDates].sort();
  let longest = 0;
  let run = 0;
  let previousOrdinal: number | null = null;
  for (const date of ordered) {
    const ordinal = localDayOrdinal(date);
    if (ordinal == null) continue;
    run = previousOrdinal != null && ordinal - previousOrdinal === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previousOrdinal = ordinal;
  }

  let current = 0;
  let cursor = localDayOffset(until, 0);
  if (!cursor) return { activeDays: activeDates.size, current, longest };
  if (!activeDates.has(localDayKey(cursor))) cursor = localDayOffset(cursor, -1);
  while (cursor && activeDates.has(localDayKey(cursor))) {
    current += 1;
    cursor = localDayOffset(cursor, -1);
  }
  return { activeDays: activeDates.size, current, longest };
}

/**
 * The lifetime active-day set, memoized.
 *
 * The streak union below carries no range predicate — that is the whole point
 * of it, since a streak that shrinks when you narrow the filter is not a
 * streak — but it therefore rescans and de-duplicates all five tables on every
 * single stats call, and this page reads on mount, on every scope or preset
 * change, and on every usage update.
 *
 * Three things bust the entry, and between them they cover everything a streak
 * can actually notice: a different database, the calendar day rolling over, and
 * a short TTL for activity recorded inside the current day. A streak is a count
 * of days, so a value up to `STREAK_CACHE_TTL_MS` old cannot be wrong by more
 * than the moment the day's first activity lands.
 *
 * Keyed on the database handle rather than on a module-level singleton: ADE
 * opens one per project, and a shared entry would show one project's streak on
 * another's page. A `WeakMap` also lets a closed database's entry go with it.
 */
const STREAK_CACHE_TTL_MS = 60_000;
const streakCaches = new WeakMap<AdeDb, { key: string; expiresAtMs: number; dates: string[] }>();

export function collectAdeDatabaseUsageStats(
  db: AdeDb | null | undefined,
  range: AdeUsageStatsRange,
  logger?: Pick<Logger, "debug">,
): AdeDatabaseUsageStats | null {
  if (!db) return null;

  const aiRange = rangeClause("timestamp", range);
  const sessionRange = rangeClause("started_at", range);
  const eventRange = rangeClause("occurred_at", range);
  const operationRange = rangeClause("started_at", range);
  const deltaRange = rangeClause("d.started_at", range);
  const artifactRange = rangeClause("created_at", range);

  /**
   * What a deleted lane left behind.
   *
   * Deleting a lane cascades away its `lanes`, session, delta and `operations`
   * rows, so every count below used to be survivor-only — "lifetime" stats that
   * fell whenever someone tidied up. The tombstone holds that lane's totals as
   * integers plus a day bitmap; nothing here can name the lane or say what it
   * was doing.
   */
  const tombstones = safeAll<LaneUsageTombstoneRow>(db, "select * from lane_usage_tombstones");
  const untilDay = localDayKey(range.until);
  const sinceDay = range.since ? localDayKey(range.since) : null;
  /**
   * A tombstone's counters cover the lane's whole life with no per-day
   * breakdown, so they can only be attributed to a window that contains that
   * whole life. On the lifetime preset that is every one of them; on a 7-day
   * window it is only lanes that both started and finished inside it. Counting
   * a partially-overlapping lane in full would be worse than omitting it.
   */
  const spannedTombstones = tombstones.filter((tombstone) => {
    const last = tombstone.last_active_day ?? tombstone.deleted_day;
    const first = tombstone.first_active_day ?? tombstone.created_day ?? tombstone.deleted_day;
    return last <= untilDay && (!sinceDay || first >= sinceDay);
  });
  const tombstoneSum = (pick: (tombstone: LaneUsageTombstoneRow) => number): number =>
    spannedTombstones.reduce((sum, tombstone) => sum + int(pick(tombstone)), 0);
  const tombstonesCreatedInRange = tombstones.filter((tombstone) => {
    const created = tombstone.created_day;
    return created != null && created <= untilDay && (!sinceDay || created >= sinceDay);
  });
  /**
   * Absorbed tombstones are excluded, not just from creations.
   *
   * The duplicate-lane dedupe writes a tombstone with `mode: "absorbed"` and
   * `lanes_created: 0`, because folding a duplicate row onto its keeper was
   * never a lane the user made. It was never a lane the user *deleted* either —
   * counting it here gave "4 created / 5 deleted" for four real lanes and one
   * race. `lanes_created` is the mode discriminator this file already relies on.
   */
  const tombstonesDeletedInRange = tombstones.filter(
    (tombstone) => int(tombstone.lanes_created) > 0
      && tombstone.deleted_day <= untilDay
      && (!sinceDay || tombstone.deleted_day >= sinceDay),
  );
  /**
   * A day is atomic, so it needs no span rule: a deleted lane's active day was
   * a day this account worked, whatever else happened around it. Fed into both
   * `activeDays` and the streak set.
   */
  const tombstoneActiveDays = tombstones.flatMap((tombstone) =>
    decodeActiveDayKeys(tombstone.first_active_day, tombstone.active_day_bits));

  const aiRows = safeAll<{
    feature: string;
    provider: string;
    model: string | null;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
    successes: number;
  }>(db, `
    select feature, provider, model, count(*) calls,
           sum(coalesce(input_tokens, 0)) input_tokens,
           sum(coalesce(output_tokens, 0)) output_tokens,
           sum(coalesce(duration_ms, 0)) duration_ms,
           sum(case when success = 1 then 1 else 0 end) successes
      from ai_usage_log
     where ${aiRange.sql}
     group by feature, provider, model
  `, aiRange.params);

  const sessionRows = safeAll<{
    id: string;
    lane_id: string;
    tool_type: string | null;
    resume_metadata_json: string | null;
    chat_session_id: string | null;
    started_at: string;
    ended_at: string | null;
  }>(db, `
    select id, lane_id, tool_type, resume_metadata_json, chat_session_id, started_at, ended_at
      from terminal_sessions
     where ${sessionRange.sql}
  `, sessionRange.params);

  const deltaRows = safeAll<{
    lane_id: string;
    lane_name: string | null;
    started_at: string;
    files_changed: number;
    insertions: number;
    deletions: number;
  }>(db, `
    select d.lane_id, l.name lane_name, d.started_at,
           d.files_changed, d.insertions, d.deletions
      from session_deltas d
      left join lanes l on l.id = d.lane_id
     where ${deltaRange.sql}
  `, deltaRange.params);

  const clientRows = safeAll<{
    client_surface: AdeUsageClientSurface;
    interactions: number;
    active_days: number;
    sessions: number;
    last_active_at: string | null;
  }>(db, `
    select client_surface, count(*) interactions,
           count(distinct date(occurred_at, 'localtime')) active_days,
           count(distinct session_id) sessions,
           max(occurred_at) last_active_at
      from usage_events
     where ${eventRange.sql}
     group by client_surface
  `, eventRange.params);

  const clientDailyRows = safeAll<{
    active_date: string | null;
    client_surface: AdeUsageClientSurface;
    interactions: number;
  }>(db, `
    select date(occurred_at, 'localtime') active_date,
           client_surface,
           count(*) interactions
      from (
        select occurred_at, client_surface
          from usage_events
         where ${eventRange.sql}
         order by occurred_at desc
         limit ?
      )
     group by active_date, client_surface
  `, [...eventRange.params, DAILY_BUCKET_SCAN_MAX_ROWS]);

  // Summary day counts and streaks must not depend on the capped chart scans
  // below. This query returns at most one row per local calendar day even when
  // the underlying event tables contain millions of rows.
  const activeDateRows = safeAll<{ active_date: string }>(db, `
    select active_date
      from (
        select date(timestamp, 'localtime') active_date
          from ai_usage_log
         where ${aiRange.sql}
           and (coalesce(input_tokens, 0) > 0 or coalesce(output_tokens, 0) > 0)
        union
        select date(started_at, 'localtime') active_date
          from terminal_sessions
         where ${sessionRange.sql}
        union
        select date(d.started_at, 'localtime') active_date
          from session_deltas d
         where ${deltaRange.sql}
           and (coalesce(d.insertions, 0) > 0 or coalesce(d.deletions, 0) > 0 or coalesce(d.files_changed, 0) > 0)
        union
        select date(occurred_at, 'localtime') active_date
          from usage_events
         where ${eventRange.sql}
        union
        select date(started_at, 'localtime') active_date
          from operations
         where ${operationRange.sql}
           and status = 'succeeded'
           and kind in ('git_commit', 'pr_land')
      )
     where active_date is not null
     order by active_date
  `, [
    ...aiRange.params,
    ...sessionRange.params,
    ...deltaRange.params,
    ...eventRange.params,
    ...operationRange.params,
  ]);

  // Streaks are a lifetime property of the account, not of the selected
  // window. Deriving them from the range-filtered rows above capped them at
  // the preset width, so a genuine 22-day streak read as "7-day streak" on the
  // 7d preset and "1-day" on today — the number changed when you changed the
  // filter, which a streak by definition must not. Same union as
  // `activeDateRows` with every range predicate dropped; it still returns at
  // most one row per calendar day.
  const streakCacheKey = localDayKey(range.until) || "unknown";
  const nowMs = Date.now();
  const streakCache = streakCaches.get(db);
  let streakDates: string[];
  if (streakCache && streakCache.key === streakCacheKey && streakCache.expiresAtMs > nowMs) {
    streakDates = streakCache.dates;
  } else {
    streakDates = safeAll<{ active_date: string }>(db, `
      select active_date
        from (
          select date(timestamp, 'localtime') active_date
            from ai_usage_log
           where (coalesce(input_tokens, 0) > 0 or coalesce(output_tokens, 0) > 0)
          union
          select date(started_at, 'localtime') active_date
            from terminal_sessions
          union
          select date(d.started_at, 'localtime') active_date
            from session_deltas d
           where (coalesce(d.insertions, 0) > 0 or coalesce(d.deletions, 0) > 0 or coalesce(d.files_changed, 0) > 0)
          union
          select date(occurred_at, 'localtime') active_date
            from usage_events
          union
          select date(started_at, 'localtime') active_date
            from operations
           where status = 'succeeded'
             and kind in ('git_commit', 'pr_land')
        )
       where active_date is not null
       order by active_date
    `).map((row) => row.active_date);
    // Unfiltered, and inside the value that gets memoized: streaks are a
    // lifetime property, and a day added after the cache was written would be
    // dropped on the very next read.
    streakDates = [...streakDates, ...tombstoneActiveDays];
    streakCaches.set(db, { key: streakCacheKey, expiresAtMs: nowMs + STREAK_CACHE_TTL_MS, dates: streakDates });
  }

  const interactionRows = safeAll<{ action: string; count: number }>(db, `
    select action, count(*) count
      from usage_events
     where ${eventRange.sql}
     group by action
  `, eventRange.params);

  const operationRows = safeAll<{ kind: string; count: number }>(db, `
    select kind, count(*) count
      from operations
     where ${operationRange.sql}
       and status = 'succeeded'
       and kind in ('git_commit', 'git_push', 'pr_land', 'git_pull', 'git_sync_merge', 'git_sync_rebase', 'lane_delete')
     group by kind
  `, operationRange.params);
  const operationDailyRows = safeAll<{
    active_date: string | null;
    kind: string;
    operations: number;
  }>(db, `
    select date(started_at, 'localtime') active_date,
           kind,
           count(*) operations
      from (
        select started_at, kind
          from operations
         where ${operationRange.sql}
           and status = 'succeeded'
           and kind in ('git_commit', 'pr_land')
         order by started_at desc
         limit ?
      )
     group by active_date, kind
  `, [...operationRange.params, DAILY_BUCKET_SCAN_MAX_ROWS]);
  const operationCounts = new Map(operationRows.map((row) => [row.kind, int(row.count)]));
  const activityCounts = new Map(interactionRows.map((row) => [row.action, int(row.count)]));
  const operationActivityNames: Record<string, string> = {
    git_commit: "git.commit",
    git_push: "git.push",
    pr_land: "prs.land",
    git_pull: "git.pull",
    git_sync_merge: "git.sync",
    git_sync_rebase: "git.sync",
    // Queried alongside the others above but absent here, so it fell through to
    // its raw `lane_delete` kind and never met the `lanes.delete` interaction
    // rows in the reconciliation below — the one operation kind that skipped it.
    lane_delete: "lanes.delete",
  };
  // Sum the operation kinds that share an activity name BEFORE reconciling with
  // the interaction counts. `git_sync_merge` and `git_sync_rebase` both land on
  // "git.sync"; taking Math.max per row would report only the larger of the two
  // and silently drop the other kind's operations.
  const operationActivityTotals = new Map<string, number>();
  for (const row of operationRows) {
    const kind = operationActivityNames[row.kind] ?? row.kind;
    operationActivityTotals.set(kind, (operationActivityTotals.get(kind) ?? 0) + int(row.count));
  }
  // Folded in before the reconcile below, for the same reason the summary
  // counts them: the `operations` rows behind these went with the lane, so the
  // tombstone is the only surviving record and summing cannot double-count.
  for (const [kind, count] of [
    ["git.commit", tombstoneSum((tombstone) => tombstone.commits_created)],
    ["git.push", tombstoneSum((tombstone) => tombstone.push_operations)],
    ["prs.land", tombstoneSum((tombstone) => tombstone.pr_landings)],
  ] as const) {
    if (count > 0) operationActivityTotals.set(kind, (operationActivityTotals.get(kind) ?? 0) + count);
  }
  // `lanes.delete` is the exception: its `operations` row is written with a
  // null `lane_id` (laneService `lane_delete`), so the lane cleanup's
  // `delete from operations where lane_id = ?` leaves it behind alongside the
  // tombstone for the very same delete. Reconciled rather than summed — the
  // same rule the summary applies — or a fresh delete reads as two.
  if (tombstonesDeletedInRange.length > 0) {
    operationActivityTotals.set(
      "lanes.delete",
      Math.max(operationActivityTotals.get("lanes.delete") ?? 0, tombstonesDeletedInRange.length),
    );
  }
  for (const [kind, count] of operationActivityTotals) {
    activityCounts.set(kind, Math.max(activityCounts.get(kind) ?? 0, count));
  }

  const activeLaneRow = safeGet<{ count: number }>(db, "select count(*) count from lanes where archived_at is null");
  const laneCreatedRow = safeGet<{ count: number }>(db, `select count(*) count from lanes where ${rangeClause("created_at", range).sql}`, rangeClause("created_at", range).params);
  const laneArchivedRow = safeGet<{ count: number }>(db, `select count(*) count from lanes where archived_at is not null and ${rangeClause("archived_at", range).sql}`, rangeClause("archived_at", range).params);
  const artifactRow = safeGet<{ count: number }>(db, `select count(*) count from computer_use_artifacts where ${artifactRange.sql}`, artifactRange.params);
  const automationRow = safeGet<{ count: number }>(db, `select count(*) count from automation_runs where ${rangeClause("started_at", range).sql}`, rangeClause("started_at", range).params);
  const workerRow = safeGet<{ count: number }>(db, `select count(*) count from worker_agent_runs where ${rangeClause("created_at", range).sql}`, rangeClause("created_at", range).params);

  const providersByName = new Map<string, AdeUsageProviderSummary>();
  const modelsByKey = new Map<string, AdeUsageModelSummary>();
  const featureRows = new Map<string, AdeUsageFeatureSummary>();
  const featureSuccesses = new Map<string, number>();
  for (const row of aiRows) {
    const provider = row.provider?.trim() || "unknown";
    const inputTokens = int(row.input_tokens);
    const outputTokens = int(row.output_tokens);
    const totalTokens = inputTokens + outputTokens;
    const providerRow = providersByName.get(provider) ?? {
      provider,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      rangeCostUsd: 0,
      todayCostUsd: 0,
      last30dCostUsd: 0,
    };
    providerRow.inputTokens += inputTokens;
    providerRow.outputTokens += outputTokens;
    providerRow.totalTokens += totalTokens;
    providersByName.set(provider, providerRow);

    const model = row.model?.trim() || "unknown";
    const modelKey = `${provider}\u0000${model}`;
    const modelRow = modelsByKey.get(modelKey) ?? {
      provider,
      model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    modelRow.calls += int(row.calls);
    modelRow.inputTokens += inputTokens;
    modelRow.outputTokens += outputTokens;
    modelRow.totalTokens += totalTokens;
    modelsByKey.set(modelKey, modelRow);

    const featureKey = `${row.feature}\u0000${provider}`;
    const feature = featureRows.get(featureKey) ?? {
      feature: row.feature,
      provider,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      successRate: 0,
    };
    feature.calls += int(row.calls);
    feature.inputTokens += inputTokens;
    feature.outputTokens += outputTokens;
    feature.totalTokens += totalTokens;
    const successes = (featureSuccesses.get(featureKey) ?? 0) + int(row.successes);
    featureSuccesses.set(featureKey, successes);
    feature.successRate = feature.calls > 0 ? Math.round((successes / feature.calls) * 100) : 0;
    featureRows.set(featureKey, feature);
  }

  const sessionProviderMap = new Map<string, { sessions: number; models: Set<string>; latestAt: string | null }>();
  const sessionModelMap = new Map<string, AdeUsageAgentModelSummary>();
  for (const row of sessionRows) {
    const { provider, model: modelName } = sessionRuntime(row);
    const current = sessionProviderMap.get(provider) ?? { sessions: 0, models: new Set<string>(), latestAt: null };
    current.sessions += 1;
    current.models.add(modelName);
    if (!current.latestAt || row.started_at > current.latestAt) current.latestAt = row.started_at;
    sessionProviderMap.set(provider, current);
    const modelKey = `${provider}\u0000${modelName}`;
    const model = sessionModelMap.get(modelKey) ?? { provider, model: modelName, sessions: 0, latestAt: null };
    model.sessions += 1;
    if (!model.latestAt || row.started_at > model.latestAt) model.latestAt = row.started_at;
    sessionModelMap.set(modelKey, model);
  }

  const laneMap = new Map<string, AdeUsageLaneSummary>();
  for (const session of sessionRows) {
    const lane = laneMap.get(session.lane_id) ?? {
      laneId: session.lane_id,
      laneName: session.lane_id,
      sessions: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    };
    lane.sessions += 1;
    laneMap.set(session.lane_id, lane);
  }
  for (const delta of deltaRows) {
    const lane = laneMap.get(delta.lane_id) ?? {
      laneId: delta.lane_id,
      laneName: delta.lane_name || delta.lane_id,
      sessions: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    };
    lane.laneName = delta.lane_name || lane.laneName;
    lane.filesChanged += int(delta.files_changed);
    lane.insertions += int(delta.insertions);
    lane.deletions += int(delta.deletions);
    laneMap.set(delta.lane_id, lane);
  }

  const daily = new Map<string, Partial<AdeUsageDailyPoint> & Pick<AdeUsageDailyPoint, "date">>();
  const ensureDay = (date: string) => {
    const existing = daily.get(date) ?? { date, clients: {} };
    daily.set(date, existing);
    return existing;
  };
  // Grouped by provider as well as day. The daily chart plots one series per
  // provider, and these rows are what fills a day the provider ledgers could
  // not see; without the provider column that fill would raise the day's total
  // while contributing to no series, so the bars would not add up to the line.
  const aiDailyRows = safeAll<{
    active_date: string | null;
    provider: string | null;
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
    calls: number;
  }>(db, `
    select date(timestamp, 'localtime') active_date,
           provider,
           sum(max(0, cast(coalesce(input_tokens, 0) as integer))) input_tokens,
           sum(max(0, cast(coalesce(output_tokens, 0) as integer))) output_tokens,
           sum(max(0, cast(coalesce(duration_ms, 0) as integer))) duration_ms,
           count(*) calls
      from (
        select timestamp, provider, input_tokens, output_tokens, duration_ms
          from ai_usage_log
         where ${aiRange.sql}
         order by timestamp desc
         limit ?
      )
     group by active_date, provider
  `, [...aiRange.params, DAILY_BUCKET_SCAN_MAX_ROWS]);
  const clientDailyScanCount = clientDailyRows.reduce(
    (sum, row) => sum + int(row.interactions),
    0,
  );
  const operationDailyScanCount = operationDailyRows.reduce(
    (sum, row) => sum + int(row.operations),
    0,
  );
  const aiDailyScanCount = aiDailyRows.reduce(
    (sum, row) => sum + int(row.calls),
    0,
  );
  const cappedDailySources = [
    clientDailyScanCount === DAILY_BUCKET_SCAN_MAX_ROWS ? "usage_events" : null,
    operationDailyScanCount === DAILY_BUCKET_SCAN_MAX_ROWS ? "operations" : null,
    aiDailyScanCount === DAILY_BUCKET_SCAN_MAX_ROWS ? "ai_usage_log" : null,
  ].filter((source): source is string => source !== null);
  if (cappedDailySources.length > 0) {
    logger?.debug("usage.daily_bucket_scan_capped", {
      maxRows: DAILY_BUCKET_SCAN_MAX_ROWS,
      sources: cappedDailySources,
    });
  }
  for (const row of aiDailyRows) {
    const date = isoDate(row.active_date);
    if (!date) continue;
    const day = ensureDay(date);
    const inputTokens = int(row.input_tokens);
    const outputTokens = int(row.output_tokens);
    day.inputTokens = int(day.inputTokens) + inputTokens;
    day.outputTokens = int(day.outputTokens) + outputTokens;
    day.totalTokens = int(day.totalTokens) + inputTokens + outputTokens;
    day.durationMs = int(day.durationMs) + int(row.duration_ms);
    if (inputTokens + outputTokens > 0) {
      const provider = row.provider?.trim() || "unknown";
      const byProvider = day.byProvider ?? (day.byProvider = {});
      const existing = byProvider[provider];
      if (existing) existing.totalTokens += inputTokens + outputTokens;
      // ADE's own log records tokens, never a price, so cost stays 0 here and
      // the provider ledgers remain the only source of a dollar figure.
      else byProvider[provider] = { totalTokens: inputTokens + outputTokens, costUsd: 0 };
    }
  }
  for (const row of sessionRows) {
    const date = isoDate(row.started_at);
    if (!date) continue;
    const day = ensureDay(date);
    day.sessions = int(day.sessions) + 1;
  }
  for (const row of deltaRows) {
    const date = isoDate(row.started_at);
    if (!date) continue;
    const day = ensureDay(date);
    day.filesChanged = int(day.filesChanged) + int(row.files_changed);
    day.insertions = int(day.insertions) + int(row.insertions);
    day.deletions = int(day.deletions) + int(row.deletions);
  }
  for (const row of clientDailyRows) {
    const date = isoDate(row.active_date);
    if (!date) continue;
    const interactions = int(row.interactions);
    const day = ensureDay(date);
    day.interactions = int(day.interactions) + interactions;
    day.clients = {
      ...(day.clients ?? {}),
      [row.client_surface]: int(day.clients?.[row.client_surface]) + interactions,
    };
  }
  for (const row of operationDailyRows) {
    const date = isoDate(row.active_date);
    if (!date) continue;
    const day = ensureDay(date);
    if (row.kind === "git_commit") day.commits = int(day.commits) + int(row.operations);
    if (row.kind === "pr_land") day.prs = int(day.prs) + int(row.operations);
  }

  // `activeDays` counts days inside the selected range; `current`/`longest`
  // come from the unfiltered, memoized set built above.
  const { activeDays } = calculateStreaks(
    [
      ...activeDateRows.map((row) => row.active_date),
      // A deleted lane's days count too — filtered to the window here, because
      // unlike the tombstone's totals a single day belongs to exactly one.
      ...tombstoneActiveDays.filter((day) => day <= untilDay && (!sinceDay || day >= sinceDay)),
    ],
    range.until,
  );
  const { current, longest } = calculateStreaks(streakDates, range.until);
  const streaks = { activeDays, current, longest };
  // Only sessions that actually ended. Substituting the range end for a
  // missing `ended_at` measured "how long ago this session was opened", which
  // for the 18-of-19 rows here that never recorded an end turned a 1-second
  // session into a 15-day one — and made the number grow purely because the
  // selected range was wider.
  const longestSessionMs = Math.max(
    sessionRows.reduce((max, row) => {
      if (!row.ended_at) return max;
      const start = Date.parse(row.started_at);
      const end = Date.parse(row.ended_at);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return max;
      return Math.max(max, Math.max(0, end - start));
    }, 0),
    // A record set in a lane that has since been deleted is still a record.
    ...spannedTombstones.map((tombstone) => int(tombstone.longest_session_ms)),
  );

  const trackedInput = aiRows.reduce((sum, row) => sum + int(row.input_tokens), 0);
  const trackedOutput = aiRows.reduce((sum, row) => sum + int(row.output_tokens), 0);
  const trackedCalls = aiRows.reduce((sum, row) => sum + int(row.calls), 0);
  const trackedDuration = aiRows.reduce((sum, row) => sum + int(row.duration_ms), 0);
  // Code movement that happened in a lane someone has since deleted still
  // happened. `session_deltas` went with the lane; the tombstone did not.
  const filesChanged = deltaRows.reduce((sum, row) => sum + int(row.files_changed), 0)
    + tombstoneSum((tombstone) => tombstone.files_changed);
  const insertions = deltaRows.reduce((sum, row) => sum + int(row.insertions), 0)
    + tombstoneSum((tombstone) => tombstone.insertions);
  const deletions = deltaRows.reduce((sum, row) => sum + int(row.deletions), 0)
    + tombstoneSum((tombstone) => tombstone.deletions);
  const clients: AdeUsageClientSummary[] = clientRows
    .map((row) => ({
      client: row.client_surface,
      interactions: int(row.interactions),
      activeDays: int(row.active_days),
      sessions: int(row.sessions),
      lastActiveAt: row.last_active_at,
    }))
    .sort((a, b) => b.interactions - a.interactions);

  return {
    summary: {
      trackedAdeTokens: trackedInput + trackedOutput,
      trackedAdeInputTokens: trackedInput,
      trackedAdeOutputTokens: trackedOutput,
      trackedAdeCalls: trackedCalls,
      trackedAdeDurationMs: trackedDuration,
      chatSessions: sessionRows.filter(isChatSession).length
        + tombstoneSum((tombstone) => tombstone.chat_sessions),
      terminalSessions: sessionRows.filter((row) => !isChatSession(row)).length
        + tombstoneSum((tombstone) => tombstone.terminal_sessions),
      activeLanes: int(activeLaneRow?.count),
      // Counted on the lane's *creation* day, matching the `lanes.created_at`
      // predicate above rather than the whole-life span rule — a lane created
      // in this window was created in this window whenever it later died.
      lanesCreated: int(laneCreatedRow?.count)
        + tombstonesCreatedInRange.reduce((sum, tombstone) => sum + int(tombstone.lanes_created), 0),
      lanesArchived: int(laneArchivedRow?.count),
      // The `operations` row that recorded a delete is pruned after 60 days;
      // the tombstone is exact and permanent. Reconciled rather than summed,
      // because for a recent delete both sources describe the same event.
      lanesDeleted: Math.max(operationCounts.get("lane_delete") ?? 0, tombstonesDeletedInRange.length),
      commitsCreated: (operationCounts.get("git_commit") ?? 0)
        + tombstoneSum((tombstone) => tombstone.commits_created),
      pushOperations: (operationCounts.get("git_push") ?? 0)
        + tombstoneSum((tombstone) => tombstone.push_operations),
      prLandings: (operationCounts.get("pr_land") ?? 0)
        + tombstoneSum((tombstone) => tombstone.pr_landings),
      filesChanged,
      insertions,
      deletions,
      artifactsCaptured: int(artifactRow?.count)
        + tombstoneSum((tombstone) => tombstone.artifacts_captured),
      automationRuns: int(automationRow?.count),
      workerRuns: int(workerRow?.count),
      totalInteractions: clients.reduce((sum, row) => sum + row.interactions, 0),
      activeDays: streaks.activeDays,
      currentStreakDays: streaks.current,
      longestStreakDays: streaks.longest,
      longestSessionMs,
    },
    providers: [...providersByName.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    models: [...modelsByKey.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    agentProviders: [...sessionProviderMap.entries()].map(([provider, value]) => ({
      provider,
      sessions: value.sessions,
      models: value.models.size,
      latestAt: value.latestAt,
    })).sort((a, b) => b.sessions - a.sessions),
    agentModels: [...sessionModelMap.values()].sort((a, b) => b.sessions - a.sessions),
    features: [...featureRows.values()].sort((a, b) => b.calls - a.calls),
    lanes: [...laneMap.values()].sort((a, b) => b.sessions - a.sessions || (b.insertions + b.deletions) - (a.insertions + a.deletions)),
    activities: [...activityCounts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    clients,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
