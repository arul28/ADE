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
  ): Promise<T>;
  /** The running send for this chat wrote the user's message. */
  noteMessageWritten(sessionId: string): void;
};

type SendScope = { sessionId: string; written: boolean };

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
      const scope: SendScope = { sessionId, written: false };
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
  };
}
