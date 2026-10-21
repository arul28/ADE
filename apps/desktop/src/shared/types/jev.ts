/**
 * ADE's shared Jev helper: one typed question to OpenCode Zen's free
 * `jev-1.13-free` decision model ("System One"). Jev never generates text; it
 * answers yes/no, choice and score questions about a piece of state with
 * probabilities. It is an optional upgrade over each caller's existing logic:
 * every failure answers `null`, which means "use your fallback".
 */

/** Who is asking. Closed so the summary log can count per feature; extend it here. */
export const JEV_FEATURES = [
  "turn_end",
  "cli_status",
  "settle_nudge",
  "palette",
  "lane_emoji",
  "model_hint",
  "status_line",
] as const;
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

/**
 * Where a call is answered, tried in this order: OpenCode's free Jev (no key,
 * a daily allowance per network), Jev on the user's own OpenCode Zen balance
 * (only when they opt in), and the ADE bonus (ADE's key through the account
 * directory, capped per account per day).
 */
export type JevRoute = "free" | "zen_credit" | "bonus";
export const JEV_ROUTES: readonly JevRoute[] = ["free", "zen_credit", "bonus"];

/** Why a call answered `null`, as counted in `jev.summary` and `status()`. */
export type JevFallbackReason =
  | "disabled"
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

export type JevAvailabilityReason = "ok" | "disabled";

export type JevStatus = {
  available: boolean;
  reason: JevAvailabilityReason;
  /** Each route's breaker, in the order calls try them. */
  routes: Array<{
    route: JevRoute;
    open: boolean;
    /** What opened it: `rate_limited`, `auth_rejected`, or `transient`. */
    reason: string | null;
    until: string | null;
    consecutiveFailures: number;
  }>;
  /** This machine's OpenCode Zen sign-in, which only the `zen_credit` route uses. */
  zen: "signed_in" | "not_signed_in" | "token_expired";
  inFlight: number;
  /** Since this brain started, per feature and outcome. */
  counts: Partial<Record<JevFeature, Partial<Record<JevOutcome, number>>>>;
  /** This project's tally for the current local day; null before its first call. */
  today: JevDayTally | null;
};

/**
 * One local day of Jev use in one project, kept so ADE can see what Jev would
 * cost to pay for. Numbers only: no state text, questions or answers.
 */
export type JevDayTally = {
  /** Machine-local calendar day, `YYYY-MM-DD`. */
  day: string;
  /** `decide()` calls that would reach Jev if it were up (the setting is on). */
  wanted: number;
  /** Requests actually sent. */
  sent: number;
  /** Sent requests that returned no usable answer. */
  failed: number;
  /** Every outcome, sent or not, as in `counts`. */
  outcomes: Partial<Record<JevOutcome, number>>;
  /** Requests sent, per feature. */
  sentByFeature: Partial<Record<JevFeature, number>>;
  /** Answered requests, per route. */
  answeredByRoute: Partial<Record<JevRoute, number>>;
  /** Tokens Jev reported for sent requests. */
  inputTokens: number;
  outputTokens: number;
  /** Estimated input tokens for wanted calls that were never sent (breaker, busy). */
  unsentInputTokensEstimate: number;
  /** Times the breaker opened. */
  breakerOpens: number;
  /** Answered requests, total and over one second. */
  latencyTotalMs: number;
  latencyCount: number;
  slowCount: number;
};
