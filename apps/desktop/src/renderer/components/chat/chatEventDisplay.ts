/**
 * Pure display helpers for the new SDK event surfaces (terminal reasons, Bash
 * auto-background timeout, Grep totals). Kept free of React so they are cheap to
 * unit-test and shared by the message list.
 */

// Terse terminal-reason labels live in shared/terminalReasonLabels so the ADE
// CLI shows the same words. Completed turns never pass a reason (avoid noise).
export { TERMINAL_REASON_LABELS, terminalReasonLabel } from "../../../shared/terminalReasonLabels";

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
