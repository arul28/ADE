import {
  cloudCatalogOf,
  CLOUD_JOIN_WATCH_MS,
  cloudMadeByMetadata,
  CLOUD_WAKE_PORT,
  CLOUD_WAKE_PORT_LABEL,
} from "../../../shared/adeCloud";
import {
  CLOUD_LANE_ID_METADATA,
  CLOUD_LANE_NAME_METADATA,
  CLOUD_PROJECT_ORIGIN_METADATA,
} from "../../../shared/cloudLaneLaunch";
import { cloudTier, type CloudTier } from "../../../shared/cloudTiers";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type {
  ChatLaunchCloudStageId,
  ChatLaunchStage,
  ChatLaunchStageId,
  ChatLaunchStageStatus,
  RemoteRuntimeProjectRecord,
} from "../../../shared/types";
import { getErrorMessage } from "../shared/utils";
import {
  approveCloudMachineSignIn,
  cloudMinAdeVersion,
  readCloudBoxAuth,
  startCloudBoxSignIn,
  waitForCloudAccountRow,
  waitForCloudBoxAuth,
} from "./cloudMachineCreator";
import type { CloudLaneLaunchRecord } from "./cloudLaneLaunchRecords";
import {
  CANT_MAKE_COMPUTER,
  CONNECT_RETRY_MS,
  CREATE_IN_PROGRESS_POLL_MS,
  CREATE_IN_PROGRESS_WAIT_MS,
  LANE_LAUNCH_HOLD,
  LANE_LAUNCH_HOLD_MS,
  LOST_CREATE_LOOK_MS,
  LaunchStepError,
  clip,
  mayHaveMadeComputer,
  type CloudLaneLaunchDeps,
  type Logger,
} from "./cloudLaneLaunchSteps";
import { deleteCloudInstanceConfirmed } from "./cloudPendingCreates";
import { CloudProviderError, type CloudInstance, type CloudProvider } from "./cloudProvider";
import { cloudHoldCommand, cloudReleaseHoldCommand, enableCloudSleep } from "./cloudSleep";

/**
 * The computer half of an ADE Cloud lane launch (`cloudLaneLaunchService.ts`):
 * the `computer`, `join` and `clone` stages, the hold that keeps the computer
 * awake until the hand-off, and the cancel's delete of the computers this
 * launch made. The service hands in how a stage row changes and is saved.
 */

/** How a stage changes the launch's record, from the service that owns it. */
export type CloudLaneStageHandle = {
  stageOf: (record: CloudLaneLaunchRecord, id: ChatLaunchStageId) => ChatLaunchStage | null;
  setStage: (
    record: CloudLaneLaunchRecord,
    id: ChatLaunchStageId,
    status: ChatLaunchStageStatus,
    patch?: Partial<Omit<ChatLaunchStage, "id" | "status">>,
  ) => void;
  finishStage: (record: CloudLaneLaunchRecord, id: ChatLaunchCloudStageId, detail: string | null) => void;
  publish: (record: CloudLaneLaunchRecord, options?: { persist?: boolean }) => void;
  persist: (record: CloudLaneLaunchRecord) => void;
  assertActive: (record: CloudLaneLaunchRecord, signal: AbortSignal) => void;
};

export function createCloudLaneComputerStages(
  deps: CloudLaneLaunchDeps,
  handle: CloudLaneStageHandle,
  env: { logger: Logger; sleep: (ms: number) => Promise<void> },
) {
  const { logger, sleep } = env;
  const { stageOf, setStage, finishStage, publish, persist, assertActive } = handle;

  const providerClient = async (): Promise<CloudProvider> => await deps.creator.client();

  /** The size picked at Send, read from the server's catalog (rates included). */
  const resolveTier = async (client: CloudProvider, sizeId: string): Promise<CloudTier> => {
    const account = await client.getAccount();
    const tier = cloudTier(cloudCatalogOf(account), sizeId);
    if (!tier) throw new LaunchStepError("ADE Cloud doesn't offer that size right now. Pick another one.");
    return tier;
  };

  /** A computer this launch made: the one on the record, else the one carrying its request id. */
  const findOwnComputer = async (client: CloudProvider, record: CloudLaneLaunchRecord): Promise<CloudInstance | null> => {
    const launchId = record.snapshot.launchId;
    const known = record.snapshot.cloud.instanceId;
    if (known) {
      try {
        const instance = await client.getInstance(known);
        if (instance.status !== "deleted" && instance.metadata.ade_request_id === launchId) return instance;
      } catch (error) {
        if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
      }
      record.snapshot.cloud.instanceId = null;
      persist(record);
    }
    const listed = await client.listInstances();
    return listed.find((instance) => instance.metadata.ade_request_id === launchId && instance.status !== "deleted") ?? null;
  };

  const createComputer = async (
    client: CloudProvider,
    record: CloudLaneLaunchRecord,
    tier: CloudTier,
    signal: AbortSignal,
  ): Promise<CloudInstance> => {
    const launchId = record.snapshot.launchId;
    // No sign-in value in the env (the Worker and the host would see it): the
    // computer's brain takes them from the account vault (cloudMachineCreator.ts).
    const minAdeVersion = cloudMinAdeVersion(deps.creator.minAdeVersion?.() ?? null);
    const env: Record<string, string> = minAdeVersion ? { ADE_MIN_VERSION: minAdeVersion } : {};
    assertActive(record, signal);
    const input = {
      name: record.computerName,
      type: tier.type,
      resources: { cpu: tier.cpu, memory: tier.memoryGb },
      metadata: {
        [CLOUD_LANE_ID_METADATA]: record.snapshot.laneId,
        [CLOUD_LANE_NAME_METADATA]: record.snapshot.laneName.slice(0, 200),
        [CLOUD_PROJECT_ORIGIN_METADATA]: record.project.identity,
        ...cloudMadeByMetadata(record),
        created_by: "ade",
        ade_request_id: launchId,
      },
      ...(Object.keys(env).length ? { env } : {}),
      // The wake URL: the computer's brain requests it while it works (cloudSleep.ts).
      publicPorts: [{ port: CLOUD_WAKE_PORT, label: CLOUD_WAKE_PORT_LABEL }],
    };
    const waitUntil = Date.now() + CREATE_IN_PROGRESS_WAIT_MS;
    for (;;) {
      try {
        return await client.createInstance(input, signal);
      } catch (error) {
        assertActive(record, signal);
        // The server is still making it for this request id: ask again, never twice at once.
        if (error instanceof CloudProviderError && error.code === "create_in_progress" && Date.now() < waitUntil) {
          await sleep(CREATE_IN_PROGRESS_POLL_MS);
          continue;
        }
        if (!mayHaveMadeComputer(error)) throw error;
        // The answer was lost, but the computer may exist: look for its tag
        // instead of asking again, so an older server never makes two.
        logger.warn("cloud_lane_launch.create_answer_lost", { launchId, error: getErrorMessage(error) });
        const lookUntil = Date.now() + LOST_CREATE_LOOK_MS;
        while (Date.now() < lookUntil) {
          assertActive(record, signal);
          const found = await findOwnComputer(client, record).catch((lookError: unknown) => {
            logger.warn("cloud_lane_launch.lost_create_look_failed", { launchId, error: getErrorMessage(lookError) });
            return null;
          });
          if (found) return found;
          await sleep(CREATE_IN_PROGRESS_POLL_MS);
        }
        throw error;
      }
    }
  };

  const runComputerStage = async (record: CloudLaneLaunchRecord, signal: AbortSignal): Promise<void> => {
    setStage(record, "computer", "running", { detail: null });
    publish(record);
    const client = await providerClient();
    if (!deps.creator.directoryBaseUrl()) {
      throw new LaunchStepError("ADE's account service isn't set up on this computer, so it can't add a computer to your account.");
    }
    if (!(await deps.creator.getAccountToken())) throw new LaunchStepError("Sign in to ADE on this computer first. The new computer joins your account.");
    record.tier ??= await resolveTier(client, record.snapshot.cloud.sizeId);
    const tier = record.tier;
    assertActive(record, signal);
    let instance = await findOwnComputer(client, record);
    // A computer ADE Cloud gave up on never answers: delete it and make a new one.
    if (instance?.status === "failed") {
      logger.warn("cloud_lane_launch.failed_computer_replaced", { launchId: record.snapshot.launchId, instanceId: instance.id });
      await deleteCloudInstanceConfirmed(client, instance.id, { logger, sleep, reason: "lane_launch_failed_computer" });
      instance = null;
    }
    if (!instance) {
      if (!(await client.hasTemplate())) throw new LaunchStepError(CANT_MAKE_COMPUTER);
      const stage = stageOf(record, "computer");
      if (stage) stage.detail = `${tier.label} · ${tier.cpu} CPU, ${tier.memoryGb} GB`;
      publish(record, { persist: false });
      instance = await createComputer(client, record, tier, signal);
      deps.onComputerCreated?.();
      logger.info("cloud_lane_launch.computer_created", { launchId: record.snapshot.launchId, instanceId: instance.id, tier: tier.id });
    }
    record.snapshot.cloud.instanceId = instance.id;
    publish(record);
    assertActive(record, signal);
    // The computer counts as made once its ADE answers.
    await waitForCloudBoxAuth(client, instance.id, { signal, sleep, machine: "the new computer" });
    finishStage(record, "computer", `${tier.label} · ${tier.cpu} CPU, ${tier.memoryGb} GB`);
  };

  const runJoinStage = async (record: CloudLaneLaunchRecord, signal: AbortSignal): Promise<void> => {
    const launchId = record.snapshot.launchId;
    const instanceId = record.snapshot.cloud.instanceId;
    if (!instanceId) throw new LaunchStepError("ADE lost track of the new computer. Cancel and send again.");
    setStage(record, "join", "running", { detail: null });
    publish(record);
    const client = await providerClient();
    const directory = deps.creator.directoryBaseUrl();
    if (!directory) throw new LaunchStepError("ADE's account service isn't set up on this computer, so it can't add a computer to your account.");
    const name = record.computerName;
    // Wakes a computer a failure put to sleep.
    const auth = await waitForCloudBoxAuth(client, instanceId, { signal, sleep, machine: "the new computer" });
    assertActive(record, signal);
    if (auth.signedIn !== true) {
      // A code an earlier attempt sent for approval may be used up: start a fresh one.
      const fresh = record.joinAttempts > 0;
      record.joinAttempts += 1;
      persist(record);
      const started = await startCloudBoxSignIn(client, instanceId, "login", signal, { fresh });
      assertActive(record, signal);
      if (!started.userCode) {
        logger.warn("cloud_lane_launch.sign_in_no_code", { launchId, instanceId, exitCode: started.exitCode });
        throw new LaunchStepError("The new computer didn't start its sign-in.");
      }
      await approveCloudMachineSignIn(deps.creator, {
        userCode: started.userCode,
        name,
        instanceId,
        requestId: launchId,
        restartSignIn: async () => (await startCloudBoxSignIn(client, instanceId, "login", signal, { fresh: true })).userCode,
        directory,
        signal,
        readSignedIn: async () => (await readCloudBoxAuth(client, instanceId, signal))?.signedIn === true,
        onApprovalSent: () => undefined,
        progress: (stage, message, _instanceId, approvalUrl) => {
          if (stage === "approve_elsewhere" && approvalUrl) deps.onApprovalLink?.(launchId, approvalUrl);
          // Only the steps that ask something of the person reach the row.
          const row = stageOf(record, "join");
          if (!row || row.status !== "running") return;
          row.detail = stage === "confirm_in_window" || stage === "approve_elsewhere" ? clip(message, 160) : null;
          publish(record, { persist: false });
        },
      });
    }
    assertActive(record, signal);
    const joinRow = stageOf(record, "join");
    if (joinRow) joinRow.detail = "Adding it to your computers…";
    publish(record, { persist: false });
    const row = await waitForCloudAccountRow(deps.creator, { client, instanceId, name, requestId: launchId, signal });
    if (!row.machineKey) throw new LaunchStepError("The new computer signed in, but ADE couldn't tell which computer it is.");
    record.snapshot.cloud.machineKey = row.machineKey;
    persist(record);
    // Signed in, so its brain keeps itself awake while it works; let ADE Cloud sleep it otherwise.
    const sleepResult = await enableCloudSleep(client, instanceId, { logger });
    if (sleepResult.state !== "on") logger.warn("cloud_lane_launch.sleep_not_enabled", { launchId, instanceId, state: sleepResult.state });
    // Nothing on its busy list sees the pairing and clone ahead: hold it awake until the hand-off.
    await client.exec(instanceId, cloudHoldCommand(LANE_LAUNCH_HOLD, LANE_LAUNCH_HOLD_MS), { timeoutMs: 30_000 }).catch((error: unknown) => {
      logger.warn("cloud_lane_launch.hold_failed", { launchId, instanceId, error: getErrorMessage(error) });
    });
    finishStage(record, "join", row.joined ? null : "Still starting");
  };

  const releaseHold = async (record: CloudLaneLaunchRecord): Promise<void> => {
    const instanceId = record.snapshot.cloud.instanceId;
    if (!instanceId) return;
    try {
      await (await providerClient()).exec(instanceId, cloudReleaseHoldCommand(LANE_LAUNCH_HOLD), { timeoutMs: 30_000 });
    } catch (error) {
      // It expires on its own.
      logger.warn("cloud_lane_launch.hold_release_failed", { launchId: record.snapshot.launchId, error: getErrorMessage(error) });
    }
  };

  /** Pairs and connects, retrying while the computer's account row and relay route come up. */
  const pairAndConnect = async (record: CloudLaneLaunchRecord, machineKey: string, signal: AbortSignal): Promise<string> => {
    const startedAt = Date.now();
    let lastError: unknown = null;
    for (;;) {
      assertActive(record, signal);
      try {
        const targetId = record.targetId ?? (await deps.pairMachine(machineKey)).targetId;
        record.targetId = targetId;
        if (await deps.connect(targetId)) return targetId;
      } catch (error) {
        lastError = error;
        // A saved target that is gone is paired again on the next try.
        if (/target was not found/i.test(getErrorMessage(error))) record.targetId = null;
      }
      if (Date.now() - startedAt >= CLOUD_JOIN_WATCH_MS) break;
      await sleep(CONNECT_RETRY_MS);
    }
    logger.warn("cloud_lane_launch.connect_timed_out", {
      launchId: record.snapshot.launchId,
      error: lastError ? getErrorMessage(lastError) : null,
    });
    throw new LaunchStepError("ADE couldn't connect to the new computer in time.");
  };

  const runCloneStage = async (record: CloudLaneLaunchRecord, signal: AbortSignal): Promise<void> => {
    const machineKey = record.snapshot.cloud.machineKey;
    if (!machineKey) throw new LaunchStepError("ADE lost track of the new computer. Cancel and send again.");
    setStage(record, "clone", "running", { detail: record.project.identity.replace(/^github\.com\//i, "") });
    publish(record);
    const targetId = await pairAndConnect(record, machineKey, signal);
    persist(record);
    assertActive(record, signal);
    const identity = record.project.identity;
    const sameRepo = (project: RemoteRuntimeProjectRecord) =>
      project.exists !== false && normalizeGitRemoteIdentity(project.gitOriginUrl) === identity;
    let project = (await deps.listProjects(targetId)).find(sameRepo) ?? null;
    if (!project) {
      const parentDir = await deps.defaultParentDir(targetId);
      assertActive(record, signal);
      // The computer's own brain joins a second request for the same folder
      // and answers with a checkout that is already there.
      project = await deps.cloneProject(targetId, { url: record.project.cloneUrl, parentDir, name: record.project.repoName });
    }
    assertActive(record, signal);
    record.snapshot.cloud.binding = await deps.resolveBinding(targetId, project.projectId, project.rootPath);
    finishStage(record, "clone", record.project.identity.replace(/^github\.com\//i, ""));
  };

  /** Deletes only computers made for this launch (its request id), then takes a joined one off the account. */
  const deleteOwnComputers = async (record: CloudLaneLaunchRecord): Promise<{ found: number; deleted: number }> => {
    const launchId = record.snapshot.launchId;
    const client = await providerClient();
    const own = new Map<string, CloudInstance>();
    const known = record.snapshot.cloud.instanceId;
    if (known) {
      try {
        const instance = await client.getInstance(known);
        if (instance.metadata.ade_request_id === launchId && instance.status !== "deleted") own.set(instance.id, instance);
      } catch (error) {
        if (!(error instanceof CloudProviderError && error.status === 404)) throw error;
      }
    }
    for (const instance of await client.listInstances()) {
      if (instance.metadata.ade_request_id === launchId && instance.status !== "deleted") own.set(instance.id, instance);
    }
    let deleted = 0;
    for (const instance of own.values()) {
      if (await deleteCloudInstanceConfirmed(client, instance.id, { logger, sleep, reason: "lane_launch_cancelled" })) {
        deleted += 1;
        logger.info("cloud_lane_launch.computer_deleted", { launchId, instanceId: instance.id });
      }
    }
    const machineKey = record.snapshot.cloud.machineKey;
    if (machineKey && deleted === own.size && own.size > 0) {
      await deps.removeAccountMachine(machineKey).catch((error: unknown) => {
        logger.warn("cloud_lane_launch.account_row_left", { launchId, error: getErrorMessage(error) });
      });
    }
    if (deleted === own.size && own.size > 0) {
      // A saved connection left behind points at a computer that is gone,
      // and the Connections list shows it as a machine that never answers.
      for (const instance of own.values()) {
        try {
          deps.forgetMachineConnections?.({ machineKey, instanceId: instance.id });
        } catch (error) {
          logger.warn("cloud_lane_launch.connection_left", { launchId, error: getErrorMessage(error) });
        }
      }
      record.targetId = null;
    }
    return { found: own.size, deleted };
  };

  return { providerClient, runComputerStage, runJoinStage, runCloneStage, releaseHold, deleteOwnComputers };
}

export type CloudLaneComputerStages = ReturnType<typeof createCloudLaneComputerStages>;
