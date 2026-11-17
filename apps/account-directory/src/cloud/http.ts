import { readBoundedJson } from "../sinkUtils";

/** The JSON answers every ADE Cloud route gives. */

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** `extra` adds fields next to `code` and `message` (a disk refusal's `reason`); clients that don't read them still show `message`. */
export const fail = (code: string, message: string, status: number, extra?: Record<string, unknown>): Response =>
  json({ error: { ...extra, code, message } }, status);

export const UNREADABLE_REQUEST_MESSAGE = "That request could not be read.";

export const badRequest = (message: string): Response => fail("bad_request", message, 400);

/** An account over its minute for a bucket (`takeRequest`). */
export const tooManyRequests = (message = "Too many requests from this account in the last minute. Try again in a minute."): Response =>
  fail("rate_limited", message, 429);

/** A short value (an id, a name) on one line, or null when it is missing or too long. */
export function shortString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\u0000-\u001f]/g, " ").trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/** Words for a person (a stage's detail or error, a launch's error): a long one is cut, never dropped. */
export function clippedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\u0000-\u001f]/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/** A saved row's id in a path or a body: a machine key, chat, session or lane id. */
export const ROW_ID = /^[A-Za-z0-9._:-]{1,160}$/;
/** A lowercase 8-4-4-4-12 UUID: a launch, a lane on a launch, a delete job. Callers lowercase first. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Largest request body a `/cloud` route reads. */
const MAX_BODY_BYTES = 256_000;

/** A JSON object body; `{}` for an empty body, null when it is too big or isn't an object. */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  return readBoundedJson(request, MAX_BODY_BYTES);
}
