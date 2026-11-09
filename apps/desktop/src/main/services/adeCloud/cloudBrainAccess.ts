/**
 * ADE Cloud as a brain reaches it: the account's access and waking a box for
 * use. No Electron, so `ade serve` and the brain's `cloud` actions share it
 * with the desktop's own copy of the same rules.
 */

import type { AdeAccountMachine } from "../../../shared/types/account";
import type { CloudLogger, CloudProvider } from "./cloudProvider";
import { getCloudProvider, watchCloudAccessForSkills, type CloudAccessDeps } from "./cloudAccess";
import { wakeCloudMachineForUse } from "./cloudSleep";

export function createCloudBrainAccess(deps: {
  signedIn: () => boolean;
  accountId: () => string | null;
  accessToken: () => Promise<string | null>;
  directoryBaseUrl: () => string | null;
  deviceName?: () => string | null;
  logger?: CloudLogger & { warn(event: string, meta?: Record<string, unknown>): void };
}) {
  const credentials: CloudAccessDeps = {
    signedIn: deps.signedIn,
    accountId: deps.accountId,
    accessToken: deps.accessToken,
    directoryBaseUrl: deps.directoryBaseUrl,
    deviceName: deps.deviceName,
    ...(deps.logger ? { logger: deps.logger } : {}),
  };
  // The brain owns this account here, so its chats' skill listings follow it.
  watchCloudAccessForSkills(credentials);
  const client = (): Promise<CloudProvider | null> => getCloudProvider(credentials);
  return {
    credentials,
    client,
    /**
     * Wakes the cloud box behind an account machine a call names. False for
     * any other machine, or with no access to ADE Cloud; throws when out of hours.
     */
    async wakeForUse(machine: Pick<AdeAccountMachine, "machineKey" | "name">): Promise<boolean> {
      const cloud = await client().catch(() => null);
      if (!cloud) return false;
      const result = await wakeCloudMachineForUse(cloud, { machineKey: machine.machineKey, hostname: machine.name }, { logger: deps.logger });
      if (result.state === "refused") throw new Error(result.message);
      return result.state === "woken";
    },
  };
}

export type CloudBrainAccess = ReturnType<typeof createCloudBrainAccess>;
