/**
 * Constants about providers' own on-disk usage records, shared by the live
 * chat path (ACP telemetry) and the history scanners (usage ledger worker). A
 * leaf module with no imports. The per-row readers live beside each dialect's
 * ledger (`acpHost/acpDialects/*UsageLedger.ts`, `grokTelemetry.ts`); they
 * import only leaf helpers, so the worker can load them.
 */

/** Copilot CLI's usage table in `session-store.db`, one row per model request. */
export const COPILOT_USAGE_TABLE = "assistant_usage_events";

/** Grok reports cost in ticks: one billionth of a US dollar. */
export const GROK_COST_TICKS_PER_USD = 1_000_000_000;
