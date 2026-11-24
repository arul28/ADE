/**
 * The ADE Cloud iPhone on NoMac (`phones.ts` picks the provider per account).
 *
 * NoMac's account key (`NOMAC_API_KEY`) lives only here. A brain gets a token
 * for one phone (it can drive that phone, never start, list or stop one) and a
 * person's window gets a view link signed for their account alone. Each phone
 * starts with NoMac's own spend cap and time limit set to what the account may
 * still use, so it stops by itself there. NoMac's signed webhook settles the
 * rows (`handleNomacWebhook` in `phones.ts`; its signature is checked here).
 */

import { CLOUD_PHONE_IDLE_SECONDS } from "../../../desktop/src/shared/cloudPhone";
import type { CloudEnv } from "./store";
import { withoutPhoneProviderNames } from "./contract";
import { fail } from "./http";
import { reportCloudFailure } from "./store";
import {
  LIVE_STATES,
  TOKEN_MINUTES,
  VIEW_MINUTES,
  isoMs,
  sentryCode,
  stopRefused,
  type PhoneProviderServer,
  type PhoneRead,
  type PhoneSession,
} from "./phoneProvider";

const NOMAC_ORIGIN = "https://nomac.app";
const NOMAC_SIMULATOR_BASE = `${NOMAC_ORIGIN}/api/v1/simulator`;
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * The spend cap a phone starts with, a minute of its time limit: $0.90 an
 * hour. NoMac bills ADE $0.60 an hour per whole minute (since 2026-11-23), so
 * the time limit stops a phone first; the cap is the backstop.
 */
const NOMAC_MICROS_PER_MINUTE = 15_000;
/** The visitor signature inside a view link lives far shorter than the link (NoMac's own ceiling is 15 min). */
const VISITOR_SECONDS = 600;
/** NoMac's signature on a webhook older than this is refused. */
const WEBHOOK_TOLERANCE_SECONDS = 300;

type NomacAnswer = { status: number; body: Record<string, unknown> | null };

/** NoMac's label for an ADE account: its id, never an email. */
export function phoneLabelFor(userId: string): string | null {
  const label = `ade:${userId}`;
  return /^[A-Za-z0-9._:@-]{1,64}$/.test(label) ? label : null;
}

/** The ADE account a NoMac label names (`ade:<userId>`), or null for a label ADE did not make. */
export function userIdOfLabel(label: unknown): string | null {
  return typeof label === "string" && label.startsWith("ade:") && label.length > 4 ? label.slice(4) : null;
}

async function nomac(env: Pick<CloudEnv, "NOMAC_API_KEY">, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<NomacAnswer> {
  const key = env.NOMAC_API_KEY?.trim();
  if (!key) return { status: 503, body: null };
  const response = await fetch(`${NOMAC_ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // Workers have no `redirect: "error"`: a redirect is answered as a failure here.
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) return { status: 502, body: null };
  const parsed = await response.json().catch(() => null) as unknown;
  return { status: response.status, body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null };
}

function errorOf(answer: NomacAnswer): { code: string; message: string } {
  const error = answer.body?.error as { code?: unknown; message?: unknown } | undefined;
  return {
    code: typeof error?.code === "string" ? error.code : `http_${answer.status}`,
    message: typeof error?.message === "string" ? error.message : "The phone service did not answer.",
  };
}

/**
 * NoMac failed us: logged with its code (never a credential), sent to Sentry
 * per event and code (its phone limit, a 5xx and a refusal each their own
 * issue), and answered as one plain sentence.
 */
function providerFailure(event: string, answer: NomacAnswer, userId: string): Response {
  const { code, message } = errorOf(answer);
  reportCloudFailure(`${event}.${sentryCode(code)}`, { userId, status: answer.status, code }, "cloud-phone");
  if (code === "start_rate_limited" || answer.status === 429) {
    return fail("phone_busy", "Too many phones started in a row. Wait a minute, then try again.", 429);
  }
  if (code === "insufficient_credit" || code === "credit") {
    reportCloudFailure("cloud.phone_nomac_credit", { status: answer.status });
    // A 5xx may still hide a phone it made (502); a 4xx refusal made none.
    return fail("phone_unavailable", "The ADE Cloud iPhone can't start right now. ADE has been told.", answer.status >= 500 ? 502 : 503);
  }
  return fail("phone_unavailable", answer.status >= 500 || answer.status === 503
    ? "The ADE Cloud iPhone isn't answering right now. Try again in a moment."
    : `The ADE Cloud iPhone refused that: ${withoutPhoneProviderNames(message)}`, answer.status >= 500 ? 502 : 400);
}

export function sessionOf(value: unknown): PhoneSession | null {
  const session = value as PhoneSession | null;
  return session && typeof session.id === "string" && typeof session.state === "string" ? session : null;
}

/** One phone as NoMac answers it now, or null when it can't be read. */
async function readSession(env: Pick<CloudEnv, "NOMAC_API_KEY">, phoneId: string): Promise<PhoneRead | null> {
  // A timeout or a dropped connection is unreadable, like a 5xx: callers fall back to the phone id they know.
  const answer = await nomac(env, "GET", `/api/v1/simulator/sessions/${encodeURIComponent(phoneId)}`).catch((): NomacAnswer => ({ status: 504, body: null }));
  const session = sessionOf(answer.body?.session);
  return answer.status === 200 && session ? { session, stopNotice: answer.body?.stop_notice } : null;
}

async function phoneToken(env: CloudEnv, sessionId: string, userId: string): Promise<{ token: string; expiresAt: number } | Response> {
  const answer = await nomac(env, "POST", `/api/v1/simulator/sessions/${encodeURIComponent(sessionId)}/token`, { minutes: TOKEN_MINUTES });
  const token = answer.body?.token;
  const expiresAt = isoMs(answer.body?.expires_at);
  if (answer.status !== 200 || typeof token !== "string" || !token.startsWith("nmp_") || expiresAt == null) {
    return providerFailure("cloud.phone_token_failed", answer, userId);
  }
  return { token, expiresAt };
}

const base64url = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** NoMac's visitor signature (HS256 over `{ sub, sid, iat, exp }` with the `nme_` embed secret). */
async function signPhoneVisitor(secret: string, sessionId: string, visitor: string, now: number): Promise<string> {
  const encoder = new TextEncoder();
  const issued = Math.floor(now / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(encoder.encode(JSON.stringify({ sub: visitor, sid: sessionId, iat: issued, exp: issued + VISITOR_SECONDS })));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${base64url(mac)}`;
}

export const NOMAC_PHONE: PhoneProviderServer = {
  canStart: (env) => Boolean(env.NOMAC_API_KEY?.trim()),
  hasKey: (env) => Boolean(env.NOMAC_API_KEY?.trim()),
  ownsTimeLimit: true,
  stopFailedEvent: "cloud.phone_stop_failed.",

  async start(env, { userId, label, device, minutes, lastPhoneId, now }) {
    const answer = await nomac(env, "POST", "/api/v1/simulator/sessions", {
      label,
      reuse: true,
      ...(device ? { device } : {}),
      limits: {
        max_duration_seconds: minutes * 60,
        idle_timeout_seconds: CLOUD_PHONE_IDLE_SECONDS,
        spend_cap_microunits: String(minutes * NOMAC_MICROS_PER_MINUTE),
      },
      // A retry of this start reaches the same phone; a start after that phone (a stop, then start) is a new one.
    }, `ade-phone-${userId}-${lastPhoneId ?? "first"}-${Math.floor(now / 10_000)}`);
    const session = sessionOf(answer.body?.session);
    // A success it couldn't read may have made a phone: answered as unknown (502), never as a refusal.
    if (answer.status < 400 && !session) return providerFailure("cloud.phone_start_failed", { status: 502, body: null }, userId);
    if (answer.status >= 400 || !session) return providerFailure("cloud.phone_start_failed", answer, userId);
    return { session, reused: answer.body?.reused === true };
  },

  read: (env, _userId, phoneId) => readSession(env, phoneId),

  async stop(env, _userId, phoneId) {
    const answer = await nomac(env, "DELETE", `/api/v1/simulator/sessions/${encodeURIComponent(phoneId)}`).catch((): NomacAnswer => ({ status: 504, body: null }));
    if (stopRefused(answer.status)) return { ok: false, status: answer.status, code: errorOf(answer).code };
    return { ok: true, status: answer.status, after: await readSession(env, phoneId) };
  },

  async startAnswer(env, session, userId) {
    const token = await phoneToken(env, session.id, userId);
    return token instanceof Response ? token : { token, apiBase: NOMAC_SIMULATOR_BASE };
  },

  async view(env, { userId, phone, label, control, now }) {
    const secret = env.NOMAC_EMBED_SECRET?.trim() || null;
    const answer = await nomac(env, "POST", `/api/v1/simulator/sessions/${encodeURIComponent(phone.id)}/view`, {
      control,
      minutes: VIEW_MINUTES,
      ...(secret ? { visitor: label } : {}),
    });
    const url = answer.body?.url;
    const expiresAt = isoMs(answer.body?.expires_at);
    if (answer.status !== 200 || typeof url !== "string" || !url.startsWith(`${NOMAC_ORIGIN}/`) || expiresAt == null) {
      return providerFailure("cloud.phone_view_failed", answer, userId);
    }
    // Signed for this account alone: a copied link opens nothing. Without a secret
    // set up, the link itself is the permission (2 hours, this phone only).
    const signed = secret ? `${url}#visitor=${await signPhoneVisitor(secret, phone.id, label, now)}` : url;
    return { url: signed, expiresAt, control, provider: "nomac" };
  },
};

const hexOf = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** `nomac-signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`, fresh and matching, compared in constant time. */
export async function nomacSignatureValid(secret: string, header: string | null, raw: string, now: number): Promise<boolean> {
  if (!header) return false;
  const parts = new Map(header.split(",").map((part) => {
    const at = part.indexOf("=");
    return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as const;
  }));
  const t = Number(parts.get("t"));
  const given = parts.get("v1") ?? "";
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > WEBHOOK_TOLERANCE_SECONDS || !/^[0-9a-f]{64}$/i.test(given)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hexOf(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.get("t")}.${raw}`)));
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ given.toLowerCase().charCodeAt(index);
  return diff === 0;
}

/**
 * An account's deletion at NoMac: its live phones stop, and NoMac forgets what
 * it kept for the label (saved states, replays, workspace). Throws while NoMac
 * can't finish (it still saves the last phone's replay), so the deletion is
 * retried.
 */
export async function forgetNomacLabel(env: Pick<CloudEnv, "NOMAC_API_KEY">, label: string): Promise<void> {
  const listed = await nomac(env, "GET", `/api/v1/simulator/sessions?${new URLSearchParams({ label, limit: "100" }).toString()}`);
  // Unread is not "none": the deletion is tried again rather than leaving a phone or its data behind.
  if (listed.status !== 200) throw new Error(`phone_list_${errorOf(listed).code}`);
  const sessions = Array.isArray(listed.body?.sessions) ? (listed.body.sessions as unknown[]).map(sessionOf) : [];
  for (const session of sessions) {
    if (!session || !LIVE_STATES.has(session.state)) continue;
    const stopped = await nomac(env, "DELETE", `/api/v1/simulator/sessions/${encodeURIComponent(session.id)}`);
    if (stopped.status >= 400 && stopped.status !== 404) throw new Error(`phone_stop_${errorOf(stopped).code}`);
  }
  // The label goes whether or not a phone is listed: its saved states, replays and workspace outlive the phones.
  const answer = await nomac(env, "DELETE", `/api/v1/simulator/labels/${encodeURIComponent(label)}`);
  if (answer.status >= 400 && answer.status !== 404) throw new Error(`phone_label_delete_${errorOf(answer).code}`);
}
