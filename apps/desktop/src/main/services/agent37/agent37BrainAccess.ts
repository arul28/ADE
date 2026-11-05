/**
 * Agent 37 as a brain reaches it: the account's key (its vault, else this
 * computer's credential file), the monthly cap, and waking a box for use. No
 * Electron, so `ade serve` and the brain's `agent37` actions share it with
 * the desktop's own copy of the same rules.
 */

import { EncryptedFileCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import type { AdeAccountMachine } from "../../../shared/types/account";
import { agent37UsageDay, type Agent37Client, type Agent37Logger } from "./agent37Client";
import { agent37VaultFromStore, readAgent37Key, type Agent37CredentialDeps } from "./agent37Credential";
import { createAgent37Client } from "./agent37Client";
import { AGENT37_BUDGET_VAULT_KEY, createAgent37BudgetStore, readAgent37Spending, wakeAgent37MachineForUse } from "./agent37Sleep";

type VaultStore = Parameters<typeof agent37VaultFromStore>[0];

/** The machine's shared credential file. One per process. */
let machineCredentialStore: EncryptedFileCredentialStore | null = null;
export function agent37MachineCredentialStore(): EncryptedFileCredentialStore {
  machineCredentialStore ??= new EncryptedFileCredentialStore({ secretsDir: resolveMachineAdeLayout().secretsDir });
  return machineCredentialStore;
}

export function createAgent37BrainAccess(deps: {
  /** A booted project's account vault store, or null (signed out, nothing booted). */
  vaultStore: () => VaultStore | null | Promise<VaultStore | null>;
  signedIn: () => boolean;
  logger?: Agent37Logger & { warn(event: string, meta?: Record<string, unknown>): void };
}) {
  let vaultStore: VaultStore | null = null;
  const refreshVault = async () => {
    vaultStore = deps.signedIn() ? await deps.vaultStore() : null;
  };
  const credentials: Agent37CredentialDeps = {
    vault: () => (vaultStore ? agent37VaultFromStore(vaultStore) : null),
    machineStore: () => agent37MachineCredentialStore(),
    signedIn: deps.signedIn,
    ...(deps.logger ? { logger: deps.logger } : {}),
  };
  const budget = createAgent37BudgetStore({
    vault: () => (vaultStore ? agent37VaultFromStore(vaultStore, AGENT37_BUDGET_VAULT_KEY) : null),
    machineStore: () => agent37MachineCredentialStore(),
    logger: deps.logger,
  });
  const client = async (): Promise<Agent37Client | null> => {
    await refreshVault();
    const saved = await readAgent37Key(credentials);
    return saved ? createAgent37Client({ apiKey: saved.key }) : null;
  };
  const spending = (agent37: Agent37Client) => readAgent37Spending(
    budget,
    // This month only: the cap is monthly.
    () => agent37.usage({ from: `${agent37UsageDay(Date.now()).slice(0, 7)}-01` }).catch(() => null),
  );
  return {
    credentials,
    budget,
    client,
    spending,
    /**
     * Wakes the Agent 37 box behind an account machine a call names. False for
     * any other machine, or with no key saved; throws at the monthly cap.
     */
    async wakeForUse(machine: Pick<AdeAccountMachine, "machineKey" | "name">): Promise<boolean> {
      const agent37 = await client().catch(() => null);
      if (!agent37) return false;
      const result = await wakeAgent37MachineForUse(agent37, { machineKey: machine.machineKey, hostname: machine.name }, {
        spending: () => spending(agent37),
        logger: deps.logger,
      });
      if (result.state === "refused") throw new Error(result.message);
      return result.state === "woken";
    },
  };
}

export type Agent37BrainAccess = ReturnType<typeof createAgent37BrainAccess>;
