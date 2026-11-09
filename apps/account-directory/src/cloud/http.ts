/** The JSON answers every ADE Cloud route gives. */

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const fail = (code: string, message: string, status: number): Response => json({ error: { code, message } }, status);

export const UNREADABLE_REQUEST_MESSAGE = "That request could not be read.";
