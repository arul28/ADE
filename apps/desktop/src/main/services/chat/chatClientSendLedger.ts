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
export type ClientSendLedger = {
  /**
   * Run `send` once per `(sessionId, clientSendId)`. Without an id, `send`
   * always runs (older clients keep today's behavior). `whenTakenWithoutResult`
   * answers a retry of a send that wrote its message and then threw.
   */
  run<T>(
    sessionId: string,
    clientSendId: string | null | undefined,
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

  const prune = (): void => {
    const cutoff = now() - options.ttlMs;
    for (const [key, entry] of entries) {
      if (entry.state === "taken" && (entry.at < cutoff || entries.size > maxEntries)) entries.delete(key);
    }
  };

  return {
    async run(sessionId, clientSendId, send, whenTakenWithoutResult) {
      const id = clientSendId?.trim();
      if (!id) return send();
      const key = `${sessionId}\u0000${id}`;
      prune();
      for (;;) {
        const entry = entries.get(key);
        if (!entry) break;
        if (entry.state === "running") {
          await entry.settled;
          continue;
        }
        options.onDuplicate?.({ sessionId, clientSendId: id });
        return entry.result ? entry.result.value as T : whenTakenWithoutResult();
      }
      let settle = (): void => {};
      entries.set(key, { state: "running", settled: new Promise<void>((resolve) => { settle = resolve; }) });
      const scope: SendScope = { sessionId, written: false };
      try {
        const value = await scopes.run(scope, send);
        entries.set(key, { state: "taken", at: now(), result: { value } });
        return value;
      } catch (error) {
        if (scope.written) entries.set(key, { state: "taken", at: now(), result: null });
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
