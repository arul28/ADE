import type { PendingInputRequest } from "./types/chat";
import { isQuestionKind, optionsForQuestion } from "./pendingInputAnswers";

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
    lines.push(`           ${base} --text "<your own answer>"`);
  } else {
    lines.push(`  Answer:  ${base} --text "<your answer>"`);
  }
  lines.push(`  Decline: ${base} --deny`);
  return lines.join("\n");
}
