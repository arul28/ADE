// Keep this map aligned with WU2's desktop terminal-reason labels. The shared
// event contract deliberately keeps terminalReason open-ended, so unknown SDK
// reasons stay silent until a concise user-facing label is chosen.
const TERMINAL_REASON_LABELS: Readonly<Record<string, string>> = {
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

export function terminalReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return TERMINAL_REASON_LABELS[reason] ?? null;
}
