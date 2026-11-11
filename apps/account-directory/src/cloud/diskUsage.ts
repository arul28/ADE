import {
  CLOUD_DISK_USAGE_KINDS,
  CLOUD_DISK_USAGE_MAX_ITEMS,
  type CloudDiskUsage,
  type CloudDiskUsageItem,
  type CloudDiskUsageKind,
  type CloudDiskUsageReport,
  type CloudInstance,
  type CloudLaneWork,
} from "./contract";
import type { CloudEnv, ComputerRow } from "./store";

/**
 * What uses each computer's disk, and when it last did work (README,
 * "ADE Cloud dashboard").
 *
 * The computer measures itself at its idle step, while it is awake anyway, at
 * most every few hours, and posts it here (`POST .../disk-usage`). The
 * computer list carries it back, so the dashboard shows "measured 2 days ago"
 * for a sleeping computer and never wakes one to look.
 */

/** No part of one computer's disk is bigger than this; a larger number is a broken report. */
const MAX_PART_GB = 4096;
/** A report from the future (a skewed clock) is pinned to now. */
const FUTURE_SLACK_MS = 5 * 60_000;

function gbOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_PART_GB) return null;
  return Math.round(value * 1000) / 1000;
}

function timeOf(value: unknown, now: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.round(value), now + FUTURE_SLACK_MS);
}

function isKind(value: unknown): value is CloudDiskUsageKind {
  return typeof value === "string" && (CLOUD_DISK_USAGE_KINDS as readonly string[]).includes(value);
}

function itemOf(raw: unknown): CloudDiskUsageItem | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const gb = gbOf(record.gb);
  if (!isKind(record.kind) || gb == null) return null;
  const label = typeof record.label === "string" ? record.label.trim().slice(0, 60) : "";
  return { kind: record.kind, label: label || record.kind, gb, clearable: record.clearable === true };
}

const PR_STATES = ["draft", "open", "merged", "closed"] as const;

function laneWorkOf(raw: unknown, now: number): CloudLaneWork | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const checkedAt = timeOf(record.checkedAt, now);
  if (checkedAt == null || typeof record.unpushed !== "boolean") return null;
  const prState = (PR_STATES as readonly unknown[]).includes(record.prState) ? record.prState as CloudLaneWork["prState"] : null;
  return { checkedAt, unpushed: record.unpushed, prState };
}

/** The body the computer sends, checked; null when it can't be read. */
export function parseDiskUsageReport(body: Record<string, unknown> | null, now: number): CloudDiskUsageReport | null {
  if (!body) return null;
  const lastActiveAt = body.lastActiveAt == null ? null : timeOf(body.lastActiveAt, now);
  if (body.lastActiveAt != null && lastActiveAt == null) return null;
  const work = body.work == null ? null : laneWorkOf(body.work, now);
  if (body.work != null && work == null) return null;
  if (body.usage == null) return { lastActiveAt, usage: null, work };
  if (typeof body.usage !== "object") return null;
  const usage = body.usage as Record<string, unknown>;
  const measuredAt = timeOf(usage.measuredAt, now);
  const totalGb = gbOf(usage.totalGb);
  if (measuredAt == null || totalGb == null || !Array.isArray(usage.items)) return null;
  const items = usage.items.slice(0, CLOUD_DISK_USAGE_MAX_ITEMS).map(itemOf);
  if (items.some((item) => item == null)) return null;
  return { lastActiveAt, usage: { measuredAt, totalGb, items: items as CloudDiskUsageItem[] }, work };
}

/** Saves a report. A report without a measure keeps the last one; an older measure never replaces a newer one. */
export async function recordDiskUsage(env: CloudEnv, computer: ComputerRow, report: CloudDiskUsageReport): Promise<void> {
  const statements = [];
  if (report.lastActiveAt != null) {
    statements.push(env.DB.prepare(
      "update cloud_computers set last_active_at = ? where instance_id = ? and (last_active_at is null or last_active_at < ?)",
    ).bind(report.lastActiveAt, computer.instance_id, report.lastActiveAt));
  }
  if (report.usage) {
    const json = JSON.stringify({ totalGb: report.usage.totalGb, items: report.usage.items });
    statements.push(env.DB.prepare(
      "update cloud_computers set disk_usage_json = ?, disk_measured_at = ? where instance_id = ? and (disk_measured_at is null or disk_measured_at <= ?)",
    ).bind(json, report.usage.measuredAt, computer.instance_id, report.usage.measuredAt));
  }
  if (report.work) {
    // An older read (a report retried late) never replaces a newer one, as with the disk measure.
    statements.push(env.DB.prepare(`
      update cloud_computers set lane_work_json = ?
      where instance_id = ? and (lane_work_json is null or coalesce(json_extract(lane_work_json, '$.checkedAt'), 0) <= ?)
    `).bind(JSON.stringify(report.work), computer.instance_id, report.work.checkedAt));
  }
  if (statements.length) await env.DB.batch(statements);
}

type UseRow = Pick<ComputerRow, "disk_usage_json" | "disk_measured_at" | "last_active_at" | "lane_work_json" | "last_awake_at" | "awake_since">;

/** The saved measure, or null before the first one (or a row the code can't read). */
export function diskUsageOf(computer: UseRow): CloudDiskUsage | null {
  if (!computer.disk_usage_json || computer.disk_measured_at == null) return null;
  try {
    const parsed = JSON.parse(computer.disk_usage_json) as { totalGb?: unknown; items?: unknown };
    const totalGb = gbOf(parsed.totalGb);
    if (totalGb == null || !Array.isArray(parsed.items)) return null;
    const items = parsed.items.map(itemOf).filter((item): item is CloudDiskUsageItem => item != null);
    return { measuredAt: computer.disk_measured_at, totalGb, items };
  } catch {
    return null;
  }
}

/** Its lane's saved work read, or null before the first one. */
export function laneWorkOfRow(computer: UseRow): CloudLaneWork | null {
  if (!computer.lane_work_json) return null;
  try {
    return laneWorkOf(JSON.parse(computer.lane_work_json), Number.MAX_SAFE_INTEGER);
  } catch {
    return null;
  }
}

/** Its own last work, else the last time it was awake. */
export function lastActiveAtOf(computer: UseRow): number | null {
  return computer.last_active_at ?? computer.last_awake_at ?? computer.awake_since ?? null;
}

/** The instance as the list shows it, with its use facts. */
export function withUseFacts(instance: CloudInstance, computer: UseRow | null | undefined): CloudInstance {
  if (!computer) return instance;
  return { ...instance, lastActiveAt: lastActiveAtOf(computer), diskUsage: diskUsageOf(computer), laneWork: laneWorkOfRow(computer) };
}

/** Days of settled hours the forecast reads. */
export const RECENT_USE_DAYS = 7;

/**
 * Hours the meter charged the account over the last `RECENT_USE_DAYS` whole
 * UTC days, deleted computers included: the metered hours plus the daily
 * reconcile's correction (`corrected_milli` is that day's difference).
 */
export async function recentUsedMilli(env: CloudEnv, userId: string, now: number): Promise<number> {
  const today = new Date(now).toISOString().slice(0, 10);
  const from = new Date(now - RECENT_USE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    "select coalesce(sum(metered_milli + coalesce(corrected_milli, 0)), 0) as used from cloud_computer_days where user_id = ? and day >= ? and day < ?",
  ).bind(userId, from, today).first<{ used: number }>();
  return Math.max(0, Math.round(row?.used ?? 0));
}
