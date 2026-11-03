import { scrubFreeText } from "../../../shared/sentry/scrub";
import type { ProductAnalyticsException } from "../../../shared/types/productAnalytics";
import { SLUG_VALUE } from "./productAnalyticsPolicy";

const ERROR_APP_VERSION_VALUE = /^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/;
const EXCEPTION_TYPE_VALUE = /^[A-Za-z_$][\w$.:-]{0,79}$/;
const FRAME_FUNCTION_VALUE = /^[\w$.<>\[\] /:-]{1,160}$/;
const PROCESS_VALUES = new Set(["main", "renderer", "brain", "worker", "utility"]);
const MAX_EXCEPTIONS = 5;
const MAX_FRAMES = 50;
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A stack frame's file, reduced to where it sits inside ADE: the part after
 * `app.asar/`, `dist/`, `src/` or `node_modules/`, else the bare file name.
 * Never the folder it was installed to, which names the person's machine.
 */
function frameFile(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^file:\/\//i, "");
  const anchors = ["app.asar/", "/node_modules/", "/dist/", "/src/"];
  for (const anchor of anchors) {
    const index = normalized.lastIndexOf(anchor);
    if (index >= 0) {
      const tail = normalized.slice(index + anchor.length);
      const prefix = anchor === "/node_modules/" ? "node_modules/" : "";
      return `${prefix}${tail}`.slice(0, 200);
    }
  }
  const base = normalized.split("/").pop() ?? "";
  return base ? base.slice(0, 120) : null;
}

function frameNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 10_000_000 ? value : undefined;
}

/**
 * PostHog error tracking's `$exception` properties from one scrubbed Sentry
 * event. On top of Sentry's scrub, the message loses email addresses and
 * absolute paths, frames keep only their in-app file, function, position and
 * the bundle's debug id as `chunk_id` (no source lines, no variables), and
 * every string is bounded.
 */
export function sanitizeExceptionProperties(
  payload: ProductAnalyticsException | undefined,
): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.exceptions)) return null;
  if (payload.level !== "error" && payload.level !== "fatal" && payload.level !== "warning") return null;
  const exceptionList = payload.exceptions.slice(0, MAX_EXCEPTIONS).flatMap((exception) => {
    if (!exception || typeof exception !== "object") return [];
    const type = typeof exception.type === "string" && EXCEPTION_TYPE_VALUE.test(exception.type.trim())
      ? exception.type.trim()
      : "Error";
    const value = typeof exception.value === "string" ? scrubFreeText(exception.value, { maxLength: 500 }) : "";
    const frames = (Array.isArray(exception.frames) ? exception.frames : []).slice(-MAX_FRAMES).flatMap((frame) => {
      if (!frame || typeof frame !== "object") return [];
      const filename = frameFile(frame.filename);
      const fn = typeof frame.function === "string" && FRAME_FUNCTION_VALUE.test(frame.function.trim())
        ? frame.function.trim()
        : undefined;
      if (!filename && !fn) return [];
      // A bundle's Sentry debug id: PostHog finds the uploaded source map by
      // it, and names nothing about the machine. Anything not UUID-shaped is dropped.
      const chunkId = typeof frame.chunkId === "string" && UUID_VALUE.test(frame.chunkId.trim())
        ? frame.chunkId.trim().toLowerCase()
        : undefined;
      return [{
        platform: "node:javascript",
        // PostHog reads a Node frame only when both strings are present.
        filename: filename ?? "<unknown>",
        function: fn ?? "<anonymous>",
        ...(chunkId ? { chunk_id: chunkId } : {}),
        ...(frameNumber(frame.lineno) !== undefined ? { lineno: frameNumber(frame.lineno) } : {}),
        ...(frameNumber(frame.colno) !== undefined ? { colno: frameNumber(frame.colno) } : {}),
        in_app: frame.inApp === true,
      }];
    });
    const mechanism = typeof exception.mechanism === "string" && SLUG_VALUE.test(exception.mechanism.trim().toLowerCase())
      ? exception.mechanism.trim().toLowerCase()
      : "generic";
    return [{
      type,
      value,
      mechanism: { type: mechanism, handled: exception.handled !== false, synthetic: false },
      ...(frames.length ? { stacktrace: { type: "raw", frames } } : {}),
    }];
  });
  if (exceptionList.length === 0) return null;
  const fingerprint = typeof payload.fingerprint === "string" ? payload.fingerprint.trim() : "";
  const process = typeof payload.process === "string" && PROCESS_VALUES.has(payload.process) ? payload.process : null;
  return {
    $exception_list: exceptionList,
    $exception_level: payload.level,
    ...(fingerprint
      ? { $exception_fingerprint: scrubFreeText(fingerprint, { maxLength: 200 }) }
      : {}),
    ...(process ? { process } : {}),
    ...(typeof payload.releaseVersion === "string" && ERROR_APP_VERSION_VALUE.test(payload.releaseVersion)
      ? { error_app_version: payload.releaseVersion }
      : {}),
  };
}
