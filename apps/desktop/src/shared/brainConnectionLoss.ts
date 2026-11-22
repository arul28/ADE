/**
 * The answer an `ade rpc --stdio` relay gives for calls it was carrying when
 * its socket to the brain failed or closed: JSON-RPC `internalError` whose
 * `data.code` is this, and whose `data` says what the relay could see. The
 * relay writes it (`apps/ade-cli/src/lib/brainConnectionLoss.ts`); the desktop
 * reads it (`runtimeRpcClient.ts`) and reports it, since the brain's machine
 * may have no route to Sentry.
 *
 * Only structured fields cross: the brain log's last lines become their
 * level, code-defined event name and an errno-shaped code. No message text,
 * path, URL or name leaves the brain's machine.
 */
export const BRAIN_CONNECTION_LOST_CODE = "brain_connection_lost";

export type BrainLogTailEntry = {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  code?: string;
};

export type BrainConnectionLossState = "alive" | "exited" | "exited_and_replaced" | "unknown";

export type BrainConnectionLossData = {
  code: typeof BRAIN_CONNECTION_LOST_CODE;
  socketError: string | null;
  brainState: BrainConnectionLossState;
  heartbeatAgeSec: number | null;
  brainLogTail: BrainLogTailEntry[];
};

const LOG_LEVELS: ReadonlySet<string> = new Set<BrainLogTailEntry["level"]>(["debug", "info", "warn", "error"]);

function isLogLevel(value: unknown): value is BrainLogTailEntry["level"] {
  return typeof value === "string" && LOG_LEVELS.has(value);
}
const BRAIN_STATES = new Set<BrainConnectionLossState>(["alive", "exited", "exited_and_replaced", "unknown"]);
/** A log event name as code writes it: `process.uncaught_exception`. */
const LOG_EVENT_PATTERN = /^[a-z][A-Za-z0-9_]{0,40}(?:\.[A-Za-z0-9_]{1,40}){0,5}$/;
/** An errno or a coded error's code: `ENOSPC`, `SQLITE_BUSY`. */
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,40}$/;
export const BRAIN_LOG_TAIL_MAX_ENTRIES = 6;

/** One log line's safe fields, or null when its level or event is not code-shaped. */
export function brainLogTailEntry(level: unknown, event: unknown, code: unknown): BrainLogTailEntry | null {
  if (!isLogLevel(level)) return null;
  if (typeof event !== "string" || event.length > 120 || !LOG_EVENT_PATTERN.test(event)) return null;
  return { level, event, ...(isErrorCodeShaped(code) ? { code } : {}) };
}

/** The relay's data, re-validated field by field: anything not of the shapes above is dropped. */
export function readBrainConnectionLossData(data: unknown): BrainConnectionLossData | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.code !== BRAIN_CONNECTION_LOST_CODE) return null;
  const tail = Array.isArray(record.brainLogTail) ? record.brainLogTail : [];
  return {
    code: BRAIN_CONNECTION_LOST_CODE,
    socketError: isErrorCodeShaped(record.socketError) ? record.socketError : null,
    brainState: BRAIN_STATES.has(record.brainState as BrainConnectionLossState)
      ? record.brainState as BrainConnectionLossState
      : "unknown",
    heartbeatAgeSec: typeof record.heartbeatAgeSec === "number" && Number.isFinite(record.heartbeatAgeSec)
      ? Math.max(0, Math.round(record.heartbeatAgeSec))
      : null,
    brainLogTail: tail
      .slice(-BRAIN_LOG_TAIL_MAX_ENTRIES)
      .map((entry) => entry && typeof entry === "object"
        ? brainLogTailEntry((entry as Record<string, unknown>).level, (entry as Record<string, unknown>).event, (entry as Record<string, unknown>).code)
        : null)
      .filter((entry): entry is BrainLogTailEntry => entry !== null),
  };
}

/** Whether `value` is shaped like an errno or a coded error's code (`ENOSPC`, `SQLITE_BUSY`). */
export function isErrorCodeShaped(value: unknown): value is string {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value);
}
