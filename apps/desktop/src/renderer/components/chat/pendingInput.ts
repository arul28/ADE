import type {
  AgentChatEventEnvelope,
  AgentChatSessionSummary,
  PendingInputOption,
  PendingInputQuestion,
  PendingInputRequest,
} from "../../../shared/types";
import { isAskQuestionRequest } from "../../../shared/pendingInputAnswers";
import { readRecord } from "./chatTranscriptRows";

export type DerivedPendingInput = {
  sessionId: string;
  itemId: string;
  request: PendingInputRequest;
  /**
   * Something in the transcript implies this card is over, but no
   * `pending_input_resolved` receipt confirms it. Read only by
   * {@link resolvePendingInputs} — never by a renderer directly.
   */
  sweptWithoutReceipt?: true;
};

export function getPendingInputQuestionCount(request: PendingInputRequest | null | undefined): number {
  return request?.questions?.length ?? 0;
}

function readPendingInputOption(value: unknown): PendingInputOption | null {
  const record = readRecord(value);
  if (!record) return null;
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const rawValue = typeof record.value === "string" ? record.value : label;
  if (!label.length || !rawValue.trim().length) return null;
  return {
    label,
    value: rawValue,
    ...(typeof record.description === "string" && record.description.trim().length
      ? { description: record.description.trim() }
      : {}),
    ...(record.recommended === true ? { recommended: true } : {}),
    ...(typeof record.preview === "string" && record.preview.trim().length
      ? { preview: record.preview }
      : {}),
    ...(record.previewFormat === "html" || record.previewFormat === "markdown"
      ? { previewFormat: record.previewFormat }
      : {}),
  };
}

function readPendingInputQuestion(value: unknown): PendingInputQuestion | null {
  const record = readRecord(value);
  if (!record) return null;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const question = typeof record.question === "string" ? record.question.trim() : "";
  if (!id.length || !question.length) return null;
  return {
    id,
    question,
    ...(typeof record.header === "string" && record.header.trim().length ? { header: record.header.trim() } : {}),
    ...(record.multiSelect === true ? { multiSelect: true } : {}),
    // Preserve an explicit `false`. Collapsing it to undefined made "the
    // provider declined freeform" indistinguishable from "unspecified", and the
    // composer defaults unspecified to a note row — so we rendered a note field
    // for a question that refused one and sent text it never agreed to accept.
    ...(typeof record.allowsFreeform === "boolean" ? { allowsFreeform: record.allowsFreeform } : {}),
    ...(record.isSecret === true ? { isSecret: true } : {}),
    ...(typeof record.defaultAssumption === "string" && record.defaultAssumption.trim().length
      ? { defaultAssumption: record.defaultAssumption.trim() }
      : {}),
    ...(typeof record.impact === "string" && record.impact.trim().length
      ? { impact: record.impact.trim() }
      : {}),
    ...(Array.isArray(record.options)
      ? {
          options: record.options
            .map((option) => readPendingInputOption(option))
            .filter((option): option is PendingInputOption => option != null),
        }
      : {}),
  };
}

export function readPendingInputRequest(value: unknown): PendingInputRequest | null {
  const record = readRecord(value);
  if (!record) return null;
  const requestId = typeof record.requestId === "string" ? record.requestId.trim() : "";
  const source = typeof record.source === "string" ? record.source.trim() : "";
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  const questions = Array.isArray(record.questions)
    ? record.questions.map((question) => readPendingInputQuestion(question)).filter((question): question is PendingInputQuestion => question != null)
    : [];
  if (!requestId.length || !source.length || !kind.length) return null;
  return {
    requestId,
    ...(typeof record.itemId === "string" && record.itemId.trim().length ? { itemId: record.itemId.trim() } : {}),
    source: source as PendingInputRequest["source"],
    kind: kind as PendingInputRequest["kind"],
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    questions,
    allowsFreeform: record.allowsFreeform === true,
    blocking: record.blocking !== false,
    canProceedWithoutAnswer: record.canProceedWithoutAnswer === true,
    ...(Array.isArray(record.options)
      ? {
          options: record.options.map((option) => readPendingInputOption(option)).filter((option): option is PendingInputOption => option != null),
        }
      : {}),
    ...(readRecord(record.providerMetadata) ? { providerMetadata: readRecord(record.providerMetadata)! } : {}),
    ...(typeof record.turnId === "string" ? { turnId: record.turnId } : {}),
  };
}

export function buildLegacyPendingInputFromApprovalEvent(
  envelope: AgentChatEventEnvelope | { event: AgentChatEventEnvelope["event"] },
): PendingInputRequest | null {
  const event = envelope.event;
  if (event.type !== "approval_request") return null;
  const detail = readRecord(event.detail);
  const normalizedTool = typeof detail?.tool === "string" ? detail.tool.trim().toLowerCase() : "";
  const question = typeof detail?.question === "string" ? detail.question.trim() : "";
  const optionList = Array.isArray(detail?.options)
    ? detail.options.map((option) => readPendingInputOption(option)).filter((option): option is PendingInputOption => option != null)
    : [];

  if ((normalizedTool === "askuser" || normalizedTool === "ask_user") && question.length) {
    return {
      requestId: event.itemId,
      itemId: event.itemId,
      source: "ade",
      kind: optionList.length ? "structured_question" : "question",
      description: question,
      questions: [
        {
          id: "response",
          header: "Question",
          question,
          ...(optionList.length ? { options: optionList } : {}),
          allowsFreeform: true,
        },
      ],
      allowsFreeform: true,
      blocking: true,
      canProceedWithoutAnswer: false,
      turnId: event.turnId ?? null,
      providerMetadata: detail ?? undefined,
    };
  }

  return {
    requestId: event.itemId,
    itemId: event.itemId,
    source: "ade",
    kind: "approval",
    description: event.description,
    questions: [],
    allowsFreeform: false,
    blocking: true,
    canProceedWithoutAnswer: false,
    turnId: event.turnId ?? null,
    providerMetadata: detail ?? undefined,
  };
}

function buildLegacyPendingInputFromStructuredQuestion(envelope: AgentChatEventEnvelope): PendingInputRequest | null {
  const event = envelope.event;
  if (event.type !== "structured_question") return null;
  return {
    requestId: event.itemId,
    itemId: event.itemId,
    source: "ade",
    kind: "structured_question",
    description: event.question,
    questions: [
      {
        id: "response",
        header: "Question",
        question: event.question,
        ...(event.options?.length
          ? {
              options: event.options.map((option) => ({
                label: option.label,
                value: option.value,
              })),
            }
          : {}),
        allowsFreeform: true,
      },
    ],
    allowsFreeform: true,
    blocking: true,
    canProceedWithoutAnswer: false,
    turnId: event.turnId ?? null,
  };
}

/**
 * Reconcile a raw derivation against the session summary. See "Pending input
 * derivation" in `docs/features/chat/README.md` for the incident this exists
 * to prevent.
 *
 * Same placement rule as `resolveTurnActive` — outside the derivation and
 * outside the view cache — applied here at read time, which leaves not even a
 * write-time staleness window. `appendRetainedChatSessionEvents` caches raw
 * scalars from a context with no summary at all, so a summary-tainted
 * derivation would be cached inconsistently and read back stale.
 *
 * Only `pendingInputItemId` can rescue a card swept without a receipt, so one
 * main has stopped claiming stays swept — that is what keeps a genuinely stale
 * provider approval (its tool resolved, leaving no receipt) out of the
 * composer. Main names at most one card, so when two are live at once they
 * reveal one at a time; harmless, because the composer draws only
 * `pendingInputs[0]` and the "needs you" badge reads `awaitingInput`, which is
 * true while any card is live.
 */
export function resolvePendingInputs(
  derived: readonly DerivedPendingInput[],
  summary: Pick<AgentChatSessionSummary, "pendingInputItemId"> | null | undefined,
): DerivedPendingInput[] {
  // `|| null` collapses both "no id" and "blank id" into one sentinel that no
  // real itemId can equal, so the claim check needs no separate empty branch.
  const liveItemId = summary?.pendingInputItemId?.trim() || null;
  return derived.filter((entry) => !entry.sweptWithoutReceipt || entry.itemId === liveItemId);
}

export function derivePendingInputRequests(events: AgentChatEventEnvelope[]): DerivedPendingInput[] {
  const pending = new Map<string, DerivedPendingInput>();
  // Record the sweep instead of applying it. A new object every time: entries
  // are handed to React state and must never be mutated in place.
  const sweep = (itemId: string): void => {
    const entry = pending.get(itemId);
    if (!entry || entry.sweptWithoutReceipt) return;
    pending.set(itemId, { ...entry, sweptWithoutReceipt: true });
  };

  for (const envelope of events) {
    const event = envelope.event;

    if (event.type === "done") {
      if (event.status !== "completed") {
        for (const itemId of pending.keys()) sweep(itemId);
        continue;
      }
      for (const [itemId, entry] of pending) {
        if ((entry.request.turnId ?? null) !== event.turnId) continue;
        const keepAfterCompletedTurn =
          isAskQuestionRequest(entry.request)
          || entry.request.kind === "plan_approval";
        if (!keepAfterCompletedTurn) {
          sweep(itemId);
        }
      }
      continue;
    }

    if (event.type === "approval_request") {
      const detail = readRecord(event.detail);
      const request = readPendingInputRequest(detail?.request) ?? buildLegacyPendingInputFromApprovalEvent(envelope);
      if (!request) continue;
      pending.set(event.itemId, {
        sessionId: envelope.sessionId,
        itemId: event.itemId,
        request,
      });
      continue;
    }

    if (event.type === "structured_question") {
      const request = buildLegacyPendingInputFromStructuredQuestion(envelope);
      if (!request) continue;
      pending.set(event.itemId, {
        sessionId: envelope.sessionId,
        itemId: event.itemId,
        request,
      });
      continue;
    }

    // A hard delete, not a sweep: this is an explicit receipt.
    if (event.type === "pending_input_resolved") {
      pending.delete(event.itemId);
      continue;
    }

    // A provider approval shares its tool call's itemId, so the tool resolving
    // moots it — but leaves no receipt, so this is evidence and not proof.
    if (event.type === "tool_result" || event.type === "command" || event.type === "file_change") {
      sweep(event.itemId);
    }
  }

  return [...pending.values()];
}
