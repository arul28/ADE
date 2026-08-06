/**
 * Crash-safe rotation journal for the machine-shared account session.
 *
 * A rotating refresh grant is consumed by the identity provider the moment the
 * exchange is accepted, but the replacement only becomes durable once it is
 * written back. A crash, a kill, or a wedge inside that window burns the token
 * family with nothing on disk to say so, and the next refresh gets a perfectly
 * truthful `invalid_grant` that looks exactly like a stolen or revoked session.
 * The journal closes the gap: it records that an exchange was STARTED against a
 * specific token generation, and is cleared once the replacement is durable. An
 * entry that survives means "the stored token may already have been consumed" —
 * the one `invalid_grant` that follows is not definitive.
 */

import type { SyncCredentialStore } from "../credentials/credentialStore";
import type {
  AccountSessionMutationAction,
  AccountSessionMutationSource,
} from "./accountAuthService";

/**
 * Sibling key to the session record. It records that a token exchange was
 * STARTED against a specific stored refresh token, so a process that later sees
 * `invalid_grant` can tell "this grant is dead" from "a peer (or a previous run
 * of this process) may already have consumed it and died before it could
 * persist the replacement".
 */
export const ACCOUNT_SESSION_ROTATION_JOURNAL_KEY = "account.session.rotation.v1";

export type RotationJournalEntry = {
  oldRefreshTokenHash: string;
  startedAt: string;
  pid: number;
  source: AccountSessionMutationSource | null;
  userId: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseRotationJournal(
  raw: string | null | undefined,
): RotationJournalEntry | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = asRecord(JSON.parse(raw));
    const oldRefreshTokenHash = readNonEmptyString(parsed.oldRefreshTokenHash);
    const startedAt = readNonEmptyString(parsed.startedAt);
    if (parsed.version !== 1 || !oldRefreshTokenHash || !startedAt) return null;
    const source = readNonEmptyString(parsed.source);
    return {
      oldRefreshTokenHash,
      startedAt,
      pid: typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) ? parsed.pid : 0,
      source: source === "brain" || source === "cli" || source === "desktop" ? source : null,
      userId: readNonEmptyString(parsed.userId),
    };
  } catch {
    return null;
  }
}

export type RotationJournalArgs = {
  credentialStore: SyncCredentialStore;
  /** Clock, so tests can pin `startedAt`. */
  now: () => number;
  /** Process that owns the entry, for attributed audit logging. */
  pid: number;
  source: AccountSessionMutationSource | null;
  /** One attributed audit line per journal mutation. */
  log: (entry: {
    action: AccountSessionMutationAction;
    reason: string;
    tokenGeneration?: string | null;
  }) => void;
};

export type RotationJournal = {
  read: () => RotationJournalEntry | null;
  write: (entry: { oldRefreshTokenHash: string; userId: string | null }) => void;
  /**
   * `expectedTokenGeneration` scopes the clear to OUR entry. A peer may have
   * started its own rotation against a newer generation while ours was in
   * flight; erasing that entry would strip the crash protection from an
   * exchange still running elsewhere. Callers that replace the whole session
   * (sign-in, sign-out) omit it — every journal is moot at that point.
   */
  clear: (reason: string, expectedTokenGeneration?: string | null) => void;
};

export function createRotationJournal(args: RotationJournalArgs): RotationJournal {
  const read = (): RotationJournalEntry | null => {
    try {
      return parseRotationJournal(
        args.credentialStore.getSync(ACCOUNT_SESSION_ROTATION_JOURNAL_KEY),
      );
    } catch {
      // A journal is an optimization over correctness-by-deletion. Never let
      // reading it fail a refresh.
      return null;
    }
  };

  const write = (entry: { oldRefreshTokenHash: string; userId: string | null }): void => {
    try {
      args.credentialStore.setSync(
        ACCOUNT_SESSION_ROTATION_JOURNAL_KEY,
        JSON.stringify({
          version: 1,
          oldRefreshTokenHash: entry.oldRefreshTokenHash,
          startedAt: new Date(args.now()).toISOString(),
          pid: args.pid,
          source: args.source,
          userId: entry.userId,
        }),
      );
      args.log({
        action: "rotation_journal_begin",
        reason: "refresh_exchange_started",
        tokenGeneration: entry.oldRefreshTokenHash,
      });
    } catch {
      // Best effort: without a journal this refresh simply behaves the way it
      // did before, so a store write failure must not block the exchange.
    }
  };

  const clear = (reason: string, expectedTokenGeneration?: string | null): void => {
    try {
      const existing = parseRotationJournal(
        args.credentialStore.getSync(ACCOUNT_SESSION_ROTATION_JOURNAL_KEY),
      );
      if (!existing) return;
      if (
        expectedTokenGeneration != null
        && existing.oldRefreshTokenHash !== expectedTokenGeneration
      ) {
        return;
      }
      args.credentialStore.deleteSync(ACCOUNT_SESSION_ROTATION_JOURNAL_KEY);
      args.log({
        action: "rotation_journal_clear",
        reason,
        tokenGeneration: existing.oldRefreshTokenHash,
      });
    } catch {
      // A stale journal only costs one extra rotation-wait cycle later.
    }
  };

  return { read, write, clear };
}
