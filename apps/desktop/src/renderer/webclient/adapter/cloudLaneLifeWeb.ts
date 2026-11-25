import type { CloudMachineActionResult } from "../../../shared/adeCloud";
import { CloudApiError, type CloudApiClient } from "../../../shared/cloudApiClient";
import { cloudMachineLaneFactsOf, CLOUD_LANE_NAME_METADATA } from "../../../shared/cloudLaneLaunch";
import {
  CLOUD_LANE_CHANGE_RUNNING_MESSAGE,
  CLOUD_LANE_SAVE_WARNING_DETAIL,
  cloudLaneJobGrowsDiskOnly,
  cloudLaneJobIsLive,
  cloudLaneJobStageIds,
  type CloudLaneDeleteResult,
  type CloudLaneFreeResult,
  type CloudLaneJobSnapshot,
  type CloudLaneJobStage,
  type CloudLaneJobStageId,
  type CloudLaneWorkLane,
  type CloudLaneWorkState,
} from "../../../shared/cloudLaneLife";
import {
  cloudTierRequestChatMachineKey,
  cloudTierRequestEndArgs,
  cloudTierRequestIdsOf,
  cloudTierRequestOutcomeOfJob,
  cloudTierRequestProjectRef,
  createTierRequestTelling,
  type CloudTierRequestAnswerArgs,
} from "../../../shared/cloudTierRequest";
import { cloudTierOfShape, cloudTiers, type CloudTier } from "../../../shared/cloudTiers";
import type { CloudCatalog } from "../../../shared/adeCloud";
import { sameMachineKey } from "../../../shared/machineAddress";
import { sanitizeRendererProjectBinding } from "../../../shared/projectBinding";
import type { MachineProjectRef } from "../../../shared/projectIdentity";
import { forwardSignalToSentry } from "../../../shared/sentry/logBridge";
import type { OpenProjectBinding, RemoteOpenProjectBinding } from "../../../shared/types/core";
import {
  CLOUD_MACHINE_KEY_METADATA,
  KEEP_AWAKE_STATE_COMMAND,
  agentWorkOf,
  formerMachineKeysOf,
  prepareStopCommand,
  pushWorkCommand,
  readPushWorkTally,
  shellJobId,
} from "../../../../../account-directory/src/cloud/computerCommands";
import type { CloudFreeRecord, CloudInstance } from "../../../../../account-directory/src/cloud/contract";

/**
 * ADE Web's life of a lane's computer, through the account server with this
 * browser's account token, so it needs no computer of the person's: the work
 * check, delete lane, free (keep the lane), push all work, and a size change
 * in place. The desktop's main process does the same (`cloudLaneLife.ts`,
 * `cloudMachines.ts`), and the phone does too (`CloudServerClient.swift`);
 * the sentences are theirs.
 *
 * - Work check and push: `ade cloud work-state` / `push-work` on the
 *   computer (`POST /cloud/instances/:id/exec`), the same command and parser
 *   the server uses (`computerCommands.ts`).
 * - Free: ADE's server runs the whole free (`POST /cloud/instances/:id/free`,
 *   `frees.ts`); this tab starts it and reads it until it ends.
 * - A size change in place runs in this tab (stages like the desktop's job).
 *   "When the agent is idle" waits here too, so the page has to stay open.
 */

/** As the desktop's: 3 minutes, plus the minute the git warm-up may take. */
const PUSH_WORK_TIMEOUT_MS = 4 * 60_000;
const KEEP_AWAKE_TIMEOUT_MS = 30_000;
const PREPARE_STOP_TIMEOUT_MS = 90_000;
const WAKE_RETRY_MS = 15_000;
const WAKE_TRANSIENT_CODES = new Set(["try_again", "wake_failed", "wake_timeout", "host_mesh_not_ready"]);
const DELETE_CONFIRM_ATTEMPTS = 15;
const DELETE_CONFIRM_POLL_MS = 2_000;
const FREE_POLL_MS = 2_500;
const FREE_WAIT_MAX_MS = 15 * 60_000;
const IDLE_POLL_MS = 30_000;
const IDLE_WAIT_MAX_MS = 24 * 60 * 60_000;
const RESTART_WAIT_MS = 15 * 60_000;
const RESTART_POLL_MS = 5_000;
const SAVED_CHAT_PAGE = 200;
const SAVED_CHAT_PAGES = 20;
const WORK_CHECK_UNKNOWN = /unknown (cloud )?command|method not found|can't read this computer's work/i;
const WORK_CHECK_TOO_OLD = "This computer's ADE is too old to say what isn't pushed.";
/** The same sentence as `CLOUD_LANE_LIFE_UNAVAILABLE` (cloudLaneActions.ts). */
const ON_DESKTOP = "Do this in the ADE desktop app. This window can't change ADE Cloud lanes.";
const DELETE_UNCONFIRMED = "ADE Cloud took the delete but hasn't finished it yet. Check again in a minute; if the computer is still there, delete it again.";

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const withoutStop = (text: string): string => text.trim().replace(/[.!?…]+$/, "");
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isNotFound = (error: unknown) => error instanceof CloudApiError && error.status === 404;

type PushWorkTally = { pushed: number; failed: number; skipped: number; lanes: CloudLaneWorkLane[] | null };

const WORK_LANE_STATES = new Set<CloudLaneWorkLane["state"]>(["clean", "pushed", "failed", "unpushed"]);

/** `readPushWorkTally`'s answer with each lane's `dirty` and `ahead`, which the delete's list names. */
function workTallyOf(stdout: string): PushWorkTally | null {
  const tally = readPushWorkTally(stdout);
  if (!tally) return null;
  let raw: Record<string, { dirty?: unknown; ahead?: unknown }> = {};
  try {
    const parsed = JSON.parse(stdout.trim()) as { result?: { lanes?: unknown }; lanes?: unknown };
    const lanes = (parsed.result ?? parsed).lanes;
    if (Array.isArray(lanes)) {
      raw = Object.fromEntries(lanes.flatMap((lane) => (lane && typeof lane === "object" && typeof (lane as { laneId?: unknown }).laneId === "string" ? [[(lane as { laneId: string }).laneId, lane]] : [])));
    }
  } catch {
    // `readPushWorkTally` read it, so this can't fail; the counts stay zero if it does.
  }
  return {
    pushed: tally.pushed,
    failed: tally.failed,
    skipped: tally.skipped,
    lanes: tally.lanes?.map((lane) => ({
      laneId: lane.laneId,
      laneName: lane.laneName,
      branchRef: lane.branchRef,
      primary: lane.primary,
      dirty: raw[lane.laneId]?.dirty === true,
      ahead: Number(raw[lane.laneId]?.ahead) || 0,
      state: WORK_LANE_STATES.has(lane.state as CloudLaneWorkLane["state"]) ? lane.state as CloudLaneWorkLane["state"] : "unpushed",
    })) ?? null,
  };
}

const leftLanes = (lanes: readonly CloudLaneWorkLane[] | null): CloudLaneWorkLane[] =>
  (lanes ?? []).filter((lane) => lane.state === "unpushed" || lane.state === "failed");

/** "Pushed 2 lanes to GitHub." and the rest, as the desktop says it (`pushAllWorkResult`). */
function pushAllWorkResult(exitCode: number, tally: PushWorkTally | null): CloudMachineActionResult {
  if (exitCode !== 0 || !tally) return { ok: false, blocker: null, message: "ADE couldn't push this computer's work. Try again." };
  const { pushed, failed, skipped } = tally;
  if (pushed === 0 && failed === 0) {
    return { ok: true, blocker: null, message: skipped ? `Nothing new to push. ${skipped === 1 ? "One primary lane has" : `${skipped} primary lanes have`} local work left on the computer.` : "All work is already on GitHub." };
  }
  const moved = `${pushed} ${pushed === 1 ? "lane" : "lanes"}`;
  const left = failed ? ` ${failed} couldn't be pushed; open the computer to see why.` : "";
  return { ok: failed === 0, blocker: null, message: `Pushed ${moved} to GitHub.${left}` };
}

/** The computer, or null when ADE Cloud has none by that id. */
async function readComputer(api: CloudApiClient, instanceId: string): Promise<CloudInstance | null> {
  try {
    return await api.computer(instanceId);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Wakes (or starts) a computer, trying again for a few seconds while it is still changing state. */
async function wakeThroughTransition(api: CloudApiClient, instanceId: string): Promise<void> {
  const deadline = Date.now() + WAKE_RETRY_MS;
  for (;;) {
    try {
      await api.wake(instanceId);
      return;
    } catch (error) {
      if (!(error instanceof CloudApiError) || !WAKE_TRANSIENT_CODES.has(error.code) || Date.now() >= deadline) throw error;
      await wait(500);
    }
  }
}

/** Deletes a computer and waits until the server says it is gone (a 404 or `deleted`). False when it isn't yet. */
async function deleteComputerConfirmed(api: CloudApiClient, instanceId: string): Promise<boolean> {
  try {
    await api.deleteComputer(instanceId, { reason: "user" });
  } catch (error) {
    // A computer already gone is what a delete wants.
    if (!isNotFound(error)) throw error;
  }
  for (let attempt = 0; attempt < DELETE_CONFIRM_ATTEMPTS; attempt += 1) {
    try {
      if ((await api.computer(instanceId)).status === "deleted") return true;
    } catch (error) {
      if (isNotFound(error)) return true;
      // Read again on the next round.
    }
    if (attempt < DELETE_CONFIRM_ATTEMPTS - 1) await wait(DELETE_CONFIRM_POLL_MS);
  }
  return false;
}

export type WebCloudLaneLifeDeps = {
  api: () => CloudApiClient | null;
  /** A size change or move runs for this computer: a delete or free waits for it. */
  changing: (instanceId: string) => boolean;
};

export function createWebCloudLaneLife(deps: WebCloudLaneLifeDeps) {
  const need = () => {
    const api = deps.api();
    if (!api) throw new Error("Sign in to ADE to change your ADE Cloud lanes.");
    return api;
  };

  const runPushWork = async (api: CloudApiClient, instanceId: string, check: boolean): Promise<{ tally: PushWorkTally | null; error: string | null }> => {
    try {
      await wakeThroughTransition(api, instanceId);
      const ran = await api.exec(instanceId, pushWorkCommand(check), PUSH_WORK_TIMEOUT_MS);
      const tally = ran.exitCode === 0 ? workTallyOf(ran.stdout) : null;
      if (tally) return { tally, error: null };
      if (check && ran.exitCode !== 0 && WORK_CHECK_UNKNOWN.test(`${ran.stderr}\n${ran.stdout}`)) return { tally: null, error: WORK_CHECK_TOO_OLD };
      return { tally: null, error: "ADE couldn't read this computer's work." };
    } catch (error) {
      return { tally: null, error: errorText(error) };
    }
  };

  const workStateWith = async (api: CloudApiClient, instanceId: string): Promise<CloudLaneWorkState> => {
    const ran = await runPushWork(api, instanceId, true);
    if (!ran.tally) return { unpushed: null, unpushedLanes: [], message: ran.error ?? "ADE couldn't read this computer's work." };
    // An older computer answers counts without the lane list: it can't say, so the caller warns.
    if (!ran.tally.lanes) return { unpushed: null, unpushedLanes: [], message: WORK_CHECK_TOO_OLD };
    const unpushedLanes = leftLanes(ran.tally.lanes);
    // A project it couldn't open listed no lanes: its work is unknown, not saved.
    if (ran.tally.failed > 0) return { unpushed: null, unpushedLanes, message: "ADE couldn't read every project on this computer." };
    return { unpushed: unpushedLanes.length > 0, unpushedLanes, message: null };
  };

  /**
   * Every saved chat the lane left on ADE Cloud: the computer's own, and the
   * lane's older copies from computers a move replaced (only those the server
   * says are deleted). How many went, or null when some are left.
   */
  const deleteSavedChatsOf = async (api: CloudApiClient, lane: { machineKey: string; formerMachineKeys: readonly string[] }): Promise<number | null> => {
    let deleted = 0;
    const clear = async (machineKey: string, deletable: (chat: { computer?: { state?: string } | null }) => boolean): Promise<boolean> => {
      // Each pass lists what is left, so the next page is the first page again.
      for (let pass = 0; pass < SAVED_CHAT_PAGES; pass += 1) {
        const page = await api.savedChats({ machineKey, limit: SAVED_CHAT_PAGE });
        const mine = page.chats.filter((chat) => sameMachineKey(chat.machineKey, machineKey) && deletable(chat));
        for (const chat of mine) {
          await api.deleteSavedChat(chat.machineKey, chat.chatId);
          deleted += 1;
        }
        if (!page.nextCursor || mine.length === 0) return false;
      }
      return true;
    };
    try {
      let left = await clear(lane.machineKey, () => true);
      for (const machineKey of lane.formerMachineKeys) {
        if (sameMachineKey(machineKey, lane.machineKey)) continue;
        if (await clear(machineKey, (chat) => chat.computer?.state === "deleted")) left = true;
      }
      return left ? null : deleted;
    } catch (error) {
      forwardSignalToSentry("web.cloud_lane_saved_chats_delete_failed", { deleted, message: errorText(error) }, "cloud_lane_saved_chats_delete_failed", "info");
      return null;
    }
  };

  return {
    workState: async (instanceId: string): Promise<CloudLaneWorkState> => await workStateWith(need(), instanceId),

    /** `cloud.pushAllWork`: every lane's work on the computer, committed and pushed. It wakes a resting computer. */
    pushAllWork: async (instanceId: string): Promise<CloudMachineActionResult> => {
      const api = need();
      try {
        await wakeThroughTransition(api, instanceId);
        const ran = await api.exec(instanceId, pushWorkCommand(false), PUSH_WORK_TIMEOUT_MS);
        return pushAllWorkResult(ran.exitCode, workTallyOf(ran.stdout));
      } catch (error) {
        return { ok: false, blocker: null, message: errorText(error) };
      }
    },

    /** Deletes the computer, and so the lane on it; then its saved chats unless `keepChats`. */
    deleteComputer: async (instanceId: string): Promise<CloudMachineActionResult> => {
      const api = need();
      try {
        if (!(await deleteComputerConfirmed(api, instanceId))) return { ok: false, blocker: null, message: DELETE_UNCONFIRMED };
        return { ok: true, blocker: null, message: "Deleted on ADE Cloud and removed from ADE." };
      } catch (error) {
        return { ok: false, blocker: null, message: errorText(error) };
      }
    },

    deleteLane: async (args: { instanceId: string; skipCheck?: boolean; keepChats?: boolean }): Promise<CloudLaneDeleteResult> => {
      const api = need();
      const refuse = (message: string, state: CloudLaneWorkState | null = null): CloudLaneDeleteResult => ({
        ok: false,
        message,
        unpushed: state?.unpushed ?? null,
        unpushedLanes: state?.unpushedLanes ?? [],
        chatsKept: true,
      });
      if (deps.changing(args.instanceId)) {
        return refuse("This lane is changing size. Wait for it to finish, or cancel it, then delete.");
      }
      const instance = await readComputer(api, args.instanceId);
      const machineKey = instance?.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null;
      const state = args.skipCheck || !instance ? null : await workStateWith(api, args.instanceId);
      // Without the person's go-ahead (`skipCheck`), work that may not be on GitHub keeps the lane.
      if (state && state.unpushed !== false) {
        return refuse(state.unpushed
          ? "This lane has work that isn't on GitHub, so ADE kept it. Push it first, or delete anyway."
          : `ADE couldn't check this lane for work that isn't on GitHub, so it stays: ${withoutStop(state.message ?? "no answer")}.`, state);
      }
      let gone: boolean;
      try {
        gone = await deleteComputerConfirmed(api, args.instanceId);
      } catch (error) {
        return refuse(errorText(error), state);
      }
      if (!gone) return refuse(DELETE_UNCONFIRMED, state);
      // The chats go after the computer, so a turn that saves a last part can't bring one back.
      const chatsDeleted = !args.keepChats && machineKey
        ? await deleteSavedChatsOf(api, { machineKey, formerMachineKeys: formerMachineKeysOf(instance?.metadata) })
        : null;
      return {
        ok: true,
        message: "Deleted on ADE Cloud and removed from ADE.",
        unpushed: state?.unpushed ?? null,
        unpushedLanes: state?.unpushedLanes ?? [],
        chatsKept: args.keepChats === true || chatsDeleted == null,
      };
    },

    /**
     * Pushes the lane's work, removes its computer and keeps the lane. ADE's
     * server runs every step; this reads its record until it ends.
     */
    freeLane: async (args: { instanceId: string }): Promise<CloudLaneFreeResult> => {
      const api = need();
      const fail = (message: string): CloudLaneFreeResult => ({ ok: false, message, lane: null });
      if (deps.changing(args.instanceId)) return fail("This lane is changing size. Wait for it to finish, then try again.");
      let instance: CloudInstance | null;
      try {
        instance = await readComputer(api, args.instanceId);
      } catch (error) {
        return fail(errorText(error));
      }
      if (!instance) return fail("ADE Cloud has no such computer.");
      let record: CloudFreeRecord;
      try {
        record = await api.startFree(args.instanceId, crypto.randomUUID());
      } catch (error) {
        // An older server has no free of its own: the desktop app still frees it.
        if (isNotFound(error)) return fail(ON_DESKTOP);
        return fail(errorText(error));
      }
      const since = Date.now();
      while (record.state !== "done" && record.state !== "failed" && record.state !== "cancelled") {
        if (Date.now() - since > FREE_WAIT_MAX_MS) {
          return fail("ADE Cloud is still freeing the computer. Check again in a few minutes.");
        }
        await wait(FREE_POLL_MS);
        // A read that fails is read again on the next round, until the wait runs out.
        record = await api.free(record.freeId).catch(() => record);
      }
      if (record.state !== "done") return fail(record.error || record.message || "ADE Cloud couldn't free the computer.");
      const kept = record.laneKept && record.laneId
        ? (await api.lanesWithoutComputer().catch(() => [])).find((lane) => lane.laneId === record.laneId) ?? null
        : null;
      return {
        ok: true,
        message: record.message || (kept
          ? "The work is on GitHub and the computer is removed. The next message makes a new computer on the same branch."
          : "The work is on GitHub and the computer is removed. Start a new lane on its branch to go on."),
        lane: kept,
      };
    },

    /** Whether the agent's work keeps the computer busy: asleep counts as idle; facts it can't read are unknown. */
    agentWork: async (instanceId: string): Promise<"idle" | "busy" | "unknown"> => {
      const api = need();
      if ((await api.computer(instanceId)).status !== "running") return "idle";
      const read = await api.exec(instanceId, KEEP_AWAKE_STATE_COMMAND, KEEP_AWAKE_TIMEOUT_MS).catch(() => null);
      return read ? agentWorkOf(read.stdout) : "unknown";
    },
  };
}

// ---------------------------------------------------------------------------
// Telling the chat that asked for a change how it ended, from this tab
// ---------------------------------------------------------------------------

/** The agent's size request a change answers: its chat is told how the change ended, on the chat's machine. */
export type WebTierRequest = { requestId: string; chatSessionId: string; pin: RemoteOpenProjectBinding };

/** The request fields a change carries from its card's yes (`CloudLaneChangeTierArgs`). */
export type WebTierRequestInput = { requestId?: unknown; requestedByChat?: unknown; requestedByChatPin?: unknown };

/** How this tab reaches the asking chat's machine. */
export type WebTierRequestReach = {
  /** `cloud.tier_request_answer` through a pin: the federated adapter sends it to the pin's machine. */
  answer: (pin: OpenProjectBinding, args: CloudTierRequestAnswerArgs) => Promise<unknown>;
  /** The account machine a connection of this tab reaches, or null. */
  machineKeyOf: (targetId: string) => Promise<string | null>;
  /** The pin of a project on a machine of the account, connecting (and waking) that machine first (`pickMachineProject`). */
  pinOnMachine: (machineKey: string, ref: MachineProjectRef) => Promise<OpenProjectBinding>;
};

/** A chat this tab couldn't tell how its change ended is tried again after these waits. */
const TELL_CHAT_RETRY_MS = [15_000, 60_000];

/**
 * The request a change carries, or null without one. Its pin is rebuilt
 * field by field (`sanitizeRendererProjectBinding`, as main does), with no
 * icon: ADE Web reaches a chat only on another machine, so only a remote pin
 * counts.
 */
export function webTierRequestOf(raw: WebTierRequestInput | null | undefined): WebTierRequest | null {
  const { requestId, requestedByChat: chatSessionId } = cloudTierRequestIdsOf(raw);
  const pin = sanitizeRendererProjectBinding(raw?.requestedByChatPin, () => null);
  if (!requestId || !chatSessionId || !pin || pin.kind !== "remote") return null;
  return { requestId, chatSessionId, pin };
}

/**
 * Tells the chat whose size request started a change how it ended, from this
 * tab, whatever shows the chat (none may): `createTierRequestTelling`, one
 * telling per request, of its newest change (a Retry's new job is newer, and
 * its end is a new end). A pin that names no machine, or a chat that moved
 * with the lane, is reached by its machine key
 * (`cloudTierRequestChatMachineKey`). The chat's machine tells the agent
 * once, by the card.
 */
export function createWebTierRequestTeller(reach: WebTierRequestReach) {
  type Entry = {
    request: WebTierRequest;
    job: CloudLaneJobSnapshot;
    /** The machine the job started on: a move's old computer. */
    fromMachineKey: string | null;
    /** The job and end last told. */
    told: string | null;
  };
  const byRequest = new Map<string, Entry>();
  const telling = createTierRequestTelling({
    retryMs: TELL_CHAT_RETRY_MS,
    onFailed: (error, { key, final }) => {
      if (!final) return;
      const entry = byRequest.get(key);
      forwardSignalToSentry("web.cloud_tier_request_tell_failed", { outcome: entry ? cloudTierRequestOutcomeOfJob(entry.job) : null, message: errorText(error) }, "cloud_tier_request_tell_failed", "info");
    },
  });

  const pinNow = async (entry: Entry): Promise<OpenProjectBinding> => {
    const { pin } = entry.request;
    const machineKey = cloudTierRequestChatMachineKey({ pin, pinMachineKey: await reach.machineKeyOf(pin.targetId), job: entry.job, fromMachineKey: entry.fromMachineKey });
    if (!machineKey) return pin;
    return await reach.pinOnMachine(machineKey, cloudTierRequestProjectRef(pin, entry.job));
  };

  /** The job's end, by job: a Retry's new job ends anew. */
  const endOf = (entry: Entry): string | null => {
    const outcome = cloudTierRequestOutcomeOfJob(entry.job);
    return outcome ? `${entry.job.jobId}:${outcome}` : null;
  };

  return {
    /** A change that answers `request` published: an end is told (an older change of the same request no longer is). */
    note(request: WebTierRequest | null, job: CloudLaneJobSnapshot, fromMachineKey: string | null): void {
      if (!request) return;
      const known = byRequest.get(request.requestId);
      if (known && known.job.jobId !== job.jobId && job.startedAt < known.job.startedAt) return;
      const entry: Entry = known ?? { request, job, fromMachineKey, told: null };
      Object.assign(entry, { request, job, fromMachineKey });
      byRequest.set(request.requestId, entry);
      telling.note(request.requestId, {
        read: () => endOf(entry),
        tell: async () => {
          // `read` just gave an end, so the job has ended; if not, the try fails and nothing is marked told.
          await reach.answer(await pinNow(entry), cloudTierRequestEndArgs(entry.job, entry.request));
        },
        isTold: (end) => entry.told === end,
        markTold: (end) => {
          entry.told = end;
        },
      });
    },
  };
}

export type WebTierRequestTeller = ReturnType<typeof createWebTierRequestTeller>;

// ---------------------------------------------------------------------------
// A size change in place, run in this tab
// ---------------------------------------------------------------------------

type ResizeRecord = {
  job: CloudLaneJobSnapshot;
  tier: CloudTier;
  cancelled: boolean;
  request: WebTierRequest | null;
};

/** The disk a resize grows to, or null to keep it (never smaller, never past what the size allows). */
function diskGrowOf(raw: unknown, currentGb: number | null, tier: CloudTier): number | null {
  if (raw == null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) throw new Error("Pick a disk size in whole GB.");
  if (currentGb == null) throw new Error("ADE Cloud didn't say how big this computer's disk is, so ADE can't grow it.");
  if (raw <= currentGb) return null;
  if (tier.diskMaxGb != null && raw > tier.diskMaxGb) throw new Error(`${tier.label} lets the disk grow to ${tier.diskMaxGb} GB.`);
  return raw;
}

export function createWebCloudResizes(deps: {
  api: () => CloudApiClient | null;
  agentWork: (instanceId: string) => Promise<"idle" | "busy" | "unknown">;
  /** A move of this computer runs (on ADE's server): with this tab's own size changes, one change of a computer at a time. */
  moving: (instanceId: string) => boolean;
  /** This tab ran the change, so it tells the chat whose size request started it how it ended. */
  teller: WebTierRequestTeller;
}) {
  const jobs = new Map<string, ResizeRecord>();
  const listeners = new Set<(job: CloudLaneJobSnapshot) => void>();
  const nowIso = () => new Date().toISOString();

  const publish = (record: ResizeRecord) => {
    record.job.updatedAt = nowIso();
    const job = structuredClone(record.job);
    for (const listener of listeners) listener(job);
    deps.teller.note(record.request, record.job, record.job.machineKey);
  };

  const stageOf = (record: ResizeRecord, id: CloudLaneJobStageId): CloudLaneJobStage | null =>
    record.job.stages.find((stage) => stage.id === id) ?? null;

  const setStage = (record: ResizeRecord, id: CloudLaneJobStageId, status: CloudLaneJobStage["status"], detail?: string | null) => {
    const stage = stageOf(record, id);
    if (!stage) return;
    stage.status = status;
    if (status === "running") {
      stage.startedAt ??= nowIso();
      stage.endedAt = null;
      stage.error = null;
    } else if (status !== "pending") {
      stage.endedAt = nowIso();
    }
    if (detail !== undefined) stage.detail = detail;
    publish(record);
  };

  class Stopped extends Error {}
  const assertActive = (record: ResizeRecord) => {
    if (record.cancelled) throw new Stopped();
  };

  const run = async (record: ResizeRecord): Promise<void> => {
    const job = record.job;
    const api = deps.api();
    let active: CloudLaneJobStageId = "save";
    try {
      if (!api) throw new Error("Sign in to ADE to change your ADE Cloud lanes.");
      // Save work: wait for the agent (or stop its turn), then write the chats' saved copy.
      const growOnly = cloudLaneJobGrowsDiskOnly(job);
      setStage(record, "save", "running", growOnly ? "Saving the chats" : job.timing === "now" ? "Stopping the running turn" : "Waiting for the agent to finish. Keep this page open.");
      if (job.timing === "idle") {
        const since = Date.now();
        while ((await deps.agentWork(job.instanceId).catch(() => "unknown" as const)) !== "idle") {
          assertActive(record);
          if (Date.now() - since > IDLE_WAIT_MAX_MS) throw new Error("The agent didn't finish within a day. Change the size now, or try again later.");
          await wait(IDLE_POLL_MS);
          assertActive(record);
        }
        job.phase = "running";
        publish(record);
      }
      assertActive(record);
      const before = await api.computer(job.instanceId);
      const wasAwake = before.status === "running";
      if (wasAwake) {
        // Stops what still runs and writes the saved chat copy, so the chats read the same while it restarts.
        // A save that fails goes on: the person chose to restart now.
        const ran = await api.exec(job.instanceId, prepareStopCommand(growOnly ? { gb: job.diskGb ?? 0, jobId: job.jobId } : null), PREPARE_STOP_TIMEOUT_MS).catch(() => null);
        setStage(record, "save", ran?.exitCode === 0 ? "done" : "warning", ran?.exitCode === 0 ? null : CLOUD_LANE_SAVE_WARNING_DETAIL);
      } else {
        setStage(record, "save", "done", "Asleep, nothing running");
      }
      assertActive(record);

      active = "resize";
      const diskGb = job.diskGb ?? null;
      setStage(record, "resize", "running", diskGb ? `With a ${diskGb} GB disk` : null);
      let status: string;
      try {
        status = (await api.resize(job.instanceId, growOnly
          ? { disk: diskGb ?? 0, computerIdle: true }
          : { cpu: record.tier.cpu, memory: record.tier.memoryGb, ...(diskGb ? { disk: diskGb, computerIdle: true } : {}) })).status;
      } catch (error) {
        // The save left a grow note that would read the next restart as a disk grow.
        if (growOnly && wasAwake) {
          await api.exec(job.instanceId, `f="$ADE_HOME/cloud/disk-grow.json"; grep -q '"jobId":"${shellJobId(job.jobId)}"' "$f" 2>/dev/null && rm -f "$f"; true`, 20_000).catch(() => null);
        }
        throw error;
      }
      setStage(record, "resize", "done");

      active = "start";
      if (!wasAwake) {
        // It was asleep: it stays asleep, and the next message starts it at the new size.
        setStage(record, "start", "skipped", "Asleep. The next message starts it.");
        setStage(record, "connect", "skipped");
      } else {
        setStage(record, "start", "running");
        const since = Date.now();
        while (status !== "running") {
          if (status === "failed") throw new Error("ADE Cloud couldn't start the computer again.");
          // A resize leaves it asleep on some sizes: wake it, as a send would.
          if (status === "sleeping" || status === "stopped") await api.wake(job.instanceId).catch(() => null);
          if (Date.now() - since > RESTART_WAIT_MS) throw new Error("The computer didn't start again in time.");
          await wait(RESTART_POLL_MS);
          status = (await api.computer(job.instanceId).catch(() => null))?.status ?? status;
        }
        setStage(record, "start", "done");
        // This page has no connection to make: ADE on the computer is starting again.
        active = "connect";
        setStage(record, "connect", "done", "ADE on it is starting again");
      }
      job.phase = "online";
      job.endedAt = nowIso();
      publish(record);
    } catch (error) {
      if (error instanceof Stopped) return;
      const message = errorText(error);
      job.phase = "failed";
      job.error = message;
      const stage = stageOf(record, active);
      if (stage) Object.assign(stage, { status: "failed", error: message, endedAt: nowIso() });
      job.endedAt = nowIso();
      publish(record);
      if (!(error instanceof CloudApiError)) {
        forwardSignalToSentry("web.cloud_lane_resize_failed", { stage: active, message }, `cloud_lane_resize_failed:${active}`);
      }
    }
  };

  const begin = (
    input: Omit<CloudLaneJobSnapshot, "jobId" | "phase" | "stages" | "error" | "startedAt" | "updatedAt" | "endedAt">,
    tier: CloudTier,
    request: WebTierRequest | null,
  ): CloudLaneJobSnapshot => {
    const startedAt = nowIso();
    const job: CloudLaneJobSnapshot = {
      ...input,
      jobId: crypto.randomUUID(),
      phase: input.timing === "idle" ? "waiting" : "running",
      stages: cloudLaneJobStageIds("resize").map((id) => ({ id, status: "pending", detail: null, error: null, startedAt: null, endedAt: null })),
      error: null,
      startedAt,
      updatedAt: startedAt,
      endedAt: null,
    };
    // A new change replaces what an older one of this lane left on screen.
    for (const older of jobs.values()) {
      if (cloudLaneJobIsLive(older.job) || older.job.dismissedAt || older.job.instanceId !== job.instanceId) continue;
      older.job.dismissedAt = startedAt;
      publish(older);
    }
    const record: ResizeRecord = { job, tier, cancelled: false, request };
    jobs.set(job.jobId, record);
    publish(record);
    void run(record);
    return structuredClone(job);
  };

  const liveOn = (instanceId: string): boolean =>
    [...jobs.values()].some((record) => cloudLaneJobIsLive(record.job) && record.job.instanceId === instanceId);
  /** One change of a computer at a time: this tab's size change, or a move. */
  const changing = (instanceId: string): boolean => liveOn(instanceId) || deps.moving(instanceId);

  return {
    /** A size change of the same kind, from the computer and the size the person picked. */
    start(args: {
      computer: CloudInstance;
      tier: CloudTier;
      catalog: CloudCatalog;
      timing: "idle" | "now";
      diskGb?: unknown;
      request?: WebTierRequestInput;
    }): CloudLaneJobSnapshot {
      const { computer, tier } = args;
      const request = webTierRequestOf(args.request);
      if (changing(computer.id)) throw new Error(CLOUD_LANE_CHANGE_RUNNING_MESSAGE);
      const from = cloudTierOfShape({ type: computer.type, cpu: computer.resources?.cpu, memoryGb: computer.resources?.memory }, cloudTiers(args.catalog));
      const diskGb = diskGrowOf(args.diskGb, computer.resources?.disk ?? null, tier);
      if (from?.id === tier.id && diskGb == null) throw new Error(`It's already ${tier.label}.`);
      const lane = cloudMachineLaneFactsOf(computer.metadata);
      return begin({
        kind: "resize",
        timing: args.timing,
        instanceId: computer.id,
        fromInstanceId: computer.id,
        machineKey: computer.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null,
        laneId: lane?.laneId ?? null,
        laneName: lane?.laneName ?? computer.metadata[CLOUD_LANE_NAME_METADATA] ?? computer.name ?? computer.id,
        projectOrigin: lane?.projectOrigin ?? null,
        fromSizeId: from?.id ?? null,
        toSizeId: tier.id,
        ...cloudTierRequestIdsOf(args.request),
        diskGb,
      }, tier, request);
    },
    isLive: liveOn,
    has(jobId: string): boolean {
      return jobs.has(jobId);
    },
    list(): CloudLaneJobSnapshot[] {
      return [...jobs.values()].filter((record) => !record.job.dismissedAt).map((record) => structuredClone(record.job));
    },
    /** Only while it waits for the agent or saves: once the size changes, it runs to the end. */
    cancel(jobId: string): CloudLaneJobSnapshot | null {
      const record = jobs.get(jobId);
      if (!record) return null;
      const resizing = stageOf(record, "resize")?.status !== "pending";
      if (!cloudLaneJobIsLive(record.job) || resizing) return structuredClone(record.job);
      record.cancelled = true;
      record.job.phase = "cancelled";
      record.job.endedAt = nowIso();
      const save = stageOf(record, "save");
      if (save && save.status === "running") Object.assign(save, { status: "skipped", endedAt: nowIso() });
      publish(record);
      return structuredClone(record.job);
    },
    /** A change that ended without changing: the same change again, as a new job. */
    retry(jobId: string): CloudLaneJobSnapshot | null {
      const record = jobs.get(jobId);
      if (!record) return null;
      if (cloudLaneJobIsLive(record.job) || record.job.phase === "online") return structuredClone(record.job);
      const { job } = record;
      // A Retry from a card that still shows an older failure: one change of a computer at a time.
      if (changing(job.instanceId)) throw new Error(CLOUD_LANE_CHANGE_RUNNING_MESSAGE);
      record.job.dismissedAt = nowIso();
      publish(record);
      return begin({
        kind: "resize",
        timing: job.timing,
        instanceId: job.instanceId,
        fromInstanceId: job.fromInstanceId,
        machineKey: job.machineKey,
        laneId: job.laneId,
        laneName: job.laneName,
        projectOrigin: job.projectOrigin,
        fromSizeId: job.fromSizeId,
        toSizeId: job.toSizeId,
        requestedByChat: job.requestedByChat,
        requestId: job.requestId ?? null,
        diskGb: job.diskGb ?? null,
      }, record.tier, record.request);
    },
    dismiss(jobId: string): CloudLaneJobSnapshot | null {
      const record = jobs.get(jobId);
      if (!record) return null;
      record.job.dismissedAt = nowIso();
      publish(record);
      return structuredClone(record.job);
    },
    onLaneJob(cb: (job: CloudLaneJobSnapshot) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
