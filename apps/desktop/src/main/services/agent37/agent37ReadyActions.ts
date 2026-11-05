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

import {
  AGENT37_READY_METADATA,
  type Agent37ReadyClaim,
  type Agent37ReadyMachineState,
  type Agent37ReadyProjectSettings,
} from "../../../shared/agent37";
import { requireAgent37Client, type Agent37CredentialDeps } from "./agent37Credential";
import { agent37ReadyMachinesFor, agent37ReadyStateOf, claimAgent37ReadyMachine, releaseAgent37ReadyMachine } from "./agent37ReadyClaim";
import { agent37ReadyIdentity } from "./agent37ReadyMachines";

export type Agent37ReadyPoolEntry = {
  identity: string;
  projectName: string;
  /** Whether a computer keeps this project's machine ready (its setting), or only machines are left. */
  keptReady: boolean;
  /** Machines per state: `ready` (asleep, the next chat takes one), `preparing`, `inUse` (claimed), `failed`. */
  ready: number;
  preparing: number;
  inUse: number;
  failed: number;
  /** The last prepare's failure, kept until Retry. */
  failure: string | null;
  machines: Array<{ instanceId: string; name: string | null; state: Agent37ReadyMachineState; status: string }>;
};

export type Agent37ReadyPool = { projects: Agent37ReadyPoolEntry[] };

export type Agent37ReadyActionDeps = {
  credentials: Agent37CredentialDeps;
  /** The account's choice per project; empty when it can't be read (this is a read-only view). */
  readSettings: () => Agent37ReadyProjectSettings[];
  logger?: { info?(event: string, meta?: Record<string, unknown>): void; warn?(event: string, meta?: Record<string, unknown>): void };
};

function readString(args: unknown, key: string): string | null {
  const value = args && typeof args === "object" ? (args as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildAgent37ReadyActions(deps: Agent37ReadyActionDeps) {
  return {
    async ready_status(): Promise<Agent37ReadyPool> {
      const client = await requireAgent37Client(deps.credentials);
      const [instances, settings] = [await client.listInstances(), deps.readSettings()];
      const identities = new Set<string>(settings.map((entry) => entry.identity));
      for (const instance of instances) {
        const identity = instance.metadata[AGENT37_READY_METADATA.project];
        if (identity && agent37ReadyStateOf(instance) && instance.status !== "deleted") identities.add(identity);
      }
      return {
        projects: [...identities].sort().map((identity) => {
          const setting = settings.find((entry) => entry.identity === identity) ?? null;
          const machines = agent37ReadyMachinesFor(instances, identity);
          const count = (state: Agent37ReadyMachineState) => machines.filter((instance) => agent37ReadyStateOf(instance) === state).length;
          return {
            identity,
            projectName: setting?.projectName ?? machines[0]?.metadata[AGENT37_READY_METADATA.projectName] ?? identity,
            keptReady: setting != null,
            ready: count("ready"),
            preparing: count("preparing"),
            inUse: count("claimed"),
            failed: count("failed"),
            failure: setting?.failure?.error ?? null,
            machines: machines.map((instance) => ({
              instanceId: instance.id,
              name: instance.name,
              state: agent37ReadyStateOf(instance)!,
              status: instance.status,
            })),
          };
        }),
      };
    },

    async claim_ready(args?: unknown): Promise<Agent37ReadyClaim> {
      const identity = agent37ReadyIdentity(readString(args, "originUrl"));
      if (!identity) throw new Error("Pass the project's git origin (originUrl); a project without one has no ready machine.");
      return await claimAgent37ReadyMachine(await requireAgent37Client(deps.credentials), identity, { logger: deps.logger });
    },

    async release_ready(args?: unknown): Promise<{ released: boolean }> {
      const instanceId = readString(args, "instanceId");
      if (!instanceId || !/^[a-z0-9]{4,40}$/.test(instanceId)) throw new Error("Pass the machine's Agent 37 id (instanceId).");
      return {
        released: await releaseAgent37ReadyMachine(await requireAgent37Client(deps.credentials), instanceId, { logger: deps.logger }),
      };
    },
  };
}
