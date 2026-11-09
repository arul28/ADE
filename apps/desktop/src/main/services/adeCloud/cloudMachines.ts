/**
 * cloud boxes in the machine list: what each one is and how fast it uses
 * hours, and the lifecycle actions on it (sleep, wake, resize, back up, delete).
 *
 * Account-level, like the rest of the integration: every call goes to the
 * the account's cloud machines, from the desktop the person is
 * using, never to the box's own brain. So none of it takes a pin, and an
 * action works the same whichever machine a project tab is bound to.
 */

import {
  CLOUD_MADE_BY_CHAT_METADATA,
  CLOUD_OUT_OF_HOURS_MESSAGE,
  isCloudInstanceId,
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
  type CloudMachineActionResult,
  type CloudMachinesResult,
  type CloudResources,
} from "../../../shared/adeCloud";
import { CLOUD_READY_METADATA, readCloudReadyMachineState } from "../../../shared/cloudReady";
import { CLOUD_ACCESS_REFUSED, cloudUsageDay, CloudProviderError, type CloudProvider, type CloudInstance, type CloudUsage } from "./cloudProvider";
import { deleteCloudInstanceConfirmed } from "./cloudPendingCreates";
import { cloudSleepPolicyOf } from "./cloudSleep";
import { wakeThroughTransition } from "./cloudReadyClaim";
import { getErrorMessage } from "../shared/utils";

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
};

/** the provider's usage window reaches back 90 days at most. */
const USAGE_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60_000;
/** Which deleted machines the usage still lists changes slowly. */
const USAGE_CACHE_MS = 5 * 60_000;

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

function toCloudMachine(instance: CloudInstance): CloudMachine {
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
    hoursRate: shape ? cloudHoursRate(cloudMachineKindOf(type), shape.id) : null,
    pastDue: instance.pastDue,
    failure: instance.status === "failed" ? instance.statusReason?.message ?? null : null,
    machineKey: instance.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null,
    createdAtMs: instance.created != null ? instance.created * 1000 : null,
    madeByAde: cloudInstanceMadeByAde(instance),
    ready: readyOf(instance),
    sleep: cloudSleepPolicyOf(instance),
    diskFull: cloudDiskFullMessage(instance.metadata[CLOUD_DISK_FULL_METADATA]),
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
 * Commits and pushes every project's lanes on the computer: uncommitted work is
 * committed as it stands; the primary lane is only reported, since its branch
 * is usually the default one. Prints one JSON tally line.
 */
const PUSH_ALL_WORK_COMMAND = [
  'd="$ADE_HOME/cloud/holds"; mkdir -p "$d"; printf \'{"reason":"push_work","until":%s}\' "$(( $(date +%s%3N) + 600000 ))" > "$d/push_work.json"',
  // ADE on the computer answers a few seconds after a start.
  'i=0; until ade projects list --json >/dev/null 2>&1 || [ "$i" -ge 25 ]; do sleep 1; i=$((i+1)); done',
  "python3 - <<'PY'",
  "import json, subprocess",
  "def ade(*args, cwd=None):",
  "    r = subprocess.run(['ade', *args], capture_output=True, text=True, cwd=cwd, timeout=150)",
  "    return r.returncode, r.stdout",
  "tally = {'pushed': 0, 'failed': 0, 'skipped': 0}",
  "rc, out = ade('projects', 'list', '--json')",
  "try:",
  "    payload = json.loads(out)",
  "    projects = payload if isinstance(payload, list) else (payload.get('projects') or [])",
  "except Exception: projects = []",
  "for project in projects:",
  "    root = project.get('rootPath') or project.get('path')",
  "    if not root: continue",
  "    rc, out = ade('lanes', 'list', '--json', cwd=root)",
  "    try: lanes = json.loads(out).get('lanes') or []",
  "    except Exception: continue",
  "    for lane in lanes:",
  "        if lane.get('archivedAt'): continue",
  "        status = lane.get('status') or {}",
  "        dirty = bool(status.get('dirty'))",
  "        ahead = int(status.get('ahead') or 0)",
  "        if not dirty and ahead == 0: continue",
  "        if lane.get('laneType') == 'primary':",
  "            tally['skipped'] += 1; continue",
  "        lane_id = lane.get('id')",
  "        if dirty:",
  "            ade('git', 'stage-all', '--lane', lane_id, cwd=root)",
  "            ade('git', 'commit', '--lane', lane_id, '-m', 'Work saved from ADE Cloud', cwd=root)",
  "        rc, _ = ade('git', 'push', '--lane', lane_id, '--set-upstream', cwd=root)",
  "        tally['pushed' if rc == 0 else 'failed'] += 1",
  "print(json.dumps(tally))",
  "PY",
  'code=$?; rm -f "$d/push_work.json"; exit $code',
].join("\n");

function readPushAllTally(stdout: string): { pushed: number; failed: number; skipped: number } | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const parsed = JSON.parse(line) as { pushed?: unknown; failed?: unknown; skipped?: unknown };
    return { pushed: Number(parsed.pushed) || 0, failed: Number(parsed.failed) || 0, skipped: Number(parsed.skipped) || 0 };
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
  let usageCache: { at: number; usage: CloudUsage } | null = null;
  /** The ADE machines the last good list showed as cloud boxes: only those are worth a wake lookup. */
  let knownMachineKeys = new Set<string>();

  async function readUsage(client: CloudProvider): Promise<CloudUsage | null> {
    const at = now();
    if (usageCache && at - usageCache.at < USAGE_CACHE_MS) return usageCache.usage;
    try {
      const usage = await client.usage({ from: cloudUsageDay(at - (USAGE_WINDOW_DAYS - 1) * DAY_MS) });
      usageCache = { at, usage };
      return usage;
    } catch (error) {
      // The boxes still show without it.
      logger.warn?.("cloud.usage_read_failed", { error: errorText(error) });
      return usageCache?.usage ?? null;
    }
  }

  /**
   * Every box on the account, ADE's own and the rest: the list shows a box
   * ADE made, and any other one whose ADE row it matches (signed in by hand).
   */
  async function list(): Promise<CloudMachinesResult> {
    const client = await deps.client();
    if (!client) return emptyResult("not_connected", (await deps.whyNoClient?.()) ?? null);
    let instances: CloudInstance[];
    try {
      instances = await client.listInstances();
    } catch (error) {
      const refused = error instanceof CloudProviderError && error.code === CLOUD_ACCESS_REFUSED;
      logger.warn?.("cloud.machines_read_failed", { error: errorText(error), refused });
      return emptyResult(refused ? "access_refused" : "unreachable", errorText(error));
    }
    const [usage, account] = await Promise.all([readUsage(client), readAccount(client)]);
    const live = instances.filter((instance) => instance.status !== "deleted");
    knownMachineKeys = new Set(live.map((instance) => instance.metadata[CLOUD_MACHINE_KEY_METADATA]).filter((key): key is string => Boolean(key)));
    const machines = live.map((instance) => toCloudMachine(instance));
    return {
      state: "ok",
      machines,
      instanceCount: live.filter((instance) => instance.status !== "failed").length,
      runningCount: live.filter((instance) => cloudStatusAwake(instance.status)).length,
      account,
      deletedInstanceIds: usage ? Object.keys(usage.byInstance).filter((id) => !live.some((instance) => instance.id === id)) : [],
      message: null,
    };
  }

  /** Plan and hours, or null when they can't be read. Unknown is not "out". */
  async function readAccount(client: CloudProvider): Promise<CloudAccountState | null> {
    return await client.getAccount().catch((error: unknown) => {
      logger.warn?.("cloud.account_read_failed", { error: errorText(error) });
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
        message: "ADE Cloud takes one backup of a box every 15 minutes. Try again in a few minutes. It also keeps the last seven nights on its own.",
      };
    }
    if (code === "out_of_hours") {
      return { ok: false, blocker: "out_of_hours", message: error instanceof Error ? error.message : CLOUD_OUT_OF_HOURS_MESSAGE };
    }
    if (code === "try_again") {
      return { ok: false, blocker: null, message: "The box is busy changing state. Try again in a moment." };
    }
    return { ok: false, blocker: null, message: errorText(error) };
  }

  async function run(args: CloudMachineActionArgs): Promise<CloudMachineActionResult> {
    const client = await deps.client();
    if (!client) return { ok: false, blocker: null, message: (await deps.whyNoClient?.()) ?? "ADE Cloud isn't available on this account yet." };
    const instanceId = typeof args?.instanceId === "string" ? args.instanceId.trim() : "";
    if (!isCloudInstanceId(instanceId)) return { ok: false, blocker: null, message: "ADE doesn't know that box." };
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
          if (!current) return { ok: false, blocker: null, message: "ADE Cloud didn't say how big this box is, so ADE can't resize it." };
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
                message: `Deleted on ADE Cloud. ADE couldn't take it off your computers (${errorText(error).replace(/\.$/, "")}); use Remove from ADE on its row.`,
              };
            }
          }
          return { ok: true, blocker: null, message: "Deleted on ADE Cloud and removed from ADE." };
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
    logger?.warn?.("cloud.machine_key_record_failed", { instanceId, error: errorText(error) });
  }
}
