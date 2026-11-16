import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cloudPlanIdOf, isPaidPlanId, type CloudCreateProgress, type CloudShapeId } from "../../../shared/adeCloud";
import {
  CTO_CLOUD_HOME_METADATA,
  CTO_CLOUD_HOME_NEEDS_GITHUB,
  CTO_CLOUD_HOME_NEEDS_PAID_PLAN,
  type CtoCloudHomeEvent,
  type CtoCloudHomeSnapshot,
} from "../../../shared/ctoCloudHome";
import { CLOUD_PROJECT_ORIGIN_METADATA } from "../../../shared/cloudLaneLaunch";
import type { CloudGitPreflight } from "../../../shared/cloudGitCredential";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type {
  ChatLaunchCloudStageId,
  ChatLaunchStage,
  ChatLaunchStageStatus,
  OpenProjectBinding,
  RemoteRuntimeProjectRecord,
} from "../../../shared/types";
import type { CloneProjectInput } from "../../../shared/types";
import { AdeExpectedError } from "../../../shared/expectedError";
import { getErrorMessage, writeTextAtomic } from "../shared/utils";
import { CloudCreateCancelled, bringCloudBoxIntoAde, createCloudMachine, type CloudMachineCreatorDeps } from "./cloudMachineCreator";
import { deleteComputersForRequest, pairAndConnectWithRetry } from "./cloudComputerSteps";
import { CloudProviderError, type CloudInstance, type CloudProvider } from "./cloudProvider";
import { clip, cloudLaneLaunchFailureSentence, githubClone, LaunchCancelled, LaunchStepError, type Logger } from "./cloudLaneLaunchSteps";

/**
 * Makes the CTO's home on ADE Cloud (`shared/ctoCloudHome.ts`): the smallest
 * computer, joined to the account, with the repository cloned. It takes the
 * same path as Settings' "New cloud machine" (`cloudMachineCreator.ts`), not a
 * lane launch: the computer runs no lane, so it carries no lane facts and no
 * lane list shows it. It is tagged `ade_cto_home` and the repository's origin.
 *
 * One job per repository, kept on disk, so a quit mid-way resumes on the same
 * computer instead of making a second one. Cancel deletes only a computer this
 * job made. The computer is under the normal idle cleanup: when the cleanup
 * deletes it, the CTO page offers to make a new one, and the CTO restores from
 * its account copy.
 */

type RemoteBinding = OpenProjectBinding & { kind: "remote" };

type JobRecord = {
  v: 1;
  jobId: string;
  identity: string;
  cloneUrl: string;
  repoName: string;
  computerName: string;
  phase: "running" | "completed" | "failed" | "cancelled";
  stages: ChatLaunchStage[];
  error: string | null;
  warning: string | null;
  /** An earlier CTO computer for this repository: never this job's to delete. */
  reused: boolean;
  instanceId: string | null;
  machineKey: string | null;
  targetId: string | null;
  binding: RemoteBinding | null;
  cleanupDone: boolean;
  updatedAt: string;
};

type Deps = {
  creator: CloudMachineCreatorDeps;
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  forgetMachineConnections?: (machine: { machineKey: string | null; instanceId: string }) => void;
  pairMachine: (machineKey: string) => Promise<{ targetId: string }>;
  connect: (targetId: string) => Promise<unknown>;
  listProjects: (targetId: string) => Promise<RemoteRuntimeProjectRecord[]>;
  defaultParentDir: (targetId: string) => Promise<string>;
  cloneProject: (targetId: string, input: CloneProjectInput) => Promise<RemoteRuntimeProjectRecord>;
  resolveBinding: (targetId: string, projectId: string, rootPath: string) => Promise<RemoteBinding>;
  recordsDir: string;
  logger: Logger;
  emit: (event: CtoCloudHomeEvent) => void;
  gitPreflight?: (originUrl: string) => Promise<CloudGitPreflight>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

const STAGE_IDS: ChatLaunchCloudStageId[] = ["computer", "join", "clone"];
/** The smallest computer: the CTO coordinates; the real work goes to lanes. */
const CTO_HOME_SHAPE: CloudShapeId = "2x4";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fileKey(identity: string): string {
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24);
}

/** "CTO · owner/repo", as ADE Cloud and the account list show it. */
function computerNameFor(identity: string): string {
  return `CTO · ${identity.replace(/^github\.com\//i, "")}`.slice(0, 60);
}

/** The creator's steps on this job's two rows: making the computer, then joining the account. */
const COMPUTER_STEPS = new Set<CloudCreateProgress["stage"]>(["creating", "waiting_for_brain"]);

export function createCtoCloudHomeService(deps: Deps) {
  const { logger } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const nowIso = () => now().toISOString();
  /** By project identity. */
  const jobs = new Map<string, JobRecord>();
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let disposed = false;

  const recordPath = (identity: string) => path.join(deps.recordsDir, `${fileKey(identity)}.json`);

  const persist = (job: JobRecord): void => {
    try {
      fs.mkdirSync(deps.recordsDir, { recursive: true });
      writeTextAtomic(recordPath(job.identity), JSON.stringify(job));
    } catch (error) {
      logger.warn("cto_cloud_home.persist_failed", { error: getErrorMessage(error) });
    }
  };

  const unpersist = (identity: string): void => {
    try { fs.rmSync(recordPath(identity), { force: true }); } catch { /* read and dropped next start */ }
  };

  const load = (identity: string): JobRecord | null => {
    const cached = jobs.get(identity);
    if (cached) return cached;
    try {
      const raw = JSON.parse(fs.readFileSync(recordPath(identity), "utf8")) as JobRecord;
      // A record this build can't read is dropped: its computer, if any, is
      // found again by its tag.
      if (raw?.v !== 1 || raw.identity !== identity) {
        unpersist(identity);
        return null;
      }
      // A quit cut the job off: it waits for Retry, on the same computer.
      if (raw.phase === "running") {
        raw.phase = "failed";
        raw.error = "ADE closed while it was setting this up. Retry to go on.";
        for (const stage of raw.stages) if (stage.status === "running") stage.status = "pending";
      }
      if (raw.phase === "cancelled" && raw.cleanupDone) {
        unpersist(identity);
        return null;
      }
      jobs.set(identity, raw);
      return raw;
    } catch (error) {
      // No record is the usual answer; anything else is a record that broke.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn("cto_cloud_home.record_unreadable", { error: getErrorMessage(error) });
        unpersist(identity);
      }
      return null;
    }
  };

  const snapshotOf = (job: JobRecord): CtoCloudHomeSnapshot => ({
    jobId: job.jobId,
    projectOrigin: job.identity,
    phase: job.phase === "completed" ? "ready" : job.phase,
    stages: job.stages.map((stage) => ({ ...stage })),
    error: job.error,
    warning: job.warning,
    computerName: job.computerName,
    instanceId: job.instanceId,
    machineKey: job.machineKey,
    binding: job.binding,
    targetId: job.targetId,
    reused: job.reused,
    updatedAt: job.updatedAt,
  });

  const publish = (job: JobRecord, options: { persist?: boolean } = {}): void => {
    if (disposed) return;
    job.updatedAt = nowIso();
    if (options.persist !== false) persist(job);
    deps.emit({ type: "updated", snapshot: snapshotOf(job) });
  };

  const stageOf = (job: JobRecord, id: ChatLaunchCloudStageId): ChatLaunchStage | null =>
    job.stages.find((stage) => stage.id === id) ?? null;

  const setStage = (
    job: JobRecord,
    id: ChatLaunchCloudStageId,
    status: ChatLaunchStageStatus,
    detail: string | null = null,
  ): void => {
    const stage = stageOf(job, id);
    if (!stage) return;
    const at = nowIso();
    if (status === "running" && stage.status !== "running") {
      stage.startedAt = at;
      stage.endedAt = null;
      stage.error = null;
    } else if (status !== "pending" && status !== "running") {
      stage.endedAt = at;
    }
    stage.status = status;
    stage.detail = detail;
  };

  const assertActive = (job: JobRecord, signal: AbortSignal): void => {
    if (disposed || signal.aborted || job.phase === "cancelled") throw new LaunchCancelled();
  };

  /** A paid plan, read from the server: free hours never go to a CTO's computer. */
  const assertPaidPlan = async (client: CloudProvider): Promise<void> => {
    const account = await client.getAccount();
    if (!isPaidPlanId(cloudPlanIdOf(account))) throw new AdeExpectedError(CTO_CLOUD_HOME_NEEDS_PAID_PLAN, "user");
  };

  /** A CTO computer for this repository that is still there: used instead of a new one. */
  const isHomeFor = (instance: CloudInstance, identity: string): boolean => instance.status !== "deleted"
    && instance.status !== "failed"
    && instance.metadata?.[CTO_CLOUD_HOME_METADATA] === "1"
    && instance.metadata?.[CLOUD_PROJECT_ORIGIN_METADATA]?.trim().toLowerCase() === identity;

  const findEarlierHome = async (client: CloudProvider, identity: string): Promise<CloudInstance | null> => {
    // Unlisted: a new computer is made, which is the safe side of a lookup that failed.
    const listed = await client.listInstances().catch((error: unknown) => {
      logger.warn("cto_cloud_home.list_failed", { error: error instanceof Error ? error.message : String(error) });
      return [] as CloudInstance[];
    });
    return listed.find((instance) => isHomeFor(instance, identity) && UUID_RE.test(instance.metadata?.ade_request_id ?? "")) ?? null;
  };

  /** The job's computer, if ADE Cloud still has it. */
  const currentInstance = async (client: CloudProvider, job: JobRecord): Promise<CloudInstance | null> => {
    if (!job.instanceId) return null;
    try {
      const instance = await client.getInstance(job.instanceId);
      return instance.status === "deleted" || instance.status === "failed" ? null : instance;
    } catch (error) {
      if (error instanceof CloudProviderError && error.status === 404) return null;
      throw error;
    }
  };

  /** Make (or bring back) the computer and sign it in to the account: the `computer` and `join` rows. */
  const runComputerAndJoin = async (job: JobRecord, signal: AbortSignal): Promise<void> => {
    const client = await deps.creator.client();
    const directory = deps.creator.directoryBaseUrl();
    if (!directory) throw new LaunchStepError("ADE's account service isn't set up on this computer, so it can't add a computer to your account.");
    setStage(job, "computer", "running", job.reused ? "Your earlier CTO computer" : "Smallest size");
    publish(job);
    const progress = (stage: CloudCreateProgress["stage"], message: string, instanceId?: string) => {
      if (instanceId && job.instanceId !== instanceId) {
        job.instanceId = instanceId;
        persist(job);
      }
      if (COMPUTER_STEPS.has(stage)) {
        setStage(job, "computer", "running", stageOf(job, "computer")?.detail ?? null);
      } else {
        if (stageOf(job, "computer")?.status !== "done") setStage(job, "computer", "done", stageOf(job, "computer")?.detail ?? null);
        // Only the steps that ask something of the person carry words on the row.
        setStage(job, "join", "running", stage === "confirm_in_window" || stage === "approve_elsewhere" ? clip(message, 160) : null);
      }
      publish(job, { persist: false });
    };
    const existing = await currentInstance(client, job);
    assertActive(job, signal);
    if (!existing && job.reused) {
      // The earlier computer is gone: the one made now is this job's own, and
      // a Cancel deletes it.
      job.reused = false;
      persist(job);
    }
    let result;
    try {
      result = existing
        ? await bringCloudBoxIntoAde(deps.creator, { client, instance: existing, name: job.computerName, requestId: job.jobId, signal, progress, directory })
        : await createCloudMachine(
          deps.creator,
          job.jobId,
          { kind: "box", shape: CTO_HOME_SHAPE, name: job.computerName },
          (event) => progress(event.stage, event.message, event.instanceId),
          {
            signal,
            metadata: { [CTO_CLOUD_HOME_METADATA]: "1", [CLOUD_PROJECT_ORIGIN_METADATA]: job.identity },
          },
        );
    } catch (error) {
      if (error instanceof CloudCreateCancelled || signal.aborted) throw new LaunchCancelled();
      // The creator deletes a computer that never signed in: the next try makes a new one.
      if (!job.reused) job.instanceId = null;
      throw error;
    }
    assertActive(job, signal);
    job.instanceId = result.instanceId;
    if (!result.machineKey) throw new LaunchStepError("The new computer signed in, but ADE couldn't tell which computer it is.");
    job.machineKey = result.machineKey;
    setStage(job, "computer", "done", stageOf(job, "computer")?.detail ?? null);
    setStage(job, "join", "done", result.joined ? null : "Still starting");
    publish(job);
  };

  /** Pairs and connects, retrying while the computer's account row and relay route come up. */
  const pairAndConnect = (job: JobRecord, signal: AbortSignal): Promise<string> => {
    const machineKey = job.machineKey;
    if (!machineKey) throw new LaunchStepError("ADE lost track of the new computer. Cancel and try again.");
    return pairAndConnectWithRetry({
      machineKey,
      holder: job,
      pairMachine: deps.pairMachine,
      connect: deps.connect,
      assertActive: () => assertActive(job, signal),
      onPaired: () => persist(job),
      sleep,
      logger,
      timedOutEvent: "cto_cloud_home.connect_timed_out",
    });
  };

  /** The repository on the computer, cloned once: the `clone` row. */
  const runClone = async (job: JobRecord, signal: AbortSignal): Promise<void> => {
    const repo = job.identity.replace(/^github\.com\//i, "");
    setStage(job, "clone", "running", repo);
    publish(job);
    const targetId = await pairAndConnect(job, signal);
    assertActive(job, signal);
    const sameRepo = (project: RemoteRuntimeProjectRecord) =>
      project.exists !== false && normalizeGitRemoteIdentity(project.gitOriginUrl) === job.identity;
    let project = (await deps.listProjects(targetId)).find(sameRepo) ?? null;
    if (!project) {
      const parentDir = await deps.defaultParentDir(targetId);
      assertActive(job, signal);
      // The computer's brain joins a second request for the same folder and
      // answers with the checkout that is already there.
      project = await deps.cloneProject(targetId, { url: job.cloneUrl, parentDir, name: job.repoName });
    }
    assertActive(job, signal);
    job.binding = await deps.resolveBinding(targetId, project.projectId, project.rootPath);
    setStage(job, "clone", "done", repo);
    publish(job);
  };

  const run = (job: JobRecord): void => {
    if (running.has(job.identity)) return;
    const controller = new AbortController();
    const done = (async () => {
      let current: ChatLaunchCloudStageId = "computer";
      try {
        // Every run (a Retry too) brings the computer in again: a sleeping one
        // wakes, and one the idle cleanup deleted is made anew, so nothing
        // after this step talks to a computer that is gone.
        const before = job.instanceId;
        current = "computer";
        await runComputerAndJoin(job, controller.signal);
        if (job.instanceId !== before) {
          // Another computer: its pairing and checkout are not this one's.
          job.targetId = null;
          job.binding = null;
          setStage(job, "clone", "pending");
        }
        current = "clone";
        if (stageOf(job, "clone")?.status !== "done" || !job.binding) await runClone(job, controller.signal);
        // A Cancel that landed as the clone finished wins over "ready".
        assertActive(job, controller.signal);
        job.phase = "completed";
        publish(job);
        logger.info("cto_cloud_home.ready", { instanceId: job.instanceId, reused: job.reused });
      } catch (error) {
        if (error instanceof LaunchCancelled || job.phase === "cancelled" || disposed) return;
        // The failed row is the one still running (the creator moves from `computer` to `join` itself).
        const failedRow = current === "computer" && stageOf(job, "join")?.status === "running" ? "join" : current;
        const message = error instanceof AdeExpectedError || error instanceof LaunchStepError
          ? error.message
          : cloudLaneLaunchFailureSentence(failedRow, error);
        logger.warn("cto_cloud_home.failed", { stage: failedRow, error: getErrorMessage(error) });
        setStage(job, failedRow, "failed", stageOf(job, failedRow)?.detail ?? null);
        const row = stageOf(job, failedRow);
        if (row) row.error = message;
        job.phase = "failed";
        job.error = message;
        publish(job);
      } finally {
        running.delete(job.identity);
      }
    })();
    running.set(job.identity, { controller, done });
  };

  const identityOf = (originUrl: string | null): { identity: string; cloneUrl: string; repoName: string } => {
    const clone = githubClone(originUrl);
    if (!clone) throw new AdeExpectedError(CTO_CLOUD_HOME_NEEDS_GITHUB, "user");
    return clone;
  };

  /** A start still reading the plan and looking for an earlier home, by project identity. */
  const starting = new Map<string, Promise<CtoCloudHomeSnapshot>>();

  /** Two quick starts (two windows) share one: the second would replace the first's job. */
  const start = async (args: { originUrl: string | null }): Promise<CtoCloudHomeSnapshot> => {
    const clone = identityOf(args.originUrl);
    const inFlight = starting.get(clone.identity);
    if (inFlight) return inFlight;
    const started = startOnce(args.originUrl, clone).finally(() => starting.delete(clone.identity));
    starting.set(clone.identity, started);
    return started;
  };

  const startOnce = async (
    originUrl: string | null,
    clone: ReturnType<typeof identityOf>,
  ): Promise<CtoCloudHomeSnapshot> => {
    const existing = load(clone.identity);
    if (existing && existing.phase !== "cancelled") {
      if (existing.phase === "failed") return await retryJob(existing);
      return snapshotOf(existing);
    }
    const client = await deps.creator.client();
    await assertPaidPlan(client);
    let warning: string | null = null;
    if (deps.gitPreflight && originUrl) {
      const git = await deps.gitPreflight(originUrl);
      if (!git.ok) throw new AdeExpectedError(git.message, "user");
      if (git.via === "unknown") warning = git.warning;
    }
    const raced = jobs.get(clone.identity);
    if (raced && raced.phase !== "cancelled") return snapshotOf(raced);
    const earlier = await findEarlierHome(client, clone.identity);
    const job: JobRecord = {
      v: 1,
      jobId: earlier?.metadata?.ade_request_id ?? crypto.randomUUID(),
      identity: clone.identity,
      cloneUrl: clone.cloneUrl,
      repoName: clone.repoName,
      computerName: earlier?.name?.trim() ? earlier.name.trim().slice(0, 60) : computerNameFor(clone.identity),
      phase: "running",
      stages: STAGE_IDS.map((id) => ({ id, status: "pending", startedAt: null, endedAt: null, percent: null, detail: null, error: null })),
      error: null,
      warning,
      reused: Boolean(earlier),
      instanceId: earlier?.id ?? null,
      machineKey: null,
      targetId: null,
      binding: null,
      cleanupDone: false,
      updatedAt: nowIso(),
    };
    jobs.set(clone.identity, job);
    persist(job);
    logger.info("cto_cloud_home.start", { reused: job.reused });
    run(job);
    publish(job);
    return snapshotOf(job);
  };

  const byJobId = (jobId: string): JobRecord | null => {
    for (const job of jobs.values()) if (job.jobId === jobId) return job;
    return null;
  };

  const retryJob = async (job: JobRecord): Promise<CtoCloudHomeSnapshot> => {
    if (running.has(job.identity) || job.phase !== "failed") return snapshotOf(job);
    // The plan may have changed since: still paid only.
    await assertPaidPlan(await deps.creator.client());
    job.phase = "running";
    job.error = null;
    for (const stage of job.stages) {
      if (stage.status === "failed" || stage.status === "running") {
        stage.status = "pending";
        stage.error = null;
      }
    }
    run(job);
    publish(job);
    return snapshotOf(job);
  };

  const get = (args: { originUrl: string | null }): CtoCloudHomeSnapshot | null => {
    const clone = githubClone(args.originUrl);
    if (!clone) return null;
    const job = load(clone.identity);
    return job ? snapshotOf(job) : null;
  };

  const retry = async (args: { jobId: string }): Promise<CtoCloudHomeSnapshot | null> => {
    const job = byJobId(args.jobId);
    return job ? await retryJob(job) : null;
  };

  /** Deletes only computers this job made (its request id), then takes a joined one off the account. */
  const deleteOwnComputers = async (job: JobRecord): Promise<{ found: number; deleted: number }> => {
    const result = await deleteComputersForRequest({
      client: await deps.creator.client(),
      requestId: job.jobId,
      knownInstanceId: job.instanceId,
      machineKey: job.machineKey,
      reason: "cto_home_cancelled",
      logger,
      sleep,
      removeAccountMachine: deps.removeAccountMachine,
      forgetMachineConnections: deps.forgetMachineConnections,
      logPrefix: "cto_cloud_home",
    });
    if (result.deleted === result.found) job.targetId = null;
    return { found: result.found, deleted: result.deleted };
  };

  const cancel = async (args: { jobId: string }): Promise<CtoCloudHomeSnapshot | null> => {
    const job = byJobId(args.jobId);
    if (!job) return null;
    const wasReady = job.phase === "completed";
    job.phase = "cancelled";
    const active = running.get(job.identity);
    active?.controller.abort();
    await active?.done.catch(() => undefined);
    if (job.reused || wasReady) {
      // A computer found from an earlier home stays, and so does one that is
      // set up and ready: it may already be the CTO's home.
      job.cleanupDone = true;
    } else {
      const couldnt = `ADE couldn't delete the computer "${job.computerName}". Delete it in Settings › ADE Cloud.`;
      try {
        const { found, deleted } = await deleteOwnComputers(job);
        job.cleanupDone = deleted === found;
        if (!job.cleanupDone) job.error = couldnt;
      } catch (error) {
        logger.warn("cto_cloud_home.cancel_delete_failed", { error: getErrorMessage(error) });
        job.error = couldnt;
      }
    }
    publish(job);
    const snapshot = snapshotOf(job);
    if (job.cleanupDone) {
      jobs.delete(job.identity);
      unpersist(job.identity);
      deps.emit({ type: "removed", jobId: job.jobId, projectOrigin: job.identity });
    }
    return snapshot;
  };

  const finish = (args: { jobId: string }): boolean => {
    const job = byJobId(args.jobId);
    if (!job || job.phase !== "completed") return false;
    jobs.delete(job.identity);
    unpersist(job.identity);
    deps.emit({ type: "removed", jobId: args.jobId, projectOrigin: job.identity });
    return true;
  };

  const dispose = (): void => {
    disposed = true;
    for (const entry of running.values()) entry.controller.abort();
  };

  return { start, get, retry, cancel, finish, dispose };
}

export type CtoCloudHomeService = ReturnType<typeof createCtoCloudHomeService>;
