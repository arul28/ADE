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
 * behind the account directory, capped per account per day. Each route has
 * its own breaker, so a spent free allowance moves calls to the next route
 * until it resets.
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

export { jevTallyFileStore, type JevTallyStore } from "./jevTally";

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
/**
 * The ADE bonus's last calls of the day are kept for interactive questions
 * (the model hint, mostly): background features stop using it here. Small,
 * because the status features (turn end, CLI waiting, status line) are what
 * the bonus is mostly for.
 */
const BONUS_INTERACTIVE_RESERVE = 20;
/** Never on the bonus: a chat idle for hours can wait for the free allowance to reset. */
const FREE_ONLY_FEATURES: ReadonlySet<JevFeature> = new Set(["settle_nudge"]);

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

/** The bonus calls the account directory says are left today (`x-ade-jev-remaining`), by UTC day. */
let bonusRemaining: { day: string; remaining: number } | null = null;

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

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
    return { ok: false, reason: "auth_rejected", breakerOpened: openBreaker(breaker, "auth_rejected", AUTH_BACKOFF_MS, nowMs) };
  }
  if (status === 400 || status === 413 || status === 422) {
    // Our request is bad (too big, or refused as input): the route is not broken,
    // and the next route would refuse it too.
    return { ok: false, reason: "invalid_request" };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, reason: "http_error", breakerOpened: recordTransientFailure(breaker, nowMs) };
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
  const remainingHeader = route.id === "bonus" ? headers?.get("x-ade-jev-remaining")?.trim() : null;
  const remaining = remainingHeader ? finiteNumberOrNull(Number(remainingHeader)) : null;
  if (remaining != null) bonusRemaining = { day: utcDay(nowMs), remaining };
  if (!answers) return { ok: false, reason: "bad_response", usage };
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

  type RouteResolver = (request: JevDecideRequest, nowMs: number, budgetMs: number) => Route | null | Promise<Route | null>;

  /** How each route is set up for one call; null when it is not. */
  const routeResolvers: Record<JevRoute, RouteResolver> = {
    free: () => ({ id: "free", urls: OPENCODE_JEV_URLS, token: null, model: FREE_MODEL }),

    zen_credit: (_request, nowMs) => {
      if (!deps.useZenCredit?.()) return null;
      const credential = jevAvailability(nowMs);
      return credential.ok ? { id: "zen_credit", urls: OPENCODE_JEV_URLS, token: credential.token, model: ZEN_CREDIT_MODEL } : null;
    },

    bonus: async (request, nowMs, budgetMs) => {
      if (FREE_ONLY_FEATURES.has(request.feature)) return null;
      const left = bonusRemaining?.day === utcDay(nowMs) ? bonusRemaining.remaining : null;
      if (request.priority === "background" && left != null && left <= BONUS_INTERACTIVE_RESERVE) return null;
      const base = deps.bonus?.baseUrl()?.trim().replace(/\/+$/, "");
      if (!base) return null;
      // A token refresh may go to the network: it gets the call's remaining time, no more.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const token = await Promise.race([
        deps.bonus!.accountToken().catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), budgetMs);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      // The account directory picks the model; this one is only a label.
      return token ? { id: "bonus", urls: [`${base}${BONUS_PATH}`], token, model: "jev-latest" } : null;
    },
  };

  /** A route ready to take a call now, or null: its breaker is open, or it is not set up. */
  const resolveRoute = async (
    id: JevRoute,
    request: JevDecideRequest,
    nowMs: number,
    budgetMs: number,
  ): Promise<Route | null> => (breakerOpen(breakers[id], nowMs) ? null : routeResolvers[id](request, nowMs, budgetMs));

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
  ): Promise<CallResult & { route?: JevRoute; sent: boolean }> => {
    const deadline = Date.now() + timeoutMs;
    let last: CallResult = { ok: false, reason: "breaker_open" };
    let sent = false;
    for (const id of JEV_ROUTES) {
      if (deadline - Date.now() < MIN_ROUTE_BUDGET_MS) break;
      const route = await resolveRoute(id, request, Date.now(), deadline - Date.now() - MIN_ROUTE_BUDGET_MS);
      if (deadline - Date.now() < MIN_ROUTE_BUDGET_MS) break;
      if (!route) continue;
      sent = true;
      const result = await callJev({
        route,
        state: request.state,
        questions: request.questions,
        timeoutMs: deadline - Date.now(),
        userAgent,
      });
      if (result.ok) return { ...result, route: id, sent };
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
      if (result.reason === "timeout" || result.reason === "invalid_request") break;
    }
    return { ...last, sent };
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
        // Nothing above should throw; if it does, the caller still gets its fallback.
        logger.warn("jev.decide_failed", { error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    },

    status() {
      const nowMs = Date.now();
      const reason = availabilityReason();
      const zen = jevAvailability(nowMs);
      return {
        available: reason === "ok",
        reason,
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
