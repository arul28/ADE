import type { AutomationAgentLimits } from "./types";

/** A run-command step's kill switch when the rule sets none. */
export const RUN_COMMAND_DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** Ceiling for a run-command step's Time limit, in the builder and at save. */
export const RUN_COMMAND_MAX_TIMEOUT_MS = 12 * 60 * 60_000;

/**
 * A run-command kill switch in ms, clamped to [1 s, 12 h]. Missing, zero,
 * negative, or non-numeric values mean "use the default" — never a 1 s kill,
 * and never a delay past what a Node timer can hold.
 */
export function normalizeRunCommandTimeoutMs(value: unknown): number | undefined {
  const ms = positiveNumber(value);
  return ms != null ? Math.min(RUN_COMMAND_MAX_TIMEOUT_MS, Math.max(1000, Math.floor(ms))) : undefined;
}

/**
 * Ceiling for an agent limit. Past ~24.8 days a Node timer overflows and fires
 * at once, so an absurd value must not become an instant stop.
 */
export const AUTOMATION_AGENT_LIMIT_MAX_MIN = 7 * 24 * 60;

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function positiveMinutes(value: unknown): number | undefined {
  const minutes = positiveNumber(value);
  return minutes != null ? Math.min(minutes, AUTOMATION_AGENT_LIMIT_MAX_MIN) : undefined;
}

/** Keep positive minute limits; anything else means "no limit". */
export function normalizeAutomationAgentLimits(value: unknown): AutomationAgentLimits {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const stopAfterMin = positiveMinutes(record.stopAfterMin);
  const stopWhenIdleMin = positiveMinutes(record.stopWhenIdleMin);
  return {
    ...(stopAfterMin != null ? { stopAfterMin } : {}),
    ...(stopWhenIdleMin != null ? { stopWhenIdleMin } : {}),
  };
}
