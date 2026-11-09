/**
 * Cloud computers in the machine list: what each one is and how fast it uses
 * hours, and the lifecycle actions on it (sleep, wake, resize, back up, delete).
 *
 * Account-level, like the rest of the integration: every call goes to the
 * account's cloud machines, from the desktop the person is
 * using, never to the box's own brain. So none of it takes a pin, and an
 * action works the same whichever machine a project tab is bound to.
 */

import {
  CLOUD_MADE_BY_CHAT_METADATA,
  isCloudInstanceId,
  cloudCatalogOf,
  cloudHoursRate,
  cloudMachineKindOf,
  cloudMachineState,
  cloudMachineType,
  cloudShape,
  cloudDiskFullMessage,
  CLOUD_DISK_FULL_METADATA,
  cloudShapeFor,
  cloudStatusAwake,
  type CloudAccountState,
  type CloudMachine,
  type CloudMachineActionArgs,
  type CloudCatalog,
  type CloudMachineActionResult,
  type CloudMachinesResult,
  type CloudResources,
} from "../../../shared/adeCloud";
import { CLOUD_READY_METADATA, readCloudReadyMachineState } from "../../../shared/cloudReady";
import { CLOUD_ACCESS_REFUSED, CloudProviderError, type CloudProvider, type CloudInstance } from "./cloudProvider";
import { deleteCloudInstanceConfirmed } from "./cloudPendingCreates";
import { cloudSleepPolicyOf } from "./cloudSleep";
import { wakeThroughTransition } from "./cloudReadyClaim";
import { getErrorMessage } from "../shared/utils";

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
};

/** The metadata key ADE writes once a box joins the account: its ADE machine key. */
export const CLOUD_MACHINE_KEY_METADATA = "ade_machine_key";

export type CloudMachinesDeps = {
  /** ADE Cloud for this account, or null when it has no access. */
  client: () => Promise<CloudProvider | null>;
  /** The sentence for why `client` answered null. */
  whyNoClient?: () => Promise<string | null>;
  /** Removes a machine from the ADE account directory (the "Remove from ADE" half of a delete). */
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function resourcesOf(instance: CloudInstance): CloudResources | null {
  const raw = instance.resources;
  if (!raw || !raw.cpu || !raw.memory) return null;
  return { cpu: raw.cpu, memoryGb: raw.memory, diskGb: raw.disk };
}

function toCloudMachine(instance: CloudInstance, catalog: CloudCatalog): CloudMachine {
  const resources = resourcesOf(instance);
  const type = cloudMachineType(instance.type);
  const shape = cloudShapeFor(resources);
  return {
    instanceId: instance.id,
    name: instance.name,
    status: instance.status,
    state: cloudMachineState(instance.status),
    type,
    resources,
    shapeId: shape?.id ?? null,
    region: instance.region,
    hoursRate: shape ? cloudHoursRate(cloudMachineKindOf(type), shape.id, catalog) : null,
    pastDue: instance.pastDue,
    failure: instance.status === "failed" ? instance.statusReason?.message ?? null : null,
    machineKey: instance.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null,
    createdAtMs: instance.created != null ? instance.created * 1000 : null,
    ready: readyOf(instance),
    sleep: cloudSleepPolicyOf(instance),
    diskFull: cloudDiskFullMessage(instance.metadata[CLOUD_DISK_FULL_METADATA], catalog),
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

function emptyResult(state: CloudMachinesResult["state"], message: string | null): CloudMachinesResult {
  return {
    state,
    machines: [],
    instanceCount: null,
    runningCount: null,
    account: null,
    message,
  };
}

/** Bounded so a frozen push can't outlast the free short wake it runs in. */
const PUSH_ALL_WORK_TIMEOUT_MS = 3 * 60_000;

/**
 * Commits and pushes every project's lanes on the computer (`ade cloud
 * push-work`). The new ADE sits on the disk (`$ADE_HOME/bin`), and ADE on the
 * computer answers a few seconds after a start.
 */
const PUSH_ALL_WORK_COMMAND = [
  'export PATH="$ADE_HOME/bin:$PATH"',
  'i=0; until ade projects list --json >/dev/null 2>&1 || [ "$i" -ge 25 ]; do sleep 1; i=$((i+1)); done',
  "ade cloud push-work --json",
].join("\n");

function readPushAllTally(stdout: string): { pushed: number; failed: number; skipped: number } | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as { result?: Record<string, unknown> } & Record<string, unknown>;
    const tally = parsed.result ?? parsed;
    return { pushed: Number(tally.pushed) || 0, failed: Number(tally.failed) || 0, skipped: Number(tally.skipped) || 0 };
  } catch {
    return null;
  }
}

function pushAllWorkResult(exitCode: number, tally: { pushed: number; failed: number; skipped: number } | null): CloudMachineActionResult {
  if (exitCode !== 0 || !tally) return { ok: false, blocker: null, message: "ADE couldn't push this computer's work. Try again." };
  const { pushed, failed, skipped } = tally;
  if (pushed === 0 && failed === 0) {
    return { ok: true, blocker: null, message: skipped ? `Nothing new to push. ${skipped === 1 ? "One primary lane has" : `${skipped} primary lanes have`} local work left on the computer.` : "All work is already on GitHub." };
  }
  const moved = `${pushed} ${pushed === 1 ? "lane" : "lanes"}`;
  const left = failed ? ` ${failed} couldn't be pushed; open the computer to see why.` : "";
  return { ok: failed === 0, blocker: null, message: `Pushed ${moved} to GitHub.${left}` };
}

export function createCloudMachines(deps: CloudMachinesDeps) {
  const logger = deps.logger ?? {};
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** The ADE machines the last good list showed as cloud boxes: only those are worth a wake lookup. */
  let knownMachineKeys = new Set<string>();
  /** From the last account read that worked, so a failed read doesn't bring deleted computers' rows back. */
  let lastDeletedInstanceIds: string[] = [];

  /** Every computer on the account (the server lists only the account's own). */
  async function list(): Promise<CloudMachinesResult> {
    const client = await deps.client();
    if (!client) return emptyResult("not_connected", (await deps.whyNoClient?.()) ?? null);
    let instances: CloudInstance[];
    try {
      instances = await client.listInstances();
    } catch (error) {
      const refused = error instanceof CloudProviderError && error.code === CLOUD_ACCESS_REFUSED;
      logger.warn?.("cloud.machines_read_failed", { error: getErrorMessage(error), refused });
      return emptyResult(refused ? "access_refused" : "unreachable", getErrorMessage(error));
    }
    const account = await readAccount(client);
    if (account) lastDeletedInstanceIds = account.deletedInstanceIds;
    const catalog = cloudCatalogOf(account);
    const live = instances.filter((instance) => instance.status !== "deleted");
    knownMachineKeys = new Set(live.map((instance) => instance.metadata[CLOUD_MACHINE_KEY_METADATA]).filter((key): key is string => Boolean(key)));
    const machines = live.map((instance) => toCloudMachine(instance, catalog));
    return {
      state: "ok",
      machines,
      instanceCount: live.filter((instance) => instance.status !== "failed").length,
      runningCount: live.filter((instance) => cloudStatusAwake(instance.status)).length,
      account,
      deletedInstanceIds: lastDeletedInstanceIds,
      message: null,
    };
  }

  /** Plan and hours, or null when they can't be read. Unknown is not "out". */
  async function readAccount(client: CloudProvider): Promise<CloudAccountState | null> {
    return await client.getAccount().catch((error: unknown) => {
      logger.warn?.("cloud.account_read_failed", { error: getErrorMessage(error) });
      return null;
    });
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
        message: "ADE Cloud takes one backup of a computer every 15 minutes. Try again in a few minutes. It also keeps the last seven nights on its own.",
      };
    }
    if (code === "out_of_hours") {
      return { ok: false, blocker: "out_of_hours", message: getErrorMessage(error) };
    }
    return { ok: false, blocker: null, message: getErrorMessage(error) };
  }

  async function run(args: CloudMachineActionArgs): Promise<CloudMachineActionResult> {
    const client = await deps.client();
    if (!client) return { ok: false, blocker: null, message: (await deps.whyNoClient?.()) ?? "ADE Cloud isn't available on this account yet." };
    const instanceId = typeof args?.instanceId === "string" ? args.instanceId.trim() : "";
    if (!isCloudInstanceId(instanceId)) return { ok: false, blocker: null, message: "ADE doesn't know that computer." };
    const action = args.action;
    logger.info?.("cloud.machine_action", { instanceId, action, shape: args.shape ?? null });
    try {
      switch (action) {
        case "sleep": {
          await client.sleepInstance(instanceId);
          return { ok: true, blocker: null, message: "Asleep. It uses no hours until it wakes." };
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
          if (!current) return { ok: false, blocker: null, message: "ADE Cloud didn't say how big this computer is, so ADE can't resize it." };
          if (current.cpu === shape.cpu && current.memoryGb === shape.memoryGb) {
            return { ok: true, blocker: null, message: "It's already that size." };
          }
          const status = await client.resizeInstance(instanceId, { cpu: shape.cpu, memory: shape.memoryGb });
          return {
            ok: true,
            blocker: null,
            message: status === "running"
              ? `Resized to ${shape.label}. ADE on it is starting again.`
              : `Resizing to ${shape.label}. It is back in a few minutes.`,
          };
        }
        case "backup": {
          await client.createBackup(instanceId);
          return { ok: true, blocker: null, message: "Backed up. ADE Cloud keeps this one until your next backup, plus the last seven nights." };
        }
        case "update": {
          await client.updateInstance(instanceId);
          return { ok: true, blocker: null, message: "Updating. It restarts and is back in a few minutes." };
        }
        case "delete": {
          try {
            await client.deleteInstance(instanceId, { who: args.who ?? null, reason: "user" });
          } catch (error) {
            // A box already gone is what a delete wants.
            if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
          }
          const gone = await deleteCloudInstanceConfirmed(client, instanceId, { logger, sleep });
          if (!gone) {
            return {
              ok: false,
              blocker: null,
              message: "ADE Cloud took the delete but hasn't finished it yet. Check again in a minute; if the computer is still there, delete it again.",
            };
          }
          logger.info?.("cloud.machine_deleted", { instanceId });
          const machineKey = typeof args.machineKey === "string" && args.machineKey.trim() ? args.machineKey.trim() : null;
          if (machineKey) {
            try {
              await deps.removeAccountMachine(machineKey);
            } catch (error) {
              logger.warn?.("cloud.deleted_box_account_row_left", { instanceId, error: getErrorMessage(error) });
              return {
                ok: true,
                blocker: null,
                accountRowLeft: true,
                message: `Deleted on ADE Cloud. ADE couldn't take it off your computers (${getErrorMessage(error).replace(/\.$/, "")}); use Remove from ADE on its row.`,
              };
            }
          }
          return { ok: true, blocker: null, message: "Deleted on ADE Cloud and removed from ADE." };
        }
        default:
          return { ok: false, blocker: null, message: "ADE can't do that to a computer." };
      }
    } catch (error) {
      logger.warn?.("cloud.machine_action_failed", { instanceId, action, error: getErrorMessage(error) });
      return refusal(action, error);
    }
  }

  return {
    list,
    run,
    /**
     * "Push all work to GitHub": a free short wake at 0 hours, then every lane's
     * work (committed as it stands, then pushed) over exec, so it needs no pairing.
     */
    pushAllWork: async (instanceId: string): Promise<CloudMachineActionResult> => {
      const client = await deps.client();
      if (!client) return { ok: false, blocker: null, message: (await deps.whyNoClient?.()) ?? "ADE Cloud isn't available on this account yet." };
      try {
        await wakeThroughTransition(client, instanceId, now, { reason: "push_work" });
        const ran = await client.exec(instanceId, PUSH_ALL_WORK_COMMAND, { timeoutMs: PUSH_ALL_WORK_TIMEOUT_MS });
        const tally = readPushAllTally(ran.stdout);
        logger.info?.("cloud.push_all_work", { instanceId, exitCode: ran.exitCode, ...(tally ?? {}) });
        return pushAllWorkResult(ran.exitCode, tally);
      } catch (error) {
        logger.warn?.("cloud.push_all_work_failed", { instanceId, error: getErrorMessage(error) });
        return { ok: false, blocker: null, message: getErrorMessage(error) };
      }
    },
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
    /** Plan and hours (a costly action from elsewhere checks them). */
    account: async (): Promise<CloudAccountState | null> => {
      const client = await deps.client();
      return client ? await client.getAccount() : null;
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
    logger?.warn?.("cloud.machine_key_record_failed", { instanceId, error: getErrorMessage(error) });
  }
}
