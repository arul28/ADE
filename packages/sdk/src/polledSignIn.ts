import type { AccountInfo, SignInHandle, SignInStatus } from "./accounts.js";
import { AdeError } from "./errors.js";

/** What a bridge's `accounts.signInStatus` answers. */
export type PolledSignInResult<E> = { status: SignInStatus; account?: AccountInfo; error?: E };

export type PolledSignInOps<E> = {
  status(loginId: string): Promise<PolledSignInResult<E>>;
  submitCode(loginId: string, code: string): Promise<void>;
  cancel(loginId: string): Promise<void>;
  /** Turn a serialized error back into the error the handle rejects with. */
  toError(error: E): Error;
};

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);

/**
 * A `SignInHandle` for a sign-in that lives across a bridge (Electron IPC or
 * the WebSocket server): the process that owns the real handle keeps it, and
 * this side polls its status with backoff until it ends.
 */
export function createPolledSignIn<E>(
  started: { loginId: string; status: SignInStatus },
  ops: PolledSignInOps<E>,
): SignInHandle {
  const listeners = new Set<(status: SignInStatus) => void>();
  let current = started.status;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  let delay = 500;
  let resolveDone!: (account: AccountInfo) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<AccountInfo>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // A host that only awaits `done` after an update must not see an unhandled rejection first.
  done.catch(() => {});
  const publish = (status: SignInStatus) => {
    current = status;
    for (const listener of [...listeners]) {
      try { listener(status); } catch { /* Isolate embedder callbacks. */ }
    }
  };
  const finish = (result: PolledSignInResult<E>) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    timer = null;
    publish(result.status);
    if (result.account) resolveDone(result.account);
    else if (result.error !== undefined) rejectDone(ops.toError(result.error));
    else rejectDone(new AdeError("rpc_error", result.status.message ?? `Sign-in ${result.status.state}.`));
  };
  const poll = async (): Promise<void> => {
    if (finished) return;
    try {
      const result = await ops.status(started.loginId);
      if (JSON.stringify(result.status) !== JSON.stringify(current)) publish(result.status);
      if (TERMINAL.has(result.status.state)) {
        finish(result);
        return;
      }
      delay = Math.min(5_000, delay * 1.5);
    } catch (error) {
      if (finished) return;
      finish({ status: { ...current, state: "failed", message: error instanceof Error ? error.message : String(error) } });
      return;
    }
    timer = setTimeout(() => { void poll(); }, delay);
  };
  if (TERMINAL.has(current.state)) void poll();
  else timer = setTimeout(() => { void poll(); }, delay);
  return {
    on: (_event, listener) => {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    submitCode: async (code) => { await ops.submitCode(started.loginId, code); },
    cancel: async () => {
      if (finished) return;
      await ops.cancel(started.loginId);
      finish({ status: { ...current, state: "cancelled", endedAt: new Date().toISOString() } });
    },
    done,
  };
}
