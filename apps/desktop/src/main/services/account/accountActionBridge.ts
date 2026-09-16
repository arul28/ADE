import type { AccountStoreResult } from "../../../shared/types/accountStore";

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
  const unavailable = <T>(): AccountStoreResult<T> => ({
    ok: false,
    unavailable: true,
    message: options.unavailableMessage,
  });

  const call = async <T>(
    action: string,
    argsList: unknown[],
    decode: (raw: unknown) => T,
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
      return { ok: true, value: decode(unwrap(response?.result)) };
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
