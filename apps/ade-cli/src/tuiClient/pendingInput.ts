import type {
  AgentChatEventEnvelope,
  PendingInputOption,
  PendingInputQuestion,
  PendingInputRequest,
} from "../../../desktop/src/shared/types/chat";
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
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event as Record<string, unknown> | undefined;
    if (!event) continue;
    if (event.type === "pending_input_resolved" && typeof event.itemId === "string") {
      resolved.add(event.itemId);
      continue;
    }
    if (!event || event.type !== "approval_request" || typeof event.itemId !== "string") continue;
    if (resolved.has(event.itemId)) continue;
    const request = requestFromApprovalEvent(event);
    const description = typeof event.description === "string" ? event.description : "Approve this tool request?";
    const mode = isApprovalMode(request) ? "approval" : "question";
    return {
      itemId: event.itemId,
      description,
      // Permission grants (write/network/external scope) keep the typed
      // high-stakes confirmation. Only plan_approval / model_selection were
      // intentionally relaxed to the one-key card.
      highStakes: mode === "approval" && (
        request?.kind === "permissions"
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

export function answerForQuestion(question: PendingInputQuestion, text: string): string | string[] {
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

export type PendingQuestionSelectionState = {
  itemId: string;
  activeQuestionIndex: number;
  answers: Record<string, string | string[]>;
  optionIndexByQuestionId: Record<string, number>;
  selectedValuesByQuestionId: Record<string, string[]>;
  pendingDigitSelection: {
    questionId: string;
    digit: string;
    previousOptionIndex: number;
    previousSelectedValues: string[];
  } | null;
};

export function optionsForPendingQuestion(
  request: PendingInputRequest | undefined,
  question: PendingInputQuestion | undefined,
  questionIndex: number,
): PendingInputOption[] {
  if (question?.options?.length) return question.options;
  // Only the first question inherits the request-level `options` fallback (the
  // legacy single-question shape); later questions must carry their own options.
  return questionIndex === 0 ? request?.options ?? [] : [];
}

function defaultOptionIndex(options: PendingInputOption[]): number {
  if (!options.length) return -1;
  const recommendedIndex = options.findIndex((option) => option.recommended);
  return recommendedIndex >= 0 ? recommendedIndex : 0;
}

export function createPendingQuestionSelectionState(
  approval: PendingApproval,
): PendingQuestionSelectionState | null {
  if (approval.mode !== "question") return null;
  const request = approval.request;
  const questions = request?.questions ?? [];
  if (!questions.length) return null;
  const optionIndexByQuestionId: Record<string, number> = {};
  questions.forEach((question, index) => {
    optionIndexByQuestionId[question.id] = defaultOptionIndex(optionsForPendingQuestion(request, question, index));
  });
  return {
    itemId: approval.itemId,
    activeQuestionIndex: 0,
    answers: {},
    optionIndexByQuestionId,
    selectedValuesByQuestionId: {},
    pendingDigitSelection: null,
  };
}

export function ensurePendingQuestionSelectionState(
  approval: PendingApproval | null,
  previous: PendingQuestionSelectionState | null,
): PendingQuestionSelectionState | null {
  if (!approval || approval.mode !== "question") return null;
  if (previous?.itemId === approval.itemId) {
    return {
      ...previous,
      selectedValuesByQuestionId: previous.selectedValuesByQuestionId ?? {},
      pendingDigitSelection: previous.pendingDigitSelection ?? null,
    };
  }
  return createPendingQuestionSelectionState(approval);
}

export function pendingQuestionAnsweredCount(
  request: PendingInputRequest | undefined,
  answers: Record<string, string | string[]>,
): number {
  return (request?.questions ?? []).filter((question) => Object.prototype.hasOwnProperty.call(answers, question.id)).length;
}

export function pendingQuestionSelectionValue(
  request: PendingInputRequest | undefined,
  state: PendingQuestionSelectionState,
  questionIndex = state.activeQuestionIndex,
): string | string[] | null {
  const question = request?.questions?.[questionIndex];
  if (!question) return null;
  const options = optionsForPendingQuestion(request, question, questionIndex);
  if (question.multiSelect) {
    const selectedValues = state.selectedValuesByQuestionId[question.id] ?? [];
    return selectedValues.length ? selectedValues : null;
  }
  const selectedIndex = state.optionIndexByQuestionId[question.id] ?? defaultOptionIndex(options);
  const option = options[selectedIndex] ?? null;
  return option?.value ?? question.defaultAssumption ?? null;
}

export function setPendingQuestionOptionIndex(
  request: PendingInputRequest | undefined,
  state: PendingQuestionSelectionState,
  optionIndex: number,
): PendingQuestionSelectionState {
  const questions = request?.questions ?? [];
  const question = questions[state.activeQuestionIndex];
  if (!question) return state;
  const options = optionsForPendingQuestion(request, question, state.activeQuestionIndex);
  if (!options.length) return state;
  const clamped = Math.max(0, Math.min(options.length - 1, optionIndex));
  return {
    ...clearPendingQuestionDigitSelection(state),
    optionIndexByQuestionId: {
      ...state.optionIndexByQuestionId,
      [question.id]: clamped,
    },
  };
}

export function selectPendingQuestionOptionIndex(
  request: PendingInputRequest | undefined,
  state: PendingQuestionSelectionState,
  optionIndex: number,
): PendingQuestionSelectionState {
  const highlighted = setPendingQuestionOptionIndex(request, state, optionIndex);
  const questions = request?.questions ?? [];
  const question = questions[state.activeQuestionIndex];
  if (!question?.multiSelect) return highlighted;
  const options = optionsForPendingQuestion(request, question, state.activeQuestionIndex);
  const clamped = Math.max(0, Math.min(options.length - 1, optionIndex));
  const option = options[clamped];
  if (!option) return highlighted;
  const current = highlighted.selectedValuesByQuestionId[question.id] ?? [];
  const toggled = current.includes(option.value)
    ? current.filter((value) => value !== option.value)
    : [...current, option.value];
  const ordered = options.map((entry) => entry.value).filter((value) => toggled.includes(value));
  return {
    ...highlighted,
    selectedValuesByQuestionId: {
      ...highlighted.selectedValuesByQuestionId,
      [question.id]: ordered,
    },
  };
}

export function selectPendingQuestionDigit(
  request: PendingInputRequest | undefined,
  state: PendingQuestionSelectionState,
  digit: string,
): { state: PendingQuestionSelectionState; selected: boolean } {
  if (!/^[1-9]$/.test(digit)) return { state, selected: false };
  const questions = request?.questions ?? [];
  const question = questions[state.activeQuestionIndex];
  if (!question) return { state, selected: false };
  const options = optionsForPendingQuestion(request, question, state.activeQuestionIndex);
  const optionIndex = Number(digit) - 1;
  if (!options[optionIndex]) return { state, selected: false };
  const baseline = restorePendingQuestionDigitSelection(state);
  const previousOptionIndex = baseline.optionIndexByQuestionId[question.id] ?? defaultOptionIndex(options);
  const previousSelectedValues = [...(baseline.selectedValuesByQuestionId[question.id] ?? [])];
  const next = question.multiSelect
    ? selectPendingQuestionOptionIndex(request, baseline, optionIndex)
    : setPendingQuestionOptionIndex(request, baseline, optionIndex);
  return {
    selected: true,
    state: {
      ...next,
      pendingDigitSelection: {
        questionId: question.id,
        digit,
        previousOptionIndex,
        previousSelectedValues,
      },
    },
  };
}

export function convertPendingQuestionDigitSelectionToText(
  request: PendingInputRequest | undefined,
  state: PendingQuestionSelectionState,
  suffix: string,
): { state: PendingQuestionSelectionState; text: string } | null {
  const pending = state.pendingDigitSelection;
  if (!pending || suffix.length === 0) return null;
  const question = request?.questions?.[state.activeQuestionIndex];
  if (!question || question.id !== pending.questionId) return null;
  return {
    state: restorePendingQuestionDigitSelection(state),
    text: `${pending.digit}${suffix}`,
  };
}

export function movePendingQuestionOption(
  request: PendingInputRequest | undefined,
  state: PendingQuestionSelectionState,
  delta: number,
): PendingQuestionSelectionState {
  const questions = request?.questions ?? [];
  const question = questions[state.activeQuestionIndex];
  if (!question) return state;
  const options = optionsForPendingQuestion(request, question, state.activeQuestionIndex);
  if (!options.length) return state;
  const current = state.optionIndexByQuestionId[question.id] ?? defaultOptionIndex(options);
  const next = (current + delta + options.length) % options.length;
  return setPendingQuestionOptionIndex(request, state, next);
}

export function movePendingQuestionFocus(
  request: PendingInputRequest | undefined,
  state: PendingQuestionSelectionState,
  delta: number,
): PendingQuestionSelectionState {
  const count = request?.questions?.length ?? 0;
  if (count <= 0) return state;
  return {
    ...clearPendingQuestionDigitSelection(state),
    activeQuestionIndex: (state.activeQuestionIndex + delta + count) % count,
  };
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

function clearPendingQuestionDigitSelection(state: PendingQuestionSelectionState): PendingQuestionSelectionState {
  return state.pendingDigitSelection ? { ...state, pendingDigitSelection: null } : state;
}

function restorePendingQuestionDigitSelection(state: PendingQuestionSelectionState): PendingQuestionSelectionState {
  const pending = state.pendingDigitSelection;
  if (!pending) return state;
  const optionIndexByQuestionId = { ...state.optionIndexByQuestionId };
  if (pending.previousOptionIndex >= 0) {
    optionIndexByQuestionId[pending.questionId] = pending.previousOptionIndex;
  } else {
    delete optionIndexByQuestionId[pending.questionId];
  }
  const selectedValuesByQuestionId = { ...state.selectedValuesByQuestionId };
  if (pending.previousSelectedValues.length > 0) {
    selectedValuesByQuestionId[pending.questionId] = pending.previousSelectedValues;
  } else {
    delete selectedValuesByQuestionId[pending.questionId];
  }
  return {
    ...state,
    optionIndexByQuestionId,
    selectedValuesByQuestionId,
    pendingDigitSelection: null,
  };
}
