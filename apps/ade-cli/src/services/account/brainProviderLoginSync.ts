import os from "node:os";

import type { ProviderLoginCaptureOffReason } from "../../../../desktop/src/shared/types/providerLogins";
import type { AccountAuthService } from "./accountAuthService";
import { getSharedAccountDirectoryBaseUrl } from "./sharedAccountAuthService";

type Logger = {
  debug: (event: string, data?: Record<string, unknown>) => void;
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  error: (event: string, data?: Record<string, unknown>) => void;
};

/**
 * Start the brain's one sign-in sync (P5). With `staticOff` set, no account
 * store is opened and nothing runs; `status` still says why.
 */
export async function installBrainProviderLoginSync(args: {
  staticOff: Extract<ProviderLoginCaptureOffReason, "embedded" | "dev_brain" | "sync_off"> | null;
  adeDir: string;
  secretsDir: string;
  accountAuthService: Pick<AccountAuthService, "getStatus" | "getAccessToken" | "onSignedOut">;
  logger: Logger;
}): Promise<void> {
  const [
    { createProviderLoginSync, installProviderLoginSync, providerLoginSync },
    { cloudAccessDepsFor, readCloudAccessState },
    { getOrCreateLocalAccountMachineIdentity },
    { isCloudMachine },
  ] = await Promise.all([
    import("../../../../desktop/src/main/services/providerLogins/providerLoginSync"),
    import("../../../../desktop/src/main/services/adeCloud/cloudAccess"),
    import("../../../../desktop/src/main/services/account/localMachineIdentity"),
    import("../power/cloudKeepAwake"),
  ]);
  const stores = args.staticOff ? null : (await import("./machineAccountStores")).getMachineAccountStores(args.logger);
  const accessDeps = cloudAccessDepsFor({
    account: () => args.accountAuthService,
    directoryBaseUrl: () => getSharedAccountDirectoryBaseUrl(),
    logger: args.logger,
  });
  installProviderLoginSync(createProviderLoginSync({
    adeDir: args.adeDir,
    staticOff: args.staticOff,
    vault: () => stores?.vault ?? null,
    settings: () => stores?.settings ?? null,
    accountUserId: () => {
      const status = args.accountAuthService.getStatus();
      return status.signedIn ? status.userId?.trim() || null : null;
    },
    machine: () => {
      try {
        const identity = getOrCreateLocalAccountMachineIdentity({ secretsDir: args.secretsDir });
        return { machineKey: identity.machineKey, deviceId: identity.deviceId, label: os.hostname(), platform: process.platform };
      } catch {
        return null;
      }
    },
    cloudAccess: () => readCloudAccessState(accessDeps),
    cloudComputer: isCloudMachine(),
    logger: args.logger,
  }));
  if (!args.staticOff) args.accountAuthService.onSignedOut?.(() => providerLoginSync()?.forgetAccount());
}
