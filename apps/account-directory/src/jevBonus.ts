import * as Sentry from "@sentry/cloudflare";
import { authenticate, type CallerTokenEnv } from "./callerToken";
import { logJevBonusRequest } from "./logging";
import { utcDayKey } from "./sinkUtils";

/**
 * `POST /jev/systemone`: the ADE bonus for Jev (README, "Jev bonus").
 *
 * The ADE brain tries OpenCode's free Jev first; when that day's free
 * allowance is out it sends the same `{state, questions}` here. The Worker
 * forwards it to TypeSafe's Jev API with ADE's key, which lives only here as
 * the `JEV_API_KEY` secret, and answers with TypeSafe's response unchanged.
 *
 * Each signed-in account gets `JEV_BONUS_DAILY_LIMIT` calls a UTC day (500
 * unset), and the fleet `JEV_BONUS_DAILY_GLOBAL_LIMIT` (100,000 unset), so a
 * leaked bearer or a runaway loop has a ceiling in dollars. A call TypeSafe
 * did not answer gives its slot back. Nothing about the question or answer
 * is stored or logged: counts, status and timing only.
 *
 * A Worker without the key answers 503 `jev_unavailable`; the brain then
 * falls back to its built-in rules, as it does for any failure here. Every
 * failure that is ADE's to fix (no key, a refused key, the spend cap, TypeSafe
 * down) is also a Sentry issue (`reportBonusProblem`): the brain falls back
 * quietly, so without one a dead key would look like nobody using Jev.
 */

export const JEV_BONUS_PATH = "/jev/systemone";
const UPSTREAM_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_DAILY_LIMIT = 500;
const DEFAULT_GLOBAL_DAILY_LIMIT = 100_000;
/** Jev's own cap is 64k tokens a request; this is well above any ADE question. */
const MAX_BODY_BYTES = 128 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const GLOBAL_ROW = "__all__";
const KEEP_DAYS = 7;

export type JevBonusEnv = CallerTokenEnv & {
  DB: D1Database;
  /** TypeSafe's Jev API key. A secret. */
  JEV_API_KEY?: string;
  /** `jev-latest` unset. */
  JEV_MODEL?: string;
  JEV_BONUS_DAILY_LIMIT?: string;
  JEV_BONUS_DAILY_GLOBAL_LIMIT?: string;
};

export const JEV_BONUS_ERRORS = {
  unavailable: "jev_unavailable",
  methodNotAllowed: "jev_method_not_allowed",
  badRequest: "jev_bad_request",
  exhausted: "jev_bonus_exhausted",
  upstream: "jev_upstream_failed",
} as const;

export function isJevBonusRequest(url: URL): boolean {
  return url.pathname.replace(/\/+$/, "") === JEV_BONUS_PATH;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

function limit(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Seconds until the next UTC midnight, when every count starts again. */
function secondsToReset(nowMs: number): number {
  const next = new Date(nowMs);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - nowMs) / 1000));
}

/** One slot from a row, or false at its cap. The `where count < ?` is the cap. */
async function claim(env: JevBonusEnv, day: string, userId: string, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  const result = await env.DB.prepare(`
    insert into jev_bonus_days (day, user_id, count)
    values (?, ?, 1)
    on conflict(day, user_id) do update set count = count + 1
    where count < ?
  `).bind(day, userId, cap).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function refund(env: JevBonusEnv, day: string, userId: string): Promise<void> {
  try {
    await env.DB.prepare(
      "update jev_bonus_days set count = count - 1 where day = ? and user_id = ? and count > 0",
    ).bind(day, userId).run();
  } catch {
    // One slot lost for the day is the safe direction.
  }
}

/** The day's count for an account after its claim, for the remaining-calls header. */
async function countFor(env: JevBonusEnv, day: string, userId: string): Promise<number | null> {
  try {
    const row = await env.DB.prepare("select count from jev_bonus_days where day = ? and user_id = ?")
      .bind(day, userId).first<{ count: number }>();
    return row ? Number(row.count) : null;
  } catch {
    return null;
  }
}

/**
 * Failures that are ADE's, not the caller's, become one Sentry issue per
 * reason (`sentryScrub.admitEvent` caps each to a few an hour). Counts and
 * statuses only, like the log line.
 */
const REPORTED_REASONS: Readonly<Record<string, "warning" | "error">> = {
  not_configured: "error",
  upstream_key_refused: "error",
  upstream_spend_cap: "warning",
  upstream_rate_limited: "warning",
  upstream_failed: "error",
  upstream_unreachable: "warning",
  upstream_body_failed: "warning",
  budget_unavailable: "error",
  global_cap: "warning",
};

function reportBonusProblem(reason: string | undefined, status: number, upstreamStatus: number | undefined): void {
  const level = reason ? REPORTED_REASONS[reason] : undefined;
  if (!level) return;
  Sentry.captureMessage(`jev_bonus: ${reason}`, {
    level,
    fingerprint: ["jev_bonus", reason!],
    tags: { "jev.reason": reason!, "jev.status": String(status), ...(upstreamStatus != null ? { "jev.upstream_status": String(upstreamStatus) } : {}) },
  });
}

/**
 * What the caller gets when TypeSafe did not answer 2xx. TypeSafe's own limit
 * passes through as a 429 the brain backs off from. A 402 is ADE's spend cap
 * on the key: the same 429 as our own caps, until the next UTC midnight, so
 * every brain stops asking for the day instead of retrying a spent key. A
 * refused key is ADE's problem, not the caller's: 503.
 */
function mapUpstreamFailure(status: number, headers: Headers, nowMs: number): { response: Response; reason: string } {
  if (status === 402) {
    return {
      response: json({ error: JEV_BONUS_ERRORS.exhausted }, 429, { "retry-after": String(secondsToReset(nowMs)) }),
      reason: "upstream_spend_cap",
    };
  }
  if (status === 429) {
    const retryAfter = headers.get("retry-after");
    return {
      response: json({ error: JEV_BONUS_ERRORS.exhausted }, 429, retryAfter ? { "retry-after": retryAfter } : {}),
      reason: "upstream_rate_limited",
    };
  }
  if (status === 400 || status === 422) {
    return { response: json({ error: JEV_BONUS_ERRORS.badRequest }, 400), reason: "upstream_rejected" };
  }
  if (status === 401 || status === 403) {
    return { response: json({ error: JEV_BONUS_ERRORS.unavailable }, 503), reason: "upstream_key_refused" };
  }
  return { response: json({ error: JEV_BONUS_ERRORS.upstream }, 502), reason: "upstream_failed" };
}

function readQuestion(body: unknown): { state: string; questions: Record<string, unknown> } | null {
  if (!body || typeof body !== "object") return null;
  const { state, questions } = body as { state?: unknown; questions?: unknown };
  if (typeof state !== "string" || !state.trim()) return null;
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) return null;
  if (Object.keys(questions).length === 0) return null;
  return { state, questions: questions as Record<string, unknown> };
}

export async function handleJevBonusRequest(
  request: Request,
  env: JevBonusEnv,
  nowMs: number = Date.now(),
): Promise<Response> {
  const startedAt = performance.now();
  let upstreamStatus: number | undefined;
  let usage: { inputTokens?: number; outputTokens?: number } = {};
  const finish = (response: Response, reason?: string): Response => {
    logJevBonusRequest({
      status: response.status,
      reason,
      upstreamStatus,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      durationMs: performance.now() - startedAt,
    });
    reportBonusProblem(reason, response.status, upstreamStatus);
    return response;
  };

  if (request.method !== "POST") {
    return finish(json({ error: JEV_BONUS_ERRORS.methodNotAllowed }, 405, { allow: "POST" }), "method_not_allowed");
  }
  const authentication = await authenticate(request, env);
  if (!authentication.ok) {
    const status = authentication.reason === "authentication unavailable" ? 503 : 401;
    return finish(json({ error: authentication.reason }, status), authentication.reason);
  }
  const key = env.JEV_API_KEY?.trim();
  if (!key) return finish(json({ error: JEV_BONUS_ERRORS.unavailable }, 503), "not_configured");

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return finish(json({ error: JEV_BONUS_ERRORS.badRequest }, 413), "too_large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return finish(json({ error: JEV_BONUS_ERRORS.badRequest }, 413), "too_large");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const question = readQuestion(parsed);
  if (!question) return finish(json({ error: JEV_BONUS_ERRORS.badRequest }, 400), "bad_request");

  const day = utcDayKey(nowMs);
  const userId = authentication.userId;
  const dailyLimit = limit(env.JEV_BONUS_DAILY_LIMIT, DEFAULT_DAILY_LIMIT);
  const exhausted = (reason: string) => finish(
    json({ error: JEV_BONUS_ERRORS.exhausted }, 429, { "retry-after": String(secondsToReset(nowMs)) }),
    reason,
  );
  let accountClaimed = false;
  try {
    if (!(await claim(env, day, userId, dailyLimit))) return exhausted("account_cap");
    accountClaimed = true;
    if (!(await claim(env, day, GLOBAL_ROW, limit(env.JEV_BONUS_DAILY_GLOBAL_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT)))) {
      await refund(env, day, userId);
      return exhausted("global_cap");
    }
  } catch {
    // The account's slot was taken but the fleet claim failed: give it back.
    if (accountClaimed) await refund(env, day, userId);
    return finish(json({ error: JEV_BONUS_ERRORS.unavailable }, 503), "budget_unavailable");
  }

  const giveBack = async () => {
    await refund(env, day, userId);
    await refund(env, day, GLOBAL_ROW);
  };
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ model: env.JEV_MODEL?.trim() || DEFAULT_MODEL, ...question }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    await giveBack();
    return finish(json({ error: JEV_BONUS_ERRORS.upstream }, 502), "upstream_unreachable");
  }
  upstreamStatus = upstream.status;
  let body: string;
  try {
    // The timeout also covers the body; a stalled or broken read gives the slots back.
    body = await upstream.text();
  } catch {
    await giveBack();
    return finish(json({ error: JEV_BONUS_ERRORS.upstream }, 502), "upstream_body_failed");
  }
  if (!upstream.ok) {
    await giveBack();
    const failure = mapUpstreamFailure(upstream.status, upstream.headers, nowMs);
    return finish(failure.response, failure.reason);
  }
  try {
    const answer = JSON.parse(body) as { usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    usage = {
      inputTokens: typeof answer.usage?.input_tokens === "number" ? answer.usage.input_tokens : undefined,
      outputTokens: typeof answer.usage?.output_tokens === "number" ? answer.usage.output_tokens : undefined,
    };
  } catch {
    // Passed through as-is; the brain reads a bad body as no answer.
  }
  const used = await countFor(env, day, userId);
  return finish(new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(used != null ? { "x-ade-jev-remaining": String(Math.max(0, dailyLimit - used)) } : {}),
    },
  }));
}

/** Cron: day rows older than a week. */
export async function cleanupJevBonusDays(env: { DB: D1Database }, nowMs: number = Date.now()): Promise<void> {
  const cutoff = utcDayKey(nowMs - KEEP_DAYS * 24 * 60 * 60 * 1000);
  await env.DB.prepare("delete from jev_bonus_days where day < ?").bind(cutoff).run();
}
