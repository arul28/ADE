import type { AdeCardPayload } from "./adeCard";

/** Sticky `ade_card` identity per ADE chat. Later ticks merge into this row. */
export const CLAUDE_SESSION_QUOTA_CARD_VARIANT = "claude_session_quota";
export const CLAUDE_SESSION_QUOTA_CARD_ACTION = "fork-local";
export const CLAUDE_SESSION_QUOTA_FORK_NOTE = "Continuing after Claude session limit";

export type ClaudeSessionQuotaSnapshot = {
  utilizationPct: number | null;
  resetsAtMs: number | null;
};

export type ClaudeRateLimitClassification =
  | { kind: "ignore" }
  | { kind: "approaching"; snapshot: ClaudeSessionQuotaSnapshot; status: string }
  | { kind: "rejected"; snapshot: ClaudeSessionQuotaSnapshot; status: string };

const SESSION_LIMIT_RE = /session limit/i;
const RESETS_RE = /\bresets\b/i;
const COST_LIMIT_RE = /cost limit|spending limit/i;
const CLOCK_RE = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i;

export function claudeSessionQuotaCardId(sessionId: string): string {
  return `claude-session-quota:${sessionId}`;
}

export function isClaudeSessionQuotaText(value: string | null | undefined): boolean {
  const text = value?.trim() ?? "";
  if (!text) return false;
  if (COST_LIMIT_RE.test(text)) return true;
  if (SESSION_LIMIT_RE.test(text) && RESETS_RE.test(text)) return true;
  return /you'?ve hit your session limit/i.test(text);
}

export function utilizationToPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const percent = value <= 1 ? Math.round(value * 100) : Math.round(value);
  return Math.max(0, Math.min(100, percent));
}

export function normalizeResetsAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value > 1_000_000_000_000 ? value : value * 1000;
  return Number.isNaN(new Date(ms).getTime()) ? null : ms;
}

export function mergeClaudeSessionQuotaSnapshot(
  previous: ClaudeSessionQuotaSnapshot | null | undefined,
  incoming: ClaudeSessionQuotaSnapshot,
): ClaudeSessionQuotaSnapshot {
  return {
    utilizationPct: incoming.utilizationPct ?? previous?.utilizationPct ?? null,
    resetsAtMs: incoming.resetsAtMs ?? previous?.resetsAtMs ?? null,
  };
}

export function classifyClaudeRateLimitInfo(info: Record<string, unknown> | null | undefined): ClaudeRateLimitClassification {
  const status = typeof info?.status === "string" && info.status.trim()
    ? info.status.trim()
    : "updated";
  const snapshot: ClaudeSessionQuotaSnapshot = {
    utilizationPct: utilizationToPercent(info?.utilization),
    resetsAtMs: normalizeResetsAtMs(info?.resetsAt),
  };
  if (status === "allowed") return { kind: "ignore" };
  if (status === "allowed_warning") return { kind: "approaching", snapshot, status };
  return { kind: "rejected", snapshot, status };
}

export function parseClaudeSessionQuotaResetAt(
  text: string,
  nowMs: number = Date.now(),
): number | null {
  const match = text.match(CLOCK_RE);
  if (!match) return null;
  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const ampm = (match[3] ?? "").toLowerCase();
  const timeZone = match[4]?.trim() || undefined;
  if (!Number.isFinite(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
  const hour24 = ampm === "pm" ? (hour12 % 12) + 12 : hour12 % 12;
  return nextWallClockMs({ hour24, minute, timeZone, nowMs });
}

export function formatClaudeSessionQuotaResetLabel(
  resetsAtMs: number | null | undefined,
  timeZone?: string,
): string | null {
  if (resetsAtMs == null) return null;
  const date = new Date(resetsAtMs);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
}

export function snapshotFromClaudeSessionQuotaText(
  text: string,
  nowMs: number = Date.now(),
): ClaudeSessionQuotaSnapshot {
  return {
    utilizationPct: null,
    resetsAtMs: parseClaudeSessionQuotaResetAt(text, nowMs),
  };
}

export function buildClaudeSessionQuotaCard(args: {
  sessionId: string;
  turnId?: string | null;
  snapshot: ClaudeSessionQuotaSnapshot;
  dismissed?: boolean;
}): AdeCardPayload {
  const cardId = claudeSessionQuotaCardId(args.sessionId);
  if (args.dismissed) {
    return {
      cardId,
      variant: CLAUDE_SESSION_QUOTA_CARD_VARIANT,
      state: "terminal",
      title: "Claude session resumed",
      subtitle: null,
      rows: [],
      fallbackText: "Claude session resumed.",
      ...(args.turnId ? { turnId: args.turnId } : {}),
    };
  }
  const resetLabel = formatClaudeSessionQuotaResetLabel(args.snapshot.resetsAtMs);
  const percent = args.snapshot.utilizationPct;
  const title = resetLabel
    ? `Claude session limit · resets ${resetLabel}`
    : "Claude session limit";
  const progress = percent == null
    ? null
    : {
        passed: 0,
        failed: percent,
        running: 0,
        queued: Math.max(0, 100 - percent),
      };
  return {
    cardId,
    variant: CLAUDE_SESSION_QUOTA_CARD_VARIANT,
    state: "live",
    title,
    subtitle: "Send again after reset, or fork this thread.",
    ...(percent != null
      ? { metrics: [{ label: "used", value: `${percent}%`, tone: "warning" as const }] }
      : {}),
    ...(progress ? { progress } : {}),
    rows: [{
      icon: "info",
      text: "Same Claude login after reset. Fork keeps this thread's history.",
    }],
    actions: [{
      id: CLAUDE_SESSION_QUOTA_CARD_ACTION,
      label: "Fork in this lane",
      kind: "primary" as const,
    }],
    fallbackText: resetLabel
      ? `Claude session limit · resets ${resetLabel}. Send again after reset, or fork this thread.`
      : "Claude session limit. Send again after reset, or fork this thread.",
    ...(args.turnId ? { turnId: args.turnId } : {}),
  };
}

function nextWallClockMs(args: {
  hour24: number;
  minute: number;
  timeZone?: string;
  nowMs: number;
}): number | null {
  const zone = args.timeZone;
  const now = new Date(args.nowMs);
  const candidates = [0, 1, 2].map((dayOffset) => {
    const probe = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    return wallClockOnDate(probe, args.hour24, args.minute, zone);
  });
  for (const candidate of candidates) {
    if (candidate != null && candidate > args.nowMs) return candidate;
  }
  return candidates.find((value): value is number => value != null) ?? null;
}

function wallClockOnDate(
  date: Date,
  hour24: number,
  minute: number,
  timeZone: string | undefined,
): number | null {
  if (!timeZone) {
    const next = new Date(date);
    next.setHours(hour24, minute, 0, 0);
    return next.getTime();
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = Number.parseInt(parts.find((part) => part.type === "year")?.value ?? "", 10);
    const month = Number.parseInt(parts.find((part) => part.type === "month")?.value ?? "", 10);
    const day = Number.parseInt(parts.find((part) => part.type === "day")?.value ?? "", 10);
    if (![year, month, day].every(Number.isFinite)) return null;
    // Walk UTC hours until the zoned clock matches. 15-minute steps cover DST folds.
    const start = Date.UTC(year, month - 1, day) - 14 * 60 * 60 * 1000;
    for (let offset = 0; offset <= 48 * 4; offset += 1) {
      const ms = start + offset * 15 * 60 * 1000;
      const clock = zonedHourMinute(ms, timeZone);
      if (clock && clock.hour === hour24 && clock.minute === minute) return ms;
    }
    return null;
  } catch {
    return null;
  }
}

function zonedHourMinute(ms: number, timeZone: string): { hour: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "", 10);
    const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value ?? "", 10);
    if (![hour, minute].every(Number.isFinite)) return null;
    return { hour, minute };
  } catch {
    return null;
  }
}
