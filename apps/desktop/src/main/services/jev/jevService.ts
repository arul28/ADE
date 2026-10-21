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
 * runtime, so they land in that project's log. Each runtime also keeps a day
 * tally (numbers only) that the daily usage summary reports, so the cost of
 * paying for Jev can be read from real use.
 */
import fs, { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import path from "node:path";
import {
  JEV_FEATURES,
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
  type JevStatus,
} from "../../../shared/types/jev";
import type { Logger } from "../logging/logger";
import { openReadOnlyDatabase } from "../projects/readOnlySqlite";
import { openCodeDataDirs } from "../shared/providerConfigHomes";
import { writeFileAtomic } from "../state/durableFile";
import { localDayKey } from "../usage/localDay";
import { asRecord, finiteNumberOrNull, sha256Hex } from "../shared/utils";

/**
 * The documented endpoint first, then the one Jev launched on. A 404 from one
 * moves to the other, which then stays first for later calls.
 */
const JEV_URLS = [
  "https://opencode.ai/inference/systemone/v1/systemone",
  "https://opencode.ai/zen/v1/systemone",
] as const;
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

/** Days of tallies kept in the project store; the daily report reads yesterday's. */
const TALLY_DAYS_KEPT = 8;
/** The tally is written at most this often, and on dispose. */
const TALLY_SAVE_INTERVAL_MS = 60_000;
/** An answer slower than this counts as slow in the tally. */
const SLOW_ANSWER_MS = 1_000;
/** Jev's fixed prompt is about 250 tokens; text runs about 4 characters a token. */
const ESTIMATED_BASE_TOKENS = 250;
const ESTIMATED_CHARS_PER_TOKEN = 4;

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
let preferredUrl = 0;
const resultCache = new Map<string, { at: number; answers: Record<string, JevAnswer> }>();
/** Identical questions already on the wire share one call. */
const pendingByKey = new Map<string, Promise<CallResult>>();

type JevUsage = { inputTokens: number; outputTokens: number };

type CallResult =
  | { ok: true; answers: Record<string, JevAnswer>; latencyMs: number; usage: JevUsage | null }
  | {
    ok: false;
    reason: JevFallbackReason;
    breakerOpened?: { reason: BreakerReason; until: number };
    usage?: JevUsage | null;
  };

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
    for (let attempt = 0; attempt < JEV_URLS.length; attempt += 1) {
      const urlIndex = (preferredUrl + attempt) % JEV_URLS.length;
      const response = await fetch(JEV_URLS[urlIndex]!, {
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
      if (status !== 404) {
        preferredUrl = urlIndex;
        break;
      }
    }
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
  const usage = parseUsage(body);
  // A 200 means the service is up, even when this answer is unusable.
  recordSuccess();
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

/** Where a project keeps its recent day tallies, so a restart does not lose the day. */
export type JevTallyStore = {
  read: () => unknown;
  write: (days: JevDayTally[]) => void;
};

export type JevServiceDeps = {
  logger: Logger;
  /** The Smart decisions switches, read per call: the master switch, and with a feature, its group's too. */
  isEnabled: (feature?: JevFeature) => boolean;
  appVersion?: string | null;
  tallyStore?: JevTallyStore | null;
};

/**
 * The tallies as a JSON file on this machine. Not the project database: that
 * syncs to the user's other machines, and each machine counts its own calls.
 */
export function jevTallyFileStore(filePath: string): JevTallyStore {
  return {
    read: () => {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      } catch {
        return null;
      }
    },
    write: (days) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileAtomic(filePath, `${JSON.stringify(days)}\n`);
    },
  };
}

/** What one `decide()` outcome adds to the day tally. */
type TallyDetails = {
  /** This caller put a request on the wire (not cached, not joined). */
  sent?: boolean;
  latencyMs?: number;
  usage?: JevUsage | null;
  /** For wanted calls never sent: the request's estimated input tokens. */
  estimatedInputTokens?: number;
  breakerOpened?: boolean;
};

const UNSENT_OUTCOMES: ReadonlySet<JevOutcome> = new Set(["not_signed_in", "token_expired", "breaker_open", "busy"]);

function emptyTally(day: string): JevDayTally {
  return {
    day,
    wanted: 0,
    sent: 0,
    failed: 0,
    outcomes: {},
    sentByFeature: {},
    inputTokens: 0,
    outputTokens: 0,
    unsentInputTokensEstimate: 0,
    breakerOpens: 0,
    latencyTotalMs: 0,
    latencyCount: 0,
    slowCount: 0,
  };
}

function count(value: unknown): number {
  const parsed = finiteNumberOrNull(value);
  return parsed != null && parsed > 0 ? Math.floor(parsed) : 0;
}

function countMap<K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, number>> {
  const record = asRecord(value) ?? {};
  const out: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const n = count(record[key]);
    if (n > 0) out[key] = n;
  }
  return out;
}

const OUTCOME_KEYS: readonly JevOutcome[] = [
  "ok", "cached", "disabled", "not_signed_in", "token_expired", "breaker_open", "busy", "invalid_request",
  "timeout", "network", "rate_limited", "auth_rejected", "http_error", "bad_response",
];

/** The stored tallies, newest last; anything unreadable is dropped. */
function readTallies(store: JevTallyStore | null | undefined): JevDayTally[] {
  let raw: unknown = null;
  try {
    raw = store?.read() ?? null;
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const days: JevDayTally[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const day = typeof record?.day === "string" ? localDayKey(record.day) : "";
    if (!record || !day || days.some((existing) => existing.day === day)) continue;
    days.push({
      day,
      wanted: count(record.wanted),
      sent: count(record.sent),
      failed: count(record.failed),
      outcomes: countMap(record.outcomes, OUTCOME_KEYS),
      sentByFeature: countMap(record.sentByFeature, JEV_FEATURES),
      inputTokens: count(record.inputTokens),
      outputTokens: count(record.outputTokens),
      unsentInputTokensEstimate: count(record.unsentInputTokensEstimate),
      breakerOpens: count(record.breakerOpens),
      latencyTotalMs: count(record.latencyTotalMs),
      latencyCount: count(record.latencyCount),
      slowCount: count(record.slowCount),
    });
  }
  return days.sort((a, b) => a.day.localeCompare(b.day)).slice(-TALLY_DAYS_KEPT);
}

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
  const tallies = readTallies(deps.tallyStore);
  let tallyDirty = false;
  let tallySaveTimer: ReturnType<typeof setTimeout> | null = null;

  const saveTallies = (): void => {
    if (tallySaveTimer) clearTimeout(tallySaveTimer);
    tallySaveTimer = null;
    if (!tallyDirty || !deps.tallyStore) return;
    tallyDirty = false;
    try {
      deps.tallyStore.write(structuredClone(tallies));
    } catch (error) {
      logger.debug("jev.tally_save_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const tallyFor = (day: string): JevDayTally => {
    let tally = tallies.find((existing) => existing.day === day);
    if (!tally) {
      tally = emptyTally(day);
      tallies.push(tally);
      tallies.sort((a, b) => a.day.localeCompare(b.day));
      while (tallies.length > TALLY_DAYS_KEPT) tallies.shift();
    }
    return tally;
  };

  /** Adds one outcome to today's tally. A call the user switched off is not counted. */
  const tally = (feature: JevFeature, outcome: JevOutcome, details: TallyDetails): void => {
    if (outcome === "disabled" || outcome === "invalid_request") return;
    const day = localDayKey(Date.now());
    if (!day) return;
    const current = tallyFor(day);
    current.wanted += 1;
    current.outcomes[outcome] = (current.outcomes[outcome] ?? 0) + 1;
    if (details.sent) {
      current.sent += 1;
      current.sentByFeature[feature] = (current.sentByFeature[feature] ?? 0) + 1;
      if (outcome !== "ok") current.failed += 1;
    }
    if (details.usage) {
      current.inputTokens += details.usage.inputTokens;
      current.outputTokens += details.usage.outputTokens;
    }
    if (UNSENT_OUTCOMES.has(outcome) && details.estimatedInputTokens) {
      current.unsentInputTokensEstimate += details.estimatedInputTokens;
    }
    if (details.breakerOpened) current.breakerOpens += 1;
    if (details.latencyMs != null) {
      current.latencyTotalMs += Math.max(0, Math.round(details.latencyMs));
      current.latencyCount += 1;
      if (details.latencyMs > SLOW_ANSWER_MS) current.slowCount += 1;
    }
    tallyDirty = true;
    if (deps.tallyStore && !tallySaveTimer) {
      tallySaveTimer = setTimeout(saveTallies, TALLY_SAVE_INTERVAL_MS);
      tallySaveTimer.unref?.();
    }
  };

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

  const record = (feature: JevFeature, outcome: JevOutcome, details: TallyDetails = {}): void => {
    const { latencyMs } = details;
    tally(feature, outcome, details);
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
    if (!deps.isEnabled(feature)) {
      record(feature, "disabled");
      return null;
    }
    const nowMs = Date.now();
    const credential = jevAvailability(nowMs);
    if (!credential.ok) {
      record(feature, credential.reason, { estimatedInputTokens: estimateInputTokens(request) });
      return null;
    }
    const key = sha256Hex(JSON.stringify([JEV_MODEL, request.state, request.questions]));
    const cached = cacheGet(key, nowMs);
    if (cached) {
      record(feature, "cached");
      return cached;
    }
    if (breakerOpen(nowMs)) {
      record(feature, "breaker_open", { estimatedInputTokens: estimateInputTokens(request) });
      return null;
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
      record(feature, result.ok ? "ok" : result.reason, {
        sent: true,
        latencyMs: result.ok ? result.latencyMs : undefined,
        usage: result.usage,
        breakerOpened: !result.ok && Boolean(result.breakerOpened),
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
        today: structuredClone(tallies.find((existing) => existing.day === localDayKey(nowMs)) ?? null),
      };
    },

    tallyForDay(day) {
      const found = tallies.find((existing) => existing.day === day);
      return found && found.wanted > 0 ? structuredClone(found) : null;
    },

    dispose() {
      flushSummary();
      if (summaryTimer) clearInterval(summaryTimer);
      summaryTimer = null;
      saveTallies();
    },
  };
}
