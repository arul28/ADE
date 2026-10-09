// Terse human label for a non-completed turn's SDK terminal reason. Shared by
// the desktop transcript and the ADE CLI so both show the same words. The
// shared event contract keeps terminalReason open-ended: unknown reason strings
// return null, so they stay silent until a concise label is chosen for them.
export const TERMINAL_REASON_LABELS: Readonly<Record<string, string>> = {
  budget_exhausted: "budget limit reached",
  max_turns: "max turns reached",
  prompt_too_long: "context window overflow",
  image_error: "attached image rejected",
  api_error: "API error after retries",
  malformed_tool_use_exhausted: "tool-call retries exhausted",
  structured_output_retry_exhausted: "output retries exhausted",
  model_error: "model error",
  turn_setup_failed: "turn setup failed",
  tool_deferred_unavailable: "deferred tool unavailable",
};

export function terminalReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return TERMINAL_REASON_LABELS[reason] ?? null;
}
