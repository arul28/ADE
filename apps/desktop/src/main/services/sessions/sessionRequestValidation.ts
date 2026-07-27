import {
  parseSessionSettleOverride,
  SESSION_WAKE_REASONS,
  type SessionSettleOverride,
  type SessionWakeReason,
} from "../../../shared/types";

/**
 * The one place snooze/wake/settle arguments are validated on their way into
 * `sessionService`. Three surfaces feed those calls — agent tool calls
 * (`ctoOperatorTools`), `ade actions` JSON (`adeActions/registry`), and
 * renderer IPC (`registerIpc`) — and each used to hand-roll its own checks with
 * different strictness, so the same bad input was rejected on one path and
 * silently accepted on another.
 *
 * `sessionService` returns a bare `false` for both "no such row" and "bad
 * argument", so anything unvalidated here degrades into a success-shaped no-op.
 */

const SNOOZE_EXAMPLE = "2026-07-26T18:00:00.000Z";

/**
 * A snooze deadline must be a parseable ISO-8601 timestamp *in the future*.
 * A past deadline is the dangerous case: `snoozed` is computed as
 * `snoozedUntil > now`, so the write succeeds, the caller is told the session
 * is snoozed, and the row never leaves the attention surfaces.
 */
export function parseSnoozeDeadline(value: unknown, field = "'untilIso'"): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new Error(`Expected ${field} to be an ISO-8601 timestamp (for example ${SNOOZE_EXAMPLE}).`);
  }
  const parsed = new Date(raw);
  const parsedMs = parsed.getTime();
  if (Number.isNaN(parsedMs)) {
    throw new Error(`Expected ${field} to be an ISO-8601 timestamp; received '${raw}'.`);
  }
  if (parsedMs <= Date.now()) {
    throw new Error(
      `Expected ${field} to be in the future; received '${raw}', which is already past. `
      + "Snoozing to a past deadline would hide nothing.",
    );
  }
  return parsed.toISOString();
}

/** Wake reasons are a closed union persisted on the row; anything else is a bug upstream. */
export function parseWakeReason(value: unknown, context: string): SessionWakeReason {
  if (value == null || value === "") return "manual";
  if (typeof value === "string" && (SESSION_WAKE_REASONS as readonly string[]).includes(value)) {
    return value as SessionWakeReason;
  }
  throw new Error(`${context} 'reason' must be one of: ${SESSION_WAKE_REASONS.join(", ")}.`);
}

/** Wraps the shared parser so an unrecognized value throws instead of clearing the pin. */
export function parseSettleOverrideArg(
  value: unknown,
  context: string,
): SessionSettleOverride | null {
  const parsed = parseSessionSettleOverride(value);
  if (parsed === undefined) {
    throw new Error(`${context} 'override' must be 'settled', 'active', or null.`);
  }
  return parsed;
}
