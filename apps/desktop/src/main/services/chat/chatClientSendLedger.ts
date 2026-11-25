import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Recognizes a retried user send by the id its client gave it
 * (`clientSendId`), so a retry of a message the brain already took is a no-op
 * that answers with the first send's result instead of a second message.
 *
 * A send is "taken" once it wrote the user's message into the transcript
 * (`noteMessageWritten`, called for every `user_message` event). That is the
 * point after which a retry would duplicate it: a provider that times out
 * *after* the message was written (Codex `turn/start` on a slow cloud
 * computer) used to fail the call, and the caller's retry then sent the same
 * words again. A send that failed before writing anything is forgotten, so its
 * retry runs. A retry that arrives while the first copy is still running waits
 * for it and then follows the same rule.
 *
 * In memory, per brain: a brain restart forgets the ids (the window it guards
 * is a few seconds to minutes of client retries).
 */
/** The longest client send id ADE keeps; a longer one is cut to this. */
export const CLIENT_SEND_ID_MAX_LENGTH = 128;

/**
 * A client send id as ADE keys it: a string, trimmed, at most
 * `CLIENT_SEND_ID_MAX_LENGTH` long. Anything else (absent, empty, not a
 * string) is no id, and the send runs as an older client's would.
 */
export function normalizeClientSendId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().slice(0, CLIENT_SEND_ID_MAX_LENGTH);
  return id.length ? id : null;
}

/**
 * A send that reached the host this much after the person pressed Enter was
 * held on the way (its computer woke, its ADE started). Below it the host's
 * own time is as good, and two computers' clocks can differ by a few seconds.
 */
const HELD_SEND_MIN_MS = 5_000;
/** Longer than any wake or start wait: a send time older than this is a client clock that is off. */
const HELD_SEND_MAX_MS = 60 * 60_000;

/**
 * The person's send time to write on the message (`user_message.sentAt`), or
 * null when the send was not held: no client time, a time in the future, one
 * within a few seconds of `receivedAtMs`, or one too old to be a wait.
 */
export function heldSendSentAt(clientSubmittedAtMs: unknown, receivedAtMs: number): string | null {
  if (typeof clientSubmittedAtMs !== "number" || !Number.isFinite(clientSubmittedAtMs)) return null;
  const heldMs = receivedAtMs - clientSubmittedAtMs;
  if (heldMs < HELD_SEND_MIN_MS || heldMs > HELD_SEND_MAX_MS) return null;
  return new Date(Math.round(clientSubmittedAtMs)).toISOString();
}

export type ClientSendLedger = {
  /**
   * Run `send` once per `(sessionId, clientSendId)`. The id is normalized
   * here (`normalizeClientSendId`); without one, `send` always runs (older
   * clients keep today's behavior). `whenTakenWithoutResult`
   * answers a retry of a send that wrote its message and then threw.
   */
  run<T>(
    sessionId: string,
    clientSendId: unknown,
    send: () => Promise<T>,
    whenTakenWithoutResult: () => T,
    /** `sentAt`: when the person sent it, for a send held on the way (`user_message.sentAt`). */
    extras?: { sentAt?: string | null },
  ): Promise<T>;
  /** The running send for this chat wrote the user's message. */
  noteMessageWritten(sessionId: string): void;
  /**
   * The running send's id for this chat, once: the first person's message it
   * writes carries the id (`user_message.clientSendId`). Null outside a send
   * with an id, for another chat, or after the first claim.
   */
  claimSendId(sessionId: string): string | null;
  /**
   * The running send's `sentAt` for this chat (the `extras` of `run`), read
   * with the claim of its id so it lands on the same message. Null outside a
   * send, for another chat, or for a send that was not held.
   */
  sentAtOf(sessionId: string): string | null;
  /** Runs `work` outside any send, so a message it writes (a `/compact` before the send) is not the send's. */
  outsideSend<T>(work: () => T): T;
};

type SendScope = { sessionId: string; id: string; written: boolean; claimed: boolean; sentAt: string | null };

type LedgerEntry =
  | { state: "running"; settled: Promise<void> }
  | { state: "taken"; at: number; result: { value: unknown } | null };

export function createClientSendLedger(options: {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
  onDuplicate?: (info: { sessionId: string; clientSendId: string }) => void;
}): ClientSendLedger {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 4096;
  const entries = new Map<string, LedgerEntry>();
  const scopes = new AsyncLocalStorage<SendScope>();

  const expired = (entry: LedgerEntry): boolean => entry.state === "taken" && entry.at < now() - options.ttlMs;

  /**
   * Record an entry as the newest, then drop from the oldest end what has
   * expired or is over `maxEntries`. A taken entry is re-inserted when it
   * settles, so the map runs oldest-first and the walk stops at the first
   * live taken entry once the ledger is within its cap. Running sends are
   * never dropped.
   */
  const put = (key: string, entry: LedgerEntry): void => {
    entries.delete(key);
    entries.set(key, entry);
    for (const [oldKey, oldEntry] of entries) {
      if (oldEntry.state === "running") continue;
      if (!expired(oldEntry) && entries.size <= maxEntries) break;
      entries.delete(oldKey);
    }
  };

  return {
    async run<T>(
      sessionId: string,
      clientSendId: unknown,
      send: () => Promise<T>,
      whenTakenWithoutResult: () => T,
      extras?: { sentAt?: string | null },
    ): Promise<T> {
      const id = normalizeClientSendId(clientSendId);
      if (!id) return send();
      const key = `${sessionId}\u0000${id}`;
      for (;;) {
        const entry = entries.get(key);
        if (entry && expired(entry)) entries.delete(key);
        if (!entry || expired(entry)) break;
        if (entry.state === "running") {
          await entry.settled;
          continue;
        }
        options.onDuplicate?.({ sessionId, clientSendId: id });
        return entry.result ? entry.result.value as T : whenTakenWithoutResult();
      }
      let settle = (): void => {};
      put(key, { state: "running", settled: new Promise<void>((resolve) => { settle = resolve; }) });
      const scope: SendScope = { sessionId, id, written: false, claimed: false, sentAt: extras?.sentAt ?? null };
      try {
        const value = await scopes.run(scope, send);
        put(key, { state: "taken", at: now(), result: { value } });
        return value;
      } catch (error) {
        if (scope.written) put(key, { state: "taken", at: now(), result: null });
        else entries.delete(key);
        throw error;
      } finally {
        settle();
      }
    },
    noteMessageWritten(sessionId) {
      const scope = scopes.getStore();
      if (scope && scope.sessionId === sessionId) scope.written = true;
    },
    claimSendId(sessionId) {
      const scope = scopes.getStore();
      if (!scope || scope.sessionId !== sessionId || scope.claimed) return null;
      scope.claimed = true;
      return scope.id;
    },
    sentAtOf(sessionId) {
      const scope = scopes.getStore();
      return scope && scope.sessionId === sessionId ? scope.sentAt : null;
    },
    outsideSend(work) {
      return scopes.exit(work);
    },
  };
}
