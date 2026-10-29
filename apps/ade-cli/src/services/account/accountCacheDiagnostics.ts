import path from "node:path";
import { createFileLogger } from "../../../../desktop/src/main/services/logging/logger";
import type { AccountCacheLogger } from "./accountCacheStore";

/**
 * What an account-synced store says about a failed sync, and where it says
 * it. Kept beside `accountCacheStore` so the sync loop reads as the loop.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The HTTP status a relay error carries, or null for a network failure. */
export function errorStatus(error: unknown): number | null {
  return isRecord(error) && typeof error.status === "number" ? error.status : null;
}

/** The relay's short error text on a refused request, or null. Never a value. */
export function errorReason(error: unknown): string | null {
  return isRecord(error) && typeof error.reason === "string" ? error.reason : null;
}

/**
 * A failed sync as one sentence a person can act on. Built from the status and
 * the relay's short error text only: never a value, a key, or a token.
 */
export function describeSyncFailure(error: unknown, phase: "upload" | "pull"): string {
  const what = phase === "upload" ? "send this computer's changes to" : "get changes from";
  if (isRecord(error) && error.name === "PushRelayUnreachableError" && typeof error.message === "string") {
    return `ADE couldn't ${what} your account: ${error.message}`;
  }
  const status = errorStatus(error);
  if (status === 429) return `Your account service asked ADE to slow down, so it couldn't ${what} your account yet. It retries on its own.`;
  if (status !== null && status >= 500) {
    return `ADE couldn't ${what} your account: the account service is unavailable (HTTP ${status}). It retries on its own.`;
  }
  if (status !== null) {
    const reason = errorReason(error);
    return `Your account service refused to let ADE ${what} your account (HTTP ${status}${reason !== null ? `: ${reason.slice(0, 120)}` : ""}).`;
  }
  return `ADE couldn't ${what} your account. It retries on its own.`;
}

/**
 * The relay itself is down or rate-limiting: a pull right after would fail the
 * same way. 507 (the account's vault or settings are full) is not: it refuses
 * writes only, and reads must keep flowing.
 */
export function relayUnhealthy(error: unknown): boolean {
  const status = errorStatus(error);
  return status === null || status === 429 || (status >= 500 && status !== 507);
}

const machineLoggers = new Map<string, AccountCacheLogger | null>();

/**
 * `brain.jsonl` under a machine ADE directory, for the machine-shared account
 * stores. They are built by whichever caller reaches them first, often a
 * project runtime whose logger writes that project's log (or none at all), so
 * a vault stuck for days left no trace in the machine's own log. One logger per
 * path; file only, never stderr, since a CLI process can own a store too.
 */
export function machineAccountStoreLogger(adeDir: string): AccountCacheLogger | null {
  const logPath = path.join(path.resolve(adeDir), "runtime", "brain.jsonl");
  if (!machineLoggers.has(logPath)) {
    try {
      machineLoggers.set(logPath, createFileLogger(logPath));
    } catch {
      machineLoggers.set(logPath, null);
    }
  }
  return machineLoggers.get(logPath) ?? null;
}
