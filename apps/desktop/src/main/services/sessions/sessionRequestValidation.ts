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

/**
 * A format hint, not a sample instant. A dated example goes stale the moment it
 * passes, at which point copying it straight out of the error message trips the
 * "already past" rejection below.
 */
const SNOOZE_FORMAT_HINT = "YYYY-MM-DDTHH:mm:ss.sssZ";

/** Callers can be agents or `ade actions` JSON, so echo a bounded slice back. */
const MAX_ECHOED_CHARS = 64;

/**
 * A snooze deadline must be a parseable ISO-8601 timestamp *in the future*.
 * A past deadline is the dangerous case: `snoozed` is computed as
 * `snoozedUntil > now`, so the write succeeds, the caller is told the session
 * is snoozed, and the row never leaves the attention surfaces.
 */
export function parseSnoozeDeadline(value: unknown, field = "'untilIso'"): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new Error(
      `Expected ${field} to be a future ISO-8601 timestamp in the format ${SNOOZE_FORMAT_HINT}.`,
    );
  }
  const parsed = new Date(raw);
  const parsedMs = parsed.getTime();
  if (Number.isNaN(parsedMs)) {
    throw new Error(
      `Expected ${field} to be an ISO-8601 timestamp in the format ${SNOOZE_FORMAT_HINT}; `
      + `received '${echoable(raw)}'.`,
    );
  }
  if (parsedMs <= Date.now()) {
    throw new Error(
      `Expected ${field} to be in the future; received '${echoable(raw)}', which is already past. `
      + "Snoozing to a past deadline would hide nothing.",
    );
  }
  return parsed.toISOString();
}

/** Keeps a rejected value readable in the message without pasting a whole blob into it. */
function echoable(raw: string): string {
  return raw.length > MAX_ECHOED_CHARS ? `${raw.slice(0, MAX_ECHOED_CHARS)}…` : raw;
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
