/**
 * ADE Cloud as a brain reaches it: the account's access, the monthly cap, and waking a box for use. No
 * Electron, so `ade serve` and the brain's `cloud` actions share it with
 * the desktop's own copy of the same rules.
 */

import { EncryptedFileCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { AdeAccountMachine } from "../../../shared/types/account";
import { cloudUsageDay, type CloudProvider, type CloudLogger } from "./cloudProvider";
import { CLOUD_PROVIDER_VAULT_ITEM, cloudVaultFromStore, getCloudProvider, type CloudAccessDeps } from "./cloudAccess";
import { CLOUD_BUDGET_VAULT_KEY, createCloudBudgetStore, readCloudSpending, wakeCloudMachineForUse } from "./cloudSleep";

type VaultStore = Parameters<typeof cloudVaultFromStore>[0];

/** The machine's shared credential file. One per process. */
let machineCredentialStore: EncryptedFileCredentialStore | null = null;
export function cloudMachineCredentialStore(): EncryptedFileCredentialStore {
  machineCredentialStore ??= new EncryptedFileCredentialStore({ secretsDir: resolveMachineAdeLayout().secretsDir });
  return machineCredentialStore;
}

export function createCloudBrainAccess(deps: {
  /** A booted project's account vault store, or null (signed out, nothing booted). */
  vaultStore: () => VaultStore | null | Promise<VaultStore | null>;
  signedIn: () => boolean;
  logger?: CloudLogger & { warn(event: string, meta?: Record<string, unknown>): void };
}) {
  let vaultStore: VaultStore | null = null;
  const refreshVault = async () => {
    vaultStore = deps.signedIn() ? await deps.vaultStore() : null;
  };
  const credentials: CloudAccessDeps = {
    vault: () => (vaultStore ? cloudVaultFromStore(vaultStore, CLOUD_PROVIDER_VAULT_ITEM) : null),
    signedIn: deps.signedIn,
    ...(deps.logger ? { logger: deps.logger } : {}),
  };
  const budget = createCloudBudgetStore({
    vault: () => (vaultStore ? cloudVaultFromStore(vaultStore, CLOUD_BUDGET_VAULT_KEY) : null),
    machineStore: () => cloudMachineCredentialStore(),
    logger: deps.logger,
  });
  const client = async (): Promise<CloudProvider | null> => {
    await refreshVault();
    return await getCloudProvider(credentials);
  };
  const spending = (cloud: CloudProvider) => readCloudSpending(
    budget,
    // This month only: the cap is monthly.
    () => cloud.usage({ from: `${cloudUsageDay(Date.now()).slice(0, 7)}-01` }).catch(() => null),
  );
  return {
    credentials,
    budget,
    client,
    spending,
    /**
     * Wakes the cloud box behind an account machine a call names. False for
     * any other machine, or with no access to ADE Cloud; throws at the monthly cap.
     */
    async wakeForUse(machine: Pick<AdeAccountMachine, "machineKey" | "name">): Promise<boolean> {
      const cloud = await client().catch(() => null);
      if (!cloud) return false;
      const result = await wakeCloudMachineForUse(cloud, { machineKey: machine.machineKey, hostname: machine.name }, {
        spending: () => spending(cloud),
        logger: deps.logger,
      });
      if (result.state === "refused") throw new Error(result.message);
      return result.state === "woken";
    },
  };
}

export type CloudBrainAccess = ReturnType<typeof createCloudBrainAccess>;
