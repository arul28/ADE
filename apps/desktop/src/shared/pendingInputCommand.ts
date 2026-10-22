import type { AgentChatApprovalDecision, PendingInputOption, PendingInputRequest } from "./types/chat";
import { buildAnswers, isQuestionKind, optionsForQuestion } from "./pendingInputAnswers";

/**
 * A pending question or approval written for an agent that answers it through
 * the CLI: what is asked, the numbered options, and the exact
 * `ade chat respond` commands that answer it.
 *
 * One owner for two readers: `ade chat pending --text` prints it, and the
 * brain sends it to a parent agent when its subagent blocks on a question.
 * The commands name the item id, so an answer can never land on a later
 * question the child asked in the meantime.
 */

const MAX_QUESTION_CHARS = 600;
const MAX_OPTION_CHARS = 200;
const MAX_OPTIONS = 12;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Questions answer with options or text; anything else (approvals, plans, permissions) is approved or denied. */
export function pendingInputIsAnswerable(request: Pick<PendingInputRequest, "kind">): boolean {
  return isQuestionKind(request.kind) || request.kind === "model_selection";
}

export function pendingInputItemId(request: Pick<PendingInputRequest, "itemId" | "requestId">): string {
  return request.itemId?.trim() || request.requestId;
}

export function describePendingInputForAgent(sessionId: string, request: PendingInputRequest): string {
  const itemId = pendingInputItemId(request);
  const base = `ade chat respond ${sessionId} --item ${itemId}`;
  const heading = clip(request.title?.trim() || request.description?.trim() || "Input requested", MAX_QUESTION_CHARS);
  const lines: string[] = [`Item ${itemId} (${request.kind}): ${heading}`];
  const answerable = pendingInputIsAnswerable(request);
  const questions = request.questions ?? [];

  if (!answerable) {
    const description = request.description?.trim();
    if (description && clip(description, MAX_QUESTION_CHARS) !== heading) {
      lines.push(`  ${clip(description, MAX_QUESTION_CHARS)}`);
    }
    lines.push("  (An approval is the person's to answer unless you were told you may approve.)");
    lines.push(`  Approve: ${base} --approve   (or --approve-session to allow it for the rest of the chat)`);
    lines.push(`  Deny:    ${base} --deny --text "<why>"`);
    return lines.join("\n");
  }

  // A question inherits the request's options (`optionsForQuestion`); only a
  // request with no questions at all (a model pick) lists them on their own.
  const topLevelOptions = questions.length === 0 ? request.options ?? [] : [];
  questions.forEach((question, index) => {
    const header = question.header?.trim() ? `[${clip(question.header, 80)}] ` : "";
    lines.push(`  ${index + 1}. ${header}${clip(question.question, MAX_QUESTION_CHARS)}`);
    if (question.isSecret) lines.push("     (secret: the person answers this one in the chat)");
    const options = optionsForQuestion(request, question, index);
    options.slice(0, MAX_OPTIONS).forEach((option, optionIndex) => {
      const description = option.description?.trim() ? ` — ${clip(option.description, MAX_OPTION_CHARS)}` : "";
      const recommended = option.recommended ? " (recommended)" : "";
      lines.push(`     ${optionIndex + 1}) ${clip(option.label, MAX_OPTION_CHARS)}${recommended}${description}`);
    });
    if (options.length > MAX_OPTIONS) lines.push(`     … ${options.length - MAX_OPTIONS} more`);
    if (question.multiSelect) lines.push("     (pick one or more: repeat --option)");
    if (question.allowsFreeform === false && options.length > 0) lines.push("     (pick an option; free text is not accepted)");
  });
  topLevelOptions.slice(0, MAX_OPTIONS).forEach((option, optionIndex) => {
    lines.push(`     ${optionIndex + 1}) ${clip(option.label, MAX_OPTION_CHARS)}`);
  });

  const firstHasOptions = (questions[0] ? optionsForQuestion(request, questions[0], 0).length > 0 : false)
    || topLevelOptions.length > 0;
  if (questions.length > 1) {
    const example = questions.map((_, index) => `--answer ${index + 1}=<option number or text>`).join(" ");
    lines.push(`  Answer:  ${base} ${example}`);
  } else if (firstHasOptions) {
    lines.push(`  Answer:  ${base} --option <number or label>   (add --text "<note>" to qualify it)`);
    if (questions[0]?.allowsFreeform !== false) lines.push(`           ${base} --text "<your own answer>"`);
  } else {
    lines.push(`  Answer:  ${base} --text "<your answer>"`);
  }
  lines.push(`  Decline: ${base} --deny`);
  return lines.join("\n");
}

/** What a caller said about a pending input: the `ade chat respond` flags. */
export type PendingInputResponseFlags = {
  /** The chat, named in error messages. */
  sessionId: string;
  /** `--item`: the input to answer. Without it the chat must have exactly one open. */
  itemId?: string | null;
  /** `--option`: picks for question 1 (number, value or label). */
  options?: readonly string[];
  /** `--answer <question>=<value>`: question by number from 1 or by id. */
  answers?: readonly string[];
  /** `--answers-json`: the raw answer map, merged last. */
  answersJson?: Record<string, string | string[]>;
  /** `--text`: a free answer, a note on the pick, or the reason for a decline. */
  text?: string | null;
  /** `--approve` / `--approve-session` / `--deny` / `--cancel`. */
  decision?: AgentChatApprovalDecision | null;
};

/** The `chat.respondToInput` arguments, less the session id. */
export type PendingInputResponse = {
  itemId: string;
  decision: AgentChatApprovalDecision;
  answers?: Record<string, string | string[]>;
  responseText?: string;
  kind?: string;
  title?: string;
};

/** `2`, `manual`, `Manual`: the option's value, or null. */
function matchPendingInputOption(raw: string, options: readonly PendingInputOption[]): string | null {
  const wanted = raw.trim().toLowerCase();
  if (!wanted) return null;
  const byIndex = /^\d+$/.test(wanted) ? options[Number(wanted) - 1] : undefined;
  const match = byIndex
    ?? options.find((option) => option.value.toLowerCase() === wanted)
    ?? options.find((option) => option.label.trim().toLowerCase() === wanted);
  return match?.value ?? null;
}

/**
 * Turn `ade chat respond` flags into the `chat.respondToInput` arguments, the
 * inverse of the commands {@link describePendingInputForAgent} prints.
 *
 * `requests` is what `chat.listPendingInputs` returned; `listed` is false when
 * that read failed (an older brain), in which case an explicit item is answered
 * as given. Throws an Error with a user-facing message on any bad input.
 */
export function resolvePendingInputResponse(
  requests: readonly PendingInputRequest[],
  listed: boolean,
  flags: PendingInputResponseFlags,
): PendingInputResponse {
  const { sessionId } = flags;
  const optionArgs = flags.options ?? [];
  const answerArgs = flags.answers ?? [];
  const requestedItemId = flags.itemId?.trim() || null;
  let request: PendingInputRequest | null = null;
  if (requestedItemId) {
    request = requests.find((entry) => pendingInputItemId(entry) === requestedItemId) ?? null;
  } else if (requests.length === 0) {
    throw new Error(`Chat ${sessionId} has no pending question or approval to answer.`);
  } else if (requests.length > 1) {
    throw new Error(
      `Chat ${sessionId} has ${requests.length} pending inputs; pick one with --item <id>:\n`
      + requests.map((entry) => `  ${pendingInputItemId(entry)}  ${entry.kind}  ${entry.title ?? entry.description ?? ""}`.trimEnd()).join("\n"),
    );
  } else {
    request = requests[0] ?? null;
  }
  if (requestedItemId && !request && listed && requests.length > 0) {
    throw new Error(
      `Chat ${sessionId} has no pending input ${requestedItemId}. Pending: ${requests.map(pendingInputItemId).join(", ")}`,
    );
  }
  const itemId = request ? pendingInputItemId(request) : requestedItemId!;
  const answerable = request ? pendingInputIsAnswerable(request) : true;
  const questions = request?.questions ?? [];
  const picksOrAnswers = optionArgs.length > 0 || answerArgs.length > 0;
  if (picksOrAnswers && !request) {
    throw new Error(`Could not read input ${itemId} on chat ${sessionId} to match --option/--answer; use --answers-json or --text.`);
  }
  if (picksOrAnswers && !answerable) {
    throw new Error(`Input ${itemId} is an approval, not a question: use --approve, --approve-session, or --deny.`);
  }
  let decision: AgentChatApprovalDecision;
  if (flags.decision) {
    decision = flags.decision;
  } else if (answerable) {
    decision = "accept";
  } else {
    throw new Error(
      `Input ${itemId} is an approval (${request?.title ?? request?.description ?? request?.kind}): add --approve, --approve-session, or --deny.`,
    );
  }

  const picksById: Record<string, string[]> = Object.create(null);
  const notesById: Record<string, string> = Object.create(null);
  let selection: string[] = [];
  const describeOptions = (options: readonly { label: string }[]): string =>
    options.map((option, index) => `${index + 1}) ${option.label}`).join(", ");
  const applyValue = (questionIndex: number, raw: string, mustMatch: boolean): void => {
    const question = questions[questionIndex];
    const options = question ? optionsForQuestion(request, question, questionIndex) : request?.options ?? [];
    const matched = matchPendingInputOption(raw, options);
    if (!question) {
      if (!matched) throw new Error(`"${raw}" matches no option. Options: ${describeOptions(options) || "(none)"}`);
      selection = [...selection, matched];
      return;
    }
    if (matched) {
      const picks = picksById[question.id] ?? [];
      picksById[question.id] = question.multiSelect ? [...picks, matched] : [matched];
      return;
    }
    if (mustMatch || question.allowsFreeform === false) {
      throw new Error(`"${raw}" matches no option of question ${questionIndex + 1}. Options: ${describeOptions(options) || "(none)"}`);
    }
    notesById[question.id] = notesById[question.id] ? `${notesById[question.id]}, ${raw.trim()}` : raw.trim();
  };
  for (const option of optionArgs) applyValue(0, option, true);
  for (const spec of answerArgs) {
    const separator = spec.indexOf("=");
    if (separator <= 0) throw new Error(`--answer takes <question>=<value>, for example --answer 1=2. Got "${spec}".`);
    const key = spec.slice(0, separator).trim();
    const value = spec.slice(separator + 1);
    const questionIndex = /^\d+$/.test(key) ? Number(key) - 1 : questions.findIndex((question) => question.id === key);
    if (questionIndex < 0 || questionIndex >= Math.max(questions.length, 1)) {
      throw new Error(`--answer ${key}: input ${itemId} has ${questions.length} question(s); number them from 1 or use a question id.`);
    }
    applyValue(questionIndex, value, false);
  }
  const answers: Record<string, string | string[]> = {
    ...buildAnswers(questions, picksById, notesById),
    ...(selection.length ? { selection: selection.length === 1 ? selection[0]! : selection } : {}),
    ...(flags.answersJson ?? {}),
  };
  const responseText = flags.text?.trim() ?? "";
  // A bare --text becomes the first question's answer, so it must be a
  // question that takes free text.
  const firstQuestion = questions[0];
  if (decision === "accept" && responseText && !Object.keys(answers).length && firstQuestion?.allowsFreeform === false) {
    const options = optionsForQuestion(request, firstQuestion, 0);
    throw new Error(`Question 1 takes an option, not free text. Pick one with --option. Options: ${describeOptions(options) || "(none)"}`);
  }
  return {
    itemId,
    decision,
    ...(Object.keys(answers).length ? { answers } : {}),
    ...(responseText ? { responseText } : {}),
    ...(request?.kind ? { kind: request.kind } : {}),
    ...(request?.title ? { title: request.title } : {}),
  };
}
