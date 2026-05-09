import type {
  AgentChatEventEnvelope,
  PendingInputOption,
  PendingInputQuestion,
  PendingInputRequest,
} from "../../desktop/src/shared/types/chat";
import { renderObject } from "./format";
import type { PendingApproval } from "./types";

function looksHighStakesApproval(description: string, detail: unknown): boolean {
  const text = `${description} ${renderObject(detail, 8)}`.toLowerCase();
  return /\b(drop|delete|destroy|force[- ]push|production|prod|schema|credential|secret|external|publish|release)\b/.test(text);
}

function isPendingInputRequest(value: unknown): value is PendingInputRequest {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  return Boolean(
    record
    && typeof record.requestId === "string"
    && typeof record.kind === "string"
    && Array.isArray(record.questions),
  );
}

function requestFromApprovalEvent(event: Record<string, unknown>): PendingInputRequest | undefined {
  const detail = event.detail && typeof event.detail === "object" ? event.detail as Record<string, unknown> : null;
  const request = detail?.request;
  return isPendingInputRequest(request) ? request : undefined;
}

function isApprovalMode(request: PendingInputRequest | undefined): boolean {
  return !request || request.kind === "approval" || request.kind === "permissions" || request.kind === "plan_approval";
}

export function latestPendingApproval(events: AgentChatEventEnvelope[]): PendingApproval | null {
  const resolved = new Set<string>();
  for (const envelope of events) {
    const event = envelope.event as Record<string, unknown>;
    if (event.type === "pending_input_resolved" && typeof event.itemId === "string") {
      resolved.add(event.itemId);
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event as Record<string, unknown> | undefined;
    if (!event || event.type !== "approval_request" || typeof event.itemId !== "string") continue;
    if (resolved.has(event.itemId)) continue;
    const request = requestFromApprovalEvent(event);
    const description = typeof event.description === "string" ? event.description : "Approve this tool request?";
    const mode = isApprovalMode(request) ? "approval" : "question";
    return {
      itemId: event.itemId,
      description,
      highStakes: mode === "approval" && (
        request?.kind === "permissions"
        || request?.kind === "plan_approval"
        || looksHighStakesApproval(description, event.detail)
      ),
      mode,
      ...(request ? { request } : {}),
    };
  }
  return null;
}

function optionMatches(input: string, option: PendingInputOption, index: number): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === String(index + 1)
    || normalized === option.value.toLowerCase()
    || normalized === option.label.toLowerCase();
}

function answerForQuestion(question: PendingInputQuestion, text: string): string | string[] {
  const trimmed = text.trim();
  if (!question.options?.length) return trimmed;
  const values = trimmed.split(",").map((entry) => entry.trim()).filter(Boolean);
  const matched = values.map((value) => {
    const option = question.options?.find((candidate, index) => optionMatches(value, candidate, index));
    return option?.value ?? value;
  });
  if (question.multiSelect) return matched;
  return matched[0] ?? trimmed;
}

export function buildPendingInputAnswers(
  request: PendingInputRequest | undefined,
  text: string,
): Record<string, string | string[]> | undefined {
  const questions = request?.questions ?? [];
  if (questions.length === 0) return undefined;
  if (questions.length === 1) {
    const question = questions[0]!;
    return { [question.id]: answerForQuestion(question, text) };
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return Object.fromEntries(questions.map((question, index) => [
    question.id,
    answerForQuestion(question, lines[index] ?? text),
  ]));
}
