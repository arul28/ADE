import type { GitHubAppUserAuthRefreshError } from "../../../shared/types";
import type { GitHubAppUserTokenRecord } from "./githubAppUserAuth";

/**
 * The stored GitHub App user credential and the refresh ledger beside it, plus
 * the pure functions that read and write that record.
 *
 * Split out of the service because none of it needs the service: it is parsing,
 * serializing and defaulting, and it is what a test reaches for when it wants
 * to state "this is what the credential file holds" without building a service.
 */

export type RefreshFailureKind = GitHubAppUserAuthRefreshError["kind"];

/**
 * One refresh failure as it is written into the ledger, and the shape every
 * surface that reports a refresh failure reads.
 */
export type StoredRefreshFailure = {
  kind: RefreshFailureKind;
  message: string;
  status: number | null;
  oauthError: string | null;
  retryAfterSec: number | null;
  at: string;
};

/**
 * The persistent memory of how the last refresh went, stored INSIDE the
 * credential record so every process that reads the credential also reads the
 * backoff that applies to it.
 *
 * Without this the only coordination was a per-instance in-flight promise, and
 * a machine runs many instances: one per project scope in the desktop app, one
 * per project scope in the brain, plus the CLI. Each of them independently
 * POSTed the same refresh token, GitHub's rotation-reuse detection revoked the
 * credential, and the resulting dead token was retried by all of them until
 * GitHub rate-limited the whole OAuth host.
 */
export type RefreshLedger = {
  /** No refresh may be attempted before this instant. */
  notBeforeAt: string | null;
  consecutiveFailures: number;
  /** GitHub rejected the refresh token itself; only re-authorization fixes it. */
  dead: boolean;
  leaseUntil: string | null;
  leaseHolder: string | null;
  /** Bumped on every successful refresh, for log correlation across processes. */
  generation: number;
  lastFailure: StoredRefreshFailure | null;
};

export type StoredAppUserAuth = {
  token: GitHubAppUserTokenRecord | null;
  refresh: RefreshLedger;
};

export function emptyLedger(): RefreshLedger {
  return {
    notBeforeAt: null,
    consecutiveFailures: 0,
    dead: false,
    leaseUntil: null,
    leaseHolder: null,
    generation: 0,
    lastFailure: null,
  };
}

/** True when `iso` names an instant strictly after `cutoffMs`. */
export function readIsoAfter(iso: string | null | undefined, cutoffMs: number): boolean {
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && time > cutoffMs;
}

function trimmedOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseLedger(value: unknown): RefreshLedger {
  const base = emptyLedger();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const raw = value as Record<string, unknown>;
  const failure = raw.lastFailure && typeof raw.lastFailure === "object" && !Array.isArray(raw.lastFailure)
    ? raw.lastFailure as Record<string, unknown>
    : null;
  const kind = trimmedOrNull(failure?.kind);
  return {
    notBeforeAt: trimmedOrNull(raw.notBeforeAt),
    consecutiveFailures: typeof raw.consecutiveFailures === "number" && Number.isFinite(raw.consecutiveFailures)
      ? Math.max(0, Math.trunc(raw.consecutiveFailures))
      : 0,
    dead: raw.dead === true,
    leaseUntil: trimmedOrNull(raw.leaseUntil),
    leaseHolder: trimmedOrNull(raw.leaseHolder),
    generation: typeof raw.generation === "number" && Number.isFinite(raw.generation)
      ? Math.max(0, Math.trunc(raw.generation))
      : 0,
    lastFailure: failure && kind
      ? {
        kind: kind as RefreshFailureKind,
        message: trimmedOrNull(failure.message) ?? "GitHub refused to renew the ADE GitHub App authorization.",
        status: typeof failure.status === "number" && Number.isFinite(failure.status)
          ? Math.trunc(failure.status)
          : null,
        oauthError: trimmedOrNull(failure.oauthError),
        retryAfterSec: typeof failure.retryAfterSec === "number" && Number.isFinite(failure.retryAfterSec)
          ? Math.max(0, Math.trunc(failure.retryAfterSec))
          : null,
        at: trimmedOrNull(failure.at) ?? new Date().toISOString(),
      }
      : null,
  };
}

export function parseStoredAppUserAuth(raw: string): StoredAppUserAuth {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const accessToken = trimmedOrNull(parsed.accessToken);
  const refresh = parseLedger(parsed.refresh);
  if (!accessToken) return { token: null, refresh };
  return {
    token: {
      accessToken,
      tokenType: trimmedOrNull(parsed.tokenType) ?? "bearer",
      scope: trimmedOrNull(parsed.scope),
      expiresAt: trimmedOrNull(parsed.expiresAt),
      refreshToken: trimmedOrNull(parsed.refreshToken),
      refreshTokenExpiresAt: trimmedOrNull(parsed.refreshTokenExpiresAt),
      userLogin: trimmedOrNull(parsed.userLogin),
      updatedAt: trimmedOrNull(parsed.updatedAt) ?? new Date().toISOString(),
    },
    refresh,
  };
}

export function serializeStoredAppUserAuth(stored: StoredAppUserAuth): string | null {
  if (!stored.token) return null;
  return JSON.stringify({ ...stored.token, refresh: stored.refresh });
}
