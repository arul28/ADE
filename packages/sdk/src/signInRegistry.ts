import type { AccountInfo, SignInHandle, SignInStatus } from "./accounts.js";
import { AdeError } from "./errors.js";
import type { Unsubscribe } from "./types.js";

const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled", "expired"]);

/**
 * The host side of a sign-in that a renderer or a browser follows across a
 * bridge (Electron IPC, the WebSocket server). The real `SignInHandle` stays
 * here; the far side polls `status` with the login id, and only the owner that
 * started a sign-in may read, answer or cancel it.
 *
 * `O` is whatever identifies an owner on that bridge (a webContents id, a
 * socket), and `E` is how the bridge serializes an error.
 */
export function createSignInRegistry<O, E>(serializeError: (error: unknown) => E) {
  type Entry = {
    owner: O;
    handle: SignInHandle;
    status: SignInStatus;
    stop: Unsubscribe;
    result: Promise<{ account?: AccountInfo; error?: E }>;
  };
  const entries = new Map<string, Entry>();

  const forget = (loginId: string, entry: Entry): void => {
    entries.delete(loginId);
    entry.stop();
  };
  const owned = (loginId: string, owner: O): Entry | null => {
    const entry = entries.get(loginId);
    return entry && entry.owner === owner ? entry : null;
  };

  return {
    /** Track a sign-in the client just started; answers what `signIn` returns across the bridge. */
    async start(owner: O, handle: SignInHandle): Promise<{ loginId: string; status: SignInStatus }> {
      let status = {} as SignInStatus;
      // A handle publishes its current status synchronously on subscribe.
      const stop = handle.on("update", (next) => { status = next; });
      if (!status.loginId) {
        stop();
        await handle.cancel().catch(() => {});
        throw new AdeError("protocol_error", "The sign-in did not provide its initial status.");
      }
      entries.set(status.loginId, {
        owner,
        handle,
        get status() { return status; },
        stop,
        result: handle.done.then((account) => ({ account }), (error) => ({ error: serializeError(error) })),
      } as Entry);
      return { loginId: status.loginId, status };
    },

    /** The latest status; once it is terminal, also the outcome, and the entry is released. */
    async status(owner: O, loginId: string): Promise<{ status: SignInStatus; account?: AccountInfo; error?: E }> {
      const entry = owned(loginId, owner);
      if (!entry) throw new AdeError("invalid_option", `Sign-in "${loginId}" was not found.`);
      if (!TERMINAL_STATES.has(entry.status.state)) return { status: entry.status };
      const result = await entry.result;
      forget(loginId, entry);
      return { status: entry.status, ...result };
    },

    async submitCode(owner: O, loginId: string, code: string): Promise<void> {
      const entry = owned(loginId, owner);
      if (!entry) throw new AdeError("invalid_option", "This sign-in is no longer active.");
      await entry.handle.submitCode(code);
    },

    /** Cancelling a sign-in that is already gone is not an error. */
    async cancel(owner: O, loginId: string): Promise<void> {
      const entry = owned(loginId, owner);
      if (!entry) return;
      forget(loginId, entry);
      await entry.handle.cancel();
    },

    /** Cancel every sign-in an owner started: it went away and can no longer finish them. */
    releaseOwner(owner: O): void {
      for (const [loginId, entry] of entries) {
        if (entry.owner !== owner) continue;
        forget(loginId, entry);
        void entry.handle.cancel().catch(() => {});
      }
    },
  };
}

export type SignInRegistry<O, E> = ReturnType<typeof createSignInRegistry<O, E>>;
