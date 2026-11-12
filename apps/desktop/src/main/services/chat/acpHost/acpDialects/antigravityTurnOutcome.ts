/**
 * The real outcome of an Antigravity turn.
 *
 * `agy acp` reports an upstream failure (a quota, a rate limit, a Google API
 * error) as a chat message and `end_turn`, so the prompt result alone reads
 * as a finished turn. The CLI's own session log says otherwise: each session
 * is a SQLite file, `~/.gemini/antigravity-cli/conversations/<sessionId>.db`,
 * and a turn that failed ends with an error step (`step_type` 17,
 * CORTEX_STEP_TYPE_ERROR_MESSAGE) whose payload starts with the harness's
 * error text. The only typed signal is `stopReason: "refusal"`, which the
 * agent sends for an exhausted quota.
 *
 * Before each prompt ADE notes the last step index; after it, it reads only
 * the newest step the prompt added, read-only, a bounded prefix of its
 * payload. A file that is missing, unreadable or not a plain file leaves the
 * turn to the typed signal. Same reading as t3code's AntigravityTurnOutcome.
 */

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import type { AcpTurnFailure, AcpTurnOutcomeCheck } from "../acpHostTypes";
import type { AcpPromptResponse } from "../acpProtocolTypes";
import { hasTable, openReadOnlyDatabase } from "../../../projects/readOnlySqlite";
import { antigravityCliDir } from "../../../ai/antigravityAuth";

/** CORTEX_STEP_TYPE_ERROR_MESSAGE in the native trajectory. */
const ERROR_STEP_TYPE = 17;
/** The error text leads the payload; a Go stack trace follows it. */
const MAX_ERROR_PAYLOAD_BYTES = 16_384;
/** The Go harness's rendering of a Google API error. */
const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/;
const GO_DURATION = "((?:\\d+(?:\\.\\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\\s\\]])";
const RESET_DELAY = new RegExp(`\\bquotaResetDelay:${GO_DURATION}`);
/** google.rpc.RetryInfo, which a plain rate limit carries instead of a quota reset. */
const RETRY_DELAY = new RegExp(`\\bretryDelay:${GO_DURATION}`);
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};
/** A session id is a UUID; anything else is never turned into a path. */
const NATIVE_SESSION_ID = /^[\w-]+$/;
const ERROR_MESSAGE_LIMIT = 600;

type LastStep = { type: number; payload: Uint8Array | null };

function antigravityConversationDb(sessionId: string, cliDir = antigravityCliDir()): string | null {
  if (!NATIVE_SESSION_ID.test(sessionId)) return null;
  return path.join(cliDir, "conversations", `${sessionId}.db`);
}

/** Runs `read` on the session log, or returns `undefined` when it cannot be read. */
function readSteps<T>(file: string, read: (db: DatabaseSyncType) => T): T | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return undefined;
  }
  // A link or anything else the CLI did not write is not read.
  if (!stat.isFile()) return undefined;
  let db: DatabaseSyncType | null = null;
  try {
    db = openReadOnlyDatabase(file);
    // The CLI is the writer; a read never waits long on its lock.
    db.exec("PRAGMA busy_timeout = 50");
    return hasTable(db, "steps") ? read(db) : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
}

function lastStepIndex(db: DatabaseSyncType): number {
  const index = db.prepare("SELECT max(idx) AS idx FROM steps").get<{ idx?: unknown }>()?.idx;
  return typeof index === "number" ? index : -1;
}

function lastStepAfter(index: number) {
  return (db: DatabaseSyncType): LastStep | undefined => {
    const row = db
      .prepare(
        "SELECT step_type AS type, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1",
      )
      .get<{ type?: unknown; payload?: unknown }>(MAX_ERROR_PAYLOAD_BYTES, index);
    if (typeof row?.type !== "number") return undefined;
    return { type: row.type, payload: row.payload instanceof Uint8Array ? row.payload : null };
  };
}

function goDurationMs(text: string): number {
  let total = 0;
  for (const [, amount, unit] of text.matchAll(GO_DURATION_PART)) {
    total += Number(amount) * (GO_DURATION_UNIT_MS[unit!] ?? 0);
  }
  return total;
}

function resetAtFrom(text: string, nowMs: number): string | null {
  const timestamp = RESET_TIMESTAMP.exec(text)?.[1];
  if (timestamp && Number.isFinite(Date.parse(timestamp))) return new Date(Date.parse(timestamp)).toISOString();
  const delay = RESET_DELAY.exec(text)?.[1] ?? RETRY_DELAY.exec(text)?.[1];
  if (!delay) return null;
  const delayMs = goDurationMs(delay);
  return delayMs > 0 ? new Date(nowMs + delayMs).toISOString() : null;
}

function bounded(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_MESSAGE_LIMIT ? `${flat.slice(0, ERROR_MESSAGE_LIMIT - 1)}…` : flat;
}

/** The failure a turn's result and its last new step describe, if any. */
function antigravityTurnFailure(
  stopReason: string | null | undefined,
  step: LastStep | undefined,
  nowMs = Date.now(),
): AcpTurnFailure | null {
  const errorText = step?.type === ERROR_STEP_TYPE
    ? new TextDecoder().decode(step.payload ?? new Uint8Array())
    : undefined;
  // The agent maps only an exhausted quota to `refusal`.
  if (errorText === undefined && stopReason !== "refusal") return null;
  const text = errorText ?? "";
  const apiError = API_ERROR.exec(text);
  if (stopReason === "refusal" || QUOTA_EXHAUSTED.test(text)) {
    return {
      kind: "usage_limit",
      message: "You have reached your Antigravity quota for this period.",
      code: apiError?.[3] ?? "QUOTA_EXHAUSTED",
      retryable: true,
      resetAt: resetAtFrom(text, nowMs),
    };
  }
  if (!apiError) {
    return {
      kind: "provider_error",
      message: "Antigravity stopped this turn because of an error.",
      code: null,
      retryable: false,
      resetAt: null,
    };
  }
  const [, httpStatus, message, status] = apiError;
  const rateLimited = httpStatus === "429" || status === "RESOURCE_EXHAUSTED";
  return {
    kind: rateLimited ? "usage_limit" : "provider_error",
    message: bounded(message ?? "") || "Antigravity stopped this turn because of an error.",
    code: status ?? null,
    retryable: rateLimited || Number(httpStatus) >= 500,
    resetAt: resetAtFrom(text, nowMs),
  };
}

/**
 * Taken before a prompt: notes where the session log ends, and returns the
 * check that reads what the prompt added. Never throws.
 */
export async function watchAntigravityTurnOutcome(
  { sessionId }: { sessionId: string },
  cliDir?: string,
): Promise<AcpTurnOutcomeCheck> {
  const typedOnly: AcpTurnOutcomeCheck = async (response) => antigravityTurnFailure(response?.stopReason, undefined);
  const file = antigravityConversationDb(sessionId, cliDir);
  if (!file) return typedOnly;
  // A session the CLI has not written yet starts at -1: every step is new.
  const startIndex = fs.existsSync(file) ? readSteps(file, lastStepIndex) : -1;
  if (startIndex === undefined) return typedOnly;
  return async (response: AcpPromptResponse | null) => {
    if (response?.stopReason === "cancelled") return null;
    const step = readSteps(file, lastStepAfter(startIndex));
    return antigravityTurnFailure(response?.stopReason, step);
  };
}
