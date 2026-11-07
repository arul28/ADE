import path from "node:path";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import { createPushRegistrationStore } from "../push/pushRegistrationStore";
import { createPushRelayClient } from "../push/pushRelayClient";
import { resolvePushRelayStateFile } from "../push/pushPublisherService";
import { readMachineIdFile } from "../sync/machineIdFile";
import { getSignedInAccountAccessToken } from "./accountAuthService";
import { createAccountSettingsStore, getSharedAccountSettingsStore, type AccountSettingsStore } from "./accountSettingsStore";
import { createAccountVaultStore, getSharedAccountVaultStore, type AccountVaultStore } from "./accountVaultStore";
import { getSharedAccountAuthService } from "./sharedAccountAuthService";

/**
 * The machine's account stores, for code that runs without a project runtime
 * (ADE MCP, a clone on a machine with no project yet). They are the same
 * instances a project runtime uses (one per ADE home): built like the
 * runtime's (accountRuntimeLifecycle), and whichever comes first creates them.
 */

type StoreLogger = {
  debug: (event: string, data?: Record<string, unknown>) => void;
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  error: (event: string, data?: Record<string, unknown>) => void;
};

export type MachineAccountStores = {
  settings: AccountSettingsStore;
  vault: AccountVaultStore;
  /** The signed-in account's user id, or null when this machine is signed out. */
  accountUserId: () => string | null;
};

export function getMachineAccountStores(logger: StoreLogger): MachineAccountStores {
  const layout = resolveMachineAdeLayout();
  const accountAuth = () => getSharedAccountAuthService({ secretsDir: layout.secretsDir });
  const accountUserId = (): string | null => {
    const status = accountAuth().getStatus();
    return status.signedIn ? status.userId?.trim() || null : null;
  };
  const deviceIdPath = path.join(layout.secretsDir, "sync-device-id");
  const deviceId = (): string | null => readMachineIdFile(deviceIdPath);
  const relayClient = createPushRelayClient({
    store: createPushRegistrationStore({ filePath: resolvePushRelayStateFile(layout.secretsDir), logger }),
    logger,
    getAccountAccessToken: (options) => getSignedInAccountAccessToken(accountAuth(), options),
    getAccountUserId: accountUserId,
  });
  const settings = getSharedAccountSettingsStore(layout.adeDir, () => createAccountSettingsStore({
    adeDir: layout.adeDir,
    relay: relayClient,
    getAccountUserId: accountUserId,
    getDeviceId: deviceId,
    logger,
  }));
  const vault = getSharedAccountVaultStore(layout.adeDir, () => createAccountVaultStore({
    adeDir: layout.adeDir,
    relay: relayClient,
    getAccountUserId: accountUserId,
    getDeviceId: deviceId,
    logger,
  }));
  return { settings, vault, accountUserId };
}
