import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cloudCatalogOf, cloudShapeFor, type CloudShapeId } from "../../../shared/adeCloud";
import { cloudMachineLaneFactsOf, CLOUD_LANE_NAME_METADATA } from "../../../shared/cloudLaneLaunch";
import {
  CLOUD_LANE_CHANGE_RUNNING_MESSAGE,
  CLOUD_LANE_SAVE_WARNING_DETAIL,
  cloudLaneJobIsLive,
  cloudLaneJobStageIds,
  type CloudLaneChangeTierArgs,
  type CloudLaneJobKind,
  type CloudLaneJobSnapshot,
  type CloudLaneJobStage,
  type CloudLaneJobStageId,
  cloudLaneJobGrowsDiskOnly,
} from "../../../shared/cloudLaneLife";
import {
  cloudTierRequestChatMachineKey,
  cloudTierRequestEndArgs,
  cloudTierRequestIdsOf,
  cloudTierRequestOutcomeOfJob,
  cloudTierRequestProjectRef,
  createTierRequestTelling,
  type CloudTierRequestOutcome,
} from "../../../shared/cloudTierRequest";
import { cloudTier, cloudTierOfShape, cloudTiers, isCloudTierId, type CloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { pickMachineProject } from "../../../shared/projectIdentity";
import type { ChatLaunchStageStatus, OpenProjectBinding, RemoteRuntimeActionRequest, RemoteRuntimeProjectRecord } from "../../../shared/types";
import { sanitizeRendererProjectBinding } from "../../../shared/projectBinding";
import { getErrorMessage } from "../shared/utils";
import { moveCloudMachine, type CloudCopyDeps } from "./cloudMachineCopy";
import { CloudCreateCancelled } from "./cloudMachineCreator";
import { prepareStopCommand, shellJobId } from "../../../../../account-directory/src/cloud/computerCommands";
import type { CloudLaneBackup } from "../../../../../account-directory/src/cloud/contract";
import { CLOUD_MACHINE_KEY_METADATA, type createCloudMachines } from "./cloudMachines";
import type { CloudInstance, CloudLogger, CloudProvider } from "./cloudProvider";
import { createCloudLaneAccount } from "./cloudLaneAccount";

/**
 * The life of an ADE Cloud lane's computer after its launch, in this app's
 * main process: so a tier change goes on with every window closed, and a
 * quit picks it up again at the next start.
 *
 * - Delete lane: the computer goes, and the lane with it (the lane lived on
 *   it). Never refused; the work check before says whether work was only
 *   there, so the person was warned ("Push all work to GitHub").
 * - Keep the lane on a fresh computer: refused while the agent works; the
 *   work (archived lanes too) is pushed and checked again (anything left keeps
 *   the computer), then the computer goes and the server keeps the lane as a
 *   lane without a computer. The next send starts a launch with the same lane
 *   id on its branch.
 * - A tier change: in place (`resize`) or to the other kind (`move`), with
 *   its own steps; the lane is Online only once ADE on the computer answers.
 *
 * Every call is account-level: it names a computer of the account by its
 * ADE Cloud id, never a project pin, and the main process acts on it.
 */

type MachinesApi = Pick<ReturnType<typeof createCloudMachines>, "run" | "runPushWork" | "account">;

/** Calls to a chat's machine by the chat's pin. */
export type CloudLaneChatCalls = {
  /** One runtime action through the pin: this computer's project for a local pin. */
  callAction: (pin: OpenProjectBinding, request: RemoteRuntimeActionRequest) => Promise<unknown>;
  /** The account machine a saved connection reaches (or reached, or now reaches after a move), or null. */
  machineKeyOf: (targetId: string) => string | null;
  /** The pin of a project on a connected machine, by its id or folder there. */
  resolveBinding: (targetId: string, projectId: string, rootPath: string) => Promise<OpenProjectBinding>;
};

export type CloudLaneLifeDeps = {
  recordsDir: string;
  machines: MachinesApi;
  client: () => Promise<CloudProvider>;
  /** A move's making, copying and renaming (the same deps the machine card's Move uses). */
  copyDeps: CloudCopyDeps;
  forgetMachineConnections: (machine: { machineKey: string | null; instanceId: string }) => void;
  /** Pairs with the machine when needed and connects; resolves once ADE there answers, with this app's target id. */
  connectMachine: (machineKey: string) => Promise<{ targetId: string }>;
  listProjects: (targetId: string) => Promise<RemoteRuntimeProjectRecord[]>;
  emit: (job: CloudLaneJobSnapshot) => void;
  /** The account's computers changed: every window reads them again. */
  changed: () => void;
  /** The account's lane backups of one computer: an asleep computer's work check reads them with no wake. */
  laneBackups?: ((machineKey: string) => Promise<CloudLaneBackup[]>) | null;
  /**
   * How the chat whose size request started a job is told how it ended
   * (`cloud.tier_request_answer` on that chat's own machine). Unset: nobody
   * is told.
   */
  chatCalls?: CloudLaneChatCalls | null;
  logger: CloudLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** How often "when the agent is idle" looks again, and how long it waits at most. */
const IDLE_POLL_MS = 30_000;
const IDLE_WAIT_MAX_MS = 24 * 60 * 60_000;
/** A restart after a resize: a full computer took about two minutes. */
const RESTART_WAIT_MS = 15 * 60_000;
const RESTART_POLL_MS = 5_000;
/** ADE on a computer that just started answers in well under this. */
const CONNECT_WAIT_MS = 10 * 60_000;
const CONNECT_RETRY_MS = 5_000;
/** A finished job's card stays this long, then its record goes. */
const FINISHED_JOB_KEEP_MS = 24 * 60 * 60_000;
/** How long a save covers a disk grow's restart: past it (a Retry), the chats are saved again first. */
const SAVE_FRESH_MS = 2 * 60_000;
/** How long a cancel of a move waits for ADE's answer (the server ends a step first) before it answers with the job as it is. */
const MOVE_CANCEL_WAIT_MS = 30_000;
/** A chat that couldn't be told how its change ended (its machine asleep, starting or gone) is tried again after these waits. */
const TELL_CHAT_RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
/** A disk-only job that stopped after its save: its own note goes (a newer grow's note stays). */
const clearGrowNoteCommand = (jobId: string): string =>
  `f="$ADE_HOME/cloud/disk-grow.json"; grep -q '"jobId":"${shellJobId(jobId)}"' "$f" 2>/dev/null && rm -f "$f"; true`;

class JobStopped extends Error {}

type JobRecord = {
  v: 1;
  job: CloudLaneJobSnapshot;
  shape: CloudShapeId;
  targetType: "default" | "vm";
  /** A move's old computer's account key, kept after `job.machineKey` names the new one. */
  fromMachineKey?: string | null;
  /** The move runs on ADE's server: a quit mid-move follows it again on the next start, since it went on without this app. */
  serverMove?: boolean;
  /**
   * The agent's size request the person confirmed: its chat is told how the
   * job ended, on the chat's own machine (`pin`). `told` is the outcome it
   * was told, so a restart doesn't tell it again; a Retry clears it.
   */
  request?: { requestId: string; chatSessionId: string; pin: OpenProjectBinding; told?: CloudTierRequestOutcome | null };
};

/** A finished job's card is closed: it leaves every view, and its record stays until it expires. */
const isDismissed = (job: CloudLaneJobSnapshot) => typeof job.dismissedAt === "string" && job.dismissedAt.length > 0;

function nowIsoFrom(now: () => number): string {
  return new Date(now()).toISOString();
}

/** The lane size a computer runs at, or null at a size the lane sizes don't cover. */
function tierOfInstance(instance: CloudInstance, tiers: readonly CloudTier[]): CloudTier | null {
  return cloudTierOfShape({ type: instance.type, cpu: instance.resources?.cpu, memoryGb: instance.resources?.memory }, tiers);
}

/**
 * The disk a resize grows to, or null to keep it. Only a resize grows the disk
 * (a move makes a new computer); never smaller than now, never past what the
 * size lets the disk grow to. The server checks the plan's disk again.
 */
function diskGrowOf(raw: unknown, input: { kind: CloudLaneJobKind; currentGb: number | null; tier: CloudTier }): number | null {
  if (raw == null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) throw new Error("Pick a disk size in whole GB.");
  if (input.kind !== "resize") throw new Error("A move makes a new computer. Grow its disk after the move.");
  if (input.currentGb == null) throw new Error("ADE Cloud didn't say how big this computer's disk is, so ADE can't grow it.");
  if (raw <= input.currentGb) return null;
  if (input.tier.diskMaxGb != null && raw > input.tier.diskMaxGb) {
    throw new Error(`${input.tier.label} lets the disk grow to ${input.tier.diskMaxGb} GB.`);
  }
  return raw;
}

export function createCloudLaneLife(deps: CloudLaneLifeDeps) {
  const { logger } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowIso = () => nowIsoFrom(now);
  const jobs = new Map<string, JobRecord>();
  const running = new Map<string, AbortController>();
  /** A running move's own stop, by job: a cancel before its copy asks ADE's server to take the new computer away. */
  const moveCancels = new Map<string, AbortController>();
  /** A cancel of a move waiting for its answer: true, cancelled; false, too late (the copy started). */
  const cancelSettles = new Map<string, (cancelled: boolean) => void>();
  const settleCancel = (jobId: string, cancelled: boolean): void => {
    const settle = cancelSettles.get(jobId);
    if (!settle) return;
    cancelSettles.delete(jobId);
    settle(cancelled);
  };
  /** Computers a tier change is being set up for, before its job exists: a second confirm is refused. */
  const reserving = new Set<string>();
  let disposed = false;

  // ---------------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------------

  const recordPath = (jobId: string) => path.join(deps.recordsDir, `${jobId}.json`);

  const persist = (record: JobRecord): void => {
    const target = recordPath(record.job.jobId);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(deps.recordsDir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, target);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      logger.warn?.("cloud.lane_job_persist_failed", { jobId: record.job.jobId, error: getErrorMessage(error) });
    }
  };

  const publish = (record: JobRecord): void => {
    record.job.updatedAt = nowIso();
    persist(record);
    deps.emit(structuredClone(record.job));
    tellRequestingChat(record);
  };

  /** Jobs whose chat is being told now, one telling at a time per job (`createTierRequestTelling`). */
  const telling = createTierRequestTelling<CloudTierRequestOutcome>({
    retryMs: TELL_CHAT_RETRY_MS,
    onFailed: (error, { key, end, attempt, final }) => {
      logger.warn?.("cloud.lane_job_chat_tell_failed", { jobId: key, outcome: end, attempt, final, error: getErrorMessage(error) });
    },
  });

  /**
   * The chat's pin to tell it through now. A pin that names no machine, or a
   * chat that moved with the lane, is reached by its machine key
   * (`cloudTierRequestChatMachineKey`): that machine is connected (paired and
   * woken when needed) and the chat's project found there. The ADE Cloud
   * tab's pin names the account's project, so it is found by that id or the
   * repository's origin (`cloudTierRequestProjectRef`).
   */
  const chatPinNow = async (record: JobRecord, pin: OpenProjectBinding, calls: CloudLaneChatCalls): Promise<OpenProjectBinding> => {
    const { job } = record;
    if (pin.kind !== "remote") return pin;
    const machineKey = cloudTierRequestChatMachineKey({ pin, pinMachineKey: calls.machineKeyOf(pin.targetId), job, fromMachineKey: record.fromMachineKey ?? null });
    if (!machineKey) return pin;
    const { targetId } = await deps.connectMachine(machineKey);
    try {
      return await calls.resolveBinding(targetId, pin.projectId, pin.rootPath);
    } catch (error) {
      const project = pickMachineProject(await deps.listProjects(targetId), cloudTierRequestProjectRef(pin, job));
      if (!project) throw error;
      return await calls.resolveBinding(targetId, project.projectId, project.rootPath);
    }
  };

  /**
   * The job ended: the chat whose size request started it is told how, on
   * that chat's own machine, whatever window shows it (none may). A machine
   * that can't take it now (asleep, restarting, a move's new computer still
   * pairing) is tried again a few times; a quit tries again at the next start.
   * Each try reads the job again: a Retry that runs is told when it ends, and
   * an end that comes while a try waits wakes it, so that end is told at
   * once. The chat's machine tells the agent once, by the card
   * (`tier_request_answer`).
   */
  const tellRequestingChat = (record: JobRecord): void => {
    const { job, request } = record;
    const calls = deps.chatCalls;
    if (!request || !calls) return;
    telling.note(job.jobId, {
      read: () => (disposed ? null : cloudTierRequestOutcomeOfJob(job)),
      tell: async (outcome) => {
        // `read` just gave this end, so the job has ended; if not, the try fails and nothing is marked told.
        const args = cloudTierRequestEndArgs(job, request);
        if (!args) throw new Error("This change hasn't ended, so there is nothing to tell the chat yet.");
        await calls.callAction(await chatPinNow(record, request.pin, calls), { domain: "cloud", action: "tier_request_answer", args });
        logger.info?.("cloud.lane_job_chat_told", { jobId: job.jobId, outcome });
      },
      isTold: (outcome) => request.told === outcome,
      markTold: (outcome) => {
        request.told = outcome;
        persist(record);
      },
    });
  };

  const stageOf = (record: JobRecord, id: CloudLaneJobStageId): CloudLaneJobStage | null =>
    record.job.stages.find((stage) => stage.id === id) ?? null;

  const setStage = (record: JobRecord, id: CloudLaneJobStageId, status: ChatLaunchStageStatus, patch: { detail?: string | null; error?: string | null } = {}): void => {
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
    if (patch.detail !== undefined) stage.detail = patch.detail;
    if (patch.error !== undefined) stage.error = patch.error;
    publish(record);
  };

  const finished = (stage: CloudLaneJobStage | null) => stage?.status === "done" || stage?.status === "skipped" || stage?.status === "warning";

  // ---------------------------------------------------------------------------
  // Reads, delete lane, and keep the lane on a fresh computer (shared with
  // a brain's `cloud` actions, `cloudLaneAccount.ts`)
  // ---------------------------------------------------------------------------

  const account = createCloudLaneAccount({
    machines: deps.machines,
    client: deps.client,
    laneBackups: deps.laneBackups ?? null,
    forgetMachineConnections: deps.forgetMachineConnections,
    changed: deps.changed,
    // A tier change mid-way would make a computer the delete or free doesn't know.
    busy: (instanceId) => Array.from(jobs.values()).some((record) => cloudLaneJobIsLive(record.job) && record.job.instanceId === instanceId),
    disposed: () => disposed,
    logger,
    now,
    sleep,
  });
  const { readInstance, workState, agentWork, forgetConnections, deleteLane, freeLane, lanesWithoutComputer, forgetLaneWithoutComputer } = account;

  // ---------------------------------------------------------------------------
  // Tier change
  // ---------------------------------------------------------------------------

  const assertActive = (record: JobRecord, signal: AbortSignal): void => {
    if (signal.aborted || disposed || record.job.phase === "cancelled") throw new JobStopped();
  };

  /** True when nothing the agent does keeps the computer busy (asleep counts as idle; unknown is busy). */
  const agentIdle = async (instanceId: string): Promise<boolean> => (await agentWork(instanceId)) === "idle";

  /** Save work, its first half: the step runs from here, and waits for the agent when the timing says so. */
  const waitForAgent = async (record: JobRecord, signal: AbortSignal): Promise<void> => {
    const job = record.job;
    const saveDetail = cloudLaneJobGrowsDiskOnly(job) ? "Saving the chats" : job.timing === "now" ? "Stopping the running turn" : "Waiting for the agent to finish";
    setStage(record, "save", "running", { detail: saveDetail });
    if (job.timing === "idle") {
      job.phase = "waiting";
      publish(record);
      const since = now();
      while (!(await agentIdle(job.instanceId))) {
        assertActive(record, signal);
        if (now() - since > IDLE_WAIT_MAX_MS) throw new Error("The agent didn't finish within a day. Change the size now, or try again later.");
        await sleep(IDLE_POLL_MS);
        assertActive(record, signal);
      }
    }
    job.phase = "running";
    assertActive(record, signal);
  };

  /**
   * Save work, its second half: stops what still runs and writes the saved
   * chat copy, so the chats read the same while the computer restarts or
   * moves. The step ends here.
   */
  const saveChats = async (record: JobRecord): Promise<void> => {
    const job = record.job;
    const client = await deps.client();
    const instance = await client.getInstance(job.instanceId);
    if (instance.status === "running") {
      const ran = await client.exec(job.instanceId, prepareStopCommand(cloudLaneJobGrowsDiskOnly(job) ? { gb: job.diskGb, jobId: job.jobId } : null), { timeoutMs: 90_000 }).catch((error: unknown) => {
        logger.warn?.("cloud.lane_job_prepare_stop_failed", { jobId: job.jobId, error: getErrorMessage(error) });
        return null;
      });
      setStage(record, "save", ran?.exitCode === 0 ? "done" : "warning", { detail: ran?.exitCode === 0 ? null : CLOUD_LANE_SAVE_WARNING_DETAIL });
      return;
    }
    setStage(record, "save", "done", { detail: "Asleep, nothing running" });
  };

  /** Save work: waits for the agent (or stops its turn), then writes the saved chat copy. */
  const runSave = async (record: JobRecord, signal: AbortSignal): Promise<void> => {
    await waitForAgent(record, signal);
    await saveChats(record);
    // A cancel during the save's exec stops the job here, before the size changes.
    assertActive(record, signal);
  };

  const waitForRunning = async (record: JobRecord, signal: AbortSignal, instanceId: string): Promise<void> => {
    const client = await deps.client();
    const since = now();
    for (;;) {
      assertActive(record, signal);
      const instance = await client.getInstance(instanceId).catch((error: unknown) => {
        // Read again on the next round, until the wait runs out.
        logger.warn?.("cloud.lane_job_read_failed", { jobId: record.job.jobId, instanceId, error: getErrorMessage(error) });
        return null;
      });
      if (instance?.status === "running") return;
      if (instance?.status === "failed") throw new Error("ADE Cloud couldn't start the computer again.");
      // A resize leaves it asleep on some sizes: wake it, as a send would.
      if (instance && (instance.status === "sleeping" || instance.status === "stopped")) {
        await client.startInstance(instanceId).catch((error: unknown) => {
          logger.warn?.("cloud.lane_job_wake_failed", { jobId: record.job.jobId, instanceId, error: getErrorMessage(error) });
        });
      }
      if (now() - since > RESTART_WAIT_MS) throw new Error("The computer didn't start again in time.");
      await sleep(RESTART_POLL_MS);
    }
  };

  /** Start ADE, then Connect: Online only once ADE on the computer answers and has the lane's project. */
  const runConnect = async (record: JobRecord, signal: AbortSignal): Promise<void> => {
    const job = record.job;
    if (!finished(stageOf(record, "start"))) {
      setStage(record, "start", "running");
      await waitForRunning(record, signal, job.instanceId);
      setStage(record, "start", "done");
    }
    setStage(record, "connect", "running");
    const machineKey = job.machineKey;
    if (!machineKey) throw new Error("ADE couldn't tell which machine the computer is in your account.");
    const since = now();
    let targetId: string | null = null;
    let lastError: unknown = null;
    while (!targetId) {
      assertActive(record, signal);
      try {
        targetId = (await deps.connectMachine(machineKey)).targetId;
      } catch (error) {
        lastError = error;
        if (now() - since > CONNECT_WAIT_MS) throw new Error(`ADE couldn't connect to the computer: ${getErrorMessage(lastError).replace(/\.$/, "")}.`);
        await sleep(CONNECT_RETRY_MS);
      }
    }
    if (job.projectOrigin) {
      const projects = await deps.listProjects(targetId).catch((error: unknown) => {
        logger.warn?.("cloud.lane_job_projects_read_failed", { jobId: job.jobId, error: getErrorMessage(error) });
        return [];
      });
      const has = projects.some((project) => project.exists !== false && normalizeGitRemoteIdentity(project.gitOriginUrl) === job.projectOrigin);
      if (!has) throw new Error("ADE on the computer answers, but the lane's project isn't there.");
    }
    setStage(record, "connect", "done");
  };

  const runResize = async (record: JobRecord, signal: AbortSignal): Promise<void> => {
    if (finished(stageOf(record, "resize"))) return;
    const diskGb = record.job.diskGb ?? null;
    if (diskGb) {
      // `computerIdle` tells the server the work is saved: only right after this job's save.
      // A Retry saves again first, so nothing started since is cut. A save that only warned
      // (a stuck brain) goes on, as a size change always did: the person chose to restart now.
      const save = stageOf(record, "save");
      const fresh = (save?.status === "done" || save?.status === "warning")
        && save.endedAt != null && now() - Date.parse(save.endedAt) < SAVE_FRESH_MS;
      if (!fresh) await runSave(record, signal);
    }
    setStage(record, "resize", "running", { detail: diskGb ? `With a ${diskGb} GB disk` : null });
    assertActive(record, signal);
    const result = await deps.machines.run({
      action: "resize",
      instanceId: record.job.instanceId,
      shape: record.shape,
      ...(diskGb ? { disk: diskGb, computerIdle: true } : {}),
    });
    if (!result.ok) throw new Error(result.message);
    setStage(record, "resize", "done");
    deps.changed();
  };

  /** The lane's name on the new computer: one lane, one name. */
  const nameMovedComputer = async (record: JobRecord, name: string | null): Promise<void> => {
    const job = record.job;
    if (!job.laneName || name === job.laneName) return;
    const client = await deps.client();
    await client.setInstanceName(job.instanceId, job.laneName).catch((error: unknown) => {
      logger.warn?.("cloud.lane_job_rename_failed", { jobId: job.jobId, instanceId: job.instanceId, error: getErrorMessage(error) });
    });
    if (job.machineKey) {
      await deps.copyDeps.renameMachine(job.machineKey, job.laneName).catch((error: unknown) => {
        logger.warn?.("cloud.lane_job_machine_rename_failed", { jobId: job.jobId, error: getErrorMessage(error) });
      });
    }
  };

  /**
   * After a quit between the copy and the old computer's delete: the job
   * already names the new computer. The old one goes now (or is left with a
   * warning), and the new one takes the lane's name.
   */
  const finishMoveAfterCopy = async (record: JobRecord): Promise<void> => {
    const job = record.job;
    if (!finished(stageOf(record, "remove")) && job.fromInstanceId !== job.instanceId) {
      setStage(record, "remove", "running");
      const old = await readInstance(job.fromInstanceId);
      const result = old && old.status !== "deleted"
        ? await deps.machines.run({ action: "delete", instanceId: job.fromInstanceId, machineKey: record.fromMachineKey ?? null })
        : { ok: true, message: "" };
      if (result.ok) forgetConnections(record.fromMachineKey ?? null, job.fromInstanceId);
      setStage(record, "remove", result.ok ? "done" : "warning", {
        detail: result.ok ? null : "The old computer is still there, asleep. Delete it from Settings › ADE Cloud",
      });
    }
    await nameMovedComputer(record, null);
    deps.changed();
  };

  const runMove = async (record: JobRecord, signal: AbortSignal): Promise<void> => {
    if (finished(stageOf(record, "copy"))) {
      await finishMoveAfterCopy(record);
      return;
    }
    const job = record.job;
    assertActive(record, signal);
    // The chats' save runs while the new computer is made (it took as long,
    // one after the other): on ADE's server, or here for a move run from here.
    // The copy starts only after both.
    const saveBeside = !finished(stageOf(record, "save"));
    if (saveBeside) setStage(record, "save", "running", { detail: job.timing === "now" ? "Stopping the running turn" : "Saving the chats" });
    const settleSave = (status: "done" | "warning") => {
      if (stageOf(record, "save")?.status === "running") setStage(record, "save", status, { detail: status === "done" ? null : CLOUD_LANE_SAVE_WARNING_DETAIL });
    };
    /** ADE's server reports its save (`saveState`); an older one doesn't. */
    let serverSaid = false;
    setStage(record, "computer", "running");
    const controller = new AbortController();
    moveCancels.set(job.jobId, controller);
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let result: Awaited<ReturnType<typeof moveCloudMachine>>;
    try {
      result = await moveCloudMachine(deps.copyDeps, {
        instanceId: job.fromInstanceId,
        machineKey: job.machineKey,
        to: record.targetType === "vm" ? "vm" : "box",
        shape: record.shape,
        requestId: job.jobId,
        madeByChat: job.requestedByChat,
      }, (progress) => {
        // The new computer joined: its lines name it from here on.
        if (progress.stage === "joining" && progress.instanceId) {
          if (stageOf(record, "computer")?.status === "running") setStage(record, "computer", "done");
          // The copy starts after the save: until then (the old computer still saves), nothing more.
          if (!/^Copying/.test(progress.message)) return;
          // An older server doesn't say when its save ended: before the copy.
          if (!serverSaid) settleSave("done");
          // A cancel asked for now is too late: the move goes on.
          settleCancel(job.jobId, false);
          if (stageOf(record, "copy")?.status === "pending") setStage(record, "copy", "running", { detail: progress.message });
          return;
        }
        const active = stageOf(record, "copy")?.status === "running" ? "copy" : "computer";
        const stage = stageOf(record, active);
        if (stage && stage.detail !== progress.message) setStage(record, active, "running", { detail: progress.message });
      }, {
        signal: controller.signal,
        // A save done before (a Retry after it) isn't run again.
        ...(saveBeside
          ? {
            onSave: (state: "running" | "done" | "warning") => {
              serverSaid = true;
              if (state !== "running") settleSave(state);
            },
            saveHere: () => saveChats(record),
          }
          : { save: false }),
        onServer: () => {
          record.serverMove = true;
          persist(record);
        },
        // Saved before the old computer is deleted: a quit from here on goes
        // on from the new computer, and Retry never starts from a deleted one.
        onCopied: (target) => {
          if (stageOf(record, "computer")?.status === "running") setStage(record, "computer", "done");
          job.instanceId = target.instanceId;
          job.machineKey = target.machineKey ?? null;
          // ADE on the new computer registered the lane's project during the copy.
          const start = stageOf(record, "start");
          if (start) Object.assign(start, { status: "done", endedAt: nowIso() });
          // One write: the copy done together with the new computer's identity.
          setStage(record, "copy", "done", { detail: null });
        },
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
      moveCancels.delete(job.jobId);
    }
    settleSave("done");
    settleCancel(job.jobId, false);
    if (stageOf(record, "computer")?.status === "running") setStage(record, "computer", "done");
    if (stageOf(record, "copy")?.status !== "done") setStage(record, "copy", "done", { detail: null });
    job.instanceId = result.instanceId;
    job.machineKey = result.machineKey ?? null;
    if (stageOf(record, "start")?.status !== "done") setStage(record, "start", "done");
    setStage(record, "remove", result.sourceDeleted ? "done" : "warning", {
      detail: result.sourceDeleted ? null : "The old computer is still there, asleep. Delete it from Settings › ADE Cloud",
    });
    await nameMovedComputer(record, result.name);
    deps.changed();
  };

  /**
   * A disk-only job that stopped after its save (a failed resize, a cancel)
   * leaves the computer's grow note, which would read the next restart as a
   * disk grow. The save's exec has ended by then (it's awaited), so the note
   * is there to remove.
   */
  const clearGrowNote = async (record: JobRecord): Promise<void> => {
    const job = record.job;
    if (!cloudLaneJobGrowsDiskOnly(job) || finished(stageOf(record, "resize")) || stageOf(record, "save")?.status === "pending") return;
    await deps.client().then((client) => client.exec(job.instanceId, clearGrowNoteCommand(job.jobId), { timeoutMs: 20_000 })).catch((error: unknown) => {
      logger.warn?.("cloud.lane_job_grow_note_left", { jobId: job.jobId, error: getErrorMessage(error) });
    });
    // The save wrote the note; without it that save no longer counts. A Retry
    // saves again (writing the note again), or its restart isn't a disk grow
    // and the chats it stops stay stopped when "Continue chats" is off.
    setStage(record, "save", "pending");
  };

  /** A move's save that a failure or a quit cut: pending again, so a Retry saves. */
  const resetRunningSave = (record: JobRecord): void => {
    const save = stageOf(record, "save");
    if (save?.status === "running") Object.assign(save, { status: "pending", detail: null, startedAt: null, endedAt: null });
  };

  const runJob = async (record: JobRecord): Promise<void> => {
    const job = record.job;
    if (running.has(job.jobId)) return;
    const controller = new AbortController();
    running.set(job.jobId, controller);
    const signal = controller.signal;
    let active: CloudLaneJobStageId = "save";
    try {
      job.error = null;
      if (!finished(stageOf(record, "save"))) {
        active = "save";
        // A move saves while it makes the new computer (`runMove`): only its
        // wait for the agent runs here, and not again for a move ADE's server
        // already took (followed again after a quit).
        if (job.kind === "move") {
          if (!record.serverMove) await waitForAgent(record, signal);
        } else {
          await runSave(record, signal);
        }
      }
      job.phase = "running";
      publish(record);
      if (job.kind === "resize") {
        active = "resize";
        await runResize(record, signal);
      } else {
        active = "computer";
        await runMove(record, signal);
      }
      active = finished(stageOf(record, "start")) ? "connect" : "start";
      await runConnect(record, signal);
      job.phase = "online";
      job.endedAt = nowIso();
      publish(record);
      logger.info?.("cloud.lane_job_online", { jobId: job.jobId, kind: job.kind, toSizeId: job.toSizeId });
    } catch (error) {
      await clearGrowNote(record);
      // A move cancelled before its copy (here with `cancelJob`, or from another
      // device on ADE's server): its new computer was taken away.
      if (error instanceof CloudCreateCancelled && job.kind === "move" && !disposed) {
        job.phase = "cancelled";
        job.endedAt = nowIso();
        for (const stage of job.stages) {
          if (stage.status === "running") Object.assign(stage, { status: "skipped", endedAt: job.endedAt });
        }
        publish(record);
        settleCancel(job.jobId, true);
        logger.info?.("cloud.lane_job_cancelled", { jobId: job.jobId, kind: job.kind });
        return;
      }
      if (error instanceof JobStopped || disposed) return;
      // A move's failing step: the copy, unless the new computer never came.
      if (job.kind === "move" && active === "computer" && stageOf(record, "copy")?.status === "running") active = "copy";
      // A save cut by the move's failure runs again on Retry.
      if (job.kind === "move" && active !== "save") resetRunningSave(record);
      const message = getErrorMessage(error);
      job.phase = "failed";
      job.error = message;
      const stage = stageOf(record, active);
      if (stage) {
        stage.status = "failed";
        stage.error = message;
        stage.endedAt = nowIso();
      }
      publish(record);
      logger.warn?.("cloud.lane_job_failed", { jobId: job.jobId, kind: job.kind, stage: active, error: message });
    } finally {
      running.delete(job.jobId);
      // A cancel still waiting when the run ended any other way: answered, so a later one asks again.
      settleCancel(job.jobId, job.phase === "cancelled");
    }
  };

  /**
   * One change of a computer at a time: a live job on it (the computer it is
   * on now, or the one a move started from), or one being set up for it.
   */
  const changeRunsOn = (instanceId: string): boolean =>
    reserving.has(instanceId) || Array.from(jobs.values()).some((record) => cloudLaneJobIsLive(record.job)
      && (record.job.instanceId === instanceId || record.job.fromInstanceId === instanceId));

  const changeTier = async (raw: CloudLaneChangeTierArgs): Promise<CloudLaneJobSnapshot> => {
    const instanceId = typeof raw?.instanceId === "string" ? raw.instanceId.trim() : "";
    if (!instanceId) throw new Error("Name the computer.");
    if (!isCloudTierId(raw?.sizeId)) throw new Error("Pick a size.");
    const timing = raw.timing === "now" ? "now" : "idle";
    // Reserved before the first await: two confirms at once never start two jobs.
    if (changeRunsOn(instanceId)) throw new Error(CLOUD_LANE_CHANGE_RUNNING_MESSAGE);
    reserving.add(instanceId);
    try {
      return await startTierChange(raw, instanceId, timing);
    } finally {
      reserving.delete(instanceId);
    }
  };

  const startTierChange = async (raw: CloudLaneChangeTierArgs, instanceId: string, timing: "now" | "idle"): Promise<CloudLaneJobSnapshot> => {
    const instance = await readInstance(instanceId);
    if (!instance) throw new Error("ADE Cloud has no such computer.");
    const catalog = cloudCatalogOf(await deps.machines.account().catch((error: unknown) => {
      logger.warn?.("cloud.lane_job_account_read_failed", { instanceId, error: getErrorMessage(error) });
      return null;
    }));
    const tier = cloudTier(catalog, raw.sizeId);
    if (!tier) throw new Error("ADE Cloud doesn't offer that size now.");
    const from = tierOfInstance(instance, cloudTiers(catalog));
    const shape = cloudShapeFor({ cpu: tier.cpu, memoryGb: tier.memoryGb });
    if (!shape) throw new Error("ADE can't make that size.");
    const kind: CloudLaneJobKind = (instance.type === "vm" ? "vm" : "default") === tier.type ? "resize" : "move";
    const diskGb = diskGrowOf(raw.diskGb, { kind, currentGb: instance.resources?.disk ?? null, tier });
    // The same size with a bigger disk is a disk grow (the Android pane's Grow the disk): the same steps.
    if (from?.id === tier.id && diskGb == null) throw new Error(`It's already ${tier.label}.`);
    const lane = cloudMachineLaneFactsOf(instance.metadata);
    const { requestId, requestedByChat } = cloudTierRequestIdsOf(raw);
    const startedAt = nowIso();
    const job: CloudLaneJobSnapshot = {
      jobId: randomUUID(),
      kind,
      timing,
      instanceId,
      fromInstanceId: instanceId,
      machineKey: instance.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null,
      laneId: lane?.laneId ?? null,
      laneName: lane?.laneName ?? instance.metadata[CLOUD_LANE_NAME_METADATA] ?? instance.name ?? instanceId,
      projectOrigin: lane?.projectOrigin ?? null,
      fromSizeId: from?.id ?? null,
      toSizeId: tier.id as CloudTierId,
      phase: timing === "idle" ? "waiting" : "running",
      stages: cloudLaneJobStageIds(kind).map((id) => ({ id, status: "pending", detail: null, error: null, startedAt: null, endedAt: null })),
      error: null,
      requestedByChat,
      requestId,
      diskGb,
      startedAt,
      updatedAt: startedAt,
      endedAt: null,
    };
    // No icon: a call through the pin needs none, and the record stays small.
    const chatPin = sanitizeRendererProjectBinding(raw.requestedByChatPin, () => null);
    const record: JobRecord = {
      v: 1,
      job,
      shape: shape.id,
      targetType: tier.type,
      fromMachineKey: job.machineKey,
      ...(requestId && requestedByChat && chatPin ? { request: { requestId, chatSessionId: requestedByChat, pin: chatPin } } : {}),
    };
    // A new change replaces what an older one of this lane left on screen (a
    // failure, a finish): one job per lane in view, and an old failure never
    // stands in front of the next change.
    for (const older of jobs.values()) {
      if (cloudLaneJobIsLive(older.job) || isDismissed(older.job)) continue;
      const sameLane = (job.laneId != null && older.job.laneId === job.laneId)
        || older.job.instanceId === instanceId || older.job.fromInstanceId === instanceId;
      if (!sameLane) continue;
      older.job.dismissedAt = startedAt;
      publish(older);
    }
    jobs.set(job.jobId, record);
    publish(record);
    logger.info?.("cloud.lane_job_started", { jobId: job.jobId, kind, timing, toSizeId: tier.id });
    void runJob(record);
    return structuredClone(job);
  };

  const retryJob = async (args: { jobId: string }): Promise<CloudLaneJobSnapshot | null> => {
    const record = jobs.get(args?.jobId);
    if (!record) return null;
    if (record.job.phase !== "failed") return structuredClone(record.job);
    // A card that still shows this older failure while a newer change runs: its Retry would start a second one.
    if (changeRunsOn(record.job.instanceId)) throw new Error(CLOUD_LANE_CHANGE_RUNNING_MESSAGE);
    for (const stage of record.job.stages) {
      if (stage.status === "failed") {
        stage.status = "pending";
        stage.error = null;
      }
    }
    // A failed move took its new computer away and left the old one as it
    // was: it runs again from the start of the move.
    if (record.job.kind === "move" && !finished(stageOf(record, "copy"))) {
      for (const id of ["computer", "copy"] as const) {
        const stage = stageOf(record, id);
        if (stage) Object.assign(stage, { status: "pending", detail: null, error: null, startedAt: null, endedAt: null });
      }
    }
    record.job.phase = "running";
    record.job.endedAt = null;
    record.job.dismissedAt = null;
    // Its next end is told again (the chat's card tells the agent a repeat of the same end once).
    if (record.request) record.request.told = null;
    publish(record);
    void runJob(record);
    return structuredClone(record.job);
  };

  /**
   * A move's cancel before its copy, while the new computer is made and the
   * work saves: ADE's server (or the making here) takes the new computer
   * away, and the answer says whether it did. The copy may start first; the
   * move then goes on.
   */
  const cancelMoveBeforeCopy = async (record: JobRecord): Promise<CloudLaneJobSnapshot> => {
    const { jobId } = record.job;
    if (!cancelSettles.has(jobId)) {
      const answered = new Promise<boolean>((resolve) => cancelSettles.set(jobId, resolve));
      moveCancels.get(jobId)?.abort();
      const cancelled = await Promise.race([answered, sleep(MOVE_CANCEL_WAIT_MS).then(() => null)]);
      if (cancelled === false) throw new Error("The copy already started, so the move can't be cancelled now. ADE finishes it.");
    }
    return structuredClone(record.job);
  };

  /** Stops a job before the size changed: while it waits or saves, and a move until its copy starts. After that it runs to the end. */
  const cancelJob = async (args: { jobId: string }): Promise<CloudLaneJobSnapshot | null> => {
    const record = jobs.get(args?.jobId);
    if (!record) return null;
    if (record.job.kind === "move" && record.job.phase === "running" && moveCancels.has(record.job.jobId) && stageOf(record, "copy")?.status === "pending") {
      return await cancelMoveBeforeCopy(record);
    }
    const changing = record.job.stages.some((stage) => stage.id !== "save" && stage.status !== "pending");
    if (changing && record.job.phase !== "failed") throw new Error("The size is already changing. ADE finishes it.");
    record.job.phase = "cancelled";
    record.job.endedAt = nowIso();
    running.get(record.job.jobId)?.abort();
    publish(record);
    return structuredClone(record.job);
  };

  /**
   * Closes a job's card everywhere: a failure the person read (the lane stays
   * as the failed step left it, and the next change starts fresh), or a finish
   * already seen. Refused while the job still runs: Cancel stops it.
   */
  const dismissJob = async (args: { jobId: string }): Promise<CloudLaneJobSnapshot | null> => {
    const record = jobs.get(args?.jobId);
    if (!record) return null;
    if (cloudLaneJobIsLive(record.job)) throw new Error("This change is still running. Cancel it, or wait for it to finish.");
    if (!isDismissed(record.job)) {
      record.job.dismissedAt = nowIso();
      publish(record);
    }
    return structuredClone(record.job);
  };

  const listJobs = (): CloudLaneJobSnapshot[] => Array.from(jobs.values()).map((record) => structuredClone(record.job));

  /** Jobs from before a quit: live ones go on, finished ones stay a day. A move cut off mid-copy is failed for Retry. */
  const load = (): void => {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(deps.recordsDir);
    } catch (error) {
      // None yet is normal; anything else hides size changes still under way.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn?.("cloud.lane_jobs_dir_read_failed", { error: getErrorMessage(error) });
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(deps.recordsDir, entry);
      try {
        const record = JSON.parse(fs.readFileSync(file, "utf8")) as JobRecord;
        if (record?.v !== 1 || typeof record.job?.jobId !== "string") {
          fs.rmSync(file, { force: true });
          continue;
        }
        const ended = record.job.endedAt ? Date.parse(record.job.endedAt) : null;
        if (!cloudLaneJobIsLive(record.job) && ended != null && now() - ended > FINISHED_JOB_KEEP_MS) {
          fs.rmSync(file, { force: true });
          continue;
        }
        jobs.set(record.job.jobId, record);
        if (!cloudLaneJobIsLive(record.job)) {
          // An end the chat wasn't told of before the quit.
          tellRequestingChat(record);
          continue;
        }
        const cutMove = record.job.kind === "move" && !record.serverMove
          && (stageOf(record, "computer")?.status === "running" || stageOf(record, "copy")?.status === "running");
        if (cutMove) {
          // The old computer stays as it was (its pause clears itself); the
          // half-made new one is the pending-create sweep's to delete.
          record.job.phase = "failed";
          record.job.error = "ADE quit during the move. The old computer is as it was; Retry to move it again.";
          const stage = stageOf(record, stageOf(record, "copy")?.status === "running" ? "copy" : "computer");
          if (stage) Object.assign(stage, { status: "failed", error: record.job.error, endedAt: nowIso() });
          resetRunningSave(record);
          persist(record);
          tellRequestingChat(record);
          continue;
        }
        void runJob(record);
      } catch (error) {
        logger.warn?.("cloud.lane_job_load_failed", { file, error: getErrorMessage(error) });
      }
    }
  };

  const dispose = (): void => {
    disposed = true;
    for (const controller of running.values()) controller.abort();
    running.clear();
  };

  return { workState, deleteLane, freeLane, lanesWithoutComputer, forgetLaneWithoutComputer, changeTier, retryJob, cancelJob, dismissJob, listJobs, load, dispose };
}

export type CloudLaneLife = ReturnType<typeof createCloudLaneLife>;
