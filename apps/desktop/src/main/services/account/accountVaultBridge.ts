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
  AccountVaultWriteOptions,
} from "../../../shared/types/accountVault";
import {
  createAccountActionBridge,
  type AccountActionPool,
} from "./accountActionBridge";

export const ACCOUNT_VAULT_UNAVAILABLE_MESSAGE =
  "ADE's background service isn't running on this computer, so account vault items stay on this machine for now.";
export const ACCOUNT_VAULT_REJECTED_MESSAGE =
  "The account vault write was rejected because account ownership changed. It will be retried.";

export type AccountVaultActionPool = AccountActionPool;

export type AccountVaultBridgeOptions = {
  /** The local runtime pool, or null when desktop runs with no brain. */
  getPool: () => AccountVaultActionPool | null | undefined;
  /** Any booted project root; null when none is open yet. */
  getRootPath: () => string | null;
  logger?: { debug?(message: string, meta?: Record<string, unknown>): void };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  const refreshOwner = value.refreshOwner === null || typeof value.refreshOwner === "string"
    ? value.refreshOwner
    : undefined;
  return {
    scope,
    kind,
    key,
    value: hasValue ? itemValue : null,
    updatedAt,
    ...(refreshOwner !== undefined ? { refreshOwner } : {}),
  };
}

export function createAccountVaultBridge(options: AccountVaultBridgeOptions) {
  const bridge = createAccountActionBridge<AccountVaultItem>({
    domain: "account_vault",
    unavailableMessage: ACCOUNT_VAULT_UNAVAILABLE_MESSAGE,
    getPool: options.getPool,
    getRootPath: options.getRootPath,
    logger: options.logger,
    decodeRow: toItem,
    rejectedMessage: ACCOUNT_VAULT_REJECTED_MESSAGE,
  });

  return {
    /** Every item this machine knows about in one scope, or all scopes. */
    async list(scope?: string | null): Promise<AccountVaultResult<AccountVaultItem[]>> {
      return await bridge.list(scope);
    },

    async get(scope: string, kind: string, key: string): Promise<AccountVaultResult<string | null>> {
      return await bridge.call(
        "get",
        [scope, kind, key],
        (raw) => (raw === null || typeof raw === "string" ? raw : null),
      );
    },

    async set(
      scope: string,
      kind: string,
      key: string,
      value: string,
      options?: AccountVaultWriteOptions,
    ): Promise<AccountVaultResult<null>> {
      return await bridge.call("set", [scope, kind, key, value], () => null, {
        rejectFalse: true,
        ...options,
      });
    },

    async remove(
      scope: string,
      kind: string,
      key: string,
      options?: AccountVaultWriteOptions,
    ): Promise<AccountVaultResult<null>> {
      return await bridge.call("remove", [scope, kind, key], () => null, {
        rejectFalse: true,
        ...options,
      });
    },

    /** Flush this machine's queue and take what changed. */
    async sync(): Promise<AccountVaultResult<null>> {
      return await bridge.call("sync", [], () => null);
    },
  };
}

export type AccountVaultBridge = ReturnType<typeof createAccountVaultBridge>;
