/**
 * `decide`: ask the Jev decision model a typed question.
 *
 * Every ADE feature that asks Jev goes through here. Jev is an optional
 * upgrade layered over each caller's existing logic, and every route to it is
 * rate limited or capped and sometimes down, so every failure of any kind
 * answers `null` ("use your fallback") and nothing here throws or shows the
 * user an error. Callers must treat `null` as normal.
 *
 * One call tries the routes in order (`callRoutes`): OpenCode's free Jev, no
 * key needed; Jev on the user's own OpenCode Zen balance, only when they opt
 * in and are signed in (`jevAvailability`); then the ADE bonus, ADE's key
 * behind the account directory, capped per account per day. Every feature may
 * reach the bonus; only when it is spent too do callers use their built-in
 * rules. Each route has its own breaker, so a spent free allowance moves calls
 * to the next route until it resets.
 *
 * A call that gets no answer records why the bonus was not tried
 * (`JevKeySkipReason`) in the day tally, and every failure that is ADE's to
 * fix (no account token, the bonus refusing a token or failing) is logged as
 * an error once a day, which makes it a Sentry issue. Falling back is silent
 * for the user by design, so it must not be silent for ADE.
 *
 * The breakers, the call cap and the result cache are this machine's, shared by
 * every project runtime the brain hosts; counts and the summary log are per
 * runtime, so they land in that project's log. Each runtime also keeps a day
 * tally (numbers only) that the daily usage summary reports, so the cost of
 * paying for Jev can be read from real use.
 */
import {
  JEV_FEATURES,
  JEV_ROUTES,
  type JevAnswer,
  type JevAnswers,
  type JevAvailabilityReason,
  type JevDayTally,
  type JevDecideRequest,
  type JevFallbackReason,
  type JevFeature,
  type JevKeySkipReason,
  type JevOutcome,
  type JevQuestion,
  type JevQuestions,
  type JevRoute,
  type JevStatus,
} from "../../../shared/types/jev";
import type { Logger } from "../logging/logger";
import { asRecord, finiteNumberOrNull, sha256Hex } from "../shared/utils";
import { createJevTally, type JevTallyDetails, type JevTallyStore, type JevUsage } from "./jevTally";
import { forgetJevCredential, jevAvailability } from "./jevZenCredential";

/**
 * OpenCode's endpoints: the documented one first, then the one Jev launched
 * on. A 404 from one moves to the other, which then stays first for later
 * calls.
 */
const OPENCODE_JEV_URLS = [
  "https://opencode.ai/inference/systemone/v1/systemone",
  "https://opencode.ai/zen/v1/systemone",
] as const;
/** OpenCode's free Jev: no key needed, a daily allowance per network. */
const FREE_MODEL = "jev-1.13-free";
/** Paid Jev on the user's own OpenCode Zen balance (opt-in). */
const ZEN_CREDIT_MODEL = "jev-1.13";
/** The ADE bonus: the account directory forwards to Jev with ADE's key, capped per account per day. */
const BONUS_PATH = "/jev/systemone";
/** Falling through to the next route needs at least this much of the call's time left. */
const MIN_ROUTE_BUDGET_MS = 300;

const INTERACTIVE_TIMEOUT_MS = 1_500;
const BACKGROUND_TIMEOUT_MS = 4_000;
const MAX_TIMEOUT_MS = 10_000;
/** Calls in flight at once; background may use all but one, so a user-facing call always has a slot. */
const MAX_IN_FLIGHT = 4;
const MAX_BACKGROUND_IN_FLIGHT = MAX_IN_FLIGHT - 1;

const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const AUTH_BACKOFF_MS = 30 * 60_000;
const TRANSIENT_FAILURES_TO_OPEN = 2;
const TRANSIENT_BACKOFF_MS = 60_000;
const TRANSIENT_BACKOFF_MAX_MS = 15 * 60_000;

const RESULT_CACHE_MAX = 128;
const RESULT_CACHE_TTL_MS = 10 * 60_000;

const SUMMARY_INTERVAL_MS = 10 * 60_000;
const SUMMARY_MAX_LATENCIES = 500;

/** Longest `state`, and longest questions as JSON: far above any ADE question, and every route refuses huge bodies. */
const MAX_STATE_CHARS = 32_000;
const MAX_QUESTIONS_JSON_CHARS = 32_000;
/** Jev's fixed prompt is about 250 tokens; text runs about 4 characters a token. */
const ESTIMATED_BASE_TOKENS = 250;
const ESTIMATED_CHARS_PER_TOKEN = 4;

// ── Machine-wide call state ────────────────────────────────────────────────

type BreakerReason = "rate_limited" | "auth_rejected" | "transient";

type Breaker = {
  until: number;
  reason: BreakerReason | null;
  consecutiveFailures: number;
  /** Transient opens since the last success; each doubles the back-off. */
  transientOpens: number;
  /** For OpenCode: which of its two endpoints answered last. */
  preferredUrl: number;
};

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Problems already reported today, by key: each is logged once a UTC day per brain. */
const reportedToday = new Map<string, string>();

/** One breaker per route: the free allowance running out says nothing about the bonus. */
const breakers: Record<JevRoute, Breaker> = {
  free: { until: 0, reason: null, consecutiveFailures: 0, transientOpens: 0, preferredUrl: 0 },
  zen_credit: { until: 0, reason: null, consecutiveFailures: 0, transientOpens: 0, preferredUrl: 0 },
  bonus: { until: 0, reason: null, consecutiveFailures: 0, transientOpens: 0, preferredUrl: 0 },
};

/** Where one call goes: OpenCode free, OpenCode on the user's Zen credit, or the ADE bonus. */
type Route = { id: JevRoute; urls: readonly string[]; token: string | null; model: string };

let inFlight = 0;
const resultCache = new Map<string, { at: number; answers: Record<string, JevAnswer> }>();
/** Identical questions already on the wire share one call. */
const pendingByKey = new Map<string, Promise<CallResult>>();

type CallResult =
  | { ok: true; answers: Record<string, JevAnswer>; latencyMs: number; usage: JevUsage | null }
  | {
    ok: false;
    reason: JevFallbackReason;
    breakerOpened?: { reason: BreakerReason; until: number };
    usage?: JevUsage | null;
    /** The HTTP status, when one came back. */
    status?: number;
  };

function breakerOpen(breaker: Breaker, nowMs: number): boolean {
  return breaker.until > nowMs;
}

function openBreaker(breaker: Breaker, reason: BreakerReason, durationMs: number, nowMs: number): { reason: BreakerReason; until: number } {
  breaker.reason = reason;
  breaker.until = nowMs + durationMs;
  return { reason, until: breaker.until };
}

function recordSuccess(breaker: Breaker): void {
  breaker.until = 0;
  breaker.reason = null;
  breaker.consecutiveFailures = 0;
  breaker.transientOpens = 0;
}

/** 5xx, timeouts and network errors: back off after two in a row, 1 min doubling to 15. */
function recordTransientFailure(breaker: Breaker, nowMs: number): { reason: BreakerReason; until: number } | undefined {
  breaker.consecutiveFailures += 1;
  if (breaker.consecutiveFailures < TRANSIENT_FAILURES_TO_OPEN) return undefined;
  breaker.consecutiveFailures = 0;
  const backoff = Math.min(TRANSIENT_BACKOFF_MS * 2 ** breaker.transientOpens, TRANSIENT_BACKOFF_MAX_MS);
  breaker.transientOpens += 1;
  return openBreaker(breaker, "transient", backoff, nowMs);
}

function retryAfterMs(header: string | null, nowMs: number): number | null {
  const raw = header?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > nowMs ? at - nowMs : null;
}

function cacheGet(key: string, nowMs: number): Record<string, JevAnswer> | null {
  const entry = resultCache.get(key);
  if (!entry) return null;
  resultCache.delete(key);
  if (nowMs - entry.at > RESULT_CACHE_TTL_MS) return null;
  // Re-inserted so the Map's order stays least-recently-used first.
  resultCache.set(key, entry);
  return entry.answers;
}

function cacheSet(key: string, answers: Record<string, JevAnswer>, nowMs: number): void {
  resultCache.set(key, { at: nowMs, answers });
  while (resultCache.size > RESULT_CACHE_MAX) {
    const [oldest] = resultCache.keys();
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}

// ── Request and answer shapes ──────────────────────────────────────────────

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Rejects what Jev would reject anyway, before spending a call on it. */
function validRequest(request: JevDecideRequest): boolean {
  if (!request || !(JEV_FEATURES as readonly string[]).includes(request.feature)) return false;
  if (!nonEmpty(request.state) || request.state.length > MAX_STATE_CHARS) return false;
  const entries = Object.entries(asRecord(request.questions) ?? {});
  if (entries.length === 0) return false;
  if (JSON.stringify(request.questions).length > MAX_QUESTIONS_JSON_CHARS) return false;
  return entries.every(([id, raw]) => {
    const question = raw as JevQuestion;
    if (!id.trim() || !question || !nonEmpty(question.instructions)) return false;
    if (question.type === "noul") return true;
    if (question.type === "choice") {
      const keys = Object.entries(asRecord(question.criteria) ?? {});
      return keys.length >= 2 && keys.every(([key, description]) => key.trim() && nonEmpty(description));
    }
    if (question.type === "score") {
      return Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.every(nonEmpty);
    }
    return false;
  });
}

function probability(value: unknown): number | null {
  const n = finiteNumberOrNull(value);
  return n != null && n >= 0 && n <= 1 ? n : null;
}

/** One answer, checked against its question. A choice or score outside the criteria is no answer. */
function parseAnswer(question: JevQuestion, raw: unknown): JevAnswer | null {
  const answer = asRecord(raw);
  if (!answer || answer.type !== question.type) return null;
  if (question.type === "noul") {
    const noul = probability(answer.noul);
    return noul == null ? null : { type: "noul", noul };
  }
  const confidence = probability(answer.confidence);
  if (confidence == null) return null;
  const probabilities = asRecord(answer.probabilities) ?? {};
  if (question.type === "choice") {
    const choice = typeof answer.choice === "string" ? answer.choice : "";
    if (!Object.hasOwn(question.criteria, choice)) return null;
    return {
      type: "choice",
      choice,
      confidence,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, probability(probabilities[key]) ?? 0])),
    };
  }
  // Jev keys score probabilities by index ("0", "1", …).
  const scoreProbabilities = question.criteria.map((_, index) => probability(probabilities[String(index)]) ?? 0);
  const rawScore = finiteNumberOrNull(answer.score);
  if (rawScore == null || rawScore < 0 || rawScore > question.criteria.length - 1) return null;
  // When Jev is unsure, `score` is the probability-weighted mean (2.9 for
  // {2: 0.1, 3: 0.9}), not an index: the most likely level is the answer.
  const likeliest = scoreProbabilities.reduce((best, value, index) => (value > scoreProbabilities[best]! ? index : best), 0);
  const score = Number.isInteger(rawScore) ? rawScore : scoreProbabilities[likeliest]! > 0 ? likeliest : Math.round(rawScore);
  return {
    type: "score",
    score,
    label: question.criteria[score]!,
    confidence,
    probabilities: scoreProbabilities,
  };
}

function parseAnswers(questions: JevQuestions, body: unknown): Record<string, JevAnswer> | null {
  const answers = asRecord(asRecord(body)?.answers);
  if (!answers) return null;
  const parsed: Record<string, JevAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = parseAnswer(question, answers[id]);
    if (!answer) return null;
    parsed[id] = answer;
  }
  return parsed;
}

async function callJev(args: {
  route: Route;
  state: string;
  questions: JevQuestions;
  timeoutMs: number;
  userAgent: string;
}): Promise<CallResult> {
  const startedAt = Date.now();
  const { route } = args;
  const breaker = breakers[route.id];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  let status = 0;
  let headers: Headers | null = null;
  let text = "";
  try {
    for (let attempt = 0; attempt < route.urls.length; attempt += 1) {
      const urlIndex = (breaker.preferredUrl + attempt) % route.urls.length;
      const response = await fetch(route.urls[urlIndex]!, {
        method: "POST",
        headers: {
          ...(route.token ? { Authorization: `Bearer ${route.token}` } : {}),
          "Content-Type": "application/json",
          Accept: "application/json",
          // Cloudflare refuses some default client agents (403 "error code: 1010").
          "User-Agent": args.userAgent,
        },
        body: JSON.stringify({ model: route.model, state: args.state, questions: args.questions }),
        signal: controller.signal,
      });
      status = response.status;
      headers = response.headers;
      text = await response.text();
      if (status !== 404) {
        breaker.preferredUrl = urlIndex;
        break;
      }
    }
  } catch {
    const nowMs = Date.now();
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "network", breakerOpened: recordTransientFailure(breaker, nowMs) };
  } finally {
    clearTimeout(timer);
  }
  const nowMs = Date.now();
  if (status === 429) {
    const wait = retryAfterMs(headers?.get("retry-after") ?? null, nowMs) ?? RATE_LIMIT_BACKOFF_MS;
    return { ok: false, reason: "rate_limited", breakerOpened: openBreaker(breaker, "rate_limited", wait, nowMs) };
  }
  if (status === 401 || status === 402 || status === 403) {
    // The token may have been revoked or rotated; read the store again next time.
    if (route.id === "zen_credit") forgetJevCredential();
    return { ok: false, reason: "auth_rejected", status, breakerOpened: openBreaker(breaker, "auth_rejected", AUTH_BACKOFF_MS, nowMs) };
  }
  if (status === 400 || status === 413 || status === 422) {
    // Refused as input: not this route being down, so no breaker. The next
    // route still gets the call; a route that refuses a retired model looks
    // the same as one refusing this request.
    return { ok: false, reason: "invalid_request", status };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, reason: "http_error", status, breakerOpened: recordTransientFailure(breaker, nowMs) };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const answers = parseAnswers(args.questions, body);
  const usage = parseUsage(body);
  // A 200 means the service is up, even when this answer is unusable.
  recordSuccess(breaker);
  if (!answers) return { ok: false, reason: "bad_response", usage, status };
  return { ok: true, answers, latencyMs: nowMs - startedAt, usage };
}

/** Jev's `usage` block: `{ input_tokens, output_tokens }`. */
function parseUsage(body: unknown): JevUsage | null {
  const usage = asRecord(asRecord(body)?.usage);
  if (!usage) return null;
  const inputTokens = finiteNumberOrNull(usage.input_tokens);
  const outputTokens = finiteNumberOrNull(usage.output_tokens);
  if (inputTokens == null && outputTokens == null) return null;
  return { inputTokens: Math.max(0, inputTokens ?? 0), outputTokens: Math.max(0, outputTokens ?? 0) };
}

// ── The service ────────────────────────────────────────────────────────────

export type JevService = {
  /** Answers for every question asked, or `null`: use your fallback. Never throws. */
  decide: <Q extends JevQuestions>(request: JevDecideRequest<Q>) => Promise<JevAnswers<Q> | null>;
  status: () => JevStatus;
  /** This project's tally for one local day (`YYYY-MM-DD`), or null when Jev was not wanted that day. */
  tallyForDay: (day: string) => JevDayTally | null;
  dispose: () => void;
};

export type JevServiceDeps = {
  logger: Logger;
  /** The Smart decisions switches, read per call: the master switch, and with a feature, its group's too. */
  isEnabled: (feature?: JevFeature) => boolean;
  appVersion?: string | null;
  tallyStore?: JevTallyStore | null;
  /** Opt-in: once the free allowance is out, spend the user's own OpenCode Zen balance. Read per call. */
  useZenCredit?: () => boolean;
  /** The ADE bonus: the account directory's origin and the signed-in ADE account's bearer. */
  bonus?: {
    baseUrl: () => string | null;
    accountToken: () => Promise<string | null>;
    /**
     * Whether this machine has an ADE account session at all. A signed-out
     * machine without a token is expected; a signed-in one without a token is
     * a bug, and only that one is reported as an error.
     */
    signedIn?: () => boolean;
  } | null;
};

function estimateInputTokens(request: JevDecideRequest): number {
  const chars = request.state.length + JSON.stringify(request.questions).length;
  return ESTIMATED_BASE_TOKENS + Math.ceil(chars / ESTIMATED_CHARS_PER_TOKEN);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export function createJevService(deps: JevServiceDeps): JevService {
  const { logger } = deps;
  const userAgent = `ADE/${deps.appVersion?.trim() || "dev"} (jev-helper)`;
  const counts: JevStatus["counts"] = {};
  let window = new Map<JevFeature, { outcomes: Partial<Record<JevOutcome, number>>; latencies: number[] }>();
  let summaryTimer: ReturnType<typeof setInterval> | null = null;
  const tally = createJevTally(deps.tallyStore, logger);

  const flushSummary = (): void => {
    if (window.size === 0) return;
    const features: Record<string, Record<string, number | null>> = {};
    for (const [feature, stats] of window) {
      const sorted = [...stats.latencies].sort((a, b) => a - b);
      features[feature] = { ...stats.outcomes, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95) };
    }
    window = new Map();
    logger.info("jev.summary", { windowMinutes: SUMMARY_INTERVAL_MS / 60_000, features });
  };

  const record = (feature: JevFeature, outcome: JevOutcome, details: JevTallyDetails = {}): void => {
    const { latencyMs } = details;
    tally.add(feature, outcome, details);
    const total = (counts[feature] ??= {});
    total[outcome] = (total[outcome] ?? 0) + 1;
    let stats = window.get(feature);
    if (!stats) {
      stats = { outcomes: {}, latencies: [] };
      window.set(feature, stats);
    }
    stats.outcomes[outcome] = (stats.outcomes[outcome] ?? 0) + 1;
    if (latencyMs != null && stats.latencies.length < SUMMARY_MAX_LATENCIES) stats.latencies.push(latencyMs);
    if (!summaryTimer) {
      summaryTimer = setInterval(flushSummary, SUMMARY_INTERVAL_MS);
      summaryTimer.unref?.();
    }
  };

  const availabilityReason = (): JevAvailabilityReason => (deps.isEnabled() ? "ok" : "disabled");

  /**
   * Logs one problem at most once a UTC day per brain. `error` lines become
   * Sentry issues (grouped by event name), `warn` lines Sentry logs.
   */
  const reportOncePerDay = (
    level: "info" | "warn" | "error",
    event: string,
    key: string,
    meta: Record<string, unknown>,
  ): void => {
    const day = utcDay(Date.now());
    const reportKey = `${event}:${key}`;
    if (reportedToday.get(reportKey) === day) return;
    reportedToday.set(reportKey, day);
    logger[level](event, meta);
  };

  /** The bonus was not tried because of its own breaker: why it is open. */
  const keySkipForBreaker = (reason: BreakerReason | null): JevKeySkipReason => (
    reason === "rate_limited" ? "key_spent" : reason === "auth_rejected" ? "key_rejected" : "key_failing"
  );

  /** The account directory's origin, or null when there is none. */
  const bonusBase = (): string | null => deps.bonus?.baseUrl()?.trim().replace(/\/+$/, "") || null;
  /** Known to be signed out of ADE: the bonus cannot take a call, and that is expected. */
  const bonusSignedOut = (): boolean => deps.bonus?.signedIn?.() === false;
  /** The user's Zen sign-in, only while they opted in to spend their Zen credit. */
  const zenCredential = (nowMs: number) => (deps.useZenCredit?.() ? jevAvailability(nowMs) : null);

  /** The account token within `budgetMs`: a token read may refresh over the network. */
  const fetchBonusToken = async (budgetMs: number): Promise<{ token: string | null; timedOut: boolean }> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    const token = await Promise.race([
      // The token reader reports its own failures; here a failure is only "no token".
      deps.bonus?.accountToken().catch(() => null) ?? null,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, budgetMs);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    return { token, timedOut };
  };

  /**
   * How a route takes one call: the route, null when it is not set up or is
   * backing off, or for the bonus a `skip` saying why it could not, which the
   * day tally records.
   */
  type Resolution = Route | { skip: JevKeySkipReason } | null;
  type RouteResolver = (request: JevDecideRequest, nowMs: number, budgetMs: number) => Resolution | Promise<Resolution>;

  const routeResolvers: Record<JevRoute, RouteResolver> = {
    free: (_request, nowMs) => (
      breakerOpen(breakers.free, nowMs) ? null : { id: "free", urls: OPENCODE_JEV_URLS, token: null, model: FREE_MODEL }
    ),

    zen_credit: (_request, nowMs) => {
      if (breakerOpen(breakers.zen_credit, nowMs)) return null;
      const credential = zenCredential(nowMs);
      return credential?.ok ? { id: "zen_credit", urls: OPENCODE_JEV_URLS, token: credential.token, model: ZEN_CREDIT_MODEL } : null;
    },

    bonus: async (request, nowMs, budgetMs) => {
      // A runtime built without the bonus never offers it: nothing to report.
      if (!deps.bonus) return null;
      if (breakerOpen(breakers.bonus, nowMs)) return { skip: keySkipForBreaker(breakers.bonus.reason) };
      const feature = request.feature;
      const base = bonusBase();
      if (!base) {
        reportOncePerDay("error", "jev.key_no_account_server", "", { feature });
        return { skip: "no_account_server" };
      }
      if (bonusSignedOut()) {
        reportOncePerDay("info", "jev.key_signed_out", "", { feature });
        return { skip: "signed_out" };
      }
      const { token, timedOut } = await fetchBonusToken(budgetMs);
      if (!token) {
        // Slow is not broken: earlier routes may have left this call almost no time.
        if (timedOut) {
          reportOncePerDay("warn", "jev.key_token_slow", "", { feature, budgetMs });
          return { skip: "out_of_time" };
        }
        reportOncePerDay("error", "jev.key_no_token", "", { feature });
        return { skip: "no_account_token" };
      }
      // The account directory picks the model; this one is only a label.
      return { id: "bonus", urls: [`${base}${BONUS_PATH}`], token, model: "jev-latest" };
    },
  };

  /** A failed call on a route, reported once a day when it is ADE's to fix. */
  const reportRouteFailure = (feature: JevFeature, id: JevRoute, result: Extract<CallResult, { ok: false }>): void => {
    if (id === "bonus") {
      if (result.reason === "rate_limited") {
        // The account's or ADE's daily cap, or the key's spend cap: expected, and it resets at midnight UTC.
        reportOncePerDay("info", "jev.key_spent", "spent", { feature, status: result.status ?? 429 });
      } else if (result.reason === "auth_rejected") {
        reportOncePerDay("error", "jev.key_rejected", String(result.status ?? 0), { feature, status: result.status ?? null });
      } else if (result.reason === "http_error" || result.reason === "bad_response" || result.reason === "invalid_request") {
        reportOncePerDay("error", "jev.key_call_failed", `${result.reason}:${result.status ?? 0}`, {
          feature,
          outcome: result.reason,
          status: result.status ?? null,
        });
      }
      return;
    }
    // OpenCode running out is normal; anything else from it is worth a Sentry log, not an issue.
    if (result.reason !== "rate_limited" && result.reason !== "timeout" && result.reason !== "network") {
      reportOncePerDay("warn", "jev.route_failed", `${id}:${result.reason}:${result.status ?? 0}`, {
        feature,
        route: id,
        outcome: result.reason,
        status: result.status ?? null,
      });
    }
  };

  /**
   * One call down the routes, in order, inside one time budget: a route that
   * is rate-limited, refused or broken hands the same call to the next while
   * enough time is left. A timeout spends the budget, so it ends the chain; a
   * request a route refused as bad would be refused by the next too.
   */
  const callRoutes = async (
    feature: JevFeature,
    request: JevDecideRequest,
    timeoutMs: number,
  ): Promise<CallResult & { route?: JevRoute; sent: boolean; keySkip: JevKeySkipReason | null }> => {
    const deadline = Date.now() + timeoutMs;
    let last: CallResult = { ok: false, reason: "breaker_open" };
    let sent = false;
    let keyTried = false;
    let keySkip: JevKeySkipReason | null = null;
    for (const id of JEV_ROUTES) {
      if (deadline - Date.now() < MIN_ROUTE_BUDGET_MS) break;
      const route = await routeResolvers[id](request, Date.now(), deadline - Date.now() - MIN_ROUTE_BUDGET_MS);
      if (route && "skip" in route) {
        keySkip = route.skip;
        continue;
      }
      if (deadline - Date.now() < MIN_ROUTE_BUDGET_MS) break;
      if (!route) continue;
      if (id === "bonus") keyTried = true;
      sent = true;
      const result = await callJev({
        route,
        state: request.state,
        questions: request.questions,
        timeoutMs: deadline - Date.now(),
        userAgent,
      });
      if (result.ok) return { ...result, route: id, sent, keySkip: null };
      reportRouteFailure(feature, id, result);
      if (result.breakerOpened) {
        logger.warn("jev.breaker_opened", {
          feature,
          route: id,
          reason: result.breakerOpened.reason,
          trigger: result.reason,
          until: new Date(result.breakerOpened.until).toISOString(),
        });
      }
      last = result;
      if (result.reason === "timeout") break;
    }
    // Neither tried nor turned away: the time ran out on earlier routes.
    return { ...last, sent, keySkip: keyTried ? null : keySkip ?? "out_of_time" };
  };

  const decideOnce = async (request: JevDecideRequest): Promise<Record<string, JevAnswer> | null> => {
    const feature = (JEV_FEATURES as readonly string[]).includes(request?.feature) ? request.feature : null;
    if (!feature || !validRequest(request)) {
      if (feature) record(feature, "invalid_request");
      return null;
    }
    if (!deps.isEnabled(feature)) {
      record(feature, "disabled");
      return null;
    }
    const nowMs = Date.now();
    const key = sha256Hex(JSON.stringify(["jev", request.state, request.questions]));
    const cached = cacheGet(key, nowMs);
    if (cached) {
      record(feature, "cached");
      return cached;
    }
    let pending = pendingByKey.get(key);
    if (!pending) {
      const cap = request.priority === "background" ? MAX_BACKGROUND_IN_FLIGHT : MAX_IN_FLIGHT;
      if (inFlight >= cap) {
        record(feature, "busy", { estimatedInputTokens: estimateInputTokens(request) });
        return null;
      }
      const defaultTimeout = request.priority === "background" ? BACKGROUND_TIMEOUT_MS : INTERACTIVE_TIMEOUT_MS;
      const timeoutMs = Math.min(Math.max(finiteNumberOrNull(request.timeoutMs) ?? defaultTimeout, 100), MAX_TIMEOUT_MS);
      inFlight += 1;
      const chain = callRoutes(feature, request, timeoutMs)
        .finally(() => {
          inFlight -= 1;
          pendingByKey.delete(key);
        });
      pending = chain;
      pendingByKey.set(key, pending);
      const result = await chain;
      if (result.ok) cacheSet(key, result.answers, Date.now());
      record(feature, result.ok ? "ok" : result.reason, {
        sent: result.sent,
        latencyMs: result.ok ? result.latencyMs : undefined,
        usage: result.usage,
        route: result.route,
        breakerOpened: !result.ok && Boolean(result.breakerOpened),
        estimatedInputTokens: result.sent ? undefined : estimateInputTokens(request),
        keySkip: result.ok ? null : result.keySkip,
      });
      return result.ok ? result.answers : null;
    }
    // Joined a call another caller started: count the outcome, not the breaker.
    const result = await pending;
    record(feature, result.ok ? "cached" : result.reason);
    return result.ok ? result.answers : null;
  };

  return {
    async decide<Q extends JevQuestions>(request: JevDecideRequest<Q>): Promise<JevAnswers<Q> | null> {
      try {
        return (await decideOnce(request)) as JevAnswers<Q> | null;
      } catch (error) {
        // Nothing above should throw; if it does, the caller still gets its
        // fallback, and the error (with its stack) is a Sentry issue.
        logger.error("jev.decide_failed", { feature: request?.feature ?? null, error });
        return null;
      }
    },

    status() {
      const nowMs = Date.now();
      const reason = availabilityReason();
      const zen = jevAvailability(nowMs);
      // The resolvers' own "is this route set up" checks, without fetching a token.
      const answerable = reason === "ok" && (
        !breakerOpen(breakers.free, nowMs)
        || (!breakerOpen(breakers.zen_credit, nowMs) && Boolean(zenCredential(nowMs)?.ok))
        || (!breakerOpen(breakers.bonus, nowMs) && !bonusSignedOut() && bonusBase() != null)
      );
      return {
        available: reason === "ok",
        reason,
        answerable,
        routes: JEV_ROUTES.map((route) => {
          const breaker = breakers[route];
          const open = breakerOpen(breaker, nowMs);
          return {
            route,
            open,
            reason: open ? breaker.reason : null,
            until: open ? new Date(breaker.until).toISOString() : null,
            consecutiveFailures: breaker.consecutiveFailures,
          };
        }),
        zen: zen.ok ? "signed_in" : zen.reason,
        inFlight,
        counts: structuredClone(counts),
        today: tally.today(nowMs),
      };
    },

    tallyForDay(day) {
      return tally.forDay(day);
    },

    dispose() {
      flushSummary();
      if (summaryTimer) clearInterval(summaryTimer);
      summaryTimer = null;
      tally.flush();
    },
  };
}
