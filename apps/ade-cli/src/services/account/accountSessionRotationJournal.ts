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
 *
 * The same entry is also a mutex. Clerk refresh tokens are single-use: two
 * live processes that both POST `/oauth/token` against one generation will
 * make the loser look signed out. `tryBegin` compare-and-swaps the journal so
 * a live peer's in-flight exchange is waited out, not raced.
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

/**
 * A live foreign pid alone is not enough: OS pid reuse or a wedged owner can
 * leave a journal that blocks every peer forever. Entries older than this are
 * treated as interruptable takeovers instead of peer_in_flight. Sized above the
 * credential-store lock + rotation wait window so a healthy peer still wins.
 */
export const ROTATION_JOURNAL_PEER_MAX_AGE_MS = 120_000;

export type RotationJournalEntry = {
  oldRefreshTokenHash: string;
  startedAt: string;
  pid: number;
  source: AccountSessionMutationSource | null;
  userId: string | null;
};

export type RotationJournalBeginResult =
  | { kind: "acquired"; takeover: boolean }
  | { kind: "peer_in_flight"; entry: RotationJournalEntry };

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

function describeJournalPeer(entry: RotationJournalEntry): string {
  return `started_at:${entry.startedAt} pid:${entry.pid} source:${entry.source ?? "unknown"}`;
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists; this caller just cannot signal it. Treat it
    // as live so we do not steal a refresh that is still in flight.
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
    level?: "info" | "warn";
    outcome?: string;
  }) => void;
  /**
   * Whether a journaled pid is still running. Tests inject this so a fixture
   * pid cannot be mistaken for a live peer on the host.
   */
  pidAlive?: (pid: number) => boolean;
};

export type RotationJournal = {
  read: () => RotationJournalEntry | null;
  /**
   * Compare-and-swap begin. A live peer's journal for this (or any) generation
   * is left untouched and reported as `peer_in_flight` so the caller waits
   * instead of burning the rotating grant at Clerk. A dead peer's journal is
   * taken over and treated as an interrupted rotation.
   */
  tryBegin: (entry: {
    oldRefreshTokenHash: string;
    userId: string | null;
  }) => RotationJournalBeginResult;
  /**
   * `expectedTokenGeneration` scopes the clear to OUR entry. A peer may have
   * started its own rotation against a newer generation while ours was in
   * flight; erasing that entry would strip the crash protection from an
   * exchange still running elsewhere. Callers that replace the whole session
   * (sign-in, sign-out) omit it — every journal is moot at that point.
   */
  clear: (reason: string, expectedTokenGeneration?: string | null) => void;
};

type BeginDecision =
  | { kind: "write"; takeover: boolean }
  | { kind: "already_ours" }
  | { kind: "peer_in_flight"; entry: RotationJournalEntry };

export function createRotationJournal(args: RotationJournalArgs): RotationJournal {
  const pidAlive = args.pidAlive ?? defaultPidAlive;

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

  const serialize = (entry: { oldRefreshTokenHash: string; userId: string | null }): string =>
    JSON.stringify({
      version: 1,
      oldRefreshTokenHash: entry.oldRefreshTokenHash,
      startedAt: new Date(args.now()).toISOString(),
      pid: args.pid,
      source: args.source,
      userId: entry.userId,
    });

  const decide = (
    existing: RotationJournalEntry | null,
    entry: { oldRefreshTokenHash: string; userId: string | null },
  ): BeginDecision => {
    if (!existing) return { kind: "write", takeover: false };
    if (existing.pid === args.pid && existing.oldRefreshTokenHash === entry.oldRefreshTokenHash) {
      return { kind: "already_ours" };
    }
    const peerAgeMs = args.now() - Date.parse(existing.startedAt);
    const peerFresh = Number.isFinite(peerAgeMs)
      && peerAgeMs >= 0
      && peerAgeMs < ROTATION_JOURNAL_PEER_MAX_AGE_MS;
    if (existing.pid !== args.pid && pidAlive(existing.pid) && peerFresh) {
      return { kind: "peer_in_flight", entry: existing };
    }
    return {
      kind: "write",
      takeover: existing.oldRefreshTokenHash === entry.oldRefreshTokenHash
        && existing.pid !== args.pid,
    };
  };

  const persistBegin = (entry: { oldRefreshTokenHash: string; userId: string | null }): void => {
    try {
      args.credentialStore.setSync(
        ACCOUNT_SESSION_ROTATION_JOURNAL_KEY,
        serialize(entry),
      );
    } catch {
      // Best effort: without a journal this refresh simply behaves the way it
      // did before, so a store write failure must not block the exchange.
    }
  };

  const finalizeBegin = (
    decision: BeginDecision,
    entry: { oldRefreshTokenHash: string; userId: string | null },
    options: { alreadyPersisted?: boolean } = {},
  ): RotationJournalBeginResult => {
    if (decision.kind === "peer_in_flight") {
      args.log({
        action: "rotation_journal_interrupted",
        reason: "peer_refresh_in_flight",
        tokenGeneration: entry.oldRefreshTokenHash,
        level: "warn",
        outcome: describeJournalPeer(decision.entry),
      });
      return decision;
    }
    if (decision.kind === "already_ours") {
      return { kind: "acquired", takeover: false };
    }
    if (decision.takeover) {
      args.log({
        action: "rotation_journal_interrupted",
        reason: "dead_peer_journal_taken_over",
        tokenGeneration: entry.oldRefreshTokenHash,
        level: "warn",
      });
    }
    if (!options.alreadyPersisted) {
      persistBegin(entry);
    }
    args.log({
      action: "rotation_journal_begin",
      reason: "refresh_exchange_started",
      tokenGeneration: entry.oldRefreshTokenHash,
    });
    return { kind: "acquired", takeover: decision.takeover };
  };

  const tryBegin = (entry: {
    oldRefreshTokenHash: string;
    userId: string | null;
  }): RotationJournalBeginResult => {
    try {
      // `updateKeySync` first: the routed desktop store cannot answer a
      // whole-map updater, but it can always say which file one key lives in.
      const updateKeySync = args.credentialStore.updateKeySync;
      const updateSync = args.credentialStore.updateSync;
      if (!updateKeySync && !updateSync) {
        return finalizeBegin(decide(read(), entry), entry);
      }

      let decision: BeginDecision | undefined;
      if (updateKeySync) {
        updateKeySync.call(
          args.credentialStore,
          ACCOUNT_SESSION_ROTATION_JOURNAL_KEY,
          (current) => {
            decision = decide(parseRotationJournal(current), entry);
            if (decision.kind === "peer_in_flight" || decision.kind === "already_ours") {
              return undefined;
            }
            return serialize(entry);
          },
        );
      } else if (updateSync) {
        updateSync.call(args.credentialStore, (values) => {
          const existing = parseRotationJournal(values[ACCOUNT_SESSION_ROTATION_JOURNAL_KEY]);
          decision = decide(existing, entry);
          if (decision.kind === "peer_in_flight" || decision.kind === "already_ours") {
            return false;
          }
          values[ACCOUNT_SESSION_ROTATION_JOURNAL_KEY] = serialize(entry);
          return true;
        });
      }
      if (!decision) {
        // The store declined to run the updater. Proceed without a journal
        // rather than blocking the exchange.
        return { kind: "acquired", takeover: false };
      }
      return finalizeBegin(decision, entry, {
        alreadyPersisted: decision.kind === "write",
      });
    } catch {
      return { kind: "acquired", takeover: false };
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

  return { read, tryBegin, clear };
}
