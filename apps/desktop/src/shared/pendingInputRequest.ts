import type { PendingInputOption, PendingInputQuestion, PendingInputRequest } from "./types/chat";

/**
 * Read a `PendingInputRequest` back from untyped data: a transcript event, a
 * synced envelope, or anything else that crossed a JSON boundary.
 *
 * One reader for the renderer, which rebuilds cards from events, and the chat
 * service, which reads a card back from the transcript after its waiter is
 * gone. A record without a request id, source or kind is not a request, so it
 * comes back null instead of being cast.
 */

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readPendingInputOption(value: unknown): PendingInputOption | null {
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
