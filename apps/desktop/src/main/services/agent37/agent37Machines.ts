/**
 * Agent37 boxes in the machine list: what each one is, costs and has spent,
 * and the lifecycle actions on it (sleep, wake, resize, back up, delete).
 *
 * Account-level, like the rest of the integration: every call goes to the
 * Agent37 workspace with the account's key, from the desktop the person is
 * using, never to the box's own brain. So none of it takes a pin, and an
 * action works the same whichever machine a project tab is bound to.
 */

import {
  agent37IdleHourlyUsd,
  agent37MachineLimitMessage,
  agent37MachineState,
  agent37MachineType,
  agent37ResizeBody,
  agent37RunningHourlyUsd,
  agent37Shape,
  agent37ShapeFor,
  agent37StatusAwake,
  type Agent37Machine,
  type Agent37MachineActionArgs,
  type Agent37MachineActionResult,
  type Agent37MachinesResult,
  type Agent37Resources,
} from "../../../shared/agent37";
import { agent37UsageDay, Agent37Error, type Agent37Client, type Agent37Instance, type Agent37Usage } from "./agent37Client";
import { deleteAgent37InstanceConfirmed } from "./agent37PendingCreates";

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
};

/** Agent37's usage window reaches back 90 days at most. */
const USAGE_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;
/** Compute settles hourly on Agent37, so a fresher read shows nothing new. */
const USAGE_CACHE_MS = 5 * 60_000;

/** The metadata key ADE writes once a box joins the account: its ADE machine key. */
export const AGENT37_MACHINE_KEY_METADATA = "ade_machine_key";

export type Agent37MachinesDeps = {
  /** The client for the saved key, or null when none is saved. */
  client: () => Promise<Agent37Client | null>;
  /** Removes a machine from the ADE account directory (the "Remove from ADE" half of a delete). */
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resourcesOf(instance: Agent37Instance): Agent37Resources | null {
  const raw = instance.resources;
  if (!raw || !raw.cpu || !raw.memory) return null;
  return { cpu: raw.cpu, memoryGb: raw.memory, diskGb: raw.disk };
}

/** Whether ADE made this box (its create tags) or recorded its machine on it. */
export function agent37InstanceMadeByAde(instance: Pick<Agent37Instance, "metadata">): boolean {
  return instance.metadata.created_by === "ade" || Boolean(instance.metadata[AGENT37_MACHINE_KEY_METADATA]);
}

export function toAgent37Machine(
  instance: Agent37Instance,
  usage: Agent37Usage | null,
  nowMs: number,
): Agent37Machine {
  const resources = resourcesOf(instance);
  const createdAtMs = instance.created != null ? instance.created * 1000 : null;
  const windowStartMs = nowMs - (USAGE_WINDOW_DAYS - 1) * DAY_MS;
  const spentIsLifetime = createdAtMs != null && createdAtMs >= windowStartMs;
  return {
    instanceId: instance.id,
    name: instance.name,
    status: instance.status,
    state: agent37MachineState(instance.status),
    type: agent37MachineType(instance.type),
    resources,
    shapeId: agent37ShapeFor(resources)?.id ?? null,
    region: instance.region,
    runningHourlyUsd: resources ? agent37RunningHourlyUsd(instance.type, resources) : null,
    idleHourlyUsd: resources ? agent37IdleHourlyUsd(resources) : null,
    // A box absent from a usage read has spent nothing billed yet.
    spentUsd: usage ? usage.byInstance[instance.id] ?? 0 : null,
    spentSinceMs: usage ? (spentIsLifetime ? createdAtMs : windowStartMs) : null,
    spentIsLifetime,
    pastDue: instance.pastDue,
    failure: instance.status === "failed" ? instance.statusReason?.message ?? null : null,
    machineKey: instance.metadata[AGENT37_MACHINE_KEY_METADATA] ?? null,
    createdAtMs,
    madeByAde: agent37InstanceMadeByAde(instance),
  };
}

function emptyResult(state: Agent37MachinesResult["state"], message: string | null): Agent37MachinesResult {
  return {
    state,
    machines: [],
    balanceUsd: null,
    tier: null,
    instanceLimit: null,
    instanceCount: null,
    runningCount: null,
    pastDue: false,
    usageAvailable: false,
    message,
  };
}

export function createAgent37Machines(deps: Agent37MachinesDeps) {
  const logger = deps.logger ?? {};
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let usageCache: { at: number; usage: Agent37Usage } | null = null;
  // Bumped by a key change, so a read under the old key can't refill the cache.
  let usageGeneration = 0;

  async function readUsage(client: Agent37Client): Promise<Agent37Usage | null> {
    const at = now();
    if (usageCache && at - usageCache.at < USAGE_CACHE_MS) return usageCache.usage;
    const generation = usageGeneration;
    try {
      const usage = await client.usage({ from: agent37UsageDay(at - (USAGE_WINDOW_DAYS - 1) * DAY_MS) });
      if (generation === usageGeneration) usageCache = { at, usage };
      return usage;
    } catch (error) {
      // The boxes still show without their spend.
      logger.warn?.("agent37.usage_read_failed", { error: errorText(error) });
      return usageCache?.usage ?? null;
    }
  }

  /**
   * Every box in the workspace, ADE's own and the rest: the list shows a box
   * ADE made, and any other one whose ADE row it matches (signed in by hand).
   */
  async function list(): Promise<Agent37MachinesResult> {
    const client = await deps.client();
    if (!client) return emptyResult("not_connected", null);
    let instances: Agent37Instance[];
    let billing: Awaited<ReturnType<Agent37Client["billing"]>>;
    try {
      [billing, instances] = await Promise.all([client.billing(), client.listInstances()]);
    } catch (error) {
      const refused = error instanceof Agent37Error && (error.code === "invalid_api_key" || error.code === "ip_not_allowed");
      logger.warn?.("agent37.machines_read_failed", { error: errorText(error), refused });
      return emptyResult(refused ? "key_refused" : "unreachable", errorText(error));
    }
    const usage = await readUsage(client);
    const at = now();
    const live = instances.filter((instance) => instance.status !== "deleted");
    return {
      state: "ok",
      machines: live.map((instance) => toAgent37Machine(instance, usage, at)),
      balanceUsd: billing.balanceUsd,
      tier: billing.tier,
      instanceLimit: billing.instanceLimit,
      instanceCount: live.filter((instance) => instance.status !== "failed").length,
      runningCount: live.filter((instance) => agent37StatusAwake(instance.status)).length,
      pastDue: billing.pastDue,
      usageAvailable: usage != null,
      message: null,
    };
  }

  /** The sentence and the way out for an Agent37 refusal of a lifecycle action. */
  async function refusal(
    client: Agent37Client,
    action: Agent37MachineActionArgs["action"],
    error: unknown,
  ): Promise<Agent37MachineActionResult> {
    const code = error instanceof Agent37Error ? error.code : null;
    if (code === "invalid_api_key" || code === "ip_not_allowed") {
      return { ok: false, blocker: "key", message: errorText(error) };
    }
    if (code === "instance_limit_reached") {
      const billing = await client.billing().catch((error: unknown) => {
        // The sentence then leaves the tier out.
        logger.warn?.("agent37.limit_billing_read_failed", { error: errorText(error) });
        return null;
      });
      return {
        ok: false,
        blocker: "limit",
        message: agent37MachineLimitMessage({ tier: billing?.tier ?? null, instanceLimit: billing?.instanceLimit ?? null }, "wake"),
      };
    }
    if (code === "instance_suspended") {
      return {
        ok: false,
        blocker: "suspended",
        message: "Your Agent 37 wallet is empty, so Agent 37 suspended its machines. Top it up, then wake this box. Its files are safe for 30 days.",
      };
    }
    if (code === "insufficient_balance") {
      return { ok: false, blocker: "wallet", message: "Your Agent 37 wallet can't pay for this. Top it up, then try again." };
    }
    if (code === "rate_limited" && action === "backup") {
      return {
        ok: false,
        blocker: "rate_limited",
        message: "Agent 37 takes one backup of a box every 15 minutes. Try again in a few minutes. It also keeps the last seven nights on its own.",
      };
    }
    if (code === "try_again") {
      return { ok: false, blocker: null, message: "The box is busy changing state. Try again in a moment." };
    }
    return { ok: false, blocker: null, message: errorText(error) };
  }

  async function run(args: Agent37MachineActionArgs): Promise<Agent37MachineActionResult> {
    const client = await deps.client();
    if (!client) return { ok: false, blocker: "key", message: "Connect Agent 37 first: Settings › Integrations › Agent 37." };
    const instanceId = typeof args?.instanceId === "string" ? args.instanceId.trim() : "";
    if (!/^[a-z0-9]{4,40}$/.test(instanceId)) return { ok: false, blocker: null, message: "ADE doesn't know that box." };
    const action = args.action;
    logger.info?.("agent37.machine_action", { instanceId, action, shape: args.shape ?? null });
    try {
      switch (action) {
        case "sleep": {
          await client.sleepInstance(instanceId);
          return { ok: true, blocker: null, message: "Asleep. Only its disk bills until it wakes." };
        }
        case "wake": {
          const status = await client.startInstance(instanceId);
          return {
            ok: true,
            blocker: null,
            message: status === "running" ? "Awake. ADE on it is starting." : "Waking. Agent 37 is moving it to a host with room.",
          };
        }
        case "resize": {
          const shape = agent37Shape(args.shape);
          if (!shape) return { ok: false, blocker: null, message: "Pick a size." };
          const [instance, billing] = await Promise.all([client.getInstance(instanceId), client.billing()]);
          const current = resourcesOf(instance);
          if (!current) return { ok: false, blocker: null, message: "Agent 37 didn't say how big this box is, so ADE can't resize it." };
          if (current.cpu === shape.cpu && current.memoryGb === shape.memoryGb) {
            return { ok: true, blocker: null, message: "It's already that size." };
          }
          if (billing.tier === 0 && shape.id !== "2x4") {
            return { ok: false, blocker: "wallet", message: "Agent 37 unlocks bigger sizes after your first top-up." };
          }
          const status = await client.resizeInstance(instanceId, agent37ResizeBody(current, shape));
          return {
            ok: true,
            blocker: null,
            message: status === "running"
              ? `Resized to ${shape.cpu} vCPU · ${shape.memoryGb} GB. ADE on it is starting again.`
              : `Resizing to ${shape.cpu} vCPU · ${shape.memoryGb} GB. Agent 37 is moving it to a host with room; it is back in a few minutes.`,
          };
        }
        case "backup": {
          await client.createBackup(instanceId);
          return { ok: true, blocker: null, message: "Backed up. Agent 37 keeps this one until your next backup, plus the last seven nights." };
        }
        case "delete": {
          try {
            await client.deleteInstance(instanceId);
          } catch (error) {
            // A box already gone is what a delete wants.
            if (!(error instanceof Agent37Error && error.status === 404)) throw error;
          }
          const gone = await deleteAgent37InstanceConfirmed(client, instanceId, { logger, sleep });
          if (!gone) {
            return {
              ok: false,
              blocker: null,
              message: "Agent 37 took the delete but hasn't finished it yet. Check again in a minute; if the box is still there, delete it again.",
            };
          }
          logger.info?.("agent37.machine_deleted", { instanceId });
          const machineKey = typeof args.machineKey === "string" && args.machineKey.trim() ? args.machineKey.trim() : null;
          if (machineKey) {
            try {
              await deps.removeAccountMachine(machineKey);
            } catch (error) {
              logger.warn?.("agent37.deleted_box_account_row_left", { instanceId, error: errorText(error) });
              return {
                ok: true,
                blocker: null,
                accountRowLeft: true,
                message: `Deleted on Agent 37, so it no longer bills. ADE couldn't take it off your computers (${errorText(error).replace(/\.$/, "")}); use Remove from ADE on its row.`,
              };
            }
          }
          return { ok: true, blocker: null, message: "Deleted on Agent 37 and removed from ADE. It no longer bills." };
        }
        default:
          return { ok: false, blocker: null, message: "ADE can't do that to a box." };
      }
    } catch (error) {
      logger.warn?.("agent37.machine_action_failed", { instanceId, action, error: errorText(error) });
      return await refusal(client, action, error);
    }
  }

  return {
    list,
    run,
    /** Forgets the spend read with the last key; a new key may be another workspace. */
    resetUsage: () => {
      usageCache = null;
      usageGeneration += 1;
    },
  };
}

/**
 * Records the box's ADE machine on the box itself (`ade_machine_key`), so
 * every computer on the account can match the box to its row, whatever the
 * row is named. Agent37 replaces metadata on write, so the rest is kept.
 */
export async function recordAgent37MachineKey(
  client: Agent37Client,
  instanceId: string,
  machineKey: string,
  logger?: Logger,
): Promise<void> {
  try {
    const instance = await client.getInstance(instanceId);
    if (instance.metadata[AGENT37_MACHINE_KEY_METADATA] === machineKey) return;
    await client.setInstanceMetadata(instanceId, { ...instance.metadata, [AGENT37_MACHINE_KEY_METADATA]: machineKey });
  } catch (error) {
    // The hostname still matches the box to its row; this only makes it sure.
    logger?.warn?.("agent37.machine_key_record_failed", { instanceId, error: errorText(error) });
  }
}
