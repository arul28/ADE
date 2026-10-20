/**
 * ADE's shared Jev helper: one typed question to OpenCode Zen's free
 * `jev-1.13-free` decision model ("System One"). Jev never generates text; it
 * answers yes/no, choice and score questions about a piece of state with
 * probabilities. It is an optional upgrade over each caller's existing logic:
 * every failure answers `null`, which means "use your fallback".
 */

/** Who is asking. Closed so the summary log can count per feature; extend it here. */
export const JEV_FEATURES = ["turn_end", "cli_status", "settle_nudge", "palette", "lane_emoji", "model_hint"] as const;
export type JevFeature = (typeof JEV_FEATURES)[number];

/**
 * `interactive` gets the short timeout and is never turned away for
 * background traffic. `background` gets the long timeout and is dropped when
 * the call cap is near or the breaker is open.
 */
export type JevPriority = "interactive" | "background";

export type JevNoulQuestion = { type: "noul"; instructions: string };
/** `criteria`: answer key → what it means. The answer is one of the keys. */
export type JevChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
/** `criteria`: ordered labels, lowest first. The answer is an index into them. */
export type JevScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

/** `noul`: probability (0–1) that the answer is yes. */
export type JevNoulAnswer = { type: "noul"; noul: number };
export type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  /** Keyed by the question's criteria keys. */
  probabilities: Record<string, number>;
};
export type JevScoreAnswer = {
  type: "score";
  /** Index into the question's `criteria`. */
  score: number;
  /** `criteria[score]`. */
  label: string;
  confidence: number;
  /** One probability per criterion, in the question's order. */
  probabilities: number[];
};
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export type JevAnswerFor<Q extends JevQuestion> =
  Q extends JevNoulQuestion ? JevNoulAnswer
    : Q extends JevChoiceQuestion ? JevChoiceAnswer
      : JevScoreAnswer;

export type JevQuestions = Record<string, JevQuestion>;

/** An answer for every question asked, or the whole call is `null`. */
export type JevAnswers<Q extends JevQuestions> = { [K in keyof Q]: JevAnswerFor<Q[K]> };

export type JevDecideRequest<Q extends JevQuestions = JevQuestions> = {
  feature: JevFeature;
  /** The free-text situation the questions are about. */
  state: string;
  questions: Q;
  priority: JevPriority;
  /** Defaults: 1500 ms interactive, 4000 ms background. */
  timeoutMs?: number;
};

/** Why a call answered `null`, as counted in `jev.summary` and `status()`. */
export type JevFallbackReason =
  | "disabled"
  | "not_signed_in"
  | "token_expired"
  | "breaker_open"
  | "busy"
  | "invalid_request"
  | "timeout"
  | "network"
  | "rate_limited"
  | "auth_rejected"
  | "http_error"
  | "bad_response";

export type JevOutcome = "ok" | "cached" | JevFallbackReason;

export type JevAvailabilityReason = "ok" | "disabled" | "not_signed_in" | "token_expired";

export type JevStatus = {
  available: boolean;
  reason: JevAvailabilityReason;
  breaker: {
    open: boolean;
    /** What opened it: `rate_limited`, `auth_rejected`, or `transient`. */
    reason: string | null;
    until: string | null;
    consecutiveFailures: number;
  };
  inFlight: number;
  /** Since this brain started, per feature and outcome. */
  counts: Partial<Record<JevFeature, Partial<Record<JevOutcome, number>>>>;
};
