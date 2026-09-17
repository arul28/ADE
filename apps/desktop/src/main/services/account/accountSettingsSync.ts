/**
 * Desktop main's route to the account settings store that lives in the brain.
 *
 * The store itself (`ade-cli/src/services/account/accountSettingsStore.ts`) is
 * a per-machine, per-key LWW cache with its own upload queue. Everything this
 * module adds is transport: it turns five store methods into five calls on the
 * `account_settings` action domain, and it makes "there is no brain to ask"
 * an ordinary answer instead of a crash.
 *
 * That last part is the whole reason this file exists rather than five inline
 * `callActionForRoot` calls in `registerIpc`. A runtime-backed service that
 * throws when the runtime is absent is a standing bug class in this codebase:
 * desktop runs in-process in dev, a fresh install has no project open, and a
 * brain can be restarting. In every one of those the correct behaviour for a
 * theme preference is "this machine keeps its local copy and syncs later" —
 * never a dialog, and never an unhandled rejection on a 30-second timer.
 *
 * The root path is borrowed from any booted project scope, for the same reason
 * machine-level usage reads borrow one: the account settings store is keyed by
 * the machine's ADE directory, not by whatever repository happens to be open,
 * so any scope that can reach the brain returns the same rows.
 */

import type {
  AccountSettingRow,
  AccountSettingsResult,
  AccountSettingsWriteOptions,
} from "../../../shared/types/accountSettings";
import {
  createAccountActionBridge,
  type AccountActionPool,
} from "./accountActionBridge";

export const ACCOUNT_SETTINGS_UNAVAILABLE_MESSAGE =
  "ADE's background service isn't running on this computer, so account settings stay on this machine for now.";
export const ACCOUNT_SETTINGS_REJECTED_MESSAGE =
  "The account settings write was rejected because account ownership changed. It will be retried.";

export type AccountSettingsActionPool = AccountActionPool;

export type AccountSettingsSyncOptions = {
  /** The local runtime pool, or null when desktop runs with no brain. */
  getPool: () => AccountSettingsActionPool | null | undefined;
  /** Any booted project root; null when none is open yet. */
  getRootPath: () => string | null;
  logger?: { debug?(message: string, meta?: Record<string, unknown>): void };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toRow(value: unknown): AccountSettingRow | null {
  if (!isRecord(value)) return null;
  const scope = typeof value.scope === "string" ? value.scope : null;
  const key = typeof value.key === "string" ? value.key : null;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : null;
  if (!scope || !key || !updatedAt) return null;
  return {
    scope,
    key,
    value: value.value,
    updatedAt,
    changedAt: typeof value.changedAt === "string" ? value.changedAt : null,
    writerDeviceId: typeof value.writerDeviceId === "string" ? value.writerDeviceId : null,
  };
}

export function createAccountSettingsSyncService(options: AccountSettingsSyncOptions) {
  const bridge = createAccountActionBridge<AccountSettingRow>({
    domain: "account_settings",
    unavailableMessage: ACCOUNT_SETTINGS_UNAVAILABLE_MESSAGE,
    getPool: options.getPool,
    getRootPath: options.getRootPath,
    logger: options.logger,
    decodeRow: toRow,
    rejectedMessage: ACCOUNT_SETTINGS_REJECTED_MESSAGE,
  });

  return {
    /** Every row in one scope (or all scopes when omitted). */
    async list(scope?: string | null): Promise<AccountSettingsResult<AccountSettingRow[]>> {
      return await bridge.list(scope);
    },

    async get(scope: string, key: string): Promise<AccountSettingsResult<unknown>> {
      return await bridge.call("get", [scope, key], (raw) => raw);
    },

    async set(
      scope: string,
      key: string,
      value: unknown,
      options?: AccountSettingsWriteOptions,
    ): Promise<AccountSettingsResult<null>> {
      return await bridge.call("set", [scope, key, value], () => null, {
        rejectFalse: true,
        ...options,
      });
    },

    async remove(
      scope: string,
      key: string,
      options?: AccountSettingsWriteOptions,
    ): Promise<AccountSettingsResult<null>> {
      return await bridge.call("remove", [scope, key], () => null, {
        rejectFalse: true,
        ...options,
      });
    },

    /** Flush this machine's queue and take what changed. */
    async sync(): Promise<AccountSettingsResult<null>> {
      return await bridge.call("sync", [], () => null);
    },
  };
}

export type AccountSettingsSyncService = ReturnType<typeof createAccountSettingsSyncService>;
