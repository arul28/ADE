import {
  createAccountStoreResultHelpers,
  type AccountStoreResult,
  type AccountStoreWriteOptions,
} from "../../../shared/types/accountStore";

type ActionRequest = {
  domain: string;
  action: string;
  args?: Record<string, unknown>;
  argsList?: unknown[];
};

/**
 * The longest this machine waits for the brain to answer one account-store
 * call before it answers for itself.
 *
 * Every method the brain serves for this family is local file work — the
 * machine's own cache is the fast path and only `sync` ever touches the relay
 * — so a couple of seconds is already far more than any of them should need.
 * Without a bound the wait ran all the way to the renderer's 30-second IPC
 * timer, which is how a stalled runtime turned a theme preference into
 * `IPC handler for 'ade.accountSettings.sync' timed out after 30000ms` for six
 * users across 1.2.104–1.2.107. The value matches the bound the machine-read
 * path already uses for the same shape (a machine-level read borrowed from a
 * booted project scope) and sits far enough under that IPC timer to leave room
 * for project setup, the transport and result delivery.
 *
 * Giving up on the wait does not cancel the brain's work: a JSON-RPC timeout
 * drops the caller's pending entry and the daemon runs the handler to the end,
 * so a `sync` that outlives this bound still flushes its queue and persists its
 * cursor. That is also what makes the same bound safe on the write path — the
 * local LWW row and its queue entry are written before the relay is involved
 * at all, and a mutation the daemon never received is one the caller still
 * holds locally and retries.
 */
export const ACCOUNT_ACTION_TIMEOUT_MS = 8_000;

/**
 * `sync` is the one action that is network work: it uploads this machine's
 * queue and pulls up to `MAX_PULL_PAGES` relay pages, after the brain may have
 * had to connect. On a slow link that routinely outlives the 8s bound above,
 * so every sync answered "unavailable" and the caller never learned it had
 * synced. This budget is still under the renderer's 30-second IPC timer, so the
 * ordinary unavailable answer lands before the opaque IPC timeout does.
 */
export const ACCOUNT_ACTION_SYNC_TIMEOUT_MS = 25_000;

/** The deadline fired: the brain did not answer, which is not a brain error. */
class AccountActionDeadlineError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The background service did not answer within ${timeoutMs}ms.`);
    this.name = "AccountActionDeadlineError";
  }
}

/**
 * `work`'s value, or a rejection once `timeoutMs` pass. The timer never keeps
 * the process alive.
 *
 * Both handlers are attached up front, so a rejection that arrives after the
 * deadline is still handled here rather than surfacing as an unhandled one.
 */
function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AccountActionDeadlineError(timeoutMs)),
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export type AccountActionPool = {
  callActionForRoot(
    rootPath: string,
    request: ActionRequest,
  ): Promise<{ result: unknown }>;
};

export type AccountActionBridgeOptions<TRow> = {
  /** The account action domain served by the brain. */
  domain: string;
  /** The ordinary result returned when the brain cannot be reached. */
  unavailableMessage: string;
  /** The local runtime pool, or null when desktop runs without a brain. */
  getPool: () => AccountActionPool | null | undefined;
  /** Any booted project root that can reach the machine store. */
  getRootPath: () => string | null;
  logger?: { debug?(message: string, meta?: Record<string, unknown>): void };
  /** Decode one row and return null for an invalid wire value. */
  decodeRow: (value: unknown) => TRow | null;
  /** The message returned when the store rejects a mutation. */
  rejectedMessage?: string;
};

type CallOptions = AccountStoreWriteOptions & {
  /** Treat a bare false action result as a rejected write. */
  rejectFalse?: boolean;
  /** Device id allowed to rotate a vaulted refresh grant. */
  refreshOwner?: string | null;
};

function writeOptionsArg(callOptions: CallOptions): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  if (callOptions.expectedAccountUserId !== undefined) {
    extra.expectedAccountUserId = callOptions.expectedAccountUserId;
  }
  if (callOptions.refreshOwner !== undefined) {
    extra.refreshOwner = callOptions.refreshOwner;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The brain answers `{ domain, action, result }`; older paths answer bare. */
function unwrap(raw: unknown): unknown {
  return isRecord(raw) && typeof raw.domain === "string" && "result" in raw
    ? raw.result
    : raw;
}

export function createAccountActionBridge<TRow>(options: AccountActionBridgeOptions<TRow>) {
  const { unavailable, rejected } = createAccountStoreResultHelpers({
    unavailableMessage: options.unavailableMessage,
    rejectedMessage: options.rejectedMessage
      ?? "The account store rejected this write because account ownership changed.",
  });

  const call = async <T>(
    action: string,
    argsList: unknown[],
    decode: (raw: unknown) => T,
    callOptions: CallOptions = {},
  ): Promise<AccountStoreResult<T>> => {
    try {
      const pool = options.getPool();
      if (!pool) return unavailable<T>();
      const rootPath = options.getRootPath();
      if (!rootPath) return unavailable<T>();
      const extra = writeOptionsArg(callOptions);
      const response = await withDeadline(
        pool.callActionForRoot(rootPath, {
          domain: options.domain,
          action,
          argsList: extra ? [...argsList, extra] : argsList,
        }),
        action === "sync" ? ACCOUNT_ACTION_SYNC_TIMEOUT_MS : ACCOUNT_ACTION_TIMEOUT_MS,
      );
      const raw = unwrap(response?.result);
      if (callOptions.rejectFalse && raw === false) return rejected<T>();
      return { ok: true, value: decode(raw) };
    } catch (error) {
      // A brain that did not answer in time is the same ordinary answer as one
      // that is not there at all: this machine keeps its local copy and syncs
      // later. It is not a failure of the write, so it must not read as one.
      if (error instanceof AccountActionDeadlineError) {
        options.logger?.debug?.(`${options.domain}.call_timed_out`, {
          action,
          timeoutMs: error.timeoutMs,
        });
        return unavailable<T>();
      }
      const message = error instanceof Error ? error.message : String(error ?? "");
      options.logger?.debug?.(`${options.domain}.call_failed`, { action, error: message });
      return {
        ok: false,
        unavailable: true,
        message: message || options.unavailableMessage,
      };
    }
  };

  return {
    async list(scope?: string | null): Promise<AccountStoreResult<TRow[]>> {
      return await call(
        "list",
        scope ? [scope] : [],
        (raw) => (Array.isArray(raw)
          ? raw.map(options.decodeRow).filter((row): row is TRow => row !== null)
          : []),
      );
    },

    call,
  };
}
