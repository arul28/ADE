import type { AgentChatEvent, ModelId } from "../../../shared/types";

export function mapStopReasonToTerminalEvents(args: {
  stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
  turnId: string;
  model?: string;
  modelId?: ModelId;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
  };
}): AgentChatEvent[] {
  const { stopReason, turnId, model, modelId, usage } = args;
  const out: AgentChatEvent[] = [];

  if (stopReason === "refusal") {
    out.push({ type: "error", message: "The model refused this request.", turnId });
  }

  if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
    out.push({
      type: "system_notice",
      noticeKind: "info",
      message:
        stopReason === "max_tokens"
          ? "Context or output limit reached for this turn."
          : "Maximum agent turns reached for this prompt.",
      turnId,
    });
  }

  const doneStatus =
    stopReason === "cancelled"
      ? "interrupted"
      : stopReason === "refusal"
        ? "failed"
        : "completed";

  out.push({
    type: "done",
    turnId,
    status: doneStatus,
    ...(model ? { model } : {}),
    ...(modelId ? { modelId } : {}),
    ...(usage ? { usage } : {}),
  });

  return out;
}
