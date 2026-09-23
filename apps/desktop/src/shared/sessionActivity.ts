import {
  SESSION_ACTIVITY_VALUES,
  type SessionActivityReport,
  type SessionActivityValue,
} from "./types/sessions";

const SESSION_ACTIVITY_VALUE_SET: ReadonlySet<string> = new Set(SESSION_ACTIVITY_VALUES);

/** Agent CLI target for activity reports; unlike ADE_CHAT_SESSION_ID this is a PTY row id. */
export const SESSION_ACTIVITY_SESSION_ID_ENV = "ADE_ACTIVITY_SESSION_ID";

export function isSessionActivityValue(value: unknown): value is SessionActivityValue {
  return typeof value === "string" && SESSION_ACTIVITY_VALUE_SET.has(value);
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/**
 * Parse the single persisted activity-status atom at an input boundary.
 * Unknown values, sources, timestamps, or malformed JSON are treated as absent
 * so an old or corrupt row cannot invent a card status.
 */
export function normalizeSessionActivityReport(value: unknown): SessionActivityReport | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;

  const record = candidate as Record<string, unknown>;
  if (!isSessionActivityValue(record.value) || record.source !== "agent") return null;
  const updatedAt = normalizeTimestamp(record.updatedAt);
  if (!updatedAt) return null;

  return { value: record.value, source: "agent", updatedAt };
}
