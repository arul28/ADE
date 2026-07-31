import type { PendingInputQuestion } from "./types/chat";

/**
 * The answer semantics for a pending-input question, shared by every surface
 * that renders one.
 *
 * One data model (`PendingInputRequest`) used to have four renderers that
 * disagreed about what an answer *is*: desktop sent the selection and the typed
 * text as an array, the TUI let the typed text *replace* the selection, and iOS
 * dropped the typed text entirely once more than one question was in play. No
 * provider forces any of that — Claude's `question.reply` takes
 * `answers: string[][]`, ADE's own `askUser` tool returns free-form JSON, and
 * Droid takes a single string ADE joins itself. The divergence was ours.
 *
 * This module is the contract. The desktop renderer (and therefore the web
 * client, which shares the component) and the `ade code` TUI import it
 * directly; iOS mirrors it in Swift the way `workChatPendingInputHeaderVerb`
 * already mirrors `pendingInputLabels`.
 *
 * The rules, all surfaces:
 *
 * 1. Both travel. A note never replaces a selection; a selection never clears
 *    a note.
 * 2. Typing never deselects. Selecting never clears the note.
 * 3. Selection values come first, note last, so a model reads the choice
 *    before the qualification.
 * 4. The Send label is the payload receipt — derived from the state and
 *    nothing else. If the label and the payload can disagree, the
 *    implementation is wrong.
 */

/**
 * The four legible answer states for a single question.
 *
 *   EMPTY      nothing picked, no note   → Send disabled
 *   PICK       option(s) picked          → "Send 1"  ·  "Send 3 picks"
 *   PICK_NOTE  option(s) + note          → "Send 1 + note"  ·  "Send 3 + note"
 *   NOTE       note only, no pick        → "Send note"
 */
export type AnswerState = "EMPTY" | "PICK" | "PICK_NOTE" | "NOTE";

export function answerState(picks: readonly string[], note: string): AnswerState {
  const hasPick = picks.length > 0;
  const hasNote = note.trim().length > 0;
  if (hasPick && hasNote) return "PICK_NOTE";
  if (hasPick) return "PICK";
  if (hasNote) return "NOTE";
  return "EMPTY";
}

/**
 * The Send/Next button label. Derived from `answerState` and the paging
 * position only — never from anything the payload builder does not also see,
 * so the button literally reads back what pressing it will send.
 */
export function sendLabel(args: {
  picks: readonly string[];
  note: string;
  isLast: boolean;
  totalAnswered: number;
  totalQuestions: number;
}): string {
  const { picks, note, isLast, totalAnswered, totalQuestions } = args;
  if (!isLast) return "Next";
  const state = answerState(picks, note);
  if (totalQuestions > 1) {
    return state === "EMPTY" ? "Send" : `Send ${totalAnswered} answers`;
  }
  switch (state) {
    case "PICK":
      return picks.length > 1 ? `Send ${picks.length} picks` : "Send 1";
    case "PICK_NOTE":
      return picks.length > 1 ? `Send ${picks.length} + note` : "Send 1 + note";
    case "NOTE":
      return "Send note";
    default:
      return "Send";
  }
}

/**
 * The payload for `chat.respondToInput`. One shape, four surfaces.
 *
 * Selection values come first and the note last, so a model reading the array
 * sees the choice before the qualification. A question with neither a pick nor
 * a note contributes no key at all rather than an empty string, so
 * "unanswered" stays distinguishable from "answered with nothing".
 */
export function buildAnswers(
  questions: readonly PendingInputQuestion[],
  picksById: Readonly<Record<string, readonly string[]>>,
  notesById: Readonly<Record<string, string>>,
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const values = [...(picksById[question.id] ?? [])].filter((value) => value.length > 0);
    const note = (notesById[question.id] ?? "").trim();
    if (note.length) values.push(note);
    if (values.length === 1) answers[question.id] = values[0]!;
    else if (values.length > 1) answers[question.id] = values;
  }
  return answers;
}

/**
 * Placeholder for the note row, derived from whether a pick exists.
 *
 * This is the user-visible half of the "what actually gets sent" fix: the field
 * is an ANSWER when nothing is picked and a QUALIFIER once something is. One
 * string change makes the two jobs legible without a mode switch or a disabled
 * state.
 */
export function notePlaceholder(args: {
  hasOptions: boolean;
  picks: readonly string[];
  multi: boolean;
}): string {
  const { hasOptions, picks, multi } = args;
  if (!hasOptions) return "Your answer";
  if (picks.length === 0) return "Or send your own response instead";
  if (multi && picks.length > 1) return `Add a note (sent with your ${picks.length} picks)`;
  return "Add a note (sent with your pick)";
}

/**
 * The one-line summary shown when the card is folded into the prompt box.
 * Minimize does not dismiss and does not unblock — the gate stays open, the
 * card just collapses so the transcript gets the screen back.
 */
export function foldedSummary(
  question: PendingInputQuestion | null | undefined,
  page: number,
): { label: string; text: string } {
  const label = question?.header?.trim() || `Question ${page + 1}`;
  return { label, text: question?.question ?? "" };
}

/** How many of a request's questions carry a pick or a note. */
export function answeredQuestionCount(
  questions: readonly PendingInputQuestion[],
  picksById: Readonly<Record<string, readonly string[]>>,
  notesById: Readonly<Record<string, string>>,
): number {
  return questions.filter((question) => (
    (picksById[question.id]?.length ?? 0) > 0
    || (notesById[question.id] ?? "").trim().length > 0
  )).length;
}

/**
 * Marker substituted for an `isSecret` question's answer before the resolution
 * event is persisted. `pending_input_resolved` replicates to every paired
 * device and lands in the widget's shared App Group container, so a credential
 * typed into a secret question must never reach it — iOS already refuses to
 * write those even to local draft storage.
 */
export const SECRET_ANSWER_PLACEHOLDER = "__ade_secret__";

/**
 * Budget for the answers carried on a persisted resolution event. Chat events
 * ride the shared desktop↔brain socket, where one oversized response has
 * previously taken the whole connection down; the receipt only needs enough
 * text to read back what was sent.
 */
export const RESOLVED_ANSWERS_MAX_BYTES = 2048;

export const TRUNCATED_ANSWER_MARKER = "…(truncated)";

function truncateAnswerValue(value: string, budget: number): string {
  if (budget <= TRUNCATED_ANSWER_MARKER.length) return TRUNCATED_ANSWER_MARKER;
  if (value.length <= budget) return value;
  return `${value.slice(0, budget - TRUNCATED_ANSWER_MARKER.length)}${TRUNCATED_ANSWER_MARKER}`;
}

/**
 * Prepare an answer payload for persistence on `pending_input_resolved`.
 *
 * Two hard rules, both about the fact that this event is durable *and* synced:
 *
 * - Answers to `isSecret` questions are never written. The key is dropped
 *   entirely and the receipt renders "answer hidden" from the question's own
 *   `isSecret` flag, so nothing about the value survives.
 * - The whole payload is capped at {@link RESOLVED_ANSWERS_MAX_BYTES}, longest
 *   value truncated first with a visible marker. The answer the model received
 *   is unaffected; only the transcript copy is bounded.
 */
export function sanitizeAnswersForTranscript(
  questions: readonly PendingInputQuestion[],
  answers: Readonly<Record<string, string | string[]>> | null | undefined,
): Record<string, string | string[]> | undefined {
  if (!answers) return undefined;
  const secretIds = new Set(
    questions.filter((question) => question.isSecret === true).map((question) => question.id),
  );
  const kept: Array<[string, string | string[]]> = [];
  for (const [id, value] of Object.entries(answers)) {
    if (secretIds.has(id)) continue;
    if (Array.isArray(value)) {
      const entries = value.filter((entry): entry is string => typeof entry === "string");
      if (entries.length) kept.push([id, entries]);
      continue;
    }
    if (typeof value === "string" && value.length) kept.push([id, value]);
  }
  if (!kept.length) return undefined;

  const result: Record<string, string | string[]> = Object.fromEntries(kept);
  if (JSON.stringify(result).length <= RESOLVED_ANSWERS_MAX_BYTES) return result;

  // Over budget: shrink the largest values until it fits. Every question keeps
  // a key — a receipt that silently loses a whole answer is worse than one that
  // shows a truncated one.
  const perValueBudget = Math.max(
    TRUNCATED_ANSWER_MARKER.length,
    Math.floor(RESOLVED_ANSWERS_MAX_BYTES / Math.max(1, kept.length)) - 32,
  );
  for (const [id, value] of kept) {
    result[id] = Array.isArray(value)
      ? value.map((entry) => truncateAnswerValue(entry, Math.max(TRUNCATED_ANSWER_MARKER.length, Math.floor(perValueBudget / value.length))))
      : truncateAnswerValue(value, perValueBudget);
  }
  return result;
}

/** Flatten one question's answer into the display string used by the receipt. */
export function answerDisplayText(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.filter(Boolean).join(" · ");
  return value ?? "";
}
