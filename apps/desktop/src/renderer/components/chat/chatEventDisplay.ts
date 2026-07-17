/**
 * Pure display helpers for the new SDK event surfaces (terminal reasons, Bash
 * auto-background timeout, Grep totals). Kept free of React so they are cheap to
 * unit-test and shared by the message list.
 */

// Terse human label for a non-completed turn's SDK terminal reason. Open set:
// unknown reason strings return null so we show nothing extra. Completed turns
// never pass a reason (avoid noise).
export const TERMINAL_REASON_LABELS: Record<string, string> = {
  budget_exhausted: "budget limit reached",
  max_turns: "max turns reached",
  prompt_too_long: "context window overflow",
  api_error: "API error after retries",
  malformed_tool_use_exhausted: "tool-call retries exhausted",
  structured_output_retry_exhausted: "output retries exhausted",
  model_error: "model error",
  turn_setup_failed: "turn setup failed",
  tool_deferred_unavailable: "deferred tool unavailable",
};

export function terminalReasonLabel(reason: string | undefined): string | null {
  if (!reason) return null;
  return TERMINAL_REASON_LABELS[reason] ?? null;
}

/** Compact `Nm Ns` / `Ns` label for an auto-backgrounded-on-timeout Bash chip. */
export function formatTimedOutAfter(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const minutes = Math.floor(secs / 60);
  const remainder = secs % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

/** `N matches in M files · ` prefix for a Grep tool result, or "" when absent. */
export function formatGrepTotalsPrefix(
  grepTotals: { files?: number; lines?: number } | undefined,
): string {
  if (!grepTotals) return "";
  const matches = grepTotals.lines ?? 0;
  const files = grepTotals.files ?? 0;
  return `${matches} match${matches === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"} · `;
}
