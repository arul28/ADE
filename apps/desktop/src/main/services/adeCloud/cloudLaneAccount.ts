import { randomUUID } from "node:crypto";
import { cloudMachineLaneFactsOf, CLOUD_LANE_BRANCH_METADATA } from "../../../shared/cloudLaneLaunch";
import {
  cloudWorkLaneName,
  type CloudLaneDeleteResult,
  type CloudLaneFreeResult,
  type CloudLaneWithoutComputer,
  type CloudLaneWorkLane,
  type CloudLaneWorkState,
} from "../../../shared/cloudLaneLife";
import type { CloudSavedChatRow } from "../../../shared/cloudSavedChats";
import { sameMachineKey } from "../../../shared/machineAddress";
import { expectedErrorKind } from "../../../shared/expectedError";
import { getErrorMessage } from "../shared/utils";
import {
  KEEP_AWAKE_STATE_COMMAND,
  LANE_NOT_ON_COMPUTER_MESSAGE,
  keepAwakeOf,
  pushWorkGithubMessage,
  pushWorkGithubProblem,
} from "../../../../../account-directory/src/cloud/computerCommands";
import type { CloudFreeRecord, CloudLaneBackup } from "../../../../../account-directory/src/cloud/contract";
import { CLOUD_MACHINE_KEY_METADATA, formerMachineKeysOf, type createCloudMachines } from "./cloudMachines";
import { CloudProviderError, type CloudInstance, type CloudLogger, type CloudProvider } from "./cloudProvider";
import { BRAND } from "../../../shared/brand";

/**
 * The account side of an ADE Cloud lane's life: read its work, delete it,
 * keep it and free its computer, keep a computer the idle cleanup warned
 * about, and delete a lane whose computer is gone. One implementation for
 * every caller: the desktop's main process (`cloudLaneLife.ts`, which adds
 * the tier-change jobs it runs itself) and a brain's `cloud` actions (the
 * CLI, agents, the phone).
 *
 * Every call is account level: it names a computer by its ADE Cloud id or a
 * lane by its id, never a pin, and goes to ADE's server.
 */

type MachinesApi = Pick<ReturnType<typeof createCloudMachines>, "run" | "runPushWork">;

export type CloudLaneAccountDeps = {
  machines: MachinesApi;
  client: () => Promise<CloudProvider>;
  /**
   * The account's lane backups (`GET /cloud/backups?machineKey=`). Unset, or a
   * read that fails: the work check asks the computer, which wakes it.
   */
  laneBackups?: ((machineKey: string) => Promise<CloudLaneBackup[]>) | null;
  /** Drops this app's connections to a computer that is gone. A brain with none passes a no-op. */
  forgetMachineConnections: (machine: { machineKey: string | null; instanceId: string }) => void;
  /** The account's computers changed: the callers read them again. */
  changed: () => void;
  /** A change this app runs on the computer (a tier change): a delete or a free waits for it. */
  busy?: (instanceId: string) => boolean;
  /** This app is quitting: a long free stops following the server. */
  disposed?: () => boolean;
  logger: CloudLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** A server free is followed this often, for at most this long (a push takes up to 3 minutes; a wake a few more). */
const FREE_POLL_MS = 2_000;
const FREE_FOLLOW_MAX_MS = 15 * 60_000;
// A lane's saved chats are read in pages of this size, at most this many pages.
const SAVED_CHAT_PAGE = 200;
const SAVED_CHAT_PAGES = 20;

/** The lanes with work only on the computer: unpushed, or unreadable (never counted as saved). */
export function cloudWorkLanesAtRisk(lanes: readonly CloudLaneWorkLane[] | null): CloudLaneWorkLane[] {
  return (lanes ?? []).filter((lane) => lane.state === "unpushed" || lane.state === "failed");
}

/**
 * The lanes a computer's backups say have work off GitHub: the newest backup
 * of each lane, with commits or changed files. A backup the computer restored
 * from another one is its lane's too (the list includes those).
 */
function lanesFromBackups(backups: readonly CloudLaneBackup[]): CloudLaneWorkLane[] {
  const newest = new Map<string, CloudLaneBackup>();
  for (const backup of backups) {
    const seen = newest.get(backup.laneId);
    if (!seen || backup.savedAt > seen.savedAt) newest.set(backup.laneId, backup);
  }
  return Array.from(newest.values())
    .filter((backup) => backup.commits > 0 || backup.files > 0)
    .map((backup) => ({
      laneId: backup.laneId,
      laneName: backup.laneName ?? "",
      branchRef: backup.branchRef ?? "",
      primary: false,
      dirty: backup.files > 0,
      ahead: backup.commits,
      files: backup.files,
      state: "unpushed" as const,
    }));
}

/** What `deleteLaneOfDeletedComputer` did: the kept record, and the lane's saved chats on deleted computers. */
export type CloudDeletedComputerLaneResult = {
  /** The server's record of the lane was removed (false: there was none). */
  forgotten: boolean;
  chatsDeleted: number;
  /** Chats that could not be read or deleted: try again. */
  chatsLeft: boolean;
};

export function createCloudLaneAccount(deps: CloudLaneAccountDeps) {
  const { logger } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const busy = (instanceId: string) => deps.busy?.(instanceId) === true;
  const disposed = () => deps.disposed?.() === true;

  const readInstance = async (instanceId: string): Promise<CloudInstance | null> => {
    const client = await deps.client();
    try {
      return await client.getInstance(instanceId);
    } catch (error) {
      if (error instanceof CloudProviderError && error.status === 404) return null;
      throw error;
    }
  };

  /**
   * An asleep computer that rested with every lane saved (`backups.saved`;
   * any start clears it) has its work off GitHub in its lane backups: read
   * them, with no wake. Null when that can't be said, so the computer is asked.
   */
  const workFromBackups = async (instance: CloudInstance | null): Promise<CloudLaneWorkState | null> => {
    if (!instance || !deps.laneBackups || instance.status === "running" || instance.backups?.saved !== true) return null;
    const machineKey = instance.metadata[CLOUD_MACHINE_KEY_METADATA];
    if (!machineKey) return null;
    try {
      const unpushedLanes = lanesFromBackups(await deps.laneBackups(machineKey));
      return { unpushed: unpushedLanes.length > 0, unpushedLanes, message: null, checkedBy: "backups" };
    } catch (error) {
      logger.warn?.("cloud.lane_work_backups_read_failed", { instanceId: instance.id, error: getErrorMessage(error) });
      return null;
    }
  };

  /**
   * Which lanes on the computer have work that is not on GitHub. An asleep
   * computer saved at rest answers from its backups with no wake; any other
   * computer runs the check there (a resting one wakes for it).
   */
  const workState = async (args: { instanceId: string; instance?: CloudInstance | null }): Promise<CloudLaneWorkState> => {
    const instance = args.instance !== undefined ? args.instance : await readInstance(args.instanceId).catch((error: unknown) => {
      // With no record, the check runs on the computer instead of from its backups.
      logger.warn?.("cloud.lane_work_instance_read_failed", { instanceId: args.instanceId, error: getErrorMessage(error) });
      return null;
    });
    const saved = await workFromBackups(instance);
    if (saved) return saved;
    const ran = await deps.machines.runPushWork(args.instanceId, { check: true });
    if (!ran.tally) return { unpushed: null, unpushedLanes: [], message: ran.error ?? `${BRAND.NAME} couldn't read this computer's work.` };
    // An older computer answers counts without the lane list: it can't say, so the caller warns.
    if (!ran.tally.lanes) return { unpushed: null, unpushedLanes: [], message: `This computer's ${BRAND.NAME} is too old to say what isn't pushed.` };
    const unpushedLanes = cloudWorkLanesAtRisk(ran.tally.lanes);
    const github = pushWorkGithubProblem(unpushedLanes);
    if (github) return { unpushed: null, unpushedLanes, message: pushWorkGithubMessage(github, "unknown") };
    // A project it couldn't open listed no lanes: its work is unknown, not saved.
    if (ran.tally.failed > 0) return { unpushed: null, unpushedLanes, message: `${BRAND.NAME} couldn't read every project on this computer.` };
    return { unpushed: unpushedLanes.length > 0, unpushedLanes, message: null, checkedBy: "computer" };
  };

  /**
   * Whether the agent's work keeps the computer busy, from its keep-awake
   * facts: `idle` (asleep counts), `busy`, or `unknown` when they can't be read.
   */
  const agentWork = async (instanceId: string): Promise<"idle" | "busy" | "setup" | "unknown"> => {
    const client = await deps.client();
    const instance = await client.getInstance(instanceId);
    if (instance.status !== "running") return "idle";
    const read = await client.exec(instanceId, KEEP_AWAKE_STATE_COMMAND, { timeoutMs: 30_000 }).catch((error: unknown) => {
      logger.warn?.("cloud.lane_keep_awake_read_failed", { instanceId, error: getErrorMessage(error) });
      return null;
    });
    if (!read) return "unknown";
    const work = keepAwakeOf(read.stdout);
    if (work === "unknown") logger.warn?.("cloud.lane_keep_awake_unreadable", { instanceId });
    return work;
  };

  const forgetConnections = (machineKey: string | null, instanceId: string): void => {
    try {
      deps.forgetMachineConnections({ machineKey, instanceId });
    } catch (error) {
      logger.warn?.("cloud.lane_connection_left", { instanceId, error: getErrorMessage(error) });
    }
  };

  /**
   * Deletes the saved chats of one machine key that `deletable` takes, a
   * page at a time. The cursor names the last row read (`updatedAt:chatId`),
   * so a delete never moves the next page, and a page with nothing to delete
   * still leads on to the rest. True when some are left past the page limit.
   */
  const clearSavedChats = async (client: CloudProvider, machineKey: string, deletable: (chat: CloudSavedChatRow) => boolean, count: () => void): Promise<boolean> => {
    let cursor: string | null = null;
    for (let pass = 0; pass < SAVED_CHAT_PAGES; pass += 1) {
      const page = await client.listSavedChats({ machineKey, limit: SAVED_CHAT_PAGE, cursor });
      const mine = page.chats.filter((chat) => sameMachineKey(chat.machineKey, machineKey) && deletable(chat));
      for (const chat of mine) {
        await client.deleteSavedChat({ machineKey: chat.machineKey, chatId: chat.chatId });
        count();
      }
      cursor = page.nextCursor;
      if (!cursor) return false;
    }
    return true;
  };

  /**
   * Deletes every saved chat the lane left on ADE Cloud: the computer's own,
   * listed by its key, and the lane's older copies from computers that are
   * gone (a size change moves a lane to a new computer and key). Resolves how
   * many went, or null when a list or a delete failed or chats were left past
   * the page limit (what was deleted stays deleted).
   */
  const deleteSavedChatsOf = async (lane: { machineKey: string; formerMachineKeys: readonly string[]; onlyChats: ReadonlySet<string> | null }): Promise<number | null> => {
    let deleted = 0;
    const count = () => { deleted += 1; };
    try {
      const client = await deps.client();
      // `onlyChats`: a lane move's chats, and nothing else, under any of the lane's keys.
      const only = lane.onlyChats;
      const listed = (chat: CloudSavedChatRow) => !only || only.has(chat.chatId);
      let left = await clearSavedChats(client, lane.machineKey, listed, count);
      // The computers a move replaced, only while the server says they are deleted: a move whose old computer stayed left it its chats.
      for (const machineKey of lane.formerMachineKeys) {
        if (sameMachineKey(machineKey, lane.machineKey)) continue;
        if (await clearSavedChats(client, machineKey, (chat) => chat.computer?.state === "deleted" && listed(chat), count)) left = true;
      }
      if (left) {
        logger.warn?.("cloud.lane_saved_chats_left", { deleted });
        return null;
      }
      return deleted;
    } catch (error) {
      logger.warn?.("cloud.lane_saved_chats_delete_failed", { deleted, error: getErrorMessage(error) });
      return null;
    }
  };

  /**
   * Deletes the computer and so the lane on it. Never refused: `skipCheck`
   * leaves out the work check when the person was already warned. Its saved
   * chats go too, unless `keepChats`: then they stay readable from ADE Cloud.
   * `onlyChats` deletes only those (a move's), and keeps the rest.
   */
  const deleteLane = async (args: { instanceId: string; skipCheck?: boolean; keepChats?: boolean; onlyChats?: readonly string[] }): Promise<CloudLaneDeleteResult> => {
    if (busy(args.instanceId)) {
      // A tier change mid-way would make a computer the delete doesn't know.
      return { ok: false, message: "This lane is changing size. Wait for it to finish, or cancel it, then delete.", unpushed: null, unpushedLanes: [], chatsKept: true };
    }
    const instance = await readInstance(args.instanceId);
    const machineKey = instance?.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null;
    const state = args.skipCheck || !instance ? null : await workState({ instanceId: args.instanceId, instance });
    const result = await deps.machines.run({ action: "delete", instanceId: args.instanceId, machineKey });
    // The chats go after the computer, so a turn that saves a last part can't bring one back.
    const chatsDeleted = result.ok && !args.keepChats && machineKey
      ? await deleteSavedChatsOf({ machineKey, formerMachineKeys: formerMachineKeysOf(instance?.metadata), onlyChats: args.onlyChats ? new Set(args.onlyChats) : null })
      : null;
    if (result.ok) {
      forgetConnections(machineKey, args.instanceId);
      deps.changed();
    }
    logger.info?.("cloud.lane_deleted", { instanceId: args.instanceId, ok: result.ok, unpushed: state?.unpushed ?? null, keepChats: args.keepChats === true, chatsDeleted });
    return {
      ok: result.ok,
      message: result.message,
      unpushed: state?.unpushed ?? null,
      unpushedLanes: state?.unpushedLanes ?? [],
      chatsKept: result.ok ? args.keepChats === true || chatsDeleted == null : true,
    };
  };

  /**
   * The free run by ADE's server (`frees.ts`): it goes on with this app
   * closed. Null when the server has no such route (an older one), so the
   * caller runs it here.
   */
  const freeOnServer = async (instanceId: string, laneId: string, machineKey: string | null): Promise<CloudLaneFreeResult | null> => {
    const client = await deps.client();
    if (!client.startFree || !client.readFree) return null;
    let free: CloudFreeRecord;
    try {
      free = await client.startFree(instanceId, randomUUID());
    } catch (error) {
      // The computer was read just before: a 404 here is a server with no such route.
      if (error instanceof CloudProviderError && error.status === 404) return null;
      return { ok: false, message: getErrorMessage(error), lane: null };
    }
    const deadline = now() + FREE_FOLLOW_MAX_MS;
    while (free.state !== "done" && free.state !== "failed" && free.state !== "cancelled") {
      if (disposed()) return { ok: false, message: `${BRAND.NAME} quit while the computer was being freed. ${BRAND.CLOUD_NAME} finishes it on its own.`, lane: null };
      if (now() > deadline) return { ok: false, message: `Freeing the computer is taking a while. ${BRAND.CLOUD_NAME} goes on with it; check again in a few minutes.`, lane: null };
      await sleep(FREE_POLL_MS);
      const last = free;
      free = await client.readFree(last.freeId).catch((error: unknown) => {
        logger.warn?.("cloud.lane_free_read_failed", { instanceId, error: getErrorMessage(error) });
        return last;
      });
    }
    logger.info?.("cloud.lane_freed", { instanceId, onServer: true, state: free.state, laneKept: free.laneKept });
    if (free.state !== "done") return { ok: false, message: free.error ?? free.message, lane: null };
    forgetConnections(machineKey, instanceId);
    deps.changed();
    const kept = free.laneKept
      ? await client.listLanesWithoutComputer().then((lanes) => lanes.find((entry) => entry.laneId === laneId) ?? null, () => null)
      : null;
    return { ok: true, message: free.message, lane: kept };
  };

  /**
   * Pushes the lane's work, then removes its computer and keeps the lane. A
   * push that can't save everything keeps the computer as it is.
   */
  const freeLane = async (args: { instanceId: string }): Promise<CloudLaneFreeResult> => {
    const fail = (message: string): CloudLaneFreeResult => ({ ok: false, message, lane: null });
    if (busy(args.instanceId)) return fail("This lane is changing size. Wait for it to finish, then try again.");
    const instance = await readInstance(args.instanceId);
    if (!instance) return fail(`${BRAND.CLOUD_NAME} has no such computer.`);
    const lane = cloudMachineLaneFactsOf(instance.metadata);
    if (!lane) return fail("This computer wasn't made for one lane, so there is no lane to keep. Delete it, or keep it.");
    const onServer = await freeOnServer(args.instanceId, lane.laneId, instance.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null);
    if (onServer) return onServer;
    // An older server: this app runs the free itself.
    // A running agent could write again after its lane was pushed.
    const work = await agentWork(args.instanceId);
    if (work === "setup") return fail("This lane is still being set up. Finish signing in, or cancel the setup, then free the computer.");
    if (work === "busy") return fail("The agent is still working. Stop it or wait, then free the computer.");
    if (work === "unknown") return fail(`${BRAND.NAME} couldn't tell whether the agent is still working, so the computer stays. Try again in a moment.`);
    // Archived lanes too: their work goes with the computer.
    const ran = await deps.machines.runPushWork(args.instanceId, { check: false });
    if (!ran.tally) return fail(`${BRAND.NAME} couldn't push this lane's work, so the computer stays: ${(ran.error ?? "no answer").replace(/\.$/, "")}.`);
    const left = cloudWorkLanesAtRisk(ran.tally.lanes);
    if (ran.tally.failed > 0 || left.length > 0 || (!ran.tally.lanes && ran.tally.skipped > 0)) {
      const github = pushWorkGithubProblem(left);
      if (github) return fail(pushWorkGithubMessage(github, "kept"));
      const names = left.map(cloudWorkLaneName).filter(Boolean);
      return fail(`${BRAND.NAME} couldn't push all work on this computer${names.length ? ` (${names.join(", ")})` : ""}, so it stays. Open the lane to see why, then try again.`);
    }
    // Read once more after the push, on the computer itself: anything new or unknown keeps the computer.
    const after = await workState({ instanceId: args.instanceId, instance: null });
    if (after.unpushed !== false) {
      const names = after.unpushedLanes.map(cloudWorkLaneName).filter(Boolean);
      return fail(after.unpushed
        ? `Work changed on this computer while ${BRAND.NAME} pushed it${names.length ? ` (${names.join(", ")})` : ""}, so it stays. Try again.`
        : `${BRAND.NAME} couldn't confirm all work is on GitHub, so the computer stays: ${(after.message ?? "no answer").replace(/\.$/, "")}.`);
    }
    const ownLane = ran.tally.lanes?.find((entry) => entry.laneId === lane.laneId)
      ?? (ran.tally.lanes ?? []).filter((entry) => !entry.primary).at(0)
      ?? null;
    const branchRef = ownLane?.branchRef || instance.metadata[CLOUD_LANE_BRANCH_METADATA] || null;
    if (!branchRef) return fail(ran.tally.lanes && !ownLane ? LANE_NOT_ON_COMPUTER_MESSAGE : `${BRAND.NAME} couldn't tell which branch this lane is on, so the computer stays.`);
    const machineKey = instance.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null;
    // A refusal (the server couldn't read the lane, or knows none) deleted
    // nothing: its sentence is shown as it is, and the lane is not freed.
    const result = await deps.machines.run({ action: "delete", instanceId: args.instanceId, machineKey, keepLane: { branchRef } });
    if (!result.ok) return fail(result.message);
    forgetConnections(machineKey, args.instanceId);
    deps.changed();
    const client = await deps.client();
    const kept = await client.listLanesWithoutComputer()
      .then((lanes) => lanes.find((entry) => entry.laneId === lane.laneId) ?? null)
      .catch((error: unknown) => {
        logger.warn?.("cloud.lane_kept_read_failed", { instanceId: args.instanceId, error: getErrorMessage(error) });
        return null;
      });
    logger.info?.("cloud.lane_freed", { instanceId: args.instanceId, kept: kept != null });
    if (!kept) {
      // The computer is gone but the server didn't keep the lane (an older server).
      return { ok: true, message: "The work is on GitHub and the computer is removed. Start a new lane on its branch to go on.", lane: null };
    }
    return { ok: true, message: "The work is on GitHub and the computer is removed. The next message makes a new computer on the same branch.", lane: kept };
  };

  // Read on window focus by every surface. An account with no ADE Cloud, or a
  // signed-out app, has no such lanes: the answer is the empty list, not the
  // refusal, which focus would otherwise report again and again.
  const lanesWithoutComputer = async (): Promise<CloudLaneWithoutComputer[]> => {
    let client: CloudProvider;
    try {
      client = await deps.client();
    } catch (error) {
      if (expectedErrorKind(error) === "user") return [];
      throw error;
    }
    return await client.listLanesWithoutComputer();
  };

  /** Deleting a lane that has no computer: its record goes, and the server deletes its backups and its saved chats with it. */
  const forgetLaneWithoutComputer = async (args: { laneId: string }): Promise<{ forgotten: boolean }> => {
    const forgotten = await (await deps.client()).forgetLaneWithoutComputer(args.laneId);
    deps.changed();
    return { forgotten };
  };

  /**
   * Deletes a lane whose computer is gone: the server's record first (it
   * refuses while a computer holds the lane again, so chats that computer
   * carries on are never deleted; its backups go with it), then the lane's
   * saved chats on the given machine keys whose computer is deleted.
   */
  const deleteLaneOfDeletedComputer = async (args: { laneId: string; machineKeys: readonly string[]; kept: boolean }): Promise<CloudDeletedComputerLaneResult> => {
    const client = await deps.client();
    const forgotten = args.kept ? await client.forgetLaneWithoutComputer(args.laneId) : false;
    let chatsDeleted = 0;
    let chatsLeft = false;
    const count = () => { chatsDeleted += 1; };
    const keys = Array.from(new Set(args.machineKeys.filter(Boolean)));
    try {
      for (const machineKey of keys) {
        const deletable = (chat: CloudSavedChatRow) => chat.laneId === args.laneId && chat.computer?.state === "deleted";
        if (await clearSavedChats(client, machineKey, deletable, count)) chatsLeft = true;
      }
    } catch (error) {
      logger.warn?.("cloud.deleted_lane_chats_delete_failed", { laneId: args.laneId, chatsDeleted, error: getErrorMessage(error) });
      chatsLeft = true;
    }
    deps.changed();
    logger.info?.("cloud.deleted_lane_removed", { laneId: args.laneId, forgotten, chatsDeleted, chatsLeft });
    return { forgotten, chatsDeleted, chatsLeft };
  };

  /** Keeps a computer the idle cleanup warned about: no wake, no hours; the idle clock starts again. */
  const keepComputer = async (args: { instanceId: string }): Promise<void> => {
    const client = await deps.client();
    if (!client.keepIdleComputer) throw new Error(`Update ${BRAND.NAME} to keep this computer from here.`);
    await client.keepIdleComputer(args.instanceId);
    deps.changed();
  };

  return {
    readInstance,
    workState,
    agentWork,
    forgetConnections,
    deleteLane,
    freeLane,
    lanesWithoutComputer,
    forgetLaneWithoutComputer,
    deleteLaneOfDeletedComputer,
    keepComputer,
  };
}

export type CloudLaneAccount = ReturnType<typeof createCloudLaneAccount>;
