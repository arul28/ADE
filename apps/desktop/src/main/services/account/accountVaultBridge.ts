/**
 * Desktop main's route to the account vault store that lives in the brain.
 *
 * The vault is machine-local first, but its cache is synchronized by the
 * runtime. This module keeps the desktop transport narrow and turns a missing
 * or restarting brain into an ordinary unavailable result rather than a
 * rejected renderer call.
 */

import type {
  AccountVaultItem,
  AccountVaultResult,
} from "../../../shared/types/accountVault";

export type { AccountVaultItem, AccountVaultResult };

export const ACCOUNT_VAULT_UNAVAILABLE_MESSAGE =
  "ADE's background service isn't running on this computer, so account vault items stay on this machine for now.";

type ActionRequest = {
  domain: string;
  action: string;
  args?: Record<string, unknown>;
  argsList?: unknown[];
};

export type AccountVaultActionPool = {
  callActionForRoot(
    rootPath: string,
    request: ActionRequest,
  ): Promise<{ result: unknown }>;
};

export type AccountVaultBridgeOptions = {
  /** The local runtime pool, or null when desktop runs with no brain. */
  getPool: () => AccountVaultActionPool | null | undefined;
  /** Any booted project root; null when none is open yet. */
  getRootPath: () => string | null;
  logger?: { debug?(message: string, meta?: Record<string, unknown>): void };
};

function unavailable<T>(message?: string): AccountVaultResult<T> {
  return {
    ok: false,
    unavailable: true,
    message: message ?? ACCOUNT_VAULT_UNAVAILABLE_MESSAGE,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The brain answers `{ domain, action, result }`; older paths answer bare. */
function unwrap(raw: unknown): unknown {
  return isRecord(raw) && "result" in raw && "domain" in raw ? raw.result : raw;
}

function toItem(value: unknown): AccountVaultItem | null {
  if (!isRecord(value)) return null;
  const scope = typeof value.scope === "string" ? value.scope : null;
  const kind = typeof value.kind === "string" ? value.kind : null;
  const key = typeof value.key === "string" ? value.key : null;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : null;
  const hasValue = Object.prototype.hasOwnProperty.call(value, "value");
  const itemValue = value.value === null || typeof value.value === "string" ? value.value : null;
  if (
    !scope
    || !kind
    || !key
    || !updatedAt
    || (hasValue && value.value !== null && typeof value.value !== "string")
  ) {
    return null;
  }
  return { scope, kind, key, value: hasValue ? itemValue : null, updatedAt };
}

export function createAccountVaultBridge(options: AccountVaultBridgeOptions) {
  const call = async <T>(
    action: "list" | "get" | "set" | "remove" | "sync",
    argsList: unknown[],
    coerce: (raw: unknown) => T,
  ): Promise<AccountVaultResult<T>> => {
    try {
      const pool = options.getPool();
      if (!pool) return unavailable<T>();
      const rootPath = options.getRootPath();
      if (!rootPath) return unavailable<T>();

      const response = await pool.callActionForRoot(rootPath, {
        domain: "account_vault",
        action,
        argsList,
      });
      return { ok: true, value: coerce(unwrap(response?.result)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "");
      options.logger?.debug?.("account_vault.call_failed", { action, error: message });
      return unavailable<T>(message || undefined);
    }
  };

  return {
    /** Every item this machine knows about in one scope, or all scopes. */
    async list(scope?: string | null): Promise<AccountVaultResult<AccountVaultItem[]>> {
      return await call(
        "list",
        scope ? [scope] : [],
        (raw) => (Array.isArray(raw) ? raw.map(toItem).filter((item): item is AccountVaultItem => item !== null) : []),
      );
    },

    async get(scope: string, kind: string, key: string): Promise<AccountVaultResult<string | null>> {
      return await call(
        "get",
        [scope, kind, key],
        (raw) => (raw === null || typeof raw === "string" ? raw : null),
      );
    },

    async set(scope: string, kind: string, key: string, value: string): Promise<AccountVaultResult<null>> {
      return await call("set", [scope, kind, key, value], () => null);
    },

    async remove(scope: string, kind: string, key: string): Promise<AccountVaultResult<null>> {
      return await call("remove", [scope, kind, key], () => null);
    },

    /** Flush this machine's queue and take what changed. */
    async sync(): Promise<AccountVaultResult<null>> {
      return await call("sync", [], () => null);
    },
  };
}

export type AccountVaultBridge = ReturnType<typeof createAccountVaultBridge>;
