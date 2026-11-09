/**
 * The `cloud` action domain on a brain: ready machines for the CLI, agents
 * and the phone (`ade chat create --machine cloud:ready`, `ade cloud
 * ready`). It needs only ADE Cloud access, which the brain reads
 * from its own vault, never a window:
 * preparing machines stays with the desktop (cloudReadyMachines.ts).
 *
 * Account-level, so the actions run on whichever brain is asked and take no
 * pin; what they read and change is the account's cloud machines, the same from
 * every computer.
 */

import { isCloudInstanceId } from "../../../shared/adeCloud";
import {
  CLOUD_READY_METADATA,
  type CloudReadyClaim,
  type CloudReadyMachineState,
  type CloudReadyPool,
  type CloudReadyProjectSettings,
} from "../../../shared/cloudReady";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type { CloudLogger } from "./cloudProvider";
import { requireCloudProvider, type CloudAccessDeps } from "./cloudAccess";
import { cloudReadyMachinesFor, cloudReadyStateOf, claimCloudReadyMachine, releaseCloudReadyMachine } from "./cloudReadyClaim";

export type CloudReadyActionDeps = {
  credentials: CloudAccessDeps;
  /** The choice per project (account vault, else this computer's copy). */
  readSettings: () => Promise<CloudReadyProjectSettings[]>;
  /** A claim from the CLI or an agent (analytics; coarse, never the project or machine). */
  onClaimed?: () => void;
  logger?: CloudLogger;
};

function readString(args: unknown, key: string): string | null {
  const value = args && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildCloudReadyActions(deps: CloudReadyActionDeps) {
  return {
    async ready_status(): Promise<CloudReadyPool> {
      const client = await requireCloudProvider(deps.credentials);
      const instances = await client.listInstances();
      const settings = await deps.readSettings();
      const identities = new Set<string>(settings.map((entry) => entry.identity));
      for (const instance of instances) {
        const identity = instance.metadata[CLOUD_READY_METADATA.project];
        if (identity && cloudReadyStateOf(instance) && instance.status !== "deleted") identities.add(identity);
      }
      return {
        projects: [...identities].sort().map((identity) => {
          const setting = settings.find((entry) => entry.identity === identity) ?? null;
          const machines = cloudReadyMachinesFor(instances, identity).map((instance) => ({
            instanceId: instance.id,
            name: instance.name,
            // Never null: cloudReadyMachinesFor keeps only machines with a ready state.
            state: cloudReadyStateOf(instance)!,
            status: instance.status,
            projectName: instance.metadata[CLOUD_READY_METADATA.projectName] ?? null,
          }));
          const count = (state: CloudReadyMachineState) => machines.filter((machine) => machine.state === state).length;
          return {
            identity,
            projectName: setting?.projectName ?? machines[0]?.projectName ?? identity,
            keptReady: setting != null,
            ready: count("ready"),
            preparing: count("preparing"),
            inUse: count("claimed"),
            failed: count("failed"),
            failure: setting?.failure?.error ?? null,
            machines: machines.map(({ projectName: _projectName, ...machine }) => machine),
          };
        }),
      };
    },

    async claim_ready(args?: unknown): Promise<CloudReadyClaim> {
      const identity = normalizeGitRemoteIdentity(readString(args, "originUrl"));
      if (!identity) throw new Error("Pass the project's git origin (originUrl); a project without one has no ready machine.");
      const claim = await claimCloudReadyMachine(await requireCloudProvider(deps.credentials), identity, { logger: deps.logger });
      deps.onClaimed?.();
      return claim;
    },

    async release_ready(args?: unknown): Promise<{ released: boolean }> {
      const instanceId = readString(args, "instanceId");
      const claimToken = readString(args, "claimToken");
      if (!isCloudInstanceId(instanceId) || !claimToken) {
        throw new Error("Pass the machine's ADE Cloud id (instanceId) and the claimToken its claim returned.");
      }
      return {
        released: await releaseCloudReadyMachine(await requireCloudProvider(deps.credentials), instanceId, claimToken, { logger: deps.logger }),
      };
    },
  };
}
