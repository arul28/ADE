/**
 * `decide`: ask OpenCode Zen's free Jev decision model a typed question.
 *
 * Every ADE feature that asks Jev goes through here. Jev is an optional
 * upgrade layered over each caller's existing logic, and the free tier is
 * rate limited and sometimes down, so every failure of any kind answers
 * `null` ("use your fallback") and nothing here throws or shows the user an
 * error. Callers must treat `null` as normal.
 *
 * Only a machine with an OpenCode Zen sign-in calls out (`jevAvailability`).
 * The breaker, the call cap and the result cache are this machine's, shared by
 * every project runtime the brain hosts; counts and the summary log are per
 * runtime, so they land in that project's log.
 */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import {
  JEV_FEATURES,
  type JevAnswer,
  type JevAnswers,
  type JevAvailabilityReason,
  type JevDecideRequest,
  type JevFallbackReason,
  type JevFeature,
  type JevOutcome,
  type JevQuestion,
  type JevQuestions,
  type JevStatus,
} from "../../../shared/types/jev";
import type { Logger } from "../logging/logger";
import { openReadOnlyDatabase } from "../projects/readOnlySqlite";
import { openCodeDataDirs } from "../shared/providerConfigHomes";
import { asRecord, finiteNumberOrNull, sha256Hex } from "../shared/utils";

const JEV_URL = "https://opencode.ai/zen/v1/systemone";
const JEV_MODEL = "jev-1.13-free";

const INTERACTIVE_TIMEOUT_MS = 1_500;
const BACKGROUND_TIMEOUT_MS = 4_000;
const MAX_TIMEOUT_MS = 10_000;
/** Calls in flight at once; background may use all but one, so a user-facing call always has a slot. */
const MAX_IN_FLIGHT = 4;
const MAX_BACKGROUND_IN_FLIGHT = MAX_IN_FLIGHT - 1;

const CREDENTIAL_TTL_MS = 60_000;
/** A token this close to expiry reads as expired; OpenCode owns the refresh. */
const TOKEN_EXPIRY_SLACK_MS = 60_000;

const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const AUTH_BACKOFF_MS = 30 * 60_000;
const TRANSIENT_FAILURES_TO_OPEN = 2;
const TRANSIENT_BACKOFF_MS = 60_000;
const TRANSIENT_BACKOFF_MAX_MS = 15 * 60_000;

const RESULT_CACHE_MAX = 128;
const RESULT_CACHE_TTL_MS = 10 * 60_000;

const SUMMARY_INTERVAL_MS = 10 * 60_000;
const SUMMARY_MAX_LATENCIES = 500;

// ── Availability ───────────────────────────────────────────────────────────

type JevCredential = { ok: true; token: string } | { ok: false; reason: "not_signed_in" | "token_expired" };

let credentialCache: { at: number; value: JevCredential } | null = null;

/**
 * The OpenCode Zen login in one `opencode.db`: the `credential` row for
 * `integration_id = 'opencode'`, the active one first, else the newest. The
 * value is OpenCode's OAuth JSON (`access`, `refresh`, `expires` in ms). A
 * store that is missing, locked or shaped differently reads as no sign-in.
 */
function readZenCredential(dbPath: string, nowMs: number): JevCredential {
  if (!existsSync(dbPath)) return { ok: false, reason: "not_signed_in" };
  let db: DatabaseSync | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    // A running OpenCode may hold the write lock; answer at once rather than wait.
    db.exec("PRAGMA busy_timeout = 0");
    const row = db.prepare(`
      SELECT value FROM credential
       WHERE integration_id = 'opencode'
       ORDER BY (active = 1) DESC, time_updated DESC
       LIMIT 1
    `).get() as { value?: unknown } | undefined;
    const value = asRecord(typeof row?.value === "string" ? JSON.parse(row.value) : null);
    const access = typeof value?.access === "string" ? value.access.trim() : "";
    if (value?.type !== "oauth" || !access) return { ok: false, reason: "not_signed_in" };
    const expires = finiteNumberOrNull(value.expires);
    if (expires != null && expires <= nowMs + TOKEN_EXPIRY_SLACK_MS) return { ok: false, reason: "token_expired" };
    return { ok: true, token: access };
  } catch {
    return { ok: false, reason: "not_signed_in" };
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a read-only handle cannot lose anything.
    }
  }
}

/**
 * The one gate on calling Jev: this machine has an unexpired OpenCode Zen
 * sign-in. Stores are searched in `openCodeDataDirs` order (ADE's own store
 * first) and the first usable token wins. Free Jev also answers without a
 * key; allowing keyless calls is a product decision that belongs here and
 * nowhere else. The token is never logged.
 */
function jevAvailability(nowMs: number): JevCredential {
  if (credentialCache && nowMs - credentialCache.at < CREDENTIAL_TTL_MS) return credentialCache.value;
  let value: JevCredential = { ok: false, reason: "not_signed_in" };
  for (const dir of openCodeDataDirs({ homeDir: homedir() })) {
    const found = readZenCredential(path.join(dir, "opencode.db"), nowMs);
    if (found.ok) {
      value = found;
      break;
    }
    if (found.reason === "token_expired") value = found;
  }
  credentialCache = { at: nowMs, value };
  return value;
}

// ── Machine-wide call state ────────────────────────────────────────────────

type BreakerReason = "rate_limited" | "auth_rejected" | "transient";

const breaker: {
  until: number;
  reason: BreakerReason | null;
  consecutiveFailures: number;
  /** Transient opens since the last success; each doubles the back-off. */
  transientOpens: number;
} = { until: 0, reason: null, consecutiveFailures: 0, transientOpens: 0 };

let inFlight = 0;
const resultCache = new Map<string, { at: number; answers: Record<string, JevAnswer> }>();
/** Identical questions already on the wire share one call. */
const pendingByKey = new Map<string, Promise<CallResult>>();

type CallResult =
  | { ok: true; answers: Record<string, JevAnswer>; latencyMs: number }
  | { ok: false; reason: JevFallbackReason; breakerOpened?: { reason: BreakerReason; until: number } };

function breakerOpen(nowMs: number): boolean {
  return breaker.until > nowMs;
}

function openBreaker(reason: BreakerReason, durationMs: number, nowMs: number): { reason: BreakerReason; until: number } {
  breaker.reason = reason;
  breaker.until = nowMs + durationMs;
  return { reason, until: breaker.until };
}

function recordSuccess(): void {
  breaker.until = 0;
  breaker.reason = null;
  breaker.consecutiveFailures = 0;
  breaker.transientOpens = 0;
}

/** 5xx, timeouts and network errors: back off after two in a row, 1 min doubling to 15. */
function recordTransientFailure(nowMs: number): { reason: BreakerReason; until: number } | undefined {
  breaker.consecutiveFailures += 1;
  if (breaker.consecutiveFailures < TRANSIENT_FAILURES_TO_OPEN) return undefined;
  breaker.consecutiveFailures = 0;
  const backoff = Math.min(TRANSIENT_BACKOFF_MS * 2 ** breaker.transientOpens, TRANSIENT_BACKOFF_MAX_MS);
  breaker.transientOpens += 1;
  return openBreaker("transient", backoff, nowMs);
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
  if (!nonEmpty(request.state)) return false;
  const entries = Object.entries(asRecord(request.questions) ?? {});
  if (entries.length === 0) return false;
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
  token: string;
  state: string;
  questions: JevQuestions;
  timeoutMs: number;
  userAgent: string;
}): Promise<CallResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  let status = 0;
  let headers: Headers | null = null;
  let text = "";
  try {
    const response = await fetch(JEV_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        // Cloudflare refuses some default client agents (403 "error code: 1010").
        "User-Agent": args.userAgent,
      },
      body: JSON.stringify({ model: JEV_MODEL, state: args.state, questions: args.questions }),
      signal: controller.signal,
    });
    status = response.status;
    headers = response.headers;
    text = await response.text();
  } catch {
    const nowMs = Date.now();
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "network", breakerOpened: recordTransientFailure(nowMs) };
  } finally {
    clearTimeout(timer);
  }
  const nowMs = Date.now();
  if (status === 429) {
    const wait = retryAfterMs(headers?.get("retry-after") ?? null, nowMs) ?? RATE_LIMIT_BACKOFF_MS;
    return { ok: false, reason: "rate_limited", breakerOpened: openBreaker("rate_limited", wait, nowMs) };
  }
  if (status === 401 || status === 403) {
    // The token may have been revoked or rotated; read the store again next time.
    credentialCache = null;
    return { ok: false, reason: "auth_rejected", breakerOpened: openBreaker("auth_rejected", AUTH_BACKOFF_MS, nowMs) };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, reason: "http_error", breakerOpened: recordTransientFailure(nowMs) };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const answers = parseAnswers(args.questions, body);
  // A 200 means the service is up, even when this answer is unusable.
  recordSuccess();
  if (!answers) return { ok: false, reason: "bad_response" };
  return { ok: true, answers, latencyMs: nowMs - startedAt };
}

// ── The service ────────────────────────────────────────────────────────────

export type JevService = {
  /** Answers for every question asked, or `null`: use your fallback. Never throws. */
  decide: <Q extends JevQuestions>(request: JevDecideRequest<Q>) => Promise<JevAnswers<Q> | null>;
  status: () => JevStatus;
  dispose: () => void;
};

export type JevServiceDeps = {
  logger: Logger;
  /** The "Smart decisions (OpenCode Jev)" setting; read per call. */
  isEnabled: () => boolean;
  appVersion?: string | null;
};

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

  const record = (feature: JevFeature, outcome: JevOutcome, latencyMs?: number): void => {
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

  const availabilityReason = (nowMs: number): JevAvailabilityReason => {
    if (!deps.isEnabled()) return "disabled";
    const credential = jevAvailability(nowMs);
    return credential.ok ? "ok" : credential.reason;
  };

  const decideOnce = async (request: JevDecideRequest): Promise<Record<string, JevAnswer> | null> => {
    const feature = (JEV_FEATURES as readonly string[]).includes(request?.feature) ? request.feature : null;
    if (!feature || !validRequest(request)) {
      if (feature) record(feature, "invalid_request");
      return null;
    }
    if (!deps.isEnabled()) {
      record(feature, "disabled");
      return null;
    }
    const nowMs = Date.now();
    const credential = jevAvailability(nowMs);
    if (!credential.ok) {
      record(feature, credential.reason);
      return null;
    }
    const key = sha256Hex(JSON.stringify([JEV_MODEL, request.state, request.questions]));
    const cached = cacheGet(key, nowMs);
    if (cached) {
      record(feature, "cached");
      return cached;
    }
    if (breakerOpen(nowMs)) {
      record(feature, "breaker_open");
      return null;
    }
    let pending = pendingByKey.get(key);
    if (!pending) {
      const cap = request.priority === "background" ? MAX_BACKGROUND_IN_FLIGHT : MAX_IN_FLIGHT;
      if (inFlight >= cap) {
        record(feature, "busy");
        return null;
      }
      const defaultTimeout = request.priority === "background" ? BACKGROUND_TIMEOUT_MS : INTERACTIVE_TIMEOUT_MS;
      const timeoutMs = Math.min(Math.max(finiteNumberOrNull(request.timeoutMs) ?? defaultTimeout, 100), MAX_TIMEOUT_MS);
      inFlight += 1;
      pending = callJev({ token: credential.token, state: request.state, questions: request.questions, timeoutMs, userAgent })
        .finally(() => {
          inFlight -= 1;
          pendingByKey.delete(key);
        });
      pendingByKey.set(key, pending);
      const result = await pending;
      if (!result.ok && result.breakerOpened) {
        logger.warn("jev.breaker_opened", {
          feature,
          reason: result.breakerOpened.reason,
          trigger: result.reason,
          until: new Date(result.breakerOpened.until).toISOString(),
        });
      }
      if (result.ok) cacheSet(key, result.answers, Date.now());
      record(feature, result.ok ? "ok" : result.reason, result.ok ? result.latencyMs : undefined);
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
      const reason = availabilityReason(nowMs);
      const open = breakerOpen(nowMs);
      return {
        available: reason === "ok",
        reason,
        breaker: {
          open,
          reason: open ? breaker.reason : null,
          until: open ? new Date(breaker.until).toISOString() : null,
          consecutiveFailures: breaker.consecutiveFailures,
        },
        inFlight,
        counts: structuredClone(counts),
      };
    },

    dispose() {
      flushSummary();
      if (summaryTimer) clearInterval(summaryTimer);
      summaryTimer = null;
    },
  };
}
