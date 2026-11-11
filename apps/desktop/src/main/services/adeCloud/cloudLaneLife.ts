import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cloudCatalogOf, cloudShapeFor, type CloudShapeId } from "../../../shared/adeCloud";
import { cloudMachineLaneFactsOf, CLOUD_LANE_BRANCH_METADATA, CLOUD_LANE_NAME_METADATA } from "../../../shared/cloudLaneLaunch";
import {
  cloudLaneJobStageIds,
  type CloudLaneChangeTierArgs,
  type CloudLaneDeleteResult,
  type CloudLaneFreeResult,
  type CloudLaneJobKind,
  type CloudLaneJobSnapshot,
  type CloudLaneJobStage,
  type CloudLaneJobStageId,
  type CloudLaneWithoutComputer,
  type CloudLaneWorkLane,
  type CloudLaneWorkState,
} from "../../../shared/cloudLaneLife";
import { cloudTier, cloudTiers, isCloudTierId, type CloudTier, type CloudTierId } from "../../../shared/cloudTiers";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type { ChatLaunchStageStatus, RemoteRuntimeProjectRecord } from "../../../shared/types";
import { getErrorMessage } from "../shared/utils";
import { moveCloudMachine, type CloudCopyDeps } from "./cloudMachineCopy";
import { CLOUD_MACHINE_KEY_METADATA, type createCloudMachines } from "./cloudMachines";
import { CloudProviderError, type CloudInstance, type CloudLogger, type CloudProvider } from "./cloudProvider";

/**
 * The life of an ADE Cloud lane's computer after its launch, in this app's
 * main process: so a tier change goes on with every window closed, and a
 * quit picks it up again at the next start.
 *
 * - Delete lane: the computer goes, and the lane with it (the lane lived on
 *   it). Never refused; the work check before says whether work was only
 *   there, so the person was warned ("Push all work to GitHub").
 * - Keep the lane on a fresh computer: the work is pushed first (a failed
 *   push keeps the computer), then the computer goes and the server keeps the
 *   lane as a lane without a computer. The next send starts a launch with the
 *   same lane id on its branch.
 * - A tier change: in place (`resize`) or to the other kind (`move`), with
 *   its own steps; the lane is Online only once ADE on the computer answers.
 *
 * Every call is account-level: it names a computer of the account by its
 * ADE Cloud id, never a project pin, and the main process acts on it.
 */

type MachinesApi = Pick<ReturnType<typeof createCloudMachines>, "run" | "runPushWork" | "account">;

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
/** Busy reasons that are not the agent's work: a person watching a tool, a timer due soon. */
const NOT_AGENT_WORK = new Set(["in_use", "schedule"]);

/** Interrupts running turns and agent CLIs and writes the saved chat copy (`ade cloud prepare-stop`). */
const PREPARE_STOP_COMMAND = [
  'export PATH="$ADE_HOME/bin:$PATH"',
  "ade cloud prepare-stop --timeout 40",
].join("\n");
const KEEP_AWAKE_STATE_COMMAND = 'cat "$ADE_HOME/cloud/keep-awake.json" 2>/dev/null';

class JobStopped extends Error {}

type JobRecord = { v: 1; job: CloudLaneJobSnapshot; shape: CloudShapeId; targetType: "default" | "vm" };

function nowIsoFrom(now: () => number): string {
  return new Date(now()).toISOString();
}

/** The lane size a computer runs at, or null at a size the lane sizes don't cover. */
function tierOfInstance(instance: CloudInstance, tiers: readonly CloudTier[]): CloudTier | null {
  const type = instance.type === "vm" ? "vm" : "default";
  const cpu = instance.resources?.cpu;
  const memory = instance.resources?.memory;
  return tiers.find((tier) => tier.type === type && tier.cpu === cpu && tier.memoryGb === memory) ?? null;
}

function toWorkLanes(lanes: readonly CloudLaneWorkLane[] | null): CloudLaneWorkLane[] {
  return (lanes ?? []).filter((lane) => lane.state === "unpushed" || lane.state === "failed");
}

export function createCloudLaneLife(deps: CloudLaneLifeDeps) {
  const { logger } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowIso = () => nowIsoFrom(now);
  const jobs = new Map<string, JobRecord>();
  const running = new Map<string, AbortController>();
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

  const isLive = (job: CloudLaneJobSnapshot) => job.phase === "waiting" || job.phase === "running";

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  const readInstance = async (instanceId: string): Promise<CloudInstance | null> => {
    const client = await deps.client();
    try {
      return await client.getInstance(instanceId);
    } catch (error) {
      if (error instanceof CloudProviderError && error.status === 404) return null;
      throw error;
    }
  };

  const workState = async (args: { instanceId: string }): Promise<CloudLaneWorkState> => {
    const ran = await deps.machines.runPushWork(args.instanceId, { check: true });
    if (!ran.tally) return { unpushed: null, unpushedLanes: [], message: ran.error ?? "ADE couldn't read this computer's work." };
    // An older computer answers counts without the lane list: it can't say, so the caller warns.
    if (!ran.tally.lanes) return { unpushed: null, unpushedLanes: [], message: "This computer's ADE is too old to say what isn't pushed." };
    const unpushedLanes = toWorkLanes(ran.tally.lanes);
    return { unpushed: unpushedLanes.length > 0, unpushedLanes, message: null };
  };

  // ---------------------------------------------------------------------------
  // Delete lane, and keep the lane on a fresh computer
  // ---------------------------------------------------------------------------

  const forgetConnections = (machineKey: string | null, instanceId: string): void => {
    try {
      deps.forgetMachineConnections({ machineKey, instanceId });
    } catch (error) {
      logger.warn?.("cloud.lane_connection_left", { instanceId, error: getErrorMessage(error) });
    }
  };

  /**
   * Deletes the computer and so the lane on it. Never refused: `skipCheck`
   * leaves out the work check when the person was already warned. Its chats
   * stay readable from the saved copy, which this does not touch.
   */
  const deleteLane = async (args: { instanceId: string; skipCheck?: boolean }): Promise<CloudLaneDeleteResult> => {
    if (Array.from(jobs.values()).some((record) => isLive(record.job) && record.job.instanceId === args.instanceId)) {
      // A tier change mid-way would make a computer the delete doesn't know.
      return { ok: false, message: "This lane is changing size. Wait for it to finish, or cancel it, then delete.", unpushed: null, unpushedLanes: [] };
    }
    const instance = await readInstance(args.instanceId);
    const machineKey = instance?.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null;
    const state = args.skipCheck || !instance ? null : await workState({ instanceId: args.instanceId });
    const result = await deps.machines.run({ action: "delete", instanceId: args.instanceId, machineKey });
    if (result.ok) {
      forgetConnections(machineKey, args.instanceId);
      deps.changed();
    }
    logger.info?.("cloud.lane_deleted", { instanceId: args.instanceId, ok: result.ok, unpushed: state?.unpushed ?? null });
    return { ok: result.ok, message: result.message, unpushed: state?.unpushed ?? null, unpushedLanes: state?.unpushedLanes ?? [] };
  };

  /**
   * Pushes the lane's work, then removes its computer and keeps the lane. A
   * push that can't save everything keeps the computer as it is.
   */
  const freeLane = async (args: { instanceId: string }): Promise<CloudLaneFreeResult> => {
    const fail = (message: string): CloudLaneFreeResult => ({ ok: false, message, lane: null });
    if (Array.from(jobs.values()).some((record) => isLive(record.job) && record.job.instanceId === args.instanceId)) {
      return fail("This lane is changing size. Wait for it to finish, then try again.");
    }
    const instance = await readInstance(args.instanceId);
    if (!instance) return fail("ADE Cloud has no such computer.");
    const lane = cloudMachineLaneFactsOf(instance.metadata);
    if (!lane) return fail("This computer wasn't made for one lane, so there is no lane to keep. Delete it, or keep it.");
    const ran = await deps.machines.runPushWork(args.instanceId, { check: false });
    if (!ran.tally) return fail(`ADE couldn't push this lane's work, so the computer stays: ${(ran.error ?? "no answer").replace(/\.$/, "")}.`);
    const left = toWorkLanes(ran.tally.lanes);
    if (ran.tally.failed > 0 || left.length > 0 || (!ran.tally.lanes && ran.tally.skipped > 0)) {
      const names = left.map((entry) => entry.laneName || entry.branchRef).filter(Boolean);
      return fail(`ADE couldn't push all work on this computer${names.length ? ` (${names.join(", ")})` : ""}, so it stays. Open the lane to see why, then try again.`);
    }
    const ownLane = ran.tally.lanes?.find((entry) => entry.laneId === lane.laneId)
      ?? (ran.tally.lanes ?? []).filter((entry) => !entry.primary).at(0)
      ?? null;
    const branchRef = ownLane?.branchRef || instance.metadata[CLOUD_LANE_BRANCH_METADATA] || null;
    if (!branchRef) return fail("ADE couldn't tell which branch this lane is on, so the computer stays.");
    const machineKey = instance.metadata[CLOUD_MACHINE_KEY_METADATA] ?? null;
    const result = await deps.machines.run({ action: "delete", instanceId: args.instanceId, machineKey, keepLane: { branchRef } });
    if (!result.ok) return fail(result.message);
    forgetConnections(machineKey, args.instanceId);
    deps.changed();
    const client = await deps.client();
    const kept = await client.listLanesWithoutComputer()
      .then((lanes) => lanes.find((entry) => entry.laneId === lane.laneId) ?? null)
      .catch(() => null);
    logger.info?.("cloud.lane_freed", { instanceId: args.instanceId, kept: kept != null });
    if (!kept) {
      // The computer is gone but the server didn't keep the lane (an older server).
      return { ok: true, message: "The work is on GitHub and the computer is removed. Start a new lane on its branch to go on.", lane: null };
    }
    return { ok: true, message: "The work is on GitHub and the computer is removed. The next message makes a new computer on the same branch.", lane: kept };
  };

  const lanesWithoutComputer = async (): Promise<CloudLaneWithoutComputer[]> => (await deps.client()).listLanesWithoutComputer();

  /** Deleting a lane that has no computer: only its record goes. Its saved chats stay. */
  const forgetLaneWithoutComputer = async (args: { laneId: string }): Promise<{ forgotten: boolean }> => {
    const forgotten = await (await deps.client()).forgetLaneWithoutComputer(args.laneId);
    deps.changed();
    return { forgotten };
  };

  // ---------------------------------------------------------------------------
  // Tier change
  // ---------------------------------------------------------------------------

  const assertActive = (record: JobRecord, signal: AbortSignal): void => {
    if (signal.aborted || disposed || record.job.phase === "cancelled") throw new JobStopped();
  };

  /** True when nothing the agent does keeps the computer busy (asleep counts as idle). */
  const agentIdle = async (instanceId: string): Promise<boolean> => {
    const client = await deps.client();
    const instance = await client.getInstance(instanceId);
    if (instance.status !== "running") return true;
    const read = await client.exec(instanceId, KEEP_AWAKE_STATE_COMMAND, { timeoutMs: 30_000 }).catch(() => null);
    try {
      const state = JSON.parse(read?.stdout.trim() ?? "") as { busy?: unknown; reasons?: unknown };
      const reasons = Array.isArray(state.reasons) ? state.reasons.filter((reason): reason is string => typeof reason === "string") : [];
      return state.busy !== true || reasons.every((reason) => NOT_AGENT_WORK.has(reason));
    } catch {
      // Unknown is busy, as on the computer itself.
      return false;
    }
  };

  /** Save work: waits for the agent (or stops its turn), then writes the saved chat copy. */
  const runSave = async (record: JobRecord, signal: AbortSignal): Promise<void> => {
    const job = record.job;
    setStage(record, "save", "running", { detail: job.timing === "now" ? "Stopping the running turn" : "Waiting for the agent to finish" });
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
    const client = await deps.client();
    const instance = await client.getInstance(job.instanceId);
    if (instance.status === "running") {
      // Stops what still runs and writes the saved chat copy, so the chats
      // read the same while the computer restarts or moves.
      const ran = await client.exec(job.instanceId, PREPARE_STOP_COMMAND, { timeoutMs: 90_000 }).catch((error: unknown) => {
        logger.warn?.("cloud.lane_job_prepare_stop_failed", { jobId: job.jobId, error: getErrorMessage(error) });
        return null;
      });
      setStage(record, "save", ran?.exitCode === 0 ? "done" : "warning", { detail: ran?.exitCode === 0 ? null : "The chats' saved copy may be a few minutes old" });
      return;
    }
    setStage(record, "save", "done", { detail: "Asleep, nothing running" });
  };

  const waitForRunning = async (record: JobRecord, signal: AbortSignal, instanceId: string): Promise<void> => {
    const client = await deps.client();
    const since = now();
    for (;;) {
      assertActive(record, signal);
      const instance = await client.getInstance(instanceId).catch(() => null);
      if (instance?.status === "running") return;
      if (instance?.status === "failed") throw new Error("ADE Cloud couldn't start the computer again.");
      // A resize leaves it asleep on some sizes: wake it, as a send would.
      if (instance && (instance.status === "sleeping" || instance.status === "stopped")) await client.startInstance(instanceId).catch(() => undefined);
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
      const projects = await deps.listProjects(targetId).catch(() => []);
      const has = projects.some((project) => project.exists !== false && normalizeGitRemoteIdentity(project.gitOriginUrl) === job.projectOrigin);
      if (!has) throw new Error("ADE on the computer answers, but the lane's project isn't there.");
    }
    setStage(record, "connect", "done");
  };

  const runResize = async (record: JobRecord, signal: AbortSignal): Promise<void> => {
    if (finished(stageOf(record, "resize"))) return;
    setStage(record, "resize", "running");
    assertActive(record, signal);
    const result = await deps.machines.run({ action: "resize", instanceId: record.job.instanceId, shape: record.shape });
    if (!result.ok) throw new Error(result.message);
    setStage(record, "resize", "done");
    deps.changed();
  };

  const runMove = async (record: JobRecord, signal: AbortSignal): Promise<void> => {
    if (finished(stageOf(record, "copy"))) return;
    const job = record.job;
    setStage(record, "computer", "running");
    const controller = new AbortController();
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
        // The copy starts once the new computer joined: its first line names the target.
        if (progress.stage === "joining" && progress.instanceId && /^Copying/.test(progress.message)) {
          if (stageOf(record, "computer")?.status === "running") setStage(record, "computer", "done");
          if (stageOf(record, "copy")?.status === "pending") setStage(record, "copy", "running", { detail: progress.message });
          return;
        }
        const active = stageOf(record, "copy")?.status === "running" ? "copy" : "computer";
        const stage = stageOf(record, active);
        if (stage && stage.detail !== progress.message) setStage(record, active, "running", { detail: progress.message });
      }, { signal: controller.signal });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (stageOf(record, "computer")?.status === "running") setStage(record, "computer", "done");
    setStage(record, "copy", "done", { detail: null });
    job.instanceId = result.instanceId;
    job.machineKey = result.machineKey ?? null;
    // ADE on the new computer registered the lane's project during the copy.
    setStage(record, "start", "done");
    setStage(record, "remove", result.sourceDeleted ? "done" : "warning", {
      detail: result.sourceDeleted ? null : "The old computer is still there, asleep. Delete it from Settings › ADE Cloud",
    });
    // One lane, one name: the new computer takes the lane's name.
    if (job.laneName && result.name !== job.laneName) {
      const client = await deps.client();
      await client.setInstanceName(result.instanceId, job.laneName).catch(() => undefined);
      if (result.machineKey) await deps.copyDeps.renameMachine(result.machineKey, job.laneName).catch(() => undefined);
    }
    deps.changed();
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
        await runSave(record, signal);
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
      if (error instanceof JobStopped || disposed) return;
      // A move's failing step: the copy, unless the new computer never came.
      if (job.kind === "move" && active === "computer" && stageOf(record, "copy")?.status === "running") active = "copy";
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
    }
  };

  const changeTier = async (raw: CloudLaneChangeTierArgs): Promise<CloudLaneJobSnapshot> => {
    const instanceId = typeof raw?.instanceId === "string" ? raw.instanceId.trim() : "";
    if (!instanceId) throw new Error("Name the computer.");
    if (!isCloudTierId(raw?.sizeId)) throw new Error("Pick a size.");
    const timing = raw.timing === "now" ? "now" : "idle";
    const busy = Array.from(jobs.values()).find((record) => isLive(record.job) && (record.job.instanceId === instanceId || record.job.fromInstanceId === instanceId));
    if (busy) return structuredClone(busy.job);
    const instance = await readInstance(instanceId);
    if (!instance) throw new Error("ADE Cloud has no such computer.");
    const catalog = cloudCatalogOf(await deps.machines.account().catch(() => null));
    const tier = cloudTier(catalog, raw.sizeId);
    if (!tier) throw new Error("ADE Cloud doesn't offer that size now.");
    const from = tierOfInstance(instance, cloudTiers(catalog));
    if (from?.id === tier.id) throw new Error(`It's already ${tier.label}.`);
    const shape = cloudShapeFor({ cpu: tier.cpu, memoryGb: tier.memoryGb });
    if (!shape) throw new Error("ADE can't make that size.");
    const kind: CloudLaneJobKind = (instance.type === "vm" ? "vm" : "default") === tier.type ? "resize" : "move";
    const lane = cloudMachineLaneFactsOf(instance.metadata);
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
      requestedByChat: typeof raw.requestedByChat === "string" && raw.requestedByChat.trim() ? raw.requestedByChat.trim() : null,
      startedAt,
      updatedAt: startedAt,
      endedAt: null,
    };
    const record: JobRecord = { v: 1, job, shape: shape.id, targetType: tier.type };
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
    publish(record);
    void runJob(record);
    return structuredClone(record.job);
  };

  /** Stops a job before the size changed: while it waits or saves. After that it runs to the end. */
  const cancelJob = async (args: { jobId: string }): Promise<CloudLaneJobSnapshot | null> => {
    const record = jobs.get(args?.jobId);
    if (!record) return null;
    const changing = record.job.stages.some((stage) => stage.id !== "save" && stage.status !== "pending");
    if (changing && record.job.phase !== "failed") throw new Error("The size is already changing. ADE finishes it.");
    record.job.phase = "cancelled";
    record.job.endedAt = nowIso();
    running.get(record.job.jobId)?.abort();
    publish(record);
    return structuredClone(record.job);
  };

  const listJobs = (): CloudLaneJobSnapshot[] => Array.from(jobs.values()).map((record) => structuredClone(record.job));

  /** Jobs from before a quit: live ones go on, finished ones stay a day. A move cut off mid-copy is failed for Retry. */
  const load = (): void => {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(deps.recordsDir);
    } catch {
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
        if (!isLive(record.job) && ended != null && now() - ended > FINISHED_JOB_KEEP_MS) {
          fs.rmSync(file, { force: true });
          continue;
        }
        jobs.set(record.job.jobId, record);
        if (!isLive(record.job)) continue;
        const cutMove = record.job.kind === "move"
          && (stageOf(record, "computer")?.status === "running" || stageOf(record, "copy")?.status === "running");
        if (cutMove) {
          // The old computer stays as it was (its pause clears itself); the
          // half-made new one is the pending-create sweep's to delete.
          record.job.phase = "failed";
          record.job.error = "ADE quit during the move. The old computer is as it was; Retry to move it again.";
          const stage = stageOf(record, stageOf(record, "copy")?.status === "running" ? "copy" : "computer");
          if (stage) Object.assign(stage, { status: "failed", error: record.job.error, endedAt: nowIso() });
          persist(record);
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

  return { workState, deleteLane, freeLane, lanesWithoutComputer, forgetLaneWithoutComputer, changeTier, retryJob, cancelJob, listJobs, load, dispose };
}

export type CloudLaneLife = ReturnType<typeof createCloudLaneLife>;
