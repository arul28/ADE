// Pure, framework-free state + serialization logic for the multiline feedback
// form rendered in the right pane. No React/ink imports so it can be unit
// tested in isolation.
//
// REUSE-ONLY: this module does NOT invent a daemon verb. It produces a
// FeedbackFormValues object that feeds the EXISTING buildFeedbackDraftInput()
// helper in ./feedback, whose output is sent through the existing
// conn.action("feedback", "prepareDraft" | "submitPreparedDraft", ...) path in
// app.tsx. We only swap the single-line truncated form for a multiline body +
// type selector + toggleable auto-context footer.

import type { FeedbackCategory } from "../../../desktop/src/shared/types/feedback";
import type { FeedbackFormValues } from "./feedback";

/**
 * Type selector surfaced in the right pane: ‹ bug · idea · praise ›. These are
 * the user-facing labels; each maps to an existing FeedbackCategory understood
 * by buildFeedbackDraftInput so no server change is needed:
 *   bug    -> "bug"
 *   idea   -> "feature"
 *   praise -> "improvement"  (a positive product signal — "enhancement" in
 *             review parlance; "improvement" is this schema's equivalent, since
 *             a compliment is feedback to keep/extend, not a question to answer)
 */
export const FEEDBACK_TYPES = ["bug", "idea", "praise"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

const TYPE_TO_CATEGORY: Record<FeedbackType, FeedbackCategory> = {
  bug: "bug",
  idea: "feature",
  praise: "improvement",
};

/** Map a UI feedback type to the existing daemon FeedbackCategory. */
export function feedbackTypeToCategory(type: FeedbackType): FeedbackCategory {
  return TYPE_TO_CATEGORY[type];
}

/**
 * Auto-captured context, read from existing app state at open/submit time. Each
 * field is optional; missing fields are simply omitted from the serialized
 * footer. This is what makes bug reports actionable without the user typing it.
 */
export interface ContextFooterInfo {
  /** Active provider id, e.g. "anthropic". */
  provider?: string | null;
  /** Active model id, e.g. "claude-opus-4-8". */
  model?: string | null;
  /** Active lane / worktree name. */
  lane?: string | null;
  /** Last error or notice surfaced to the user (most actionable for bugs). */
  lastError?: string | null;
}

/** Serializable, framework-free state for the feedback form. */
export interface FeedbackFormState {
  /** Selected feedback type. */
  type: FeedbackType;
  /** Raw multiline body (newline-separated). */
  text: string;
  /** Whether the auto-context footer is appended to the report. */
  showContext: boolean;
  /** Captured context snapshot (kept on state so submit uses current values). */
  context: ContextFooterInfo;
}

export type FeedbackFormAction =
  | { kind: "setType"; type: FeedbackType }
  | { kind: "cycleType"; direction: 1 | -1 }
  | { kind: "setText"; text: string }
  | { kind: "appendChar"; char: string }
  | { kind: "appendNewline" }
  | { kind: "backspace" }
  | { kind: "toggleContext" }
  | { kind: "setContext"; context: ContextFooterInfo }
  | { kind: "reset"; context?: ContextFooterInfo };

/** Initial form state. Context defaults to ON so reports are actionable. */
export function feedbackFormInitialState(
  context: ContextFooterInfo = {},
): FeedbackFormState {
  return {
    type: "bug",
    text: "",
    showContext: true,
    context: { ...context },
  };
}

/** Cycle to the next/previous type, wrapping at the ends. */
export function cycleFeedbackType(current: FeedbackType, direction: 1 | -1): FeedbackType {
  const idx = FEEDBACK_TYPES.indexOf(current);
  const len = FEEDBACK_TYPES.length;
  const next = (((idx + direction) % len) + len) % len;
  return FEEDBACK_TYPES[next];
}

/** Pure reducer for the feedback form. Always returns a new object on change. */
export function feedbackFormReducer(
  state: FeedbackFormState,
  action: FeedbackFormAction,
): FeedbackFormState {
  switch (action.kind) {
    case "setType":
      if (state.type === action.type) return state;
      return { ...state, type: action.type };
    case "cycleType": {
      const type = cycleFeedbackType(state.type, action.direction);
      if (type === state.type) return state;
      return { ...state, type };
    }
    case "setText":
      if (state.text === action.text) return state;
      return { ...state, text: action.text };
    case "appendChar":
      return { ...state, text: state.text + action.char };
    case "appendNewline":
      return { ...state, text: state.text + "\n" };
    case "backspace":
      if (state.text.length === 0) return state;
      return { ...state, text: state.text.slice(0, -1) };
    case "toggleContext":
      return { ...state, showContext: !state.showContext };
    case "setContext":
      return { ...state, context: { ...action.context } };
    case "reset":
      return feedbackFormInitialState(action.context ?? state.context);
    default:
      return state;
  }
}

/** True when the form has a non-empty (non-whitespace) body to submit. */
export function feedbackFormCanSubmit(state: FeedbackFormState): boolean {
  return state.text.trim().length > 0;
}

/**
 * Render the context footer block appended as additional context. Returns an
 * empty string when there is nothing useful to show. Lines are only emitted for
 * fields that are present, so a footer never contains dangling labels.
 */
export function serializeContextFooter(context: ContextFooterInfo): string {
  const lines: string[] = [];
  const providerModel = [context.provider, context.model]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" / ");
  if (providerModel) lines.push(`Provider/Model: ${providerModel}`);
  if (context.lane && context.lane.trim().length > 0) {
    lines.push(`Lane: ${context.lane.trim()}`);
  }
  if (context.lastError && context.lastError.trim().length > 0) {
    lines.push(`Last error/notice: ${context.lastError.trim()}`);
  }
  if (lines.length === 0) return "";
  return ["--- Context ---", ...lines].join("\n");
}

/**
 * Derive the summary line from the (multiline) body: the first non-empty line,
 * which is what buildFeedbackDraftInput expects in the required `summary` slot.
 */
export function feedbackSummaryLine(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length > 0) return line;
  }
  return "";
}

/**
 * Map the form state to the EXISTING FeedbackFormValues shape consumed by
 * buildFeedbackDraftInput(). The first non-empty line becomes the summary; the
 * full multiline body goes into details (newlines preserved verbatim); the
 * toggleable context footer is placed in additionalContext. No new daemon verb
 * or draft shape is introduced.
 */
export function feedbackFormToFormValues(state: FeedbackFormState): FeedbackFormValues {
  const summary = feedbackSummaryLine(state.text);
  const details = state.text.replace(/\s+$/u, "");
  const footer = state.showContext ? serializeContextFooter(state.context) : "";
  return {
    category: feedbackTypeToCategory(state.type),
    summary,
    details,
    ...(footer ? { additionalContext: footer } : {}),
  };
}
