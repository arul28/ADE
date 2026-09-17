import fs from "node:fs";

import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import {
  createAccountStoreResultHelpers,
} from "../../../../desktop/src/shared/types/accountStore";
import type { AccountVaultBridge } from "../../../../desktop/src/main/services/account/accountVaultBridge";
import type {
  AccountVaultItem,
  AccountVaultResult,
} from "../../../../desktop/src/shared/types/accountVault";
import {
  createAccountMigrationRunner,
  type AccountMigrationContext,
} from "../../../../desktop/src/main/services/account/accountMigrationRunner";
import type { AccountAuthService } from "./accountAuthService";
import {
  createAccountSettingsStore,
  getSharedAccountSettingsStore,
  type AccountSettingsRelay,
  type AccountSettingsStore,
} from "./accountSettingsStore";
import {
  createAccountVaultStore,
  getSharedAccountVaultStore,
  type AccountVaultRelay,
  type AccountVaultStore,
} from "./accountVaultStore";
import type { AccountVaultItemKind } from "../push/accountRelayRows";
import { createPushRegistrationStore } from "../push/pushRegistrationStore";
import { createPushRelayClient } from "../push/pushRelayClient";
import { purgeAccountApiKeys } from "../../../../desktop/src/main/services/ai/apiKeyStore";

const HEADLESS_ACCOUNT_VAULT_UNAVAILABLE_MESSAGE =
  "The account vault is unavailable in this runtime.";
const HEADLESS_ACCOUNT_VAULT_REJECTED_MESSAGE =
  "The account vault rejected the write because account ownership changed.";

export type AccountRuntimeLifecycleOptions = {
  enabled: boolean;
  accountStoreAdeDir: string;
  pushRelayFilePath: string;
  syncDeviceIdPath: string;
  receiptDir: string;
  logger: Logger;
  accountAuthService: Pick<AccountAuthService, "getStatus" | "onSignedIn" | "onSignedOut">;
  getAccountAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  getContexts: () => ReadonlyArray<AccountMigrationContext>;
  teardown: { push(release: () => void): void };
  relay?: AccountSettingsRelay & AccountVaultRelay;
  purgeAccountApiKeys?: () => void;
};

/** Adapt the headless machine-local vault to the bridge shared with desktop. */
function createHeadlessAccountVaultBridge(
  getStore: () => AccountVaultStore | null,
): AccountVaultBridge {
  const { unavailable, rejected } = createAccountStoreResultHelpers({
    unavailableMessage: HEADLESS_ACCOUNT_VAULT_UNAVAILABLE_MESSAGE,
    rejectedMessage: HEADLESS_ACCOUNT_VAULT_REJECTED_MESSAGE,
  });

  return {
    async list(scope): Promise<AccountVaultResult<AccountVaultItem[]>> {
      const store = getStore();
      if (!store) return unavailable();
      return {
        ok: true,
        value: store.list(scope ?? undefined).map((item) => ({
          scope: item.scope,
          kind: item.kind,
          key: item.key,
          value: null,
          updatedAt: item.updatedAt,
        })),
      };
    },
    async get(scope, kind, key) {
      const store = getStore();
      if (!store) return unavailable();
      return {
        ok: true,
        value: store.get(scope, kind as AccountVaultItemKind, key),
      };
    },
    async set(scope, kind, key, value) {
      const store = getStore();
      if (!store) return unavailable();
      return store.set(scope, kind as AccountVaultItemKind, key, value)
        ? { ok: true, value: null }
        : rejected();
    },
    async remove(scope, kind, key) {
      const store = getStore();
      if (!store) return unavailable();
      return store.remove(scope, kind as AccountVaultItemKind, key)
        ? { ok: true, value: null }
        : rejected();
    },
    async sync() {
      const store = getStore();
      if (!store) return unavailable();
      await store.sync();
      return { ok: true, value: null };
    },
  };
}

export function createAccountRuntimeLifecycle(options: AccountRuntimeLifecycleOptions) {
  const accountStoreUserId = (): string | null => {
    const status = options.accountAuthService.getStatus();
    return status.signedIn ? status.userId?.trim() || null : null;
  };
  const accountStoreDeviceId = (): string | null => {
    try {
      return fs.readFileSync(options.syncDeviceIdPath, "utf8").trim() || null;
    } catch {
      return null;
    }
  };

  let accountSettingsStore: AccountSettingsStore | null = null;
  let accountVaultStore: AccountVaultStore | null = null;
  const accountVaultBridge = createHeadlessAccountVaultBridge(() => accountVaultStore);

  if (options.enabled) {
    const accountStoreRelay = options.relay ?? createPushRelayClient({
      store: createPushRegistrationStore({
        filePath: options.pushRelayFilePath,
        logger: options.logger,
      }),
      logger: options.logger,
      getAccountAccessToken: options.getAccountAccessToken,
      getAccountUserId: accountStoreUserId,
    });

    accountSettingsStore = getSharedAccountSettingsStore(
      options.accountStoreAdeDir,
      () => createAccountSettingsStore({
        adeDir: options.accountStoreAdeDir,
        relay: accountStoreRelay,
        getAccountUserId: accountStoreUserId,
        getDeviceId: accountStoreDeviceId,
        logger: options.logger,
      }),
    );
    options.teardown.push(accountSettingsStore.startPeriodicSync());

    accountVaultStore = getSharedAccountVaultStore(
      options.accountStoreAdeDir,
      () => createAccountVaultStore({
        adeDir: options.accountStoreAdeDir,
        relay: accountStoreRelay,
        getAccountUserId: accountStoreUserId,
        getDeviceId: accountStoreDeviceId,
        logger: options.logger,
      }),
    );
  }

  const purgeAccountOwnedCredentials = (): void => {
    try {
      (options.purgeAccountApiKeys ?? purgeAccountApiKeys)();
    } catch (error) {
      options.logger.warn("account.local_credentials_purge_failed", {
        source: "provider_api_keys",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const context of options.getContexts()) {
      for (const [source, service] of [
        ["project_secrets", context.projectSecretService],
        ["linear_credentials", context.linearCredentialService],
      ] as const) {
        try {
          service?.purgeAccountCredentials?.();
        } catch (error) {
          options.logger.warn("account.local_credentials_purge_failed", {
            source,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  };

  let accountMigrationGeneration = 0;
  const purgeAccountState = (): void => {
    accountMigrationGeneration += 1;
    accountVaultStore?.purge();
    purgeAccountOwnedCredentials();
  };

  let migrationStarted = false;
  let lastAccountUserId = accountStoreUserId();
  const unsubscribeAccountSignedOut = options.accountAuthService.onSignedOut?.(() => {
    purgeAccountState();
    migrationStarted = false;
    lastAccountUserId = null;
  });
  if (unsubscribeAccountSignedOut) options.teardown.push(unsubscribeAccountSignedOut);

  const accountMigrationRunner = options.enabled
    ? createAccountMigrationRunner({
      accountBridge: { status: () => options.accountAuthService.getStatus() },
      accountVaultBridge,
      getContexts: options.getContexts,
      getLogger: () => options.logger,
      getReceiptDir: () => options.receiptDir,
      getAccountMigrationGeneration: () => accountMigrationGeneration,
    })
    : null;

  const startAccountMigration = (): void => {
    if (!accountMigrationRunner || migrationStarted || !accountStoreUserId()) return;
    // `start()` declines while a previous owner's run is still winding down;
    // leave the flag clear so the next ready tick tries again for this user.
    migrationStarted = accountMigrationRunner.start();
  };

  if (accountMigrationRunner && accountVaultStore) {
    options.teardown.push(accountVaultStore.startPeriodicSync(undefined, (status) => {
      if (status === "ready") startAccountMigration();
    }));
  }

  let initializationInFlight: Promise<void> | null = null;
  const initialize = async (): Promise<void> => {
    if (!accountMigrationRunner || !accountVaultStore || !accountStoreUserId()) return;
    if (initializationInFlight) return initializationInFlight;
    initializationInFlight = (async () => {
      let status: Awaited<ReturnType<AccountVaultStore["sync"]>> = "failed";
      try {
        status = await accountVaultStore!.sync();
      } catch (error) {
        options.logger.warn("account.vault_initial_sync_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (status !== "ready") {
        options.logger.warn("account.migration_skipped_vault_unavailable", { status });
        return;
      }
      startAccountMigration();
    })().finally(() => {
      initializationInFlight = null;
    });
    return initializationInFlight;
  };

  options.teardown.push(options.accountAuthService.onSignedIn(() => {
    const nextAccountUserId = accountStoreUserId();
    if (lastAccountUserId && nextAccountUserId && lastAccountUserId !== nextAccountUserId) {
      purgeAccountState();
      migrationStarted = false;
    }
    lastAccountUserId = nextAccountUserId;
    void initialize();
  }));

  return {
    accountSettingsStore,
    accountVaultStore,
    getAccountVault: () => accountVaultStore ? accountVaultBridge : null,
    initialize,
  };
}
