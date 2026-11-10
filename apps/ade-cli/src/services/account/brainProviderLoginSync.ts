import os from "node:os";
import path from "node:path";

import type { ProviderLoginCaptureOffReason } from "../../../../desktop/src/shared/types/providerLogins";
import type { AccountAuthService } from "./accountAuthService";
import { getSharedAccountDirectoryBaseUrl } from "./sharedAccountAuthService";

type Logger = {
  debug: (event: string, data?: Record<string, unknown>) => void;
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  error: (event: string, data?: Record<string, unknown>) => void;
};

/** The most the list of the account's cloud computers may take; then the answer is unknown. */
const CLOUD_COMPUTER_READ_TIMEOUT_MS = 15_000;

/**
 * Start the brain's one sign-in sync (P5). With `staticOff` set, no account
 * store is opened and nothing runs; `status` still says why.
 */
export async function installBrainProviderLoginSync(args: {
  staticOff: Extract<ProviderLoginCaptureOffReason, "embedded" | "dev_brain" | "sync_off"> | null;
  adeDir: string;
  secretsDir: string;
  accountAuthService: Pick<AccountAuthService, "getStatus" | "getAccessToken" | "onSignedIn" | "onSignedOut">;
  logger: Logger;
}): Promise<void> {
  const [
    { createProviderLoginSync, installProviderLoginSync, providerLoginSync },
    { cloudAccessDepsFor, getCloudProvider, onCloudAccessAnswerChanged, readCloudAccessState },
    { getOrCreateLocalAccountMachineIdentity },
    { isCloudMachine },
    { BORROW_RENEW_AHEAD_MS, renewProviderLogin, withMachineRenewLock },
    { codexConfigHome, grokConfigHome },
    { createCloudComputerCheck },
  ] = await Promise.all([
    import("../../../../desktop/src/main/services/providerLogins/providerLoginSync"),
    import("../../../../desktop/src/main/services/adeCloud/cloudAccess"),
    import("../../../../desktop/src/main/services/account/localMachineIdentity"),
    import("../power/cloudKeepAwake"),
    import("../proxy/borrowedLogins"),
    import("../../../../desktop/src/main/services/shared/providerConfigHomes"),
    import("../../../../desktop/src/main/services/providerLogins/providerLoginCloudComputers"),
  ]);
  // The name the machine directory and the Usage page show ("Mac Studio"), not
  // the network hostname. Loaded lazily, as the brain loads the registry; the
  // hostname stands in until it is known, and a failure never reaches a pass.
  let displayName: (() => string) | null = null;
  if (!args.staticOff) {
    void import("../sync/deviceRegistryService")
      .then((module) => {
        displayName = module.resolveDeviceDisplayName;
        displayName();
      })
      .catch(() => undefined);
  }
  const machineLabel = (): string => {
    try {
      return displayName?.().trim() || os.hostname();
    } catch {
      return os.hostname();
    }
  };
  const stores = args.staticOff ? null : (await import("./machineAccountStores")).getMachineAccountStores(args.logger);
  const accessDeps = cloudAccessDepsFor({
    account: () => args.accountAuthService,
    directoryBaseUrl: () => getSharedAccountDirectoryBaseUrl(),
    logger: args.logger,
  });
  const accountId = (): string | null => {
    const status = args.accountAuthService.getStatus();
    return status.signedIn ? status.userId?.trim() || null : null;
  };
  // "A cloud computer exists" (B2): one lazy list of the account's computers,
  // asked only by the renewal planner when a sign-in owned here is otherwise
  // due. A cloud computer has no planner, so it never asks. The brain's own
  // cloud actions also tell it, free (adeActions/registry.ts).
  const cloudComputers = args.staticOff || isCloudMachine() ? null : createCloudComputerCheck({
    accountId,
    count: async () => {
      const provider = await getCloudProvider(accessDeps);
      if (!provider) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CLOUD_COMPUTER_READ_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        const instances = await Promise.race([provider.listInstances(), deadline]);
        return instances ? instances.filter((instance) => instance.status !== "deleted" && instance.status !== "failed").length : null;
      } finally {
        clearTimeout(timer);
      }
    },
    logger: args.logger,
  });
  installProviderLoginSync(createProviderLoginSync({
    adeDir: args.adeDir,
    staticOff: args.staticOff,
    vault: () => stores?.vault ?? null,
    settings: () => stores?.settings ?? null,
    accountUserId: accountId,
    machine: () => {
      try {
        const identity = getOrCreateLocalAccountMachineIdentity({ secretsDir: args.secretsDir });
        return { machineKey: identity.machineKey, deviceId: identity.deviceId, label: machineLabel(), platform: process.platform };
      } catch {
        return null;
      }
    },
    cloudAccess: () => readCloudAccessState(accessDeps),
    onCloudAccessChanged: onCloudAccessAnswerChanged,
    cloudComputer: isCloudMachine(),
    logger: args.logger,
    // Renewal ahead on the owner computer (step 3a): the proxy's renew call,
    // under the machine lock its own keeper takes. The base login of each
    // provider is the one capture reads (`CODEX_HOME`, `GROK_HOME`).
    renewer: {
      aheadMs: { codex: BORROW_RENEW_AHEAD_MS.codex, grok: BORROW_RENEW_AHEAD_MS.grok },
      renew: async (provider) => {
        if (provider !== "codex" && provider !== "grok") return false;
        const configHome = provider === "codex" ? codexConfigHome({ env: process.env }) : grokConfigHome({ env: process.env });
        return await withMachineRenewLock(
          path.join(args.adeDir, "proxy", "auth"),
          () => renewProviderLogin({ id: provider, provider, configHome, isDefault: true }, process.env),
        );
      },
    },
    ...(cloudComputers ? { cloudComputerExists: () => cloudComputers.exists() } : {}),
  }));
  if (args.staticOff) return;
  // Sign-in asks the ADE Cloud answer once; sign-out leaves the ticks at once.
  args.accountAuthService.onSignedIn(() => void providerLoginSync()?.refreshAccess());
  args.accountAuthService.onSignedOut?.(() => {
    const sync = providerLoginSync();
    sync?.forgetAccount();
    void sync?.refreshAccess();
  });
}
