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
  CLOUD_DISK_FULL_REASON_METADATA,
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
import { withDeadline } from "../shared/withTimeout";

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
  /**
   * ADE Cloud only when the last access answer for this account was yes,
   * without asking the server. A miss in `knowsBox` refreshes through it, so
   * a person who is not on ADE Cloud never waits on the provider.
   */
  knownClient?: () => CloudProvider | null;
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
    diskFull: cloudDiskFullMessage(instance.metadata[CLOUD_DISK_FULL_METADATA], catalog, instance.metadata[CLOUD_DISK_FULL_REASON_METADATA]),
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

/** The ADE machine keys of the account's computers that still exist. */
function liveMachineKeys(instances: readonly CloudInstance[]): Set<string> {
  return new Set(
    instances
      .filter((instance) => instance.status !== "deleted")
      .map((instance) => instance.metadata[CLOUD_MACHINE_KEY_METADATA])
      .filter((key): key is string => Boolean(key)),
  );
}

/** One read of the computers for the known keys must not hold up a connect for long. */
const KNOWN_KEYS_READ_TIMEOUT_MS = 5_000;
/**
 * A key a good read already covered and did not list (a laptop) is not read
 * for again until the last good read is this old: a laptop's reconnects fail
 * every couple of minutes all day.
 */
const KNOWN_KEYS_NOT_LISTED_TTL_MS = 10 * 60_000;
/** After a read that failed, a miss waits this long before it reads again. */
const KNOWN_KEYS_FAILED_READ_PAUSE_MS = 60_000;

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
  /**
   * The ADE machines the last good read showed as cloud boxes: only those are
   * worth a wake lookup. Filled by `list()`, at startup (`loadKnownMachines`)
   * and on a miss (`knowsBox`), so it never waits for the Connections pane.
   */
  let knownMachineKeys = new Set<string>();
  /** The last good read: every computer and when. Stamped by every good read. */
  let lastRead: { instances: CloudInstance[]; atMs: number } | null = null;
  /** Keys a good read covered and did not list: not cloud computers, as of `lastRead`. */
  const notListedKeys = new Set<string>();
  let lastFailedReadAtMs = Number.NEGATIVE_INFINITY;
  let knownKeysRead: Promise<boolean> | null = null;
  /** From the last account read that worked, so a failed read doesn't bring deleted computers' rows back. */
  let lastDeletedInstanceIds: string[] = [];

  function recordRead(instances: CloudInstance[]): void {
    knownMachineKeys = liveMachineKeys(instances);
    lastRead = { instances, atMs: now() };
  }

  /** One bounded read of the account's computers, shared by concurrent callers. True when it worked. */
  function readKnownMachineKeys(client: CloudProvider, reason: "startup" | "miss"): Promise<boolean> {
    if (knownKeysRead) return knownKeysRead;
    const read = (async () => {
      try {
        recordRead(await withDeadline(
          client.listInstances(),
          KNOWN_KEYS_READ_TIMEOUT_MS,
          () => new Error(`ADE Cloud didn't answer in ${KNOWN_KEYS_READ_TIMEOUT_MS / 1000} s.`),
        ));
        return true;
      } catch (error) {
        lastFailedReadAtMs = now();
        logger.warn?.("cloud.known_machines_refresh_failed", { reason, error: getErrorMessage(error) });
        return false;
      }
    })();
    knownKeysRead = read;
    // Cleared after it is stored: a read that fails at once would otherwise
    // clear first and then be stored, settled, for good.
    void read.then(() => {
      if (knownKeysRead === read) knownKeysRead = null;
    });
    return read;
  }

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
    recordRead(instances);
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
    if (code === "out_of_hours" || code === "over_plan_disk") {
      return { ok: false, blocker: code, message: getErrorMessage(error) };
    }
    // A disk refusal keeps its reason, so a notice can offer the way out (extra disk, a bigger size).
    const reason = error instanceof CloudProviderError && (code === "disk_limit" || code === "needs_paid_plan")
      ? error.detail.reason ?? (code === "needs_paid_plan" ? "plan_disk" : null)
      : null;
    if (reason && error instanceof CloudProviderError) {
      return { ok: false, blocker: null, message: getErrorMessage(error), diskRefusal: { reason } };
    }
    return { ok: false, blocker: null, message: getErrorMessage(error) };
  }

  async function run(args: CloudMachineActionArgs): Promise<CloudMachineActionResult> {
    const client = await deps.client();
    if (!client) return { ok: false, blocker: null, message: (await deps.whyNoClient?.()) ?? "ADE Cloud isn't available on this account yet." };
    const instanceId = typeof args?.instanceId === "string" ? args.instanceId.trim() : "";
    if (!isCloudInstanceId(instanceId)) return { ok: false, blocker: null, message: "ADE doesn't know that computer." };
    const action = args.action;
    logger.info?.("cloud.machine_action", { instanceId, action, shape: args.shape ?? null, disk: args.disk ?? null });
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
          const shape = args.shape === undefined ? null : cloudShape(args.shape);
          const disk = typeof args.disk === "number" && Number.isInteger(args.disk) && args.disk > 0 ? args.disk : null;
          if ((args.shape !== undefined && !shape) || (!shape && disk == null)) return { ok: false, blocker: null, message: "Pick a size." };
          const instance = await client.getInstance(instanceId);
          const current = resourcesOf(instance);
          if (!current) return { ok: false, blocker: null, message: "ADE Cloud didn't say how big this computer is, so ADE can't resize it." };
          const growDisk = disk != null && disk > current.diskGb;
          if (!shape) {
            if (!growDisk) return { ok: true, blocker: null, message: "The disk is already that size." };
            // Same size, bigger disk: the server restarts the computer for it.
            const status = await client.resizeInstance(
              instanceId,
              { cpu: current.cpu, memory: current.memoryGb, disk },
              args.computerIdle === true ? { computerIdle: true } : undefined,
            );
            return {
              ok: true,
              blocker: null,
              message: status === "running"
                ? `The disk is ${disk} GB now. ADE on it is starting again.`
                : `Growing the disk to ${disk} GB. The computer restarts and is back in a few minutes.`,
            };
          }
          if (current.cpu === shape.cpu && current.memoryGb === shape.memoryGb && !growDisk) {
            return { ok: true, blocker: null, message: "It's already that size." };
          }
          const status = await client.resizeInstance(
            instanceId,
            { cpu: shape.cpu, memory: shape.memoryGb, ...(growDisk ? { disk } : {}) },
            growDisk && args.computerIdle === true ? { computerIdle: true } : undefined,
          );
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
    /**
     * Whether this ADE machine is a cloud box:
     * - a key the last good read listed: yes, no call;
     * - a key a good read covered and did not list: no, with no call until
     *   the last good read is 10 minutes old, then one read;
     * - a key no good read covered yet (a box made or paired since): one read
     *   at once, joined with any read already running.
     * No call without a known yes to ADE Cloud access, and none for 60 s
     * after a read that failed.
     */
    knowsBox: async (machineKey: string): Promise<boolean> => {
      if (knownMachineKeys.has(machineKey)) return true;
      let read = knownKeysRead;
      if (!read) {
        const covered = notListedKeys.has(machineKey) && lastRead != null;
        if (covered && now() - lastRead!.atMs < KNOWN_KEYS_NOT_LISTED_TTL_MS) return false;
        if (now() - lastFailedReadAtMs < KNOWN_KEYS_FAILED_READ_PAUSE_MS) return false;
        const client = deps.knownClient?.() ?? null;
        if (!client) return false;
        read = readKnownMachineKeys(client, "miss");
      }
      // A failed read covers nothing.
      if (!(await read)) return false;
      if (knownMachineKeys.has(machineKey)) return true;
      notListedKeys.add(machineKey);
      return false;
    },
    /** Reads the known keys once (at startup); nothing when this account has no ADE Cloud. */
    loadKnownMachines: async (): Promise<void> => {
      const client = await deps.client().catch((error: unknown) => {
        logger.warn?.("cloud.known_machines_startup_client_failed", { error: getErrorMessage(error) });
        return null;
      });
      if (client) await readKnownMachineKeys(client, "startup");
    },
    /** Every computer from the last good read, when it is at most `maxAgeMs` old; else null. */
    recentInstances: (maxAgeMs: number): CloudInstance[] | null =>
      lastRead && now() - lastRead.atMs <= maxAgeMs ? lastRead.instances : null,
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
