import type { AutomationAgentLimits } from "./types";

/** A run-command step's kill switch when the rule sets none. */
export const RUN_COMMAND_DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** Ceiling for a run-command step's Time limit, in the builder and at save. */
export const RUN_COMMAND_MAX_TIMEOUT_MS = 12 * 60 * 60_000;

/**
 * Ceiling for an agent limit. Past ~24.8 days a Node timer overflows and fires
 * at once, so an absurd value must not become an instant stop.
 */
export const AUTOMATION_AGENT_LIMIT_MAX_MIN = 7 * 24 * 60;

function positiveMinutes(value: unknown): number | undefined {
  const minutes = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return Math.min(minutes, AUTOMATION_AGENT_LIMIT_MAX_MIN);
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
