import type { AdeDb, SqlValue } from "../state/kvDb";
import { localDayKey, localDayOffset, localDayOrdinal } from "../usage/localDay";

/**
 * Lane deletion used to destroy the only record that a lane ever existed or did
 * anything: `lanes`, `terminal_sessions`, `claude_sessions`, `session_deltas`
 * and the lane's `operations` rows all go in one cascade. ADE's "lifetime"
 * stats were therefore survivor stats — 14 lanes created all-time against 436
 * real ones, 19 sessions against 105.
 *
 * A tombstone fixes that without retaining anything: one row per deleted lane
 * holding integer counters, two calendar-day keys and a day bitmap. No
 * transcript text, no paths, no branch or lane names, no per-day counts —
 * nothing that could reconstruct what the lane was working on.
 *
 * AI token totals were never affected: those come from provider transcript
 * files ADE does not own or delete.
 */

/** Cap on the day-bitmap span. 4096 days is ~11 years; a real lane spans days. */
const MAX_ACTIVE_DAY_SPAN = 4096;

export type LaneUsageTombstoneRow = {
  project_id: string;
  lane_id: string;
  created_day: string | null;
  deleted_day: string;
  lanes_created: number;
  chat_sessions: number;
  terminal_sessions: number;
  files_changed: number;
  insertions: number;
  deletions: number;
  commits_created: number;
  push_operations: number;
  pr_landings: number;
  artifacts_captured: number;
  longest_session_ms: number;
  first_active_day: string | null;
  last_active_day: string | null;
  active_day_bits: string | null;
};

/**
 * How a removal should be counted.
 *
 * - `deleted`: a real lane going away (user delete, or the reap of a lane whose
 *   worktree vanished). Counts toward `lanesCreated`.
 * - `absorbed`: a duplicate lane row folded into a keeper. Its sessions were
 *   already re-pointed at the keeper, so counting the lane again would inflate
 *   `lanesCreated`; only residual code movement is preserved.
 * - `none`: a lane that failed to finish being created. Nothing happened in it,
 *   and it never counted as created, so no tombstone is written.
 */
export type LaneUsageTombstoneMode = "deleted" | "absorbed" | "none";

function int(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function safeAll<T extends Record<string, unknown>>(db: AdeDb, sql: string, params: SqlValue[]): T[] {
  try {
    return db.all<T>(sql, params);
  } catch {
    // Older runtimes may not have every table yet. Counting nothing is always
    // better than failing the delete the caller actually asked for.
    return [];
  }
}

/**
 * Pack a set of local calendar days into `{ firstDay, bits }`, where `bits` is
 * a lowercase hex string whose bit `i` (byte `i >> 3`, bit `i & 7`) marks
 * `firstDay + i` as active. A lane active for a fortnight encodes to 4 hex
 * characters, which is what keeps `activeDays` and streaks reconstructible
 * without storing a per-day breakdown.
 */
export function encodeActiveDayBits(dayKeys: Iterable<string>): { firstDay: string | null; lastDay: string | null; bits: string | null } {
  const byOrdinal = new Map<number, string>();
  for (const key of dayKeys) {
    const normalized = localDayKey(key);
    const ordinal = normalized ? localDayOrdinal(normalized) : null;
    if (ordinal != null) byOrdinal.set(ordinal, normalized);
  }
  if (byOrdinal.size === 0) return { firstDay: null, lastDay: null, bits: null };
  const ordinals = [...byOrdinal.keys()].sort((a, b) => a - b);
  const last = ordinals[ordinals.length - 1]!;
  // Clamp pathological spans from the bottom: the recent days are the only ones
  // a streak can still reach.
  const firstIndex = ordinals.findIndex((ordinal) => ordinal > last - MAX_ACTIVE_DAY_SPAN);
  const first = ordinals[firstIndex]!;
  const bytes = new Uint8Array(Math.ceil((last - first + 1) / 8));
  for (const ordinal of ordinals.slice(firstIndex)) {
    const index = ordinal - first;
    bytes[index >> 3]! |= 1 << (index & 7);
  }
  return {
    firstDay: byOrdinal.get(first)!,
    lastDay: byOrdinal.get(last)!,
    bits: [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

/** Inverse of {@link encodeActiveDayBits}. Returns the local day keys, ascending. */
export function decodeActiveDayKeys(firstDay: string | null | undefined, bits: string | null | undefined): string[] {
  if (!firstDay || !bits) return [];
  if (localDayOrdinal(firstDay) == null) return [];
  const days: string[] = [];
  // The bitmap arrives over CRR from a peer, so the encoder's clamp is not a
  // guarantee here: an oversized or corrupt value would otherwise expand to
  // two day strings per byte on every read, and those synthetic days feed the
  // streak. Bound the decode by the same span the encoder writes.
  const maxBytes = MAX_ACTIVE_DAY_SPAN / 8;
  for (let byteIndex = 0; byteIndex < maxBytes && byteIndex * 2 + 2 <= bits.length; byteIndex += 1) {
    const byte = Number.parseInt(bits.slice(byteIndex * 2, byteIndex * 2 + 2), 16);
    if (!Number.isFinite(byte) || byte === 0) continue;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((byte & (1 << bit)) === 0) continue;
      const day = localDayOffset(firstDay, byteIndex * 8 + bit);
      if (day) days.push(localDayKey(day));
    }
  }
  return days;
}

function collectLaneActiveDays(db: AdeDb, args: { projectId: string; laneId: string }): string[] {
  const days = new Set<string>();
  const push = (rows: Array<{ day: string | null }>) => {
    for (const row of rows) {
      const day = typeof row.day === "string" ? row.day.trim() : "";
      if (day) days.add(day);
    }
  };
  push(safeAll<{ day: string | null }>(
    db,
    "select distinct date(started_at, 'localtime') day from terminal_sessions where lane_id = ?",
    [args.laneId],
  ));
  push(safeAll<{ day: string | null }>(
    db,
    `select distinct date(started_at, 'localtime') day
       from session_deltas
      where lane_id = ? and project_id = ?
        and (coalesce(insertions, 0) > 0 or coalesce(deletions, 0) > 0 or coalesce(files_changed, 0) > 0)`,
    [args.laneId, args.projectId],
  ));
  push(safeAll<{ day: string | null }>(
    db,
    `select distinct date(started_at, 'localtime') day
       from operations
      where lane_id = ? and project_id = ?
        and status = 'succeeded'
        and kind in ('git_commit', 'pr_land')`,
    [args.laneId, args.projectId],
  ));
  return [...days];
}

/**
 * Read the lane's countable activity. MUST run before the rows are deleted.
 * Every query is keyed on `lane_id` and returns at most a handful of rows, so
 * this costs a few indexed lookups on a path the user is already waiting on.
 */
export function computeLaneUsageTombstone(
  db: AdeDb,
  args: {
    projectId: string;
    laneId: string;
    mode: Exclude<LaneUsageTombstoneMode, "none">;
    /**
     * Artifacts this delete will actually remove. The caller knows which
     * captures are shared with a surviving lane and therefore stay.
     */
    artifactsCaptured?: number;
    now?: Date;
  },
): LaneUsageTombstoneRow {
  const { projectId, laneId } = args;

  const sessionRows = safeAll<{
    tool_type: string | null;
    chat_session_id: string | null;
    started_at: string | null;
    ended_at: string | null;
  }>(
    db,
    "select tool_type, chat_session_id, started_at, ended_at from terminal_sessions where lane_id = ?",
    [laneId],
  );
  let chatSessions = 0;
  let terminalSessions = 0;
  let longestSessionMs = 0;
  for (const row of sessionRows) {
    // Same predicate as the stats layer's `isChatSession`.
    const isChat = Boolean(row.chat_session_id) || (row.tool_type?.toLowerCase() ?? "").endsWith("-chat");
    if (isChat) chatSessions += 1;
    else terminalSessions += 1;
    if (!row.ended_at || !row.started_at) continue;
    const start = Date.parse(row.started_at);
    const end = Date.parse(row.ended_at);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    longestSessionMs = Math.max(longestSessionMs, Math.max(0, end - start));
  }

  const deltaTotals = safeAll<{ files_changed: number; insertions: number; deletions: number }>(
    db,
    `select coalesce(sum(files_changed), 0) files_changed,
            coalesce(sum(insertions), 0) insertions,
            coalesce(sum(deletions), 0) deletions
       from session_deltas
      where lane_id = ? and project_id = ?`,
    [laneId, projectId],
  )[0];

  const operationRows = safeAll<{ kind: string; count: number }>(
    db,
    `select kind, count(*) count
       from operations
      where lane_id = ? and project_id = ?
        and status = 'succeeded'
        and kind in ('git_commit', 'git_push', 'pr_land')
      group by kind`,
    [laneId, projectId],
  );
  const operationCounts = new Map(operationRows.map((row) => [row.kind, int(row.count)]));

  const laneRow = safeAll<{ created_at: string | null }>(
    db,
    "select created_at from lanes where id = ? and project_id = ? limit 1",
    [laneId, projectId],
  )[0];

  const activeDays = encodeActiveDayBits(collectLaneActiveDays(db, { projectId, laneId }));

  return {
    project_id: projectId,
    lane_id: laneId,
    created_day: laneRow?.created_at ? localDayKey(laneRow.created_at) || null : null,
    deleted_day: localDayKey(args.now ?? new Date()),
    lanes_created: args.mode === "deleted" ? 1 : 0,
    chat_sessions: chatSessions,
    terminal_sessions: terminalSessions,
    files_changed: int(deltaTotals?.files_changed),
    insertions: int(deltaTotals?.insertions),
    deletions: int(deltaTotals?.deletions),
    commits_created: operationCounts.get("git_commit") ?? 0,
    push_operations: operationCounts.get("git_push") ?? 0,
    pr_landings: operationCounts.get("pr_land") ?? 0,
    artifacts_captured: int(args.artifactsCaptured),
    longest_session_ms: longestSessionMs,
    first_active_day: activeDays.firstDay,
    last_active_day: activeDays.lastDay,
    active_day_bits: activeDays.bits,
  };
}

/**
 * Merge `next` onto any tombstone already recorded for the same lane.
 *
 * Deleting the same lane twice, or retrying a delete whose first attempt rolled
 * back and left rows behind, must not double the counters. Counters therefore
 * take the maximum rather than a sum, and the active-day sets union — both
 * idempotent under repetition.
 */
export function mergeLaneUsageTombstones(
  existing: LaneUsageTombstoneRow | null,
  next: LaneUsageTombstoneRow,
): LaneUsageTombstoneRow {
  if (!existing) return next;
  const mergedDays = encodeActiveDayBits([
    ...decodeActiveDayKeys(existing.first_active_day, existing.active_day_bits),
    ...decodeActiveDayKeys(next.first_active_day, next.active_day_bits),
  ]);
  return {
    project_id: next.project_id,
    lane_id: next.lane_id,
    created_day: existing.created_day ?? next.created_day,
    deleted_day: existing.deleted_day < next.deleted_day ? existing.deleted_day : next.deleted_day,
    lanes_created: Math.max(int(existing.lanes_created), next.lanes_created),
    chat_sessions: Math.max(int(existing.chat_sessions), next.chat_sessions),
    terminal_sessions: Math.max(int(existing.terminal_sessions), next.terminal_sessions),
    files_changed: Math.max(int(existing.files_changed), next.files_changed),
    insertions: Math.max(int(existing.insertions), next.insertions),
    deletions: Math.max(int(existing.deletions), next.deletions),
    commits_created: Math.max(int(existing.commits_created), next.commits_created),
    push_operations: Math.max(int(existing.push_operations), next.push_operations),
    pr_landings: Math.max(int(existing.pr_landings), next.pr_landings),
    artifacts_captured: Math.max(int(existing.artifacts_captured), next.artifacts_captured),
    longest_session_ms: Math.max(int(existing.longest_session_ms), next.longest_session_ms),
    first_active_day: mergedDays.firstDay,
    last_active_day: mergedDays.lastDay,
    active_day_bits: mergedDays.bits,
  };
}

/**
 * Record the tombstone for a lane about to be deleted.
 *
 * MUST be called before the lane's rows are removed, and from inside the
 * caller's transaction: `AdeDb` exposes no transaction helper, so the three
 * call sites that delete a lane each hold their own `begin immediate` and this
 * write joins it. That is what makes counted-twice / counted-never impossible —
 * a cleanup that throws rolls the tombstone back with the deletes.
 *
 * Never throws: a stats tombstone must not be able to fail a lane delete.
 */
export function writeLaneUsageTombstone(
  db: AdeDb,
  args: {
    projectId: string;
    laneId: string;
    mode: LaneUsageTombstoneMode;
    artifactsCaptured?: number;
    now?: Date;
  },
): LaneUsageTombstoneRow | null {
  if (args.mode === "none") return null;
  try {
    const computed = computeLaneUsageTombstone(db, { ...args, mode: args.mode });
    const existing = db.get<LaneUsageTombstoneRow>(
      "select * from lane_usage_tombstones where project_id = ? and lane_id = ?",
      [args.projectId, args.laneId],
    );
    const row = mergeLaneUsageTombstones(existing ?? null, computed);
    db.run(
      `insert into lane_usage_tombstones(
         project_id, lane_id, created_day, deleted_day, lanes_created, chat_sessions,
         terminal_sessions, files_changed, insertions, deletions, commits_created,
         push_operations, pr_landings, artifacts_captured, longest_session_ms,
         first_active_day, last_active_day, active_day_bits
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(project_id, lane_id) do update set
         created_day = excluded.created_day,
         deleted_day = excluded.deleted_day,
         lanes_created = excluded.lanes_created,
         chat_sessions = excluded.chat_sessions,
         terminal_sessions = excluded.terminal_sessions,
         files_changed = excluded.files_changed,
         insertions = excluded.insertions,
         deletions = excluded.deletions,
         commits_created = excluded.commits_created,
         push_operations = excluded.push_operations,
         pr_landings = excluded.pr_landings,
         artifacts_captured = excluded.artifacts_captured,
         longest_session_ms = excluded.longest_session_ms,
         first_active_day = excluded.first_active_day,
         last_active_day = excluded.last_active_day,
         active_day_bits = excluded.active_day_bits`,
      [
        row.project_id,
        row.lane_id,
        row.created_day,
        row.deleted_day,
        row.lanes_created,
        row.chat_sessions,
        row.terminal_sessions,
        row.files_changed,
        row.insertions,
        row.deletions,
        row.commits_created,
        row.push_operations,
        row.pr_landings,
        row.artifacts_captured,
        row.longest_session_ms,
        row.first_active_day,
        row.last_active_day,
        row.active_day_bits,
      ],
    );
    return row;
  } catch {
    // Stats accounting must never break the delete it observes.
    return null;
  }
}
