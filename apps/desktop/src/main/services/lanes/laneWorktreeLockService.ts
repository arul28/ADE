import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type {
  LaneWorktreeLockBlocker,
  LaneWorktreeLockInfo,
  LaneWorktreeLockOwnerKind,
} from "../../../shared/types";

const DEFAULT_LEASE_MS = 45 * 60_000;

type LaneWorktreeLockRow = {
  worktree_key: string;
  worktree_path: string;
  lane_id: string;
  owner_kind: string;
  owner_pr_id: string | null;
  owner_session_id: string | null;
  owner_proposal_id: string | null;
  owner_label: string;
  token: string;
  created_at: string;
  heartbeat_at: string;
  expires_at: string;
};

type AcquireLaneWorktreeLockArgs = {
  laneId: string;
  worktreePath: string;
  ownerKind: LaneWorktreeLockOwnerKind;
  ownerLabel: string;
  ownerPrId?: string | null;
  ownerSessionId?: string | null;
  ownerProposalId?: string | null;
  token?: string | null;
  leaseMs?: number;
};

type ReleaseLaneWorktreeLockArgs = {
  token?: string | null;
  ownerKind?: LaneWorktreeLockOwnerKind;
  ownerPrId?: string | null;
  ownerSessionId?: string | null;
  ownerProposalId?: string | null;
};

export class LaneWorktreeLockedError extends Error {
  readonly code = "LANE_WORKTREE_LOCKED";
  readonly blocker: LaneWorktreeLockBlocker;

  constructor(blocker: LaneWorktreeLockBlocker) {
    super(blocker.message);
    this.name = "LaneWorktreeLockedError";
    this.blocker = blocker;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function canonicalWorktreePath(worktreePath: string): { key: string; displayPath: string } {
  const trimmed = worktreePath.trim();
  const absolute = path.resolve(trimmed);
  try {
    const real = fs.realpathSync.native(absolute);
    return { key: real, displayPath: real };
  } catch {
    return { key: absolute, displayPath: absolute };
  }
}

function rowToLock(row: LaneWorktreeLockRow): LaneWorktreeLockInfo {
  return {
    worktreeKey: row.worktree_key,
    worktreePath: row.worktree_path,
    laneId: row.lane_id,
    ownerKind: row.owner_kind as LaneWorktreeLockOwnerKind,
    ownerPrId: row.owner_pr_id,
    ownerSessionId: row.owner_session_id,
    ownerProposalId: row.owner_proposal_id,
    ownerLabel: row.owner_label,
    createdAt: row.created_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
}

function describeOwner(lock: LaneWorktreeLockInfo): string {
  const label = lock.ownerLabel.trim();
  if (label) return label;
  if (lock.ownerPrId) return `${lock.ownerKind} for PR ${lock.ownerPrId}`;
  if (lock.ownerProposalId) return `${lock.ownerKind} for proposal ${lock.ownerProposalId}`;
  return lock.ownerKind.replace(/_/g, " ");
}

export function formatLaneWorktreeLockBlocker(lock: LaneWorktreeLockInfo): LaneWorktreeLockBlocker {
  const owner = describeOwner(lock);
  return {
    lock,
    message: `Blocked by ${owner} on this lane. Wait for it to finish or stop it before starting another PR task.`,
  };
}

function isExpired(row: LaneWorktreeLockRow, atMs: number): boolean {
  const expiresAt = Date.parse(row.expires_at);
  return !Number.isFinite(expiresAt) || expiresAt <= atMs;
}

function ownerMatches(row: LaneWorktreeLockRow, args: AcquireLaneWorktreeLockArgs): boolean {
  const token = args.token?.trim();
  if (token && row.token === token) return true;
  if (row.owner_kind !== args.ownerKind) return false;
  if ((args.ownerPrId ?? null) !== row.owner_pr_id) return false;
  if ((args.ownerProposalId ?? null) !== row.owner_proposal_id) return false;
  const requestedSessionId = args.ownerSessionId ?? null;
  if (requestedSessionId && requestedSessionId !== row.owner_session_id) return false;
  return true;
}

export function createLaneWorktreeLockService({
  db,
  logger,
}: {
  db: AdeDb;
  logger?: Pick<Logger, "debug" | "warn"> | null;
}) {
  function getByKey(worktreeKey: string): LaneWorktreeLockRow | null {
    return db.get<LaneWorktreeLockRow>(
      "select * from lane_worktree_locks where worktree_key = ? limit 1",
      [worktreeKey],
    );
  }

  function getByToken(token: string): LaneWorktreeLockRow | null {
    return db.get<LaneWorktreeLockRow>(
      "select * from lane_worktree_locks where token = ? limit 1",
      [token],
    );
  }

  function upsert(args: AcquireLaneWorktreeLockArgs, worktreeKey: string, displayPath: string, token: string, at: string, expiresAt: string): LaneWorktreeLockInfo {
    db.run(
      `insert into lane_worktree_locks (
         worktree_key, worktree_path, lane_id, owner_kind, owner_pr_id,
         owner_session_id, owner_proposal_id, owner_label, token,
         created_at, heartbeat_at, expires_at
       )
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(worktree_key) do update set
         worktree_path = excluded.worktree_path,
         lane_id = excluded.lane_id,
         owner_kind = excluded.owner_kind,
         owner_pr_id = excluded.owner_pr_id,
         owner_session_id = excluded.owner_session_id,
         owner_proposal_id = excluded.owner_proposal_id,
         owner_label = excluded.owner_label,
         token = excluded.token,
         heartbeat_at = excluded.heartbeat_at,
         expires_at = excluded.expires_at`,
      [
        worktreeKey,
        displayPath,
        args.laneId,
        args.ownerKind,
        args.ownerPrId ?? null,
        args.ownerSessionId ?? null,
        args.ownerProposalId ?? null,
        args.ownerLabel,
        token,
        at,
        at,
        expiresAt,
      ],
    );
    const row = getByKey(worktreeKey);
    if (!row) throw new Error("Failed to persist lane worktree lock.");
    return rowToLock(row);
  }

  function sweepExpired(): number {
    const at = nowIso();
    const rows = db.all<LaneWorktreeLockRow>(
      "select * from lane_worktree_locks where expires_at <= ?",
      [at],
    );
    if (rows.length === 0) return 0;
    db.run("delete from lane_worktree_locks where expires_at <= ?", [at]);
    logger?.debug?.("lane_worktree_lock.swept_expired", { count: rows.length });
    return rows.length;
  }

  function acquire(args: AcquireLaneWorktreeLockArgs): { token: string; lock: LaneWorktreeLockInfo } {
    const laneId = args.laneId.trim();
    const ownerLabel = args.ownerLabel.trim();
    if (!laneId) throw new Error("laneId is required");
    if (!args.worktreePath.trim()) throw new Error("worktreePath is required");
    if (!ownerLabel) throw new Error("ownerLabel is required");

    const { key, displayPath } = canonicalWorktreePath(args.worktreePath);
    const leaseMs = Math.max(60_000, args.leaseMs ?? DEFAULT_LEASE_MS);
    const atMs = Date.now();
    const at = new Date(atMs).toISOString();
    const expiresAt = new Date(atMs + leaseMs).toISOString();

    db.run("begin immediate");
    try {
      const existing = getByKey(key);
      if (existing && isExpired(existing, atMs)) {
        db.run("delete from lane_worktree_locks where worktree_key = ?", [key]);
      } else if (existing && !ownerMatches(existing, args)) {
        const blocker = formatLaneWorktreeLockBlocker(rowToLock(existing));
        db.run("commit");
        throw new LaneWorktreeLockedError(blocker);
      }

      const token = existing && !isExpired(existing, atMs) && ownerMatches(existing, args)
        ? existing.token
        : (args.token?.trim() || randomUUID());
      const lock = upsert(
        { ...args, laneId, ownerLabel },
        key,
        displayPath,
        token,
        existing && ownerMatches(existing, args) ? existing.created_at : at,
        expiresAt,
      );
      db.run("commit");
      return { token, lock };
    } catch (error) {
      if (!(error instanceof LaneWorktreeLockedError)) {
        try { db.run("rollback"); } catch { /* noop */ }
      }
      throw error;
    }
  }

  function heartbeat(token: string, leaseMs: number = DEFAULT_LEASE_MS): LaneWorktreeLockInfo | null {
    const normalizedToken = token.trim();
    if (!normalizedToken) return null;
    const row = getByToken(normalizedToken);
    if (!row) return null;
    const atMs = Date.now();
    if (isExpired(row, atMs)) {
      db.run("delete from lane_worktree_locks where token = ?", [normalizedToken]);
      return null;
    }
    const at = new Date(atMs).toISOString();
    const expiresAt = new Date(atMs + Math.max(60_000, leaseMs)).toISOString();
    db.run(
      "update lane_worktree_locks set heartbeat_at = ?, expires_at = ? where token = ?",
      [at, expiresAt, normalizedToken],
    );
    const updated = getByToken(normalizedToken);
    return updated ? rowToLock(updated) : null;
  }

  function attachSession(token: string, sessionId: string): LaneWorktreeLockInfo | null {
    const normalizedToken = token.trim();
    const normalizedSessionId = sessionId.trim();
    if (!normalizedToken || !normalizedSessionId) return null;
    db.run(
      "update lane_worktree_locks set owner_session_id = ?, heartbeat_at = ? where token = ?",
      [normalizedSessionId, nowIso(), normalizedToken],
    );
    const row = getByToken(normalizedToken);
    return row ? rowToLock(row) : null;
  }

  function release(args: ReleaseLaneWorktreeLockArgs): number {
    const token = args.token?.trim();
    if (token) {
      db.run("delete from lane_worktree_locks where token = ?", [token]);
      return 1;
    }
    const clauses: string[] = [];
    const params: Array<string | null> = [];
    if (args.ownerKind) {
      clauses.push("owner_kind = ?");
      params.push(args.ownerKind);
    }
    if (args.ownerPrId !== undefined) {
      clauses.push("owner_pr_id is ?");
      params.push(args.ownerPrId ?? null);
    }
    if (args.ownerSessionId !== undefined) {
      clauses.push("owner_session_id is ?");
      params.push(args.ownerSessionId ?? null);
    }
    if (args.ownerProposalId !== undefined) {
      clauses.push("owner_proposal_id is ?");
      params.push(args.ownerProposalId ?? null);
    }
    if (clauses.length === 0) return 0;
    db.run(`delete from lane_worktree_locks where ${clauses.join(" and ")}`, params);
    return 1;
  }

  function getActiveForLane(laneId: string): LaneWorktreeLockInfo[] {
    sweepExpired();
    return db.all<LaneWorktreeLockRow>(
      "select * from lane_worktree_locks where lane_id = ? order by heartbeat_at desc",
      [laneId.trim()],
    ).map(rowToLock);
  }

  return {
    acquire,
    heartbeat,
    attachSession,
    release,
    sweepExpired,
    getActiveForLane,
  };
}

export type LaneWorktreeLockService = ReturnType<typeof createLaneWorktreeLockService>;
