import { randomUUID } from "node:crypto";
import {
  laneShareLocalDayKey,
  laneShareNextDayStart,
  parseLaneShareRights,
  type LaneShareCreatedBy,
  type LaneShareRights,
} from "../../../shared/laneShareRights";
import type { AdeDb } from "../state/kvDb";

/**
 * The host's own record of each lane share it serves (lane sharing): the
 * rights the owner chose and the guest's message counters, keyed by grant id.
 *
 * Local to this machine and never synced (`LOCAL_ONLY_CRR_EXCLUDED_TABLES` in
 * kvDb.ts): the host is the only authority over what a guest may do, and a
 * synced row would let another replica change it. It survives a restart. The
 * account directory keeps only the index of grants and their revocation.
 *
 * Every call is synchronous and the brain's JavaScript runs one call at a
 * time, so a read, a check and a write in one call cannot interleave with
 * another guest's: that is what makes `claimMessage` an atomic increment.
 */

export const LANE_SHARE_RIGHTS_TABLE = "lane_share_rights";
/**
 * What a guest wrote or queued on this host, by grant: its drafts and thread
 * comments (the only ones it may edit or remove), its queued messages (removed
 * on revoke) and the chats it sent turns into (checked on revoke for a turn
 * still running). The host records each one itself; a draft's or comment's
 * stored author is a synced column and never proof of who wrote it.
 */
export const LANE_SHARE_GUEST_ITEMS_TABLE = "lane_share_guest_items";

/** `chat`: a chat the guest created, whose settings it may change. */
export type LaneShareGuestItemKind = "draft" | "comment" | "steer" | "turn" | "chat";

/** Per grant and kind, the oldest records past this many are dropped. */
const MAX_ITEMS_PER_KIND = 200;

/**
 * A row whose grant is in neither of the directory's lists (live and recently
 * closed) for this long is deleted with its items. Longer than the closed
 * window's tail and a long directory outage: only good reads count, and a
 * grant seen again starts the wait over.
 */
export const LANE_SHARE_ORPHAN_ROW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The table, made by kvDb's migration and by tests with a bare SQLite. */
export function ensureLaneShareRightsSchema(db: Pick<AdeDb, "run" | "all">): void {
  db.run(`
    create table if not exists ${LANE_SHARE_RIGHTS_TABLE} (
      grant_id text primary key,
      lane_id text not null,
      receiver_email text,
      rights_json text not null,
      total_count integer not null default 0,
      day_key text,
      day_count integer not null default 0,
      created_at integer not null,
      updated_at integer not null,
      missing_since integer,
      created_by text
    )
  `);
  // Tables made before `missing_since` or `created_by` existed (dev builds of this branch).
  const columns = db.all<{ name: string }>(`pragma table_info(${LANE_SHARE_RIGHTS_TABLE})`);
  if (!columns.some((column) => column.name === "missing_since")) {
    db.run(`alter table ${LANE_SHARE_RIGHTS_TABLE} add column missing_since integer`);
  }
  if (!columns.some((column) => column.name === "created_by")) {
    db.run(`alter table ${LANE_SHARE_RIGHTS_TABLE} add column created_by text`);
  }
  db.run(`create index if not exists idx_${LANE_SHARE_RIGHTS_TABLE}_lane on ${LANE_SHARE_RIGHTS_TABLE}(lane_id)`);
  db.run(`
    create table if not exists ${LANE_SHARE_GUEST_ITEMS_TABLE} (
      grant_id text not null,
      kind text not null,
      item_id text not null,
      session_id text,
      created_at integer not null,
      primary key (grant_id, kind, item_id)
    )
  `);
}

type RightsRow = {
  grant_id: string;
  lane_id: string;
  receiver_email: string | null;
  rights_json: string;
  total_count: number;
  day_key: string | null;
  day_count: number;
  created_at: number;
  updated_at: number;
  missing_since: number | null;
  created_by: string | null;
};

export type LaneShareRightsRecord = {
  grantId: string;
  laneId: string;
  receiverEmail: string | null;
  rights: LaneShareRights;
  /** Who made the share on this host. A row from before this column reads as `person`. */
  createdBy: LaneShareCreatedBy;
  /** Guest messages counted: over the share's life, and on `dayKey` (host local date). */
  usage: { total: number; dayKey: string | null; dayCount: number };
  createdAt: number;
  updatedAt: number;
};

export type LaneShareMessageClaim = { grantId: string; dayKey: string };

export type LaneShareMessageRefusal = {
  code: "lane_share_daily_limit" | "lane_share_total_limit";
  message: string;
  /** When a daily limit allows the next message (host clock). Null for the total limit. */
  resetAt: number | null;
};

export type LaneShareUsage = {
  /** Messages counted over the share's life, and on the host's current local day. */
  total: number;
  today: number;
  messagesLeftToday: number | null;
  messagesLeftTotal: number | null;
  dailyResetAt: number | null;
};

/** `missing`: no such lane row (deleted). `archived`: the share is paused. */
export type LaneShareLaneState = "active" | "archived" | "missing";

export type LaneShareRightsStore = ReturnType<typeof createLaneShareRightsStore>;

function readRights(json: string): LaneShareRights {
  try {
    return parseLaneShareRights(JSON.parse(json));
  } catch {
    // Unreadable: every right off, never a guess.
    return parseLaneShareRights(null);
  }
}

function toRecord(row: RightsRow): LaneShareRightsRecord {
  return {
    grantId: row.grant_id,
    laneId: row.lane_id,
    receiverEmail: row.receiver_email,
    rights: readRights(row.rights_json),
    createdBy: row.created_by === "agent" ? "agent" : "person",
    usage: { total: Number(row.total_count) || 0, dayKey: row.day_key, dayCount: Number(row.day_count) || 0 },
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export function createLaneShareRightsStore(options: {
  db: Pick<AdeDb, "get" | "all" | "run">;
  now?: () => number;
  /** Tests only. The host counts days in its own time zone. */
  timeZone?: string;
}) {
  const { db } = options;
  const now = options.now ?? Date.now;
  const timeZone = options.timeZone;

  const row = (grantId: string): RightsRow | null =>
    db.get<RightsRow>(`select * from ${LANE_SHARE_RIGHTS_TABLE} where grant_id = ?`, [grantId]);

  /** The day the stored count belongs to at `atMs`: today, unless the clock went back past it. */
  const effectiveDay = (stored: RightsRow, atMs: number): { dayKey: string; dayCount: number } => {
    const today = laneShareLocalDayKey(atMs, timeZone);
    if (!stored.day_key || today > stored.day_key) return { dayKey: today, dayCount: 0 };
    return { dayKey: stored.day_key, dayCount: Number(stored.day_count) || 0 };
  };

  /** The first moment the local date is later than `dayKey`. */
  const dayAfter = (dayKey: string, atMs: number): number => {
    let at = laneShareNextDayStart(atMs, timeZone);
    // A clock moved back can sit several days before the stored day.
    for (let step = 0; step < 400 && laneShareLocalDayKey(at, timeZone) <= dayKey; step += 1) {
      at = laneShareNextDayStart(at, timeZone);
    }
    return at;
  };

  return {
    get(grantId: string): LaneShareRightsRecord | null {
      const found = row(grantId);
      return found ? toRecord(found) : null;
    },

    list(): LaneShareRightsRecord[] {
      return db.all<RightsRow>(`select * from ${LANE_SHARE_RIGHTS_TABLE} order by created_at desc`).map(toRecord);
    },

    /**
     * A new share's row, or the rights of an existing one (its counters
     * stay). `createdBy` counts only for a new row: an existing row keeps how
     * it was made, so a person who raises an agent's share keeps the label.
     */
    put(args: {
      grantId: string;
      laneId: string;
      receiverEmail?: string | null;
      rights: LaneShareRights;
      createdBy?: LaneShareCreatedBy;
    }): LaneShareRightsRecord {
      const at = now();
      const rightsJson = JSON.stringify(parseLaneShareRights(args.rights));
      db.run(
        `insert into ${LANE_SHARE_RIGHTS_TABLE} (grant_id, lane_id, receiver_email, rights_json, created_at, updated_at, created_by)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(grant_id) do update set
           lane_id = excluded.lane_id,
           receiver_email = coalesce(excluded.receiver_email, receiver_email),
           rights_json = excluded.rights_json,
           updated_at = excluded.updated_at`,
        [args.grantId, args.laneId, args.receiverEmail ?? null, rightsJson, at, at, args.createdBy === "agent" ? "agent" : "person"],
      );
      return toRecord(row(args.grantId)!);
    },

    /** New rights for a share this host holds. Null when it holds none. */
    updateRights(grantId: string, rights: LaneShareRights): LaneShareRightsRecord | null {
      if (!row(grantId)) return null;
      db.run(
        `update ${LANE_SHARE_RIGHTS_TABLE} set rights_json = ?, updated_at = ? where grant_id = ?`,
        [JSON.stringify(parseLaneShareRights(rights)), now(), grantId],
      );
      return toRecord(row(grantId)!);
    },

    /**
     * After a GOOD read of the directory's grant lists: forgets rows whose
     * grant has been in neither list for `LANE_SHARE_ORPHAN_ROW_MAX_AGE_MS`.
     * `listedIds` holds every grant id of both lists. A row starts its wait
     * the first time it is missing; a row seen again stops it. Returns the
     * grant ids it deleted. Never call it after a failed or partial read.
     */
    forgetUnlisted(listedIds: ReadonlySet<string>): string[] {
      const at = now();
      const removed: string[] = [];
      for (const stored of db.all<RightsRow>(`select * from ${LANE_SHARE_RIGHTS_TABLE}`)) {
        if (listedIds.has(stored.grant_id)) {
          if (stored.missing_since != null) {
            db.run(`update ${LANE_SHARE_RIGHTS_TABLE} set missing_since = null where grant_id = ?`, [stored.grant_id]);
          }
          continue;
        }
        if (stored.missing_since == null) {
          db.run(`update ${LANE_SHARE_RIGHTS_TABLE} set missing_since = ? where grant_id = ?`, [at, stored.grant_id]);
          continue;
        }
        if (at - Number(stored.missing_since) < LANE_SHARE_ORPHAN_ROW_MAX_AGE_MS) continue;
        db.run(`delete from ${LANE_SHARE_RIGHTS_TABLE} where grant_id = ?`, [stored.grant_id]);
        db.run(`delete from ${LANE_SHARE_GUEST_ITEMS_TABLE} where grant_id = ?`, [stored.grant_id]);
        removed.push(stored.grant_id);
      }
      return removed;
    },

    /**
     * Only the share's rights row: from here on the host refuses the guest's
     * hello and every action. Its items stay for the close that follows.
     */
    deleteRights(grantId: string): void {
      db.run(`delete from ${LANE_SHARE_RIGHTS_TABLE} where grant_id = ?`, [grantId]);
    },

    /** The share's row and everything recorded for it. */
    delete(grantId: string): void {
      db.run(`delete from ${LANE_SHARE_RIGHTS_TABLE} where grant_id = ?`, [grantId]);
      db.run(`delete from ${LANE_SHARE_GUEST_ITEMS_TABLE} where grant_id = ?`, [grantId]);
    },

    /** Records one item the guest of `grantId` wrote or queued. */
    addItem(grantId: string, kind: LaneShareGuestItemKind, itemId: string, sessionId: string | null): void {
      db.run(
        `insert into ${LANE_SHARE_GUEST_ITEMS_TABLE} (grant_id, kind, item_id, session_id, created_at)
         values (?, ?, ?, ?, ?)
         on conflict(grant_id, kind, item_id) do update set created_at = excluded.created_at`,
        [grantId, kind, itemId, sessionId, now()],
      );
      db.run(
        `delete from ${LANE_SHARE_GUEST_ITEMS_TABLE} where grant_id = ? and kind = ? and item_id in (
           select item_id from ${LANE_SHARE_GUEST_ITEMS_TABLE} where grant_id = ? and kind = ?
           order by created_at desc, item_id desc limit -1 offset ?
         )`,
        [grantId, kind, grantId, kind, MAX_ITEMS_PER_KIND],
      );
    },

    hasItem(grantId: string, kind: LaneShareGuestItemKind, itemId: string): boolean {
      return db.get(
        `select 1 as found from ${LANE_SHARE_GUEST_ITEMS_TABLE} where grant_id = ? and kind = ? and item_id = ?`,
        [grantId, kind, itemId],
      ) != null;
    },

    /** How many items of `kind` the guest holds, in one chat when `sessionId` is given. */
    countItems(grantId: string, kind: LaneShareGuestItemKind, sessionId?: string): number {
      const found = sessionId == null
        ? db.get<{ n: number }>(`select count(*) as n from ${LANE_SHARE_GUEST_ITEMS_TABLE} where grant_id = ? and kind = ?`, [grantId, kind])
        : db.get<{ n: number }>(
          `select count(*) as n from ${LANE_SHARE_GUEST_ITEMS_TABLE} where grant_id = ? and kind = ? and session_id = ?`,
          [grantId, kind, sessionId],
        );
      return Number(found?.n) || 0;
    },

    /** The grant whose guest recorded the item, or null (not a guest's item). */
    itemGrant(kind: LaneShareGuestItemKind, itemId: string): string | null {
      return db.get<{ grant_id: string }>(
        `select grant_id from ${LANE_SHARE_GUEST_ITEMS_TABLE} where kind = ? and item_id = ? limit 1`,
        [kind, itemId],
      )?.grant_id ?? null;
    },

    /** Every grant with at least one item of `kind`, rights row or not. */
    grantsWithItems(kind: LaneShareGuestItemKind): string[] {
      return db.all<{ grant_id: string }>(
        `select distinct grant_id from ${LANE_SHARE_GUEST_ITEMS_TABLE} where kind = ?`,
        [kind],
      ).map((item) => item.grant_id);
    },

    listItems(grantId: string, kind: LaneShareGuestItemKind): Array<{ itemId: string; sessionId: string | null }> {
      return db.all<{ item_id: string; session_id: string | null }>(
        `select item_id, session_id from ${LANE_SHARE_GUEST_ITEMS_TABLE} where grant_id = ? and kind = ? order by created_at desc`,
        [grantId, kind],
      ).map((item) => ({ itemId: item.item_id, sessionId: item.session_id }));
    },

    /**
     * Holds one slot of `kind` for the guest of `grantId` while the item is
     * made, or returns null when it already holds `max` (in the chat
     * `sessionId` when `perSession`). One SQL statement counts and inserts,
     * so two requests at once cannot both pass the cap. `settleItem` turns
     * the hold into the real item or drops it.
     */
    holdItem(grantId: string, kind: LaneShareGuestItemKind, sessionId: string | null, max: number, perSession = false): string | null {
      const holdId = `hold:${randomUUID()}`;
      db.run(
        `insert into ${LANE_SHARE_GUEST_ITEMS_TABLE} (grant_id, kind, item_id, session_id, created_at)
         select ?, ?, ?, ?, ?
         where (select count(*) from ${LANE_SHARE_GUEST_ITEMS_TABLE}
                where grant_id = ? and kind = ?${perSession ? " and session_id is ?" : ""}) < ?`,
        perSession
          ? [grantId, kind, holdId, sessionId, now(), grantId, kind, sessionId, max]
          : [grantId, kind, holdId, sessionId, now(), grantId, kind, max],
      );
      const held = db.get(
        `select 1 as found from ${LANE_SHARE_GUEST_ITEMS_TABLE} where grant_id = ? and kind = ? and item_id = ?`,
        [grantId, kind, holdId],
      );
      return held ? holdId : null;
    },

    /** The hold becomes the item `itemId`, or goes away when it is null (the item was not made). */
    settleItem(grantId: string, kind: LaneShareGuestItemKind, holdId: string, itemId: string | null): void {
      if (itemId) {
        db.run(
          `update ${LANE_SHARE_GUEST_ITEMS_TABLE} set item_id = ? where grant_id = ? and kind = ? and item_id = ?`,
          [itemId, grantId, kind, holdId],
        );
        return;
      }
      db.run(`delete from ${LANE_SHARE_GUEST_ITEMS_TABLE} where grant_id = ? and kind = ? and item_id = ?`, [grantId, kind, holdId]);
    },

    removeItem(grantId: string, kind: LaneShareGuestItemKind, itemId: string): void {
      db.run(`delete from ${LANE_SHARE_GUEST_ITEMS_TABLE} where grant_id = ? and kind = ? and item_id = ?`, [grantId, kind, itemId]);
    },

    /**
     * Counts one guest message BEFORE its turn starts, or refuses it when a
     * limit is reached. A message refused by the chat after this call is
     * given back with `refundMessage`.
     */
    claimMessage(grantId: string): { ok: true; claim: LaneShareMessageClaim } | { ok: false; refusal: LaneShareMessageRefusal } {
      const stored = row(grantId);
      if (!stored) {
        return { ok: false, refusal: { code: "lane_share_total_limit", message: "This share does not allow messages.", resetAt: null } };
      }
      const limits = readRights(stored.rights_json).limits;
      const at = now();
      const day = effectiveDay(stored, at);
      const total = Number(stored.total_count) || 0;
      if (limits.messagesTotal != null && total >= limits.messagesTotal) {
        return {
          ok: false,
          refusal: { code: "lane_share_total_limit", message: "You have used every message this share allows.", resetAt: null },
        };
      }
      if (limits.messagesPerDay != null && day.dayCount >= limits.messagesPerDay) {
        return {
          ok: false,
          refusal: {
            code: "lane_share_daily_limit",
            message: "You have used today's messages on this shared lane.",
            resetAt: dayAfter(day.dayKey, at),
          },
        };
      }
      db.run(
        `update ${LANE_SHARE_RIGHTS_TABLE} set total_count = ?, day_key = ?, day_count = ?, updated_at = ? where grant_id = ?`,
        [total + 1, day.dayKey, day.dayCount + 1, at, grantId],
      );
      return { ok: true, claim: { grantId, dayKey: day.dayKey } };
    },

    /** Gives back a claimed message the chat refused. */
    refundMessage(claim: LaneShareMessageClaim): void {
      const stored = row(claim.grantId);
      if (!stored) return;
      const total = Math.max(0, (Number(stored.total_count) || 0) - 1);
      const dayCount = stored.day_key === claim.dayKey
        ? Math.max(0, (Number(stored.day_count) || 0) - 1)
        : Number(stored.day_count) || 0;
      db.run(
        `update ${LANE_SHARE_RIGHTS_TABLE} set total_count = ?, day_count = ? where grant_id = ?`,
        [total, dayCount, claim.grantId],
      );
    },

    /** Messages left and the next daily reset, for the guest's composer and the owner's list. */
    usage(grantId: string): LaneShareUsage {
      const stored = row(grantId);
      if (!stored) return { total: 0, today: 0, messagesLeftToday: null, messagesLeftTotal: null, dailyResetAt: null };
      const limits = readRights(stored.rights_json).limits;
      const at = now();
      const day = effectiveDay(stored, at);
      const total = Number(stored.total_count) || 0;
      return {
        total,
        today: day.dayCount,
        messagesLeftToday: limits.messagesPerDay == null ? null : Math.max(0, limits.messagesPerDay - day.dayCount),
        messagesLeftTotal: limits.messagesTotal == null ? null : Math.max(0, limits.messagesTotal - total),
        dailyResetAt: limits.messagesPerDay == null ? null : dayAfter(day.dayKey, at),
      };
    },

    /** Whether the lane exists and is not archived, read from this host's own lanes table. */
    laneState(laneId: string): LaneShareLaneState {
      try {
        const lane = db.get<{ archived_at: string | null }>("select archived_at from lanes where id = ? limit 1", [laneId]);
        if (!lane) return "missing";
        return lane.archived_at ? "archived" : "active";
      } catch {
        return "missing";
      }
    },

    /** The lane's name and branch now, read from this host's own lanes table: a guest sees renames and branch changes. */
    laneInfo(laneId: string): { name: string; branch: string; type: string } | null {
      try {
        const lane = db.get<{ name: string | null; branch_ref: string | null; lane_type: string | null }>(
          "select name, branch_ref, lane_type from lanes where id = ? limit 1",
          [laneId],
        );
        if (!lane) return null;
        return {
          name: (lane.name ?? "").trim(),
          branch: (lane.branch_ref ?? "").trim().replace(/^refs\/heads\//, ""),
          type: lane.lane_type ?? "worktree",
        };
      } catch {
        return null;
      }
    },
  };
}
