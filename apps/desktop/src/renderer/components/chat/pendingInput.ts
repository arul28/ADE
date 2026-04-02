import type {
  AgentChatEventEnvelope,
  PendingInputOption,
  PendingInputQuestion,
  PendingInputRequest,
} from "../../../shared/types";
import { readRecord } from "./chatTranscriptRows";

export type DerivedPendingInput = {
  sessionId: string;
  itemId: string;
  request: PendingInputRequest;
};

export function getPendingInputQuestionCount(request: PendingInputRequest | null | undefined): number {
  return request?.questions?.length ?? 0;
}

export function hasPendingInputOptions(request: PendingInputRequest | null | undefined): boolean {
  if (!request) return false;
  if (Array.isArray(request.options) && request.options.length > 0) return true;
  return Array.isArray(request.questions)
    && request.questions.some((question) => Array.isArray(question.options) && question.options.length > 0);
}

function readPendingInputOption(value: unknown): PendingInputOption | null {
  const record = readRecord(value);
  if (!record) return null;
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const rawValue = typeof record.value === "string" ? record.value.trim() : label;
  if (!label.length || !rawValue.length) return null;
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
    ...(record.allowsFreeform === true ? { allowsFreeform: true } : {}),
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

function readPendingInputRequest(value: unknown): PendingInputRequest | null {
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

function buildLegacyPendingInputFromApprovalEvent(envelope: AgentChatEventEnvelope): PendingInputRequest | null {
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
      source: "mission",
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
    source: "mission",
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
    source: "mission",
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

export function derivePendingInputRequests(events: AgentChatEventEnvelope[]): DerivedPendingInput[] {
  const pending = new Map<string, DerivedPendingInput>();

  for (const envelope of events) {
    const event = envelope.event;

    if (event.type === "done") {
      if (event.status !== "completed") {
        pending.clear();
        continue;
      }
      for (const [itemId, entry] of pending) {
        if ((entry.request.turnId ?? null) !== event.turnId) continue;
        const keepAfterCompletedTurn =
          entry.request.kind === "question"
          || entry.request.kind === "structured_question"
          || entry.request.kind === "plan_approval";
        if (!keepAfterCompletedTurn) {
          pending.delete(itemId);
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

    if (event.type === "pending_input_resolved") {
      pending.delete(event.itemId);
      continue;
    }

    if (event.type === "tool_result" || event.type === "command" || event.type === "file_change") {
      pending.delete(event.itemId);
    }
  }

  return [...pending.values()];
}
