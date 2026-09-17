import {
  createAccountStoreResultHelpers,
  type AccountStoreResult,
} from "../../../shared/types/accountStore";

type ActionRequest = {
  domain: string;
  action: string;
  args?: Record<string, unknown>;
  argsList?: unknown[];
};

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

type CallOptions = {
  /** Treat a bare false action result as a rejected write. */
  rejectFalse?: boolean;
};

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
      const response = await pool.callActionForRoot(rootPath, {
        domain: options.domain,
        action,
        argsList,
      });
      const raw = unwrap(response?.result);
      if (callOptions.rejectFalse && raw === false) return rejected<T>();
      return { ok: true, value: decode(raw) };
    } catch (error) {
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
