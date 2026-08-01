import type { PendingInputOption, PendingInputQuestion } from "./types/chat";

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
 * Is this request the one the ask-question composer owns?
 *
 * Canonical because the decision is made in two places that must agree: the
 * composer decides whether to take the prompt box over, and the transcript
 * decides whether to render a receipt instead of a control. If those two copies
 * ever drift the user gets two question UIs or none.
 */
export function isAskQuestionRequest(
  request: { kind?: string | null } | null | undefined,
): boolean {
  return request?.kind === "question" || request?.kind === "structured_question";
}

/**
 * Options offered for a question at `questionIndex`.
 *
 * Only the first question inherits the request-level `options` fallback — that
 * is the legacy single-question shape, and a later question must carry its own.
 * One rule, one place, because getting it wrong silently shows question 2 the
 * options belonging to question 1.
 */
export function optionsForQuestion(
  request: { options?: readonly PendingInputOption[] | null } | null | undefined,
  question: PendingInputQuestion | null | undefined,
  questionIndex: number,
): readonly PendingInputOption[] {
  if (question?.options?.length) return question.options;
  return questionIndex === 0 ? request?.options ?? [] : [];
}

/** Read a provider-keyed record without inheriting Object prototype members. */
export function ownQuestionValue<T>(
  record: Readonly<Record<string, T>> | null | undefined,
  questionId: string,
): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, questionId)
    ? record[questionId]
    : undefined;
}

/**
 * Split a stored answer back into the option labels that were picked and the
 * free text typed alongside them.
 *
 * The inverse of {@link buildAnswers}: values matching an offered option are
 * picks, anything else is the note, which is exactly the ordering `buildAnswers`
 * guarantees.
 *
 * Returns both forms deliberately. A receipt renders `pickLabels` for a human;
 * anything travelling back to a provider must use `picks`, the option values the
 * model itself declared.
 */
export function splitAnswer(
  question: { options?: readonly PendingInputOption[] | null },
  value: string | readonly string[] | undefined,
): { picks: string[]; pickLabels: string[]; note: string } {
  const values = Array.isArray(value) ? value : value ? [value as string] : [];
  const byValue = new Map((question.options ?? []).map((option) => [option.value, option.label]));
  const picks: string[] = [];
  const pickLabels: string[] = [];
  const notes: string[] = [];
  for (const entry of values) {
    const label = byValue.get(entry);
    if (label != null) {
      picks.push(entry);
      pickLabels.push(label);
    } else {
      notes.push(entry);
    }
  }
  return { picks, pickLabels, note: notes.join(" ") };
}

/** Split an answer using the same legacy request-level option fallback as the composer. */
export function splitAnswerForQuestion(
  request: { options?: readonly PendingInputOption[] | null } | null | undefined,
  question: PendingInputQuestion,
  questionIndex: number,
  value: string | readonly string[] | undefined,
): { picks: string[]; pickLabels: string[]; note: string } {
  return splitAnswer({ options: optionsForQuestion(request, question, questionIndex) }, value);
}

/**
 * The four legible answer states for a single question.
 *
 *   EMPTY      nothing picked, no note   → Send disabled
 *   PICK       option(s) picked          → "Send 1"  ·  "Send 3 picks"
 *   PICK_NOTE  option(s) + note          → "Send 1 + note"  ·  "Send 3 + note"
 *   NOTE       note only, no pick        → "Send note"
 */
type AnswerState = "EMPTY" | "PICK" | "PICK_NOTE" | "NOTE";

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
  const entries: Array<[string, string | string[]]> = [];
  for (const question of questions) {
    const values = [...(ownQuestionValue(picksById, question.id) ?? [])].filter((value) => value.length > 0);
    const note = (ownQuestionValue(notesById, question.id) ?? "").trim();
    if (note.length) values.push(note);
    if (values.length === 1) entries.push([question.id, values[0]!]);
    else if (values.length > 1) entries.push([question.id, values]);
  }
  // Object.fromEntries defines own data properties even for "__proto__";
  // direct assignment would invoke Object.prototype's legacy setter and lose
  // the answer from JSON serialization.
  return Object.fromEntries(entries);
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

/**
 * Does this question carry an answer? Canonical so desktop and the TUI cannot
 * disagree about "2 of 3 answered" — they previously used two structurally
 * different predicates for the same sentence.
 */
export function isQuestionAnswered(picks: readonly string[], note: string): boolean {
  return answerState(picks, note) !== "EMPTY";
}

/** Does a stored wire answer carry a pick or note? */
export function isStoredQuestionAnswered(
  question: { options?: readonly PendingInputOption[] | null },
  value: string | readonly string[] | undefined,
): boolean {
  const { picks, note } = splitAnswer(question, value);
  return isQuestionAnswered(picks, note);
}

/** How many of a request's questions carry a pick or a note. */
export function answeredQuestionCount(
  questions: readonly PendingInputQuestion[],
  picksById: Readonly<Record<string, readonly string[]>>,
  notesById: Readonly<Record<string, string>>,
): number {
  return questions.filter((question) => isQuestionAnswered(
    ownQuestionValue(picksById, question.id) ?? [],
    ownQuestionValue(notesById, question.id) ?? "",
  )).length;
}

/**
 * Byte budget for the answers carried on a persisted resolution event. Chat
 * events ride the shared desktop↔brain socket, where one oversized response has
 * previously taken the whole connection down; the receipt only needs enough
 * text to read back what was sent.
 *
 * This is a hard ceiling on the **serialized UTF-8 size** of the answers object,
 * keys included. It is not a character count: a CJK character is three bytes and
 * an emoji four, so measuring `String.length` under-counts by up to 4x — which
 * is how a nominal "2 KB" cap silently persisted 6 KB.
 */
export const RESOLVED_ANSWERS_MAX_BYTES = 2048;

export const TRUNCATED_ANSWER_MARKER = "…(truncated)";

const textEncoder = new TextEncoder();

function utf8Length(value: string): number {
  return textEncoder.encode(value).length;
}

/** Serialized UTF-8 size of an answers object, keys and JSON punctuation included. */
function serializedByteLength(value: Record<string, string | string[]>): number {
  return utf8Length(JSON.stringify(value));
}

/**
 * Cut a string to at most `budget` UTF-8 bytes, leaving room for the marker.
 *
 * Iterates by code point rather than code unit so a surrogate pair (emoji,
 * astral CJK) is never split into a lone surrogate — which would serialize to a
 * replacement character and corrupt the answer it was meant to preserve.
 */
function codePointBytes(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

function truncateToBytes(value: string, budget: number): string {
  if (utf8Length(value) <= budget) return value;
  const markerBytes = utf8Length(TRUNCATED_ANSWER_MARKER);
  if (budget <= markerBytes) return TRUNCATED_ANSWER_MARKER;
  const room = budget - markerBytes;
  let used = 0;
  let end = 0;
  // Walk code points (not code units) so a surrogate pair is never split, and
  // size them arithmetically rather than re-encoding each one — this runs over
  // whole pasted answers, so a TextEncoder call per character is not free.
  for (const codePoint of value) {
    const size = codePointBytes(codePoint.codePointAt(0)!);
    if (used + size > room) break;
    used += size;
    end += codePoint.length;
  }
  return `${value.slice(0, end)}${TRUNCATED_ANSWER_MARKER}`;
}

/**
 * Prepare an answer payload for persistence on `pending_input_resolved`.
 *
 * Two hard rules, both about the fact that this event is durable *and* synced:
 *
 * - Answers to `isSecret` questions are never written. The key is dropped
 *   entirely and the receipt renders "answer hidden" from the question's own
 *   `isSecret` flag, so nothing about the value survives.
 * - The whole payload is capped at {@link RESOLVED_ANSWERS_MAX_BYTES} real
 *   UTF-8 bytes, keys included, and the result is re-measured before it is
 *   returned. The answer the model received is unaffected; only the transcript
 *   copy is bounded.
 *
 * Question ids come from the model, so a pathological key can exceed the whole
 * budget on its own. Such an entry is dropped rather than truncated: a
 * truncated key no longer matches its question, so the receipt could not render
 * it anyway and keeping it would cost bytes and buy nothing.
 */
export function sanitizeAnswersForTranscript(
  questions: readonly PendingInputQuestion[],
  answers: Readonly<Record<string, string | string[]>> | null | undefined,
): Record<string, string | string[]> | undefined {
  if (!answers) return undefined;
  const questionIds = new Set(questions.map((question) => question.id));
  const secretIds = new Set(
    questions.filter((question) => question.isSecret === true).map((question) => question.id),
  );
  const kept: Array<[string, string | string[]]> = [];
  for (const [id, value] of Object.entries(answers)) {
    // Unknown keys cannot render in a receipt and, more importantly, must not
    // provide a side door around an isSecret question's real id.
    if (!questionIds.has(id) || secretIds.has(id)) continue;
    if (Array.isArray(value)) {
      const entries = value.filter((entry): entry is string => typeof entry === "string");
      if (entries.length) kept.push([id, entries]);
      continue;
    }
    if (typeof value === "string" && value.length) kept.push([id, value]);
  }
  if (!kept.length) return undefined;

  const asRecord = (entries: Array<[string, string | string[]]>): Record<string, string | string[]> =>
    Object.fromEntries(entries);

  if (serializedByteLength(asRecord(kept)) <= RESOLVED_ANSWERS_MAX_BYTES) return asRecord(kept);

  // Measure the JSON envelope exactly — braces, quotes, colons, commas and the
  // keys themselves — by serializing with every value emptied. What is left is
  // the real budget for content, so the arithmetic cannot quietly overshoot the
  // way an estimated per-key cost did.
  const envelopeBytes = (entries: Array<[string, string | string[]]>): number =>
    serializedByteLength(asRecord(entries.map(([id, value]) => [
      id,
      Array.isArray(value) ? value.map(() => "") : "",
    ])));

  // A key can be pathological on its own (ids come from the model). Drop the
  // largest keys until the envelope alone fits, since a truncated key no longer
  // matches its question and the receipt could not render it anyway.
  let entries = [...kept];
  while (entries.length > 1 && envelopeBytes(entries) >= RESOLVED_ANSWERS_MAX_BYTES) {
    let widestIndex = 0;
    for (let index = 1; index < entries.length; index += 1) {
      if (utf8Length(entries[index]![0]) > utf8Length(entries[widestIndex]![0])) widestIndex = index;
    }
    entries.splice(widestIndex, 1);
  }
  if (envelopeBytes(entries) >= RESOLVED_ANSWERS_MAX_BYTES) return undefined;

  // Shrink to fit, then verify. One rounding pass is normally enough; the loop
  // is the guarantee, not the optimization.
  const markerBytes = utf8Length(TRUNCATED_ANSWER_MARKER);
  let budget = RESOLVED_ANSWERS_MAX_BYTES - envelopeBytes(entries);
  let shrunk: Array<[string, string | string[]]> = entries;
  for (let pass = 0; pass < 8; pass += 1) {
    const perEntry = Math.floor(budget / entries.length);
    shrunk = entries.map(([id, value]) => {
      if (!Array.isArray(value)) return [id, truncateToBytes(value, Math.max(markerBytes, perEntry))];
      const perElement = Math.max(markerBytes, Math.floor(perEntry / value.length));
      return [id, value.map((element) => truncateToBytes(element, perElement))];
    });
    const actual = serializedByteLength(asRecord(shrunk));
    if (actual <= RESOLVED_ANSWERS_MAX_BYTES) return asRecord(shrunk);
    budget -= actual - RESOLVED_ANSWERS_MAX_BYTES;
    if (budget <= 0) break;
  }

  // Still over only if every value is already at the marker floor; drop
  // entries until it fits rather than persisting an oversized event.
  while (shrunk.length && serializedByteLength(asRecord(shrunk)) > RESOLVED_ANSWERS_MAX_BYTES) {
    shrunk.pop();
  }
  return shrunk.length ? asRecord(shrunk) : undefined;
}


/**
 * Flatten one question's answer for a provider that only accepts a single
 * string (Droid's `onAskUserRequest`).
 *
 * A bare `.join(", ")` makes a chosen option and a typed qualification
 * indistinguishable — "Hide it, keep the pin, only if it survives a restart"
 * reads as three choices. Splitting on the question's own option values lets
 * the picks stay a plain list and gives the note its own labelled line.
 */
export function flattenAnswerForSingleStringProvider(
  question: Pick<PendingInputQuestion, "options">,
  value: string | readonly string[] | undefined,
): string {
  const { picks, note } = splitAnswer(question, value);
  if (!picks.length) return note;
  if (!note.length) return picks.join(", ");
  return `${picks.join(", ")}\nNote: ${note}`;
}
