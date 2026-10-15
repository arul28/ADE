/**
 * Failures inside the forked SDK workers (Cursor, Droid, Pi), reported from
 * the parent.
 *
 * The workers carry no Sentry SDK of their own: loading one costs hundreds of
 * milliseconds on every chat start on Windows. They already post their errors
 * and unhandled failures to the parent as `log` messages, which the pools
 * write to the logger at `warn` (a worker's `error` is downgraded there, since
 * the request failure that follows is what the user sees). This turns the ones
 * that mean a bug into Sentry issues, grouped per worker and message.
 */
import { captureProblem } from "../../shared/sentry/capture";

type WorkerLogMessage = { level?: string; message?: unknown; detail?: unknown };

const UNHANDLED_ORIGINS = new Set(["uncaughtException", "unhandledRejection"]);

export function captureWorkerFailure(worker: "cursor" | "droid" | "pi", message: WorkerLogMessage): void {
  const rawOrigin = (message.detail as { origin?: unknown } | null | undefined)?.origin;
  const origin = typeof rawOrigin === "string" && UNHANDLED_ORIGINS.has(rawOrigin) ? rawOrigin : null;
  if (message.level !== "error" && !origin) return;
  const text = typeof message.message === "string" ? message.message : "SDK worker failure";
  captureProblem(text, {
    tags: { process: `worker:${worker}`, ...(origin ? { "worker.origin": origin } : {}) },
    extra: { detail: message.detail ?? null },
    fingerprint: ["worker", worker, text],
  });
}
