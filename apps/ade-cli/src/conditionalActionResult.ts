import { createHash } from "node:crypto";
import { CONDITIONAL_ACTION_RESULT_MIN_CHARS } from "../../desktop/src/shared/conditionalActionResult";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The host side of a conditional `run_ade_action` read (see
 * `shared/conditionalActionResult.ts`): an `etag` on a large successful result,
 * or the result left out when it matches the etag the caller already holds.
 */
export function conditionalActionResult(result: unknown, ifNoneMatch: unknown): unknown {
  if (!isRecord(result) || result.ok === false || !("result" in result)) return result;
  const body = JSON.stringify(result.result ?? null);
  if (body.length < CONDITIONAL_ACTION_RESULT_MIN_CHARS) return result;
  const etag = createHash("sha1").update(body).digest("base64url");
  if (ifNoneMatch === etag) {
    const { result: _unchanged, ...rest } = result;
    return { ...rest, notModified: true, etag };
  }
  // The size lets the caller budget the copies it keeps without measuring them.
  return { ...result, etag, etagChars: body.length };
}
