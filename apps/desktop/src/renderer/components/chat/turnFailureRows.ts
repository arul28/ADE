import type { AgentChatEvent } from "../../../shared/types";
import { isUsageLimitChatError } from "../../../shared/chatAutoResume";
import type { ChatTranscriptGroupedEnvelope } from "./chatTranscriptRows";

type ErrorEvent = Extract<AgentChatEvent, { type: "error" }>;

export type ProviderFailureRecovery = { kind: "capacity" | "rate_limit" };

export function classifyProviderFailure(event: ErrorEvent): ProviderFailureRecovery | null {
  const identity = `${
    typeof event.errorInfo === "string" ? event.errorInfo : event.errorInfo?.category ?? ""
  } ${event.message}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (identity.includes("serveroverloaded") || identity.includes("modelisatcapacity")) return { kind: "capacity" };
  // Delegated rather than spelled out again: the host computes
  // `usageLimitResume` off `isUsageLimitChatError`, so a turn the host treats
  // as limited is the turn the transcript treats as limited.
  if (isUsageLimitChatError(event)) return { kind: "rate_limit" };
  return null;
}

function failureSignature(event: ErrorEvent): string {
  const category = typeof event.errorInfo === "string" ? event.errorInfo : event.errorInfo?.category ?? "";
  return `${category}\u0000${event.message.trim()}`;
}

// Rows a retry leaves between two failures without changing what happened.
function isRetryNoise(event: ChatTranscriptGroupedEnvelope["event"]): boolean {
  return event.type === "status" || event.type === "context_usage";
}

/**
 * How failed turns read in the transcript.
 *
 * - A turn that ended at a usage limit draws no row of its own: its turn-end
 *   line says "Usage limit" (`endedAtUsageLimit`), and the pill above the
 *   composer owns what happens next.
 * - A retry that resends the prompt and fails the same way again folds into
 *   the failure before it: the earlier prompt, error and turn-end line drop
 *   out, and the newest failure carries `repeatCount`. Retrying into an exhausted
 *   limit otherwise stacks one identical prompt and failure per press.
 */
export function foldTurnFailureRows(rows: ChatTranscriptGroupedEnvelope[]): ChatTranscriptGroupedEnvelope[] {
  if (!rows.some((row) => row.event.type === "error")) return rows;
  const dropped = new Set<ChatTranscriptGroupedEnvelope>();
  const replaced = new Map<ChatTranscriptGroupedEnvelope, ChatTranscriptGroupedEnvelope>();
  let lastPrompt: { text: string; row: ChatTranscriptGroupedEnvelope } | null = null;
  let open: {
    signature: string;
    prompt: { text: string; row: ChatTranscriptGroupedEnvelope } | null;
    usageLimit: boolean;
    count: number;
    error: ChatTranscriptGroupedEnvelope;
    done: ChatTranscriptGroupedEnvelope | null;
    replay: ChatTranscriptGroupedEnvelope | null;
  } | null = null;

  for (const row of rows) {
    const event = row.event;
    if (event.type === "error") {
      const signature = failureSignature(event);
      const usageLimit = classifyProviderFailure(event)?.kind === "rate_limit";
      let count = 1;
      // The newest attempt's prompt stays, so the prompt and the turn-end
      // line left on screen belong to the same turn.
      if (open && open.signature === signature && open.replay) {
        if (open.prompt) dropped.add(open.prompt.row);
        dropped.add(open.error);
        if (open.done) dropped.add(open.done);
        count = open.count + 1;
      }
      if (usageLimit) dropped.add(row);
      else if (count > 1) replaced.set(row, { ...row, repeatCount: count });
      open = { signature, prompt: lastPrompt, usageLimit, count, error: row, done: null, replay: null };
      continue;
    }
    if (event.type === "user_message") {
      const text = event.text.trim();
      if (open && !open.replay && open.prompt?.text === text) {
        open.replay = row;
        lastPrompt = { text, row };
        continue;
      }
      lastPrompt = { text, row };
      open = null;
      continue;
    }
    if (event.type === "done" && open && !open.done) {
      open.done = row;
      replaced.set(row, {
        ...row,
        ...(open.usageLimit ? { endedAtUsageLimit: true } : {}),
        ...(open.count > 1 ? { repeatCount: open.count } : {}),
      });
      continue;
    }
    if (open && !isRetryNoise(event)) open = null;
  }

  const folded: ChatTranscriptGroupedEnvelope[] = [];
  for (const row of rows) {
    if (dropped.has(row)) continue;
    folded.push(replaced.get(row) ?? row);
  }
  return folded;
}
