/**
 * The `agent37` action domain on a brain: ready machines for the CLI, agents
 * and the phone (`ade chat create --machine agent37:ready`, `ade agent37
 * ready`). It needs only the account's Agent37 key, which the brain reads
 * from its own vault (or this computer's credential file), never a window:
 * preparing machines stays with the desktop (agent37ReadyMachines.ts).
 *
 * Account-level, so the actions run on whichever brain is asked and take no
 * pin; what they read and change is the Agent37 workspace, the same from
 * every computer.
 */

import { isAgent37InstanceId, type Agent37Spending } from "../../../shared/agent37";
import {
  AGENT37_READY_METADATA,
  type Agent37ReadyClaim,
  type Agent37ReadyMachineState,
  type Agent37ReadyPool,
  type Agent37ReadyProjectSettings,
} from "../../../shared/agent37Ready";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type { Agent37Logger } from "./agent37Client";
import { requireAgent37Client, type Agent37CredentialDeps } from "./agent37Credential";
import { agent37ReadyMachinesFor, agent37ReadyStateOf, claimAgent37ReadyMachine, releaseAgent37ReadyMachine } from "./agent37ReadyClaim";

export type Agent37ReadyActionDeps = {
  credentials: Agent37CredentialDeps;
  /** The choice per project (account vault, else this computer's copy). */
  readSettings: () => Promise<Agent37ReadyProjectSettings[]>;
  /** A claim from the CLI or an agent (analytics; coarse, never the project or machine). */
  onClaimed?: () => void;
  /** This month against the cap: a claim at the cap is refused. */
  spending?: () => Promise<Agent37Spending | null>;
  logger?: Agent37Logger;
};

function readString(args: unknown, key: string): string | null {
  const value = args && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildAgent37ReadyActions(deps: Agent37ReadyActionDeps) {
  return {
    async ready_status(): Promise<Agent37ReadyPool> {
      const client = await requireAgent37Client(deps.credentials);
      const instances = await client.listInstances();
      const settings = await deps.readSettings();
      const identities = new Set<string>(settings.map((entry) => entry.identity));
      for (const instance of instances) {
        const identity = instance.metadata[AGENT37_READY_METADATA.project];
        if (identity && agent37ReadyStateOf(instance) && instance.status !== "deleted") identities.add(identity);
      }
      return {
        projects: [...identities].sort().map((identity) => {
          const setting = settings.find((entry) => entry.identity === identity) ?? null;
          const machines = agent37ReadyMachinesFor(instances, identity).map((instance) => ({
            instanceId: instance.id,
            name: instance.name,
            // Never null: agent37ReadyMachinesFor keeps only machines with a ready state.
            state: agent37ReadyStateOf(instance)!,
            status: instance.status,
            projectName: instance.metadata[AGENT37_READY_METADATA.projectName] ?? null,
          }));
          const count = (state: Agent37ReadyMachineState) => machines.filter((machine) => machine.state === state).length;
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

    async claim_ready(args?: unknown): Promise<Agent37ReadyClaim> {
      const identity = normalizeGitRemoteIdentity(readString(args, "originUrl"));
      if (!identity) throw new Error("Pass the project's git origin (originUrl); a project without one has no ready machine.");
      const claim = await claimAgent37ReadyMachine(await requireAgent37Client(deps.credentials), identity, { logger: deps.logger, spending: deps.spending });
      deps.onClaimed?.();
      return claim;
    },

    async release_ready(args?: unknown): Promise<{ released: boolean }> {
      const instanceId = readString(args, "instanceId");
      const claimToken = readString(args, "claimToken");
      if (!isAgent37InstanceId(instanceId) || !claimToken) {
        throw new Error("Pass the machine's Agent 37 id (instanceId) and the claimToken its claim returned.");
      }
      return {
        released: await releaseAgent37ReadyMachine(await requireAgent37Client(deps.credentials), instanceId, claimToken, { logger: deps.logger }),
      };
    },
  };
}
