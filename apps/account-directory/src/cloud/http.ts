/** The JSON answers every ADE Cloud route gives. */

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** `extra` adds fields next to `code` and `message` (a disk refusal's `reason`); clients that don't read them still show `message`. */
export const fail = (code: string, message: string, status: number, extra?: Record<string, string | number>): Response =>
  json({ error: { ...extra, code, message } }, status);

export const UNREADABLE_REQUEST_MESSAGE = "That request could not be read.";

/** A lowercase 8-4-4-4-12 UUID: a launch, a lane on a launch, a delete job. Callers lowercase first. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `CLOUD_ACCESS_ACCOUNTS`: comma list of Clerk ids, or `*`. Unset is nobody. The router, the referrals and the plan cleanup all ask it. */
export function cloudAccessAllows(env: { CLOUD_ACCESS_ACCOUNTS?: string }, userId: string): boolean {
  const list = (env.CLOUD_ACCESS_ACCOUNTS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return list.includes("*") || list.includes(userId);
}

/** Largest request body a `/cloud` route reads. */
const MAX_BODY_BYTES = 256_000;

/** A JSON object body; `{}` for an empty body, null when it is too big or isn't an object. */
export async function readJson(request: { text(): Promise<string> }): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (!text) return {};
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
