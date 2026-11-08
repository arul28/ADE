/**
 * cloud boxes in the machine list: what each one is, costs and has spent,
 * and the lifecycle actions on it (sleep, wake, resize, back up, delete).
 *
 * Account-level, like the rest of the integration: every call goes to the
 * the provider workspace with the account's key, from the desktop the person is
 * using, never to the box's own brain. So none of it takes a pin, and an
 * action works the same whichever machine a project tab is bound to.
 */

import {
  CLOUD_DEFAULT_AGENT_LIMITS,
  CLOUD_MADE_BY_CHAT_METADATA,
  isCloudInstanceId,
  cloudIdleHourlyUsd,
  cloudMachineState,
  cloudMachineType,
  cloudResizeBody,
  cloudRunningHourlyUsd,
  cloudShape,
  cloudShapeFor,
  cloudStatusAwake,
  cloudCapReachedMessage,
  cloudSavedUsd,
  cloudSpendingFor,
  type CloudBudget,
  type CloudMachine,
  type CloudMachineActionArgs,
  type CloudMachineActionResult,
  type CloudMachinesResult,
  type CloudMonthSpend,
  type CloudResources,
} from "../../../shared/adeCloud";
import { CLOUD_READY_METADATA, readCloudReadyMachineState } from "../../../shared/cloudReady";
import { CLOUD_ACCESS_REFUSED, cloudUsageDay, CloudProviderError, type CloudProvider, type CloudInstance, type CloudUsage } from "./cloudProvider";
import { deleteCloudInstanceConfirmed } from "./cloudPendingCreates";
import { cloudMonthSpentUsd, cloudSleepPolicyOf, setCloudSleepAfter } from "./cloudSleep";

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
};

/** the provider's usage window reaches back 90 days at most. */
const USAGE_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;
/** Compute settles hourly on the provider, so a fresher read shows nothing new. */
const USAGE_CACHE_MS = 5 * 60_000;

/** The metadata key ADE writes once a box joins the account: its ADE machine key. */
export const CLOUD_MACHINE_KEY_METADATA = "ade_machine_key";

export type CloudMachinesDeps = {
  /** ADE Cloud for this account, or null when it has no access. */
  client: () => Promise<CloudProvider | null>;
  /** Removes a machine from the ADE account directory (the "Remove from ADE" half of a delete). */
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  /** The account's monthly cap; absent reads as no cap. */
  readBudget?: () => Promise<CloudBudget>;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resourcesOf(instance: CloudInstance): CloudResources | null {
  const raw = instance.resources;
  if (!raw || !raw.cpu || !raw.memory) return null;
  return { cpu: raw.cpu, memoryGb: raw.memory, diskGb: raw.disk };
}

/** Whether ADE made this box (its create tags) or recorded its machine on it. */
function cloudInstanceMadeByAde(instance: Pick<CloudInstance, "metadata">): boolean {
  return instance.metadata.created_by === "ade" || Boolean(instance.metadata[CLOUD_MACHINE_KEY_METADATA]);
}

function toCloudMachine(
  instance: CloudInstance,
  usage: CloudUsage | null,
  nowMs: number,
): CloudMachine {
  const resources = resourcesOf(instance);
  const createdAtMs = instance.created != null ? instance.created * 1000 : null;
  const windowStartMs = nowMs - (USAGE_WINDOW_DAYS - 1) * DAY_MS;
  const spentIsLifetime = createdAtMs != null && createdAtMs >= windowStartMs;
  const runningHourlyUsd = resources ? cloudRunningHourlyUsd(instance.type, resources) : null;
  const spentUsd = usage ? usage.byInstance[instance.id] ?? 0 : null;
  return {
    instanceId: instance.id,
    name: instance.name,
    status: instance.status,
    state: cloudMachineState(instance.status),
    type: cloudMachineType(instance.type),
    resources,
    shapeId: cloudShapeFor(resources)?.id ?? null,
    region: instance.region,
    runningHourlyUsd,
    idleHourlyUsd: resources ? cloudIdleHourlyUsd(resources) : null,
    // A box absent from a usage read has spent nothing billed yet.
    spentUsd,
    spentSinceMs: usage ? (spentIsLifetime ? createdAtMs : windowStartMs) : null,
    spentIsLifetime,
    pastDue: instance.pastDue,
    failure: instance.status === "failed" ? instance.statusReason?.message ?? null : null,
    machineKey: instance.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null,
    createdAtMs,
    madeByAde: cloudInstanceMadeByAde(instance),
    ready: readyOf(instance),
    sleep: cloudSleepPolicyOf(instance),
    // the provider settles compute hourly, so the newest hour reads as saved
    // until it lands; the window stops an hour back to stay honest.
    savedUsd: cloudSavedUsd({
      runningHourlyUsd,
      spentUsd,
      windowStartMs: usage ? (spentIsLifetime ? createdAtMs : windowStartMs) : null,
      nowMs: nowMs - 60 * 60_000,
    }),
  };
}

/** A project's ready machine (see cloudReadyMachines.ts), or null for any other box. */
function readyOf(instance: CloudInstance): CloudMachine["ready"] {
  const state = readCloudReadyMachineState(instance.metadata[CLOUD_READY_METADATA.state]);
  const project = instance.metadata[CLOUD_READY_METADATA.project];
  if (!state || !project) return null;
  return {
    projectName: instance.metadata[CLOUD_READY_METADATA.projectName] || project,
    state,
  };
}

/** The first instant of `nowMs`'s UTC month. */
function monthStartMs(nowMs: number): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/**
 * This month per listed machine (spent, and what sleeping saved it since the
 * month or its creation, whichever is later), and what machines no longer in
 * the workspace spent this month: the provider's usage keeps a deleted machine's
 * id, its list does not.
 */
function cloudMonthSpend(
  machines: readonly Pick<CloudMachine, "instanceId" | "runningHourlyUsd" | "createdAtMs">[],
  monthUsage: Pick<CloudUsage, "byInstance"> | null,
  nowMs: number,
): CloudMonthSpend | null {
  if (!monthUsage) return null;
  const sinceMs = monthStartMs(nowMs);
  const listed = new Set(machines.map((machine) => machine.instanceId));
  const byInstance: CloudMonthSpend["byInstance"] = {};
  for (const machine of machines) {
    const spentUsd = monthUsage.byInstance[machine.instanceId] ?? 0;
    byInstance[machine.instanceId] = {
      spentUsd,
      // As for `savedUsd`: the newest hour is not settled yet, so the window stops an hour back.
      savedUsd: cloudSavedUsd({
        runningHourlyUsd: machine.runningHourlyUsd,
        spentUsd,
        windowStartMs: Math.max(sinceMs, machine.createdAtMs ?? sinceMs),
        nowMs: nowMs - 60 * 60_000,
      }),
    };
  }
  let deletedSpentUsd = 0;
  let deletedCount = 0;
  for (const [id, usd] of Object.entries(monthUsage.byInstance)) {
    if (listed.has(id) || usd <= 0) continue;
    deletedSpentUsd += usd;
    deletedCount += 1;
  }
  return { sinceMs, byInstance, deletedSpentUsd, deletedCount };
}

function emptyResult(state: CloudMachinesResult["state"], message: string | null): CloudMachinesResult {
  return {
    state,
    machines: [],
    instanceCount: null,
    runningCount: null,
    usageAvailable: false,
    spending: cloudSpendingFor({ monthlyCapUsd: null }, null),
    message,
  };
}

export function createCloudMachines(deps: CloudMachinesDeps) {
  const logger = deps.logger ?? {};
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let usageCache: { at: number; usage: CloudUsage } | null = null;
  /** The ADE machines the last good list showed as cloud boxes: only those are worth a wake lookup. */
  let knownMachineKeys = new Set<string>();
  // Bumped by a key change, so a read under the old key can't refill the cache.
  let usageGeneration = 0;

  let monthUsageCache: { at: number; month: number; usage: CloudUsage } | null = null;
  /** This UTC month's usage, for the per-machine month figures. Cached like the 90-day read. */
  async function readMonthUsage(client: CloudProvider): Promise<CloudUsage | null> {
    const at = now();
    const month = monthStartMs(at);
    if (monthUsageCache && monthUsageCache.month === month && at - monthUsageCache.at < USAGE_CACHE_MS) return monthUsageCache.usage;
    const generation = usageGeneration;
    try {
      const usage = await client.usage({ from: cloudUsageDay(month) });
      if (generation === usageGeneration) monthUsageCache = { at, month, usage };
      return usage;
    } catch (error) {
      logger.warn?.("cloud.month_usage_read_failed", { error: errorText(error) });
      return monthUsageCache?.month === month ? monthUsageCache.usage : null;
    }
  }

  async function readUsage(client: CloudProvider): Promise<CloudUsage | null> {
    const at = now();
    if (usageCache && at - usageCache.at < USAGE_CACHE_MS) return usageCache.usage;
    const generation = usageGeneration;
    try {
      const usage = await client.usage({ from: cloudUsageDay(at - (USAGE_WINDOW_DAYS - 1) * DAY_MS) });
      if (generation === usageGeneration) usageCache = { at, usage };
      return usage;
    } catch (error) {
      // The boxes still show without their spend.
      logger.warn?.("cloud.usage_read_failed", { error: errorText(error) });
      return usageCache?.usage ?? null;
    }
  }

  /**
   * Every box in the workspace, ADE's own and the rest: the list shows a box
   * ADE made, and any other one whose ADE row it matches (signed in by hand).
   */
  async function list(): Promise<CloudMachinesResult> {
    const client = await deps.client();
    if (!client) return emptyResult("not_connected", null);
    let instances: CloudInstance[];
    try {
      instances = await client.listInstances();
    } catch (error) {
      const refused = error instanceof CloudProviderError && error.code === CLOUD_ACCESS_REFUSED;
      logger.warn?.("cloud.machines_read_failed", { error: errorText(error), refused });
      return emptyResult(refused ? "key_refused" : "unreachable", errorText(error));
    }
    const [usage, monthUsage, budget] = await Promise.all([readUsage(client), readMonthUsage(client), readBudget()]);
    const at = now();
    const live = instances.filter((instance) => instance.status !== "deleted");
    knownMachineKeys = new Set(live.map((instance) => instance.metadata[CLOUD_MACHINE_KEY_METADATA]).filter((key): key is string => Boolean(key)));
    const machines = live.map((instance) => toCloudMachine(instance, usage, at));
    return {
      state: "ok",
      machines,
      instanceCount: live.filter((instance) => instance.status !== "failed").length,
      runningCount: live.filter((instance) => cloudStatusAwake(instance.status)).length,
      usageAvailable: usage != null,
      spending: cloudSpendingFor(budget, cloudMonthSpentUsd(usage, at)),
      month: cloudMonthSpend(machines, monthUsage, at),
      deletedInstanceIds: usage ? Object.keys(usage.byInstance).filter((id) => !live.some((instance) => instance.id === id)) : [],
      message: null,
    };
  }

  const readBudget = async (): Promise<CloudBudget> => {
    if (!deps.readBudget) return { monthlyCapUsd: null, agents: CLOUD_DEFAULT_AGENT_LIMITS };
    return await deps.readBudget().catch((error: unknown) => {
      logger.warn?.("cloud.budget_read_failed", { error: errorText(error) });
      return { monthlyCapUsd: null, agents: CLOUD_DEFAULT_AGENT_LIMITS };
    });
  };

  /** This month against the cap, for a costly action. Unknown spend is not "over". */
  async function spending(client: CloudProvider) {
    const [usage, budget] = await Promise.all([readUsage(client), readBudget()]);
    return cloudSpendingFor(budget, cloudMonthSpentUsd(usage, now()));
  }

  /** The sentence and the way out for a provider refusal of a lifecycle action. */
  function refusal(
    action: CloudMachineActionArgs["action"],
    error: unknown,
  ): CloudMachineActionResult {
    const code = error instanceof CloudProviderError ? error.code : null;
    if (code === "rate_limited" && action === "backup") {
      return {
        ok: false,
        blocker: "rate_limited",
        message: "ADE Cloud takes one backup of a box every 15 minutes. Try again in a few minutes. It also keeps the last seven nights on its own.",
      };
    }
    if (code === "try_again") {
      return { ok: false, blocker: null, message: "The box is busy changing state. Try again in a moment." };
    }
    return { ok: false, blocker: null, message: errorText(error) };
  }

  async function run(args: CloudMachineActionArgs): Promise<CloudMachineActionResult> {
    const client = await deps.client();
    if (!client) return { ok: false, blocker: null, message: "ADE Cloud isn't available on this account yet." };
    const instanceId = typeof args?.instanceId === "string" ? args.instanceId.trim() : "";
    if (!isCloudInstanceId(instanceId)) return { ok: false, blocker: null, message: "ADE doesn't know that box." };
    const action = args.action;
    logger.info?.("cloud.machine_action", { instanceId, action, shape: args.shape ?? null });
    try {
      // What adds to the bill stops at the cap; sleeping, backing up and deleting never do.
      if (action === "wake" || action === "resize") {
        const month = await spending(client);
        if (month.capReached) return { ok: false, blocker: "cap", message: cloudCapReachedMessage(month) };
      }
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
            message: status === "running" ? "Awake. ADE on it is starting." : "Waking. ADE Cloud is moving it to a host with room.",
          };
        }
        case "resize": {
          const shape = cloudShape(args.shape);
          if (!shape) return { ok: false, blocker: null, message: "Pick a size." };
          const instance = await client.getInstance(instanceId);
          const current = resourcesOf(instance);
          if (!current) return { ok: false, blocker: null, message: "ADE Cloud didn't say how big this box is, so ADE can't resize it." };
          if (current.cpu === shape.cpu && current.memoryGb === shape.memoryGb) {
            return { ok: true, blocker: null, message: "It's already that size." };
          }
          const status = await client.resizeInstance(instanceId, cloudResizeBody(current, shape));
          return {
            ok: true,
            blocker: null,
            message: status === "running"
              ? `Resized to ${shape.cpu} vCPU · ${shape.memoryGb} GB. ADE on it is starting again.`
              : `Resizing to ${shape.cpu} vCPU · ${shape.memoryGb} GB. ADE Cloud is moving it to a host with room; it is back in a few minutes.`,
          };
        }
        case "backup": {
          await client.createBackup(instanceId);
          return { ok: true, blocker: null, message: "Backed up. ADE Cloud keeps this one until your next backup, plus the last seven nights." };
        }
        case "delete": {
          try {
            await client.deleteInstance(instanceId);
          } catch (error) {
            // A box already gone is what a delete wants.
            if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
          }
          const gone = await deleteCloudInstanceConfirmed(client, instanceId, { logger, sleep });
          if (!gone) {
            return {
              ok: false,
              blocker: null,
              message: "ADE Cloud took the delete but hasn't finished it yet. Check again in a minute; if the box is still there, delete it again.",
            };
          }
          logger.info?.("cloud.machine_deleted", { instanceId });
          const machineKey = typeof args.machineKey === "string" && args.machineKey.trim() ? args.machineKey.trim() : null;
          if (machineKey) {
            try {
              await deps.removeAccountMachine(machineKey);
            } catch (error) {
              logger.warn?.("cloud.deleted_box_account_row_left", { instanceId, error: errorText(error) });
              return {
                ok: true,
                blocker: null,
                accountRowLeft: true,
                message: `Deleted on ADE Cloud, so it no longer bills. ADE couldn't take it off your computers (${errorText(error).replace(/\.$/, "")}); use Remove from ADE on its row.`,
              };
            }
          }
          return { ok: true, blocker: null, message: "Deleted on ADE Cloud and removed from ADE. It no longer bills." };
        }
        case "set_sleep": {
          const minutes = args.sleepAfterMinutes ?? null;
          if (minutes != null && !(Number.isInteger(minutes) && minutes >= 5 && minutes <= 24 * 60)) {
            return { ok: false, blocker: null, message: "Pick 5 minutes to a day, or never." };
          }
          const result = await setCloudSleepAfter(client, instanceId, minutes, logger);
          switch (result.state) {
            case "never":
              return { ok: true, blocker: null, message: "It won't sleep on its own. It bills its full rate until you sleep it." };
            case "on":
              return { ok: true, blocker: null, message: `It sleeps after ${result.afterMinutes} minutes with nothing running on it.` };
            case "brain_too_old":
              return { ok: false, blocker: null, message: "The ADE on this box is too old to keep it awake while it works, so it can't sleep on its own yet. Update ADE on it, then try again." };
            case "not_running":
              return { ok: false, blocker: null, message: "Wake the box first." };
            default:
              return { ok: false, blocker: null, message: `ADE couldn't change how it sleeps: ${result.error}` };
          }
        }
        default:
          return { ok: false, blocker: null, message: "ADE can't do that to a box." };
      }
    } catch (error) {
      logger.warn?.("cloud.machine_action_failed", { instanceId, action, error: errorText(error) });
      return await refusal(action, error);
    }
  }

  return {
    list,
    run,
    /** Whether the last list showed this ADE machine as a cloud box. */
    isKnownBox: (machineKey: string): boolean => knownMachineKeys.has(machineKey),
    /** One box's metadata, read fresh. */
    instanceMetadata: async (instanceId: string): Promise<Record<string, string> | null> => {
      const client = await deps.client();
      return client ? (await client.getInstance(instanceId)).metadata : null;
    },
    /** Machines an agent made, copied or moved since UTC midnight that still exist (they carry `ade_made_by_chat`). */
    agentMadeToday: async (): Promise<number> => {
      const client = await deps.client();
      if (!client) return 0;
      const midnight = new Date(now());
      midnight.setUTCHours(0, 0, 0, 0);
      return (await client.listInstances()).filter((instance) => {
        if (!instance.metadata[CLOUD_MADE_BY_CHAT_METADATA] || instance.created == null) return false;
        // the provider answers epoch seconds; milliseconds are accepted too.
        const createdMs = instance.created < 1e12 ? instance.created * 1000 : instance.created;
        return createdMs >= midnight.getTime();
      }).length;
    },
    /** This month against the cap (a costly action from elsewhere checks it). */
    spending: async () => {
      const client = await deps.client();
      return client ? await spending(client) : null;
    },
    /** Forgets the spend read with the last key; a new key may be another workspace. */
    resetUsage: () => {
      usageCache = null;
      monthUsageCache = null;
      usageGeneration += 1;
    },
  };
}

/**
 * Records the box's ADE machine on the box itself (`ade_machine_key`), so
 * every computer on the account can match the box to its row, whatever the
 * row is named. the provider replaces metadata on write, so the rest is kept.
 */
export async function recordCloudMachineKey(
  client: CloudProvider,
  instanceId: string,
  machineKey: string,
  logger?: Logger,
): Promise<void> {
  try {
    const instance = await client.getInstance(instanceId);
    if (instance.metadata[CLOUD_MACHINE_KEY_METADATA] === machineKey) return;
    await client.setInstanceMetadata(instanceId, { ...instance.metadata, [CLOUD_MACHINE_KEY_METADATA]: machineKey });
  } catch (error) {
    // The hostname still matches the box to its row; this only makes it sure.
    logger?.warn?.("cloud.machine_key_record_failed", { instanceId, error: errorText(error) });
  }
}
