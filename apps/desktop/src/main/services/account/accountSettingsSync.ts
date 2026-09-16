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
} from "../../../shared/types/accountSettings";

export type { AccountSettingRow, AccountSettingsResult };

export const ACCOUNT_SETTINGS_UNAVAILABLE_MESSAGE =
  "ADE's background service isn't running on this computer, so account settings stay on this machine for now.";

type ActionRequest = {
  domain: string;
  action: string;
  args?: Record<string, unknown>;
  argsList?: unknown[];
};

export type AccountSettingsActionPool = {
  callActionForRoot(
    rootPath: string,
    request: ActionRequest,
  ): Promise<{ result: unknown }>;
};

export type AccountSettingsSyncOptions = {
  /** The local runtime pool, or null when desktop runs with no brain. */
  getPool: () => AccountSettingsActionPool | null | undefined;
  /** Any booted project root; null when none is open yet. */
  getRootPath: () => string | null;
  logger?: { debug?(message: string, meta?: Record<string, unknown>): void };
};

function unavailable<T>(message?: string): AccountSettingsResult<T> {
  return { ok: false, unavailable: true, message: message ?? ACCOUNT_SETTINGS_UNAVAILABLE_MESSAGE };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The brain answers `{ domain, action, result }`; older paths answer bare. */
function unwrap(raw: unknown): unknown {
  return isRecord(raw) && "result" in raw && "domain" in raw ? raw.result : raw;
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
  const call = async <T>(
    action: "list" | "get" | "set" | "remove" | "sync",
    argsList: unknown[],
    coerce: (raw: unknown) => T,
  ): Promise<AccountSettingsResult<T>> => {
    const pool = options.getPool();
    if (!pool) return unavailable<T>();
    const rootPath = options.getRootPath();
    if (!rootPath) return unavailable<T>();
    try {
      const response = await pool.callActionForRoot(rootPath, {
        domain: "account_settings",
        action,
        argsList,
      });
      return { ok: true, value: coerce(unwrap(response?.result)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "");
      // Logged, never thrown. A settings sync that failed is work to retry on
      // the next poll, not something to interrupt the user with.
      options.logger?.debug?.("account_settings.call_failed", { action, error: message });
      return unavailable<T>(message || undefined);
    }
  };

  return {
    /** Every row in one scope (or all scopes when omitted). */
    async list(scope?: string | null): Promise<AccountSettingsResult<AccountSettingRow[]>> {
      return await call(
        "list",
        scope ? [scope] : [],
        (raw) => (Array.isArray(raw) ? raw.map(toRow).filter((row): row is AccountSettingRow => row !== null) : []),
      );
    },

    async get(scope: string, key: string): Promise<AccountSettingsResult<unknown>> {
      return await call("get", [scope, key], (raw) => raw);
    },

    async set(scope: string, key: string, value: unknown): Promise<AccountSettingsResult<null>> {
      return await call("set", [scope, key, value], () => null);
    },

    async remove(scope: string, key: string): Promise<AccountSettingsResult<null>> {
      return await call("remove", [scope, key], () => null);
    },

    /** Flush this machine's queue and take what changed. */
    async sync(): Promise<AccountSettingsResult<null>> {
      return await call("sync", [], () => null);
    },
  };
}

export type AccountSettingsSyncService = ReturnType<typeof createAccountSettingsSyncService>;
