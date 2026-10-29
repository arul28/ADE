import type { PendingInputRequest } from "../../desktop/src/shared/types/chat";
import { optionsForQuestion } from "../../desktop/src/shared/pendingInputAnswers";
import { pendingInputIsAnswerable, pendingInputItemId } from "../../desktop/src/shared/pendingInputCommand";
import { isChatToolType } from "../../desktop/src/shared/sessionSpawnNesting";
import { buildDeeplink } from "../../desktop/src/shared/deeplinks";
import {
  actionStep,
  asString,
  firstArray,
  isRecord,
  unwrapActionEnvelope,
  type CliPlan,
  type InvocationStep,
  type JsonObject,
} from "./cli";

/**
 * `ade chat inbox`: every chat in the project that waits on the person, each
 * with what it asks inline — the question and its options, or what it wants
 * approved — and the exact `ade chat respond` that answers it.
 *
 * Composed from reads the brain already has: `session.list` (the Work rows,
 * which carry the needs-you signals) and `chat.listPendingInputs` for each
 * chat that waits on a card. A chat that raised its hand with `ade chat ask`
 * has no card; it is answered with `ade chat send`.
 */

/** Chats whose cards are read inline; the rest list without details. */
const MAX_DETAILED_CHATS = 12;
const MAX_TEXT_CHARS = 600;
const MAX_OPTIONS = 12;

type ChatInboxKind = "question" | "approval" | "plan" | "ask";

export type ChatInboxQuestion = {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string; recommended?: true }>;
  multiSelect?: true;
  /** Only an option is accepted, no free text. */
  optionsOnly?: true;
  /** A secret: the person answers it in ADE. */
  secret?: true;
};

/**
 * One thing a chat waits on. `requestId` is what `ade chat respond --item`
 * takes; it is null for an `ask` (answered with `ade chat send`) and for a card
 * ADE can no longer read (its runtime restarted).
 */
export type ChatInboxItem = {
  sessionId: string;
  title: string | null;
  laneId: string;
  lane: string | null;
  model: string | null;
  kind: ChatInboxKind;
  requestId: string | null;
  /** What is asked, or what wants approval. */
  text: string;
  /** More about an approval (the command, the plan). */
  detail?: string;
  questions?: ChatInboxQuestion[];
  /** When it started waiting (ISO), when known. */
  since: string | null;
  /** The exact commands that answer it; `<…>` marks a value to fill in. */
  respond: string[];
  link: string;
};

function clip(text: string, max = MAX_TEXT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function inboxKind(request: Pick<PendingInputRequest, "kind">): ChatInboxKind {
  if (request.kind === "plan_approval") return "plan";
  return pendingInputIsAnswerable(request) ? "question" : "approval";
}

/** The Work rows that wait on the person: a card, or an `ade chat ask`. */
function waitingChats(values: JsonObject): JsonObject[] {
  return firstArray(unwrapActionEnvelope(values.sessions), ["sessions", "items"])
    .filter((row) => isChatToolType(asString(row.toolType)) && !asString(row.archivedAt))
    .filter((row) => Boolean(asString(row.pendingInputItemId) || asString(row.attentionRequestedAt)
      || row.attentionSource === "provider_structured"))
    .sort((a, b) => sinceOf(b).localeCompare(sinceOf(a)));
}

function sinceOf(row: JsonObject): string {
  return asString(row.attentionRequestedAt) ?? asString(row.lastActivityAt) ?? "";
}

/** Chats waiting on a card, in the order their `pending<i>` steps read them. */
function chatsWithCards(values: JsonObject): JsonObject[] {
  return waitingChats(values)
    .filter((row) => asString(row.pendingInputItemId) || row.attentionSource === "provider_structured")
    .slice(0, MAX_DETAILED_CHATS);
}

function questionsOf(request: PendingInputRequest): ChatInboxQuestion[] {
  const toOptions = (options: readonly { label: string; description?: string; recommended?: boolean }[]) =>
    options.slice(0, MAX_OPTIONS).map((option) => ({
      label: clip(option.label, 200),
      ...(option.description?.trim() ? { description: clip(option.description, 200) } : {}),
      ...(option.recommended ? { recommended: true as const } : {}),
    }));
  const questions = request.questions ?? [];
  if (questions.length === 0) {
    const options = request.options ?? [];
    return options.length
      ? [{ id: "selection", question: clip(request.title ?? request.description ?? "Pick one"), options: toOptions(options) }]
      : [];
  }
  return questions.map((question, index) => {
    const options = optionsForQuestion(request, question, index);
    return {
      id: question.id,
      question: clip(question.question),
      ...(question.header?.trim() ? { header: clip(question.header, 80) } : {}),
      ...(options.length ? { options: toOptions(options) } : {}),
      ...(question.multiSelect ? { multiSelect: true as const } : {}),
      ...(question.allowsFreeform === false && options.length ? { optionsOnly: true as const } : {}),
      ...(question.isSecret ? { secret: true as const } : {}),
    };
  });
}

function respondCommands(sessionId: string, itemId: string, kind: ChatInboxKind, questions: ChatInboxQuestion[]): string[] {
  const base = `ade chat respond ${sessionId} --item ${itemId}`;
  if (kind !== "question") {
    return [`${base} --approve`, `${base} --approve-session`, `${base} --deny --text "<why>"`];
  }
  if (questions.length > 1) {
    return [`${base} ${questions.map((_, index) => `--answer ${index + 1}=<option number or text>`).join(" ")}`];
  }
  const first = questions[0];
  if (first?.options?.length) {
    return [`${base} --option <number or label>`, ...(first.optionsOnly ? [] : [`${base} --text "<answer>"`])];
  }
  return [`${base} --text "<answer>"`];
}

/** A pending-input row as the brain sends it, with the fields this reads. */
function isPendingInputRequest(row: JsonObject): row is JsonObject & PendingInputRequest {
  return typeof row.requestId === "string" && typeof row.kind === "string";
}

/** An inbox item, from this computer or merged from another. */
function isInboxItem(row: JsonObject): row is JsonObject & ChatInboxItem {
  return typeof row.sessionId === "string" && typeof row.kind === "string" && typeof row.text === "string"
    && Array.isArray(row.respond);
}

function chatLink(sessionId: string, laneId: string): string {
  return buildDeeplink({ kind: "session", sessionId, ...(laneId ? { laneId } : {}) });
}

/** The result of `ade chat inbox`, from its steps' values. */
function chatInboxFromValues(values: JsonObject): { items: ChatInboxItem[] } {
  const detailed = chatsWithCards(values);
  const items: ChatInboxItem[] = [];
  for (const row of waitingChats(values)) {
    const sessionId = asString(row.id) ?? "";
    const laneId = asString(row.laneId) ?? "";
    const chat = {
      sessionId,
      title: asString(row.title),
      laneId,
      lane: asString(row.laneName),
      model: asString(row.model),
    };
    const link = chatLink(sessionId, laneId);
    const since = asString(row.attentionRequestedAt) ?? asString(row.lastActivityAt);
    const index = detailed.indexOf(row);
    const listed = index >= 0 ? unwrapActionEnvelope(values[`pending${index}`]) : null;
    const requests = isRecord(listed) && listed.ok !== false
      ? firstArray(listed, ["requests"]).filter(isPendingInputRequest)
      : [];
    for (const request of requests) {
      const requestId = pendingInputItemId(request);
      const kind = inboxKind(request);
      const questions = questionsOf(request);
      const heading = request.title?.trim() || request.description?.trim()
        || questions[0]?.question || "Input requested";
      const description = request.description?.trim();
      items.push({
        ...chat,
        kind,
        requestId,
        text: clip(heading),
        ...(kind !== "question" && description && clip(description) !== clip(heading) ? { detail: clip(description) } : {}),
        ...(kind === "question" && questions.length ? { questions } : {}),
        since,
        respond: respondCommands(sessionId, requestId, kind, questions),
        link,
      });
    }
    if (requests.length) continue;
    const itemId = asString(row.pendingInputItemId);
    const message = asString(row.attentionMessage);
    if (itemId) {
      // The card is there but ADE could not read it (more chats than it reads
      // inline, or a runtime that restarted under it).
      items.push({
        ...chat,
        kind: "question",
        requestId: itemId,
        text: message ? clip(message) : `Waiting on an answer. See it with: ade chat pending ${sessionId} --text`,
        since,
        respond: [`ade chat respond ${sessionId} --item ${itemId} --text "<answer>"`],
        link,
      });
      continue;
    }
    items.push({
      ...chat,
      kind: "ask",
      requestId: null,
      text: message ? clip(message) : "The chat asked for you.",
      since,
      respond: [`ade chat send ${sessionId} --text "<answer>"`],
      link,
    });
  }
  return { items };
}

export function buildChatInboxPlan(): CliPlan {
  const pendingSteps: InvocationStep[] = Array.from({ length: MAX_DETAILED_CHATS }, (_, index) => ({
    key: `pending${index}`,
    method: "ade/actions/call",
    unwrapToolResult: true,
    optional: true,
    skipWhen: (values) => !chatsWithCards(values)[index],
    params: (values) => ({
      name: "run_ade_action",
      arguments: { domain: "chat", action: "listPendingInputs", args: { sessionId: asString(chatsWithCards(values)[index]?.id) ?? "" } },
    }),
  }));
  return {
    kind: "execute",
    label: "chat inbox",
    machineList: "inbox",
    steps: [
      actionStep("sessions", "session", "list", { includeArchived: false, limit: 500, settledLimit: 50 }),
      ...pendingSteps,
    ],
    shapeResult: chatInboxFromValues,
    formatText: formatChatInbox,
  };
}

function ago(iso: string | null): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** `--text`: one block per item, grouped under its chat. Rows merged from other machines lead with the machine. */
function formatChatInbox(value: unknown): string {
  const rows = firstArray(value, ["items"]);
  const unavailable = rows.filter((row) => asString(row.unavailable));
  const items = rows.filter((row) => !asString(row.unavailable)).filter(isInboxItem);
  const lines: string[] = [];
  if (items.length === 0) lines.push("Nothing needs you.");
  else lines.push(`${items.length === 1 ? "1 thing needs" : `${items.length} things need`} you:`);
  for (const item of items) {
    const machine = asString(item.machine);
    const heading = [
      machine,
      item.title ?? "Untitled chat",
      item.lane ? `lane ${item.lane}` : null,
      item.model,
      ago(item.since),
    ].filter(Boolean).join(" · ");
    lines.push("", heading, `  ${item.kind} · chat ${item.sessionId}${item.requestId ? ` · request ${item.requestId}` : ""}`);
    lines.push(`  ${item.text}`);
    if (item.detail) lines.push(`  ${item.detail}`);
    (item.questions ?? []).forEach((question, index) => {
      if ((item.questions?.length ?? 0) > 1 || question.question !== item.text) {
        lines.push(`  ${index + 1}. ${question.header ? `[${question.header}] ` : ""}${question.question}`);
      }
      if (question.secret) lines.push("     (secret: answer it in ADE)");
      question.options?.forEach((option, optionIndex) => {
        lines.push(`     ${optionIndex + 1}) ${option.label}${option.recommended ? " (recommended)" : ""}${option.description ? ` — ${option.description}` : ""}`);
      });
      if (question.multiSelect) lines.push("     (one or more: repeat --option)");
    });
    for (const command of item.respond) lines.push(`  $ ${command}`);
  }
  for (const row of unavailable) lines.push("", `${asString(row.machine) ?? "machine"}: ${asString(row.unavailable)}`);
  return lines.join("\n");
}
