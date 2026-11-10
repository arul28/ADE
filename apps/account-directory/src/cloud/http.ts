/** The JSON answers every ADE Cloud route gives. */

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** `extra` adds fields next to `code` and `message` (a disk refusal's `reason`); clients that don't read them still show `message`. */
export const fail = (code: string, message: string, status: number, extra?: Record<string, string | number>): Response =>
  json({ error: { ...extra, code, message } }, status);

export const UNREADABLE_REQUEST_MESSAGE = "That request could not be read.";
