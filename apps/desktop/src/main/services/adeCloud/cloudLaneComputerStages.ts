import fs from "node:fs/promises";
import path from "node:path";
import { cloudCatalogOf } from "../../../shared/adeCloud";
import { isChatLaunchCloudStageId } from "../../../shared/chatLaunch";
import { cloudTier, type CloudTier } from "../../../shared/cloudTiers";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { cloudLaunchAppArgs, cloudLaunchLaneFields } from "../../../shared/cloudLaneLaunch";
import { createCloudApiClient, CloudApiError } from "../../../shared/cloudApiClient";
import type {
  AgentChatFileRef,
  ChatLaunchCloudStageId,
  ChatLaunchSnapshot,
  ChatLaunchStage,
  ChatLaunchStageId,
  ChatLaunchStageStatus,
  RemoteRuntimeProjectRecord,
} from "../../../shared/types";
import { cloudAutoSizeSentence } from "../../../../../account-directory/src/cloud/contract";
import type {
  CloudLaunchAttachment,
  CloudLaunchRecord,
  CloudLaunchStage,
  CloudServerLaunchRequest,
} from "../../../../../account-directory/src/cloud/contract";
import { getErrorMessage } from "../shared/utils";
import { CloudCreateCancelled, waitForCloudAccountRow } from "./cloudMachineCreator";
import type { CloudLaneLaunchRecord } from "./cloudLaneLaunchRecords";
import {
  CREATE_IN_PROGRESS_POLL_MS,
  CREATE_IN_PROGRESS_WAIT_MS,
  LaunchCancelled,
  LaunchStepError,
  SERVER_LAUNCH_POLL_MS,
  SERVER_LAUNCH_SLOW_POLL_MS,
  SERVER_LAUNCH_BIND_WAIT_MS,
  clip,
  isFinished,
  type CloudLaneLaunchDeps,
  type Logger,
} from "./cloudLaneLaunchSteps";
import { deleteComputersForRequest, pairAndConnectWithRetry } from "./cloudComputerSteps";
import { launchFileName } from "./cloudLaunchFileCopies";
import type { CloudProvider } from "./cloudProvider";

/**
 * The computer half of an ADE Cloud lane launch (`cloudLaneLaunchService.ts`),
 * run by ADE's server launcher (`/cloud/launches`, docs/plans/cloud-6/
 * c6-c8-launcher-spec.md): this app sends the launch, and the server makes
 * the computer with a one-time join key in its env. The new computer signs
 * itself in to the account, clones the repository, starts the launch on its
 * own brain (same launch id and lane id) and posts its stages. No device
 * approval from here, ever.
 *
 * This side shows the server's stages on the `computer`, `join` and `clone`
 * rows (then the brain's rows the computer reports), and once the computer
 * is in the account it pairs with it while it clones, then finds the project
 * there and the brain's launch, which it follows from then on (the service's
 * hand-off). A cancel before the agent starts deletes the computer
 * (the server's cancel, and this app's own delete of computers with the
 * launch's request id).
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

/** The server's no that a later ask gets past: no answer, a busy server, a create still in flight. */
const retryableStart = (error: unknown): boolean =>
  error instanceof CloudApiError && (error.status === 0 || error.status === 429 || error.status >= 500 || error.code === "create_in_progress");

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

function contentTypeOf(file: AgentChatFileRef, readPath: string): string {
  const known = CONTENT_TYPES[path.extname(readPath).toLowerCase()];
  if (known) return known;
  return file.type === "image" ? "image/png" : "application/octet-stream";
}

/** The rows the computer's brain runs after the clone, in order: the server's record carries them once it reports them. */
const BRAIN_STAGE_IDS = ["fetch", "checkout", "environment", "agent"] as const satisfies readonly ChatLaunchStageId[];
const STAGE_STATUSES: ReadonlySet<string> = new Set<ChatLaunchStageStatus>(["pending", "running", "done", "skipped", "warning", "failed"]);

/** After the hand-off, how often the size is read from the server while the brain says setup moved the computer up. */
const SIZE_REFRESH_MIN_MS = 60_000;

export function createCloudLaneComputerStages(
  deps: CloudLaneLaunchDeps,
  handle: CloudLaneStageHandle,
  env: { logger: Logger; sleep: (ms: number) => Promise<void> },
) {
  const { logger, sleep } = env;
  const { stageOf, setStage, finishStage, publish, persist, assertActive } = handle;

  const providerClient = async (): Promise<CloudProvider> => await deps.creator.client();

  /** ADE's server launcher for this account, or a plain sentence why there is none. */
  const launcher = () => {
    const baseUrl = deps.creator.directoryBaseUrl();
    if (!baseUrl) throw new LaunchStepError("ADE's account service isn't set up on this computer, so it can't add a computer to your account.");
    return createCloudApiClient({
      baseUrl,
      accessToken: () => deps.creator.getAccountToken(),
      ...(deps.creator.fetch ? { fetch: deps.creator.fetch } : {}),
    });
  };

  /** The size picked at Send, read from the server's catalog, for the row's words. Unreadable: no words. */
  const resolveTier = async (record: CloudLaneLaunchRecord): Promise<CloudTier | null> => {
    if (record.tier) return record.tier;
    try {
      const account = await (await providerClient()).getAccount();
      record.tier = cloudTier(cloudCatalogOf(account), record.snapshot.cloud.sizeId) ?? null;
    } catch (error) {
      logger.warn("cloud_lane_launch.tier_read_failed", { launchId: record.snapshot.launchId, error: getErrorMessage(error) });
    }
    return record.tier;
  };
  const tierWords = (tier: CloudTier | null): string | null => (tier ? `${tier.label} · ${tier.cpu} CPU, ${tier.memoryGb} GB` : null);
  /** The computer row's words: its size, and why it is bigger than the size asked for. */
  const computerWords = (record: CloudLaneLaunchRecord): string | null => {
    const words = tierWords(record.tier);
    const note = record.snapshot.cloud.sizeNote?.trim();
    return note ? (words ? `${words}. ${note}` : note) : words;
  };

  /**
   * The server started a default Small at Medium (this repository's setup
   * needed it before) or moved it up since: the record takes the computer's
   * real size, so the card, a Retry and the status read say Medium, and why.
   */
  const adoptServerSize = async (record: CloudLaneLaunchRecord, server: CloudLaunchRecord): Promise<void> => {
    if (!server.sizeId || server.sizeId === record.snapshot.cloud.sizeId) return;
    logger.info("cloud_lane_launch.size_changed_on_server", { launchId: record.snapshot.launchId, from: record.snapshot.cloud.sizeId, to: server.sizeId, why: server.autoSize?.why ?? null });
    record.snapshot.cloud.sizeId = server.sizeId;
    record.snapshot.cloud.sizeNote = server.autoSize ? cloudAutoSizeSentence(server.autoSize.why) : null;
    record.tier = null;
    await resolveTier(record);
    persist(record);
  };

  /**
   * After the hand-off this app no longer follows the server: when the
   * computer's brain says setup moved the computer up, the record reads its
   * size from the server once, so the card, a Retry and the status read say
   * Medium, and why. At most one read a minute per launch (the brain sends
   * many snapshots); a read that fails or still says Small changes nothing.
   */
  const sizeRefreshes = new Map<string, number>();
  const refreshServerSize = async (record: CloudLaneLaunchRecord): Promise<boolean> => {
    const launchId = record.snapshot.launchId;
    const last = sizeRefreshes.get(launchId);
    if (last !== undefined && Date.now() - last < SIZE_REFRESH_MIN_MS) return false;
    sizeRefreshes.set(launchId, Date.now());
    try {
      const before = record.snapshot.cloud.sizeId;
      await adoptServerSize(record, await launcher().launchStatus(launchId));
      return record.snapshot.cloud.sizeId !== before;
    } catch (error) {
      logger.info("cloud_lane_launch.size_refresh_failed", { launchId, error: getErrorMessage(error) });
      return false;
    }
  };

  /**
   * Files from this computer named in the first message, sent to the server
   * before the start names them. Each goes once per launch
   * (`record.serverFiles`): a resumed or retried start names the same ones.
   */
  const uploadFiles = async (record: CloudLaneLaunchRecord, api: ReturnType<typeof launcher>): Promise<CloudLaunchAttachment[]> => {
    const local = (record.launch.chat?.message.attachments ?? []).filter((file) => file.type !== "image-url");
    if (!local.length) return [];
    const sent = (record.serverFiles ??= {});
    const out: CloudLaunchAttachment[] = [];
    for (const [index, file] of local.entries()) {
      const known = sent[file.path];
      if (known) {
        out.push(known);
        continue;
      }
      const readPath = record.localCopies?.[file.path] ?? file.path;
      const name = launchFileName(file.path, readPath);
      try {
        const bytes = await fs.readFile(readPath);
        const fileId = `f${index}-${record.snapshot.launchId.slice(0, 8)}`;
        const contentType = contentTypeOf(file, readPath);
        const uploaded = await api.uploadLaunchFile(record.snapshot.launchId, fileId, new Uint8Array(bytes), contentType);
        const attachment: CloudLaunchAttachment = { fileId, name, contentType, sizeBytes: uploaded.sizeBytes };
        sent[file.path] = attachment;
        persist(record);
        out.push(attachment);
      } catch (error) {
        throw new LaunchStepError(`ADE couldn't send ${name} to ADE Cloud: ${getErrorMessage(error).replace(/\.$/, "")}. Retry to send it again.`);
      }
    }
    return out;
  };

  /** The launch as the server takes it: its facts, and this app's own args for a computer that reads them. */
  const serverRequestOf = (record: CloudLaneLaunchRecord, files: CloudLaunchAttachment[], retry: boolean): CloudServerLaunchRequest => {
    const launch = record.launch;
    const snapshot = record.snapshot;
    const create = launch.chat?.create;
    const kind = snapshot.kind;
    const madeByChat = record.madeByChat ?? null;
    const madeByAgent = record.madeByAgent ?? (madeByChat ? "chat" : null);
    const appArgs = cloudLaunchAppArgs(launch);
    if (!appArgs) logger.warn("cloud_lane_launch.app_args_too_big", { launchId: snapshot.launchId });
    return {
      launchId: snapshot.launchId,
      // A CLI launch goes as the lane (`cli` stays in `launch.kind`): a server or computer before it runs the lane alone.
      kind: kind === "cli" ? "lane" : kind,
      sizeId: snapshot.cloud.sizeId as CloudServerLaunchRequest["sizeId"],
      ...(snapshot.cloud.sizeChoice ? { sizeChoice: snapshot.cloud.sizeChoice } : {}),
      project: { origin: record.project.identity },
      lane: { id: snapshot.laneId, ...cloudLaunchLaneFields(snapshot.laneName, launch.laneConfig) },
      ...(kind === "chat" && create && launch.chat
        ? {
          chat: {
            provider: create.provider,
            modelId: create.modelId ?? create.model,
            ...(create.reasoningEffort ? { effort: create.reasoningEffort } : {}),
            permissions: create.permissionMode ?? "default",
            ...(create.fastMode ? { fast: true } : {}),
            prompt: launch.chat.message.text,
            ...(files.length ? { attachments: files } : {}),
          },
        }
        : {}),
      madeBy: madeByAgent ? { kind: "agent", agent: madeByAgent, chatSessionId: madeByChat } : { kind: "person" },
      channel: deps.updateChannel?.() === "beta" ? "beta" : "stable",
      ...(appArgs ? { launch: appArgs } : {}),
      ...(retry ? { retry: true } : {}),
    };
  };

  /** Starts (or, the same id again, reads) the launch on the server, asking again while a create is in flight. */
  const startOnServer = async (record: CloudLaneLaunchRecord, signal: AbortSignal): Promise<CloudLaunchRecord> => {
    const api = launcher();
    if (!(await deps.creator.getAccountToken())) throw new LaunchStepError("Sign in to ADE on this computer first. The new computer joins your account.");
    const files = await uploadFiles(record, api);
    assertActive(record, signal);
    const body = serverRequestOf(record, files, record.retryOnServer === true);
    const waitUntil = Date.now() + CREATE_IN_PROGRESS_WAIT_MS;
    for (;;) {
      try {
        const answer = await api.startLaunch(body);
        if (record.retryOnServer) {
          record.retryOnServer = false;
          persist(record);
        }
        return answer;
      } catch (error) {
        assertActive(record, signal);
        if (retryableStart(error) && Date.now() < waitUntil) {
          logger.info("cloud_lane_launch.server_start_again", { launchId: record.snapshot.launchId, error: getErrorMessage(error) });
          await sleep(CREATE_IN_PROGRESS_POLL_MS);
          continue;
        }
        // The server's own sentence (hours, computers, disk, a private repository) is the one to show.
        if (error instanceof CloudApiError && error.status >= 400 && error.status < 500) throw new LaunchStepError(error.message);
        throw error;
      }
    }
  };

  /**
   * The server's rows on this app's card: what the computer reported, else
   * what the launch's state says. Past the clone, the computer's brain reports
   * its own rows (fetch, checkout, environment, agent) here too, so the card
   * moves while this app still pairs and finds the launch there. The brain's
   * snapshot at the hand-off replaces them all; it is never behind what it
   * reported, so no row goes back.
   */
  const showServerRecord = (record: CloudLaneLaunchRecord, server: CloudLaunchRecord): void => {
    const reported = new Map<string, CloudLaunchStage>(server.stages.map((stage) => [stage.id, stage]));
    const show = (id: ChatLaunchStageId, status: ChatLaunchStageStatus, detail: string | null, error: string | null = null) => {
      const row = stageOf(record, id);
      if (!row) return;
      if (row.status === status && (row.detail ?? null) === detail && (row.error ?? null) === error) return;
      if (status === "done" && isChatLaunchCloudStageId(id)) {
        finishStage(record, id, detail);
        return;
      }
      if (row.status !== status) {
        // A row the 3 s read never saw running starts where the row before it ended, not now (0 s).
        const before = record.snapshot.stages[record.snapshot.stages.indexOf(row) - 1];
        const startedAt = row.status === "pending" && status !== "running" && before?.endedAt ? { startedAt: before.endedAt } : {};
        setStage(record, id, status, { detail, error, ...startedAt });
      } else {
        row.detail = detail;
        row.error = error;
      }
      publish(record, { persist: status !== "running" });
    };
    const repository = record.project.identity.replace(/^github\.com\//i, "");
    const state = server.state;
    const computerMade = Boolean(server.instanceId) && state !== "making";
    show("computer", computerMade ? "done" : "running", computerWords(record));
    if (!computerMade) return;
    // Waiting on a sign-in comes after the join: the computer is in the account already.
    const joined = state === "joined" || state === "waiting_for_sign_in" || state === "running" || state === "done" || reported.get("join")?.status === "done";
    if (!joined) {
      const approval = state === "needs_approval" ? server.approval : null;
      if (approval?.url) record.snapshot.cloud.approvalUrl = approval.url;
      else delete record.snapshot.cloud.approvalUrl;
      show("join", "running", approval ? `Approve "${record.computerName}" joining your account: open ${approval.url} on your phone or in a browser signed in to ADE.` : null);
      return;
    }
    delete record.snapshot.cloud.approvalUrl;
    show("join", "done", null);
    const clone = reported.get("clone");
    show("clone", clone?.status === "done" ? "done" : "running", clone?.detail?.trim() || repository);
    // The computer waits for the chat's provider sign-in: the card shows the link and code.
    const waiting = state === "waiting_for_sign_in" ? server.signIn ?? null : null;
    const signIn = waiting
      ? { label: waiting.label, url: waiting.url, userCode: waiting.userCode, reason: waiting.reason, jobId: waiting.jobId ?? null, needsPastedCode: waiting.needsPastedCode === true }
      : null;
    if (JSON.stringify(record.snapshot.cloud.signIn ?? null) !== JSON.stringify(signIn)) {
      if (signIn) record.snapshot.cloud.signIn = signIn;
      else delete record.snapshot.cloud.signIn;
      publish(record, { persist: false });
    }
    // The brain's rows show once its launch reports them (it lists every row it has).
    if (clone?.status !== "done" || !BRAIN_STAGE_IDS.some((id) => reported.has(id))) return;
    for (const id of BRAIN_STAGE_IDS) {
      const row = stageOf(record, id);
      if (!row) continue;
      const stage = reported.get(id);
      // A row this app guessed that the brain doesn't have (no environment to set up for this lane).
      if (!stage) {
        if (row.status === "pending") show(id, "skipped", null);
        continue;
      }
      if (!STAGE_STATUSES.has(stage.status)) continue;
      const status = stage.status as ChatLaunchStageStatus;
      // Never back: a row shown finished stays so until the hand-off's snapshot.
      if (isFinished(row) && !isFinished({ status })) continue;
      const failure = stage.status === "failed" || stage.status === "warning" ? stage.error?.trim() || null : null;
      show(id, status, stage.detail?.trim() || null, failure);
    }
  };

  /** The sentence for a launch the server or its computer ended, from the computer's own words when it has them. */
  const serverFailure = (server: CloudLaunchRecord): LaunchStepError => {
    if (server.state === "cancelled") return new LaunchStepError("This launch was cancelled on ADE Cloud.");
    const failed = server.stages.find((stage) => stage.status === "failed");
    return new LaunchStepError(clip(server.error ?? failed?.error ?? "The new computer couldn't start the lane.", 400));
  };

  /** Pairs and connects, retrying while the computer's account row and relay route come up. */
  const pairAndConnect = (record: CloudLaneLaunchRecord, machineKey: string, signal: AbortSignal): Promise<string> =>
    pairAndConnectWithRetry({
      machineKey,
      holder: record,
      pairMachine: deps.pairMachine,
      connect: deps.connect,
      assertActive: () => assertActive(record, signal),
      sleep,
      logger,
      timedOutEvent: "cloud_lane_launch.connect_timed_out",
      logFields: { launchId: record.snapshot.launchId },
    });

  /** The computer's project is there once its clone is done (or the launch went on past it). */
  const isCloned = (server: CloudLaunchRecord): boolean =>
    server.state !== "joined" || server.stages.some((stage) => stage.id === "clone" && stage.status === "done");

  /**
   * One pass of finding the launch on the computer, run beside the server's
   * poll so the card keeps moving while it pairs. `wake` settles only on a
   * snapshot (the hand-off can go now); a null or a failure is read at the
   * next poll, so a pass that ends at once never spins.
   */
  type BindPass = {
    abort: AbortController;
    /** The clone was done when the pass began, so its failure is the launch's (pairing then never ran beside the clone). */
    afterClone: boolean;
    outcome: { snapshot: ChatLaunchSnapshot | null } | { error: unknown } | null;
    done: Promise<void>;
    wake: Promise<void>;
  };

  const startBindPass = (record: CloudLaneLaunchRecord, current: () => CloudLaunchRecord, signal: AbortSignal): BindPass => {
    const abort = new AbortController();
    const stop = () => abort.abort();
    if (signal.aborted) abort.abort();
    else signal.addEventListener("abort", stop, { once: true });
    let wakeUp: () => void = () => undefined;
    const pass: BindPass = {
      abort,
      afterClone: isCloned(current()),
      outcome: null,
      done: Promise.resolve(),
      wake: new Promise<void>((resolve) => { wakeUp = resolve; }),
    };
    pass.done = bindToComputer(record, current, abort.signal)
      .then(
        (snapshot) => {
          pass.outcome = { snapshot };
          if (snapshot) wakeUp();
        },
        (error: unknown) => { pass.outcome = { error }; },
      )
      .finally(() => signal.removeEventListener("abort", stop));
    return pass;
  };

  /** Stops a pass and waits until nothing of it runs: a pairing in flight lands before a cancel's cleanup forgets it. */
  const stopBindPass = async (pass: BindPass): Promise<void> => {
    pass.abort.abort();
    await pass.done;
  };

  /**
   * The launch on the server until the computer's brain holds it: the
   * server's stages on the rows, then the computer in the account, paired,
   * its project found and the brain's launch read. Answers that snapshot
   * (the service adopts it as the hand-off). Safe to run again (Retry, ADE
   * opening after a quit): the same id answers the same launch.
   *
   * Pairing starts as soon as the computer joined, while it still clones, and
   * runs beside the poll, so the card shows the brain's rows meanwhile and the
   * hand-off comes when its launch is there, not 5-30 s after.
   */
  const runServerLaunch = async (record: CloudLaneLaunchRecord, signal: AbortSignal): Promise<ChatLaunchSnapshot> => {
    const launchId = record.snapshot.launchId;
    if (!stageOf(record, "computer")?.startedAt) setStage(record, "computer", "running", { detail: null });
    publish(record);
    await resolveTier(record);
    let server = await startOnServer(record, signal);
    await adoptServerSize(record, server);
    /** When the clone was done: the time to find the launch there counts from it, not from the join (a clone can take minutes). */
    let clonedAt: number | null = null;
    let lastProgress = Date.now();
    const current = () => server;
    let bind: BindPass | null = null;
    /** A finished pass: its snapshot, else null for another pass. A failure past the clone ends the launch, as it always did. */
    const takeBindPass = (): ChatLaunchSnapshot | null => {
      const pass = bind;
      if (!pass?.outcome) return null;
      bind = null;
      if ("snapshot" in pass.outcome) return pass.outcome.snapshot;
      const error = pass.outcome.error;
      if (pass.afterClone || error instanceof LaunchCancelled || error instanceof CloudCreateCancelled) throw error;
      // Its time ran beside the clone, which the computer still did: the next pass tries again.
      logger.info("cloud_lane_launch.bind_during_clone_failed", { launchId, error: getErrorMessage(error) });
      return null;
    };
    try {
      for (;;) {
        assertActive(record, signal);
        if (server.instanceId && record.snapshot.cloud.instanceId !== server.instanceId) {
          const earlier = record.snapshot.cloud.instanceId;
          if (earlier) {
            // A pass for the old computer stops before its facts are cleared.
            if (bind) await stopBindPass(bind);
            bind = null;
            // A Retry began again on a new computer (the server deleted the failed one): nothing of the old one is kept.
            try {
              deps.forgetMachineConnections?.({ machineKey: record.snapshot.cloud.machineKey, instanceId: earlier });
            } catch (error) {
              logger.warn("cloud_lane_launch.connection_left", { launchId, error: getErrorMessage(error) });
            }
            record.snapshot.cloud.machineKey = null;
            record.snapshot.cloud.binding = null;
            record.targetId = null;
            for (const id of ["join", "clone", ...BRAIN_STAGE_IDS] as const) setStage(record, id, "pending");
          }
          record.snapshot.cloud.instanceId = server.instanceId;
          deps.onComputerCreated?.();
          logger.info("cloud_lane_launch.computer_created", { launchId, instanceId: server.instanceId, tier: record.tier?.id ?? null });
          persist(record);
        }
        showServerRecord(record, server);
        if (server.state === "failed" && record.snapshot.cloud.instanceId && server.stages.some((stage) => stage.id === "agent" && stage.status !== "pending")) {
          // The computer's own launch failed after its agent began: that launch
          // is the one to hold, so Retry reaches the computer's retry instead
          // of a server that leaves a started launch as it is.
          if (bind) await bind.done;
          let snapshot: ChatLaunchSnapshot | null = null;
          try {
            snapshot = takeBindPass() ?? await bindToComputer(record, current, signal);
          } catch (error) {
            logger.info("cloud_lane_launch.failed_launch_bind_failed", { launchId, error: getErrorMessage(error) });
          }
          bind = null;
          assertActive(record, signal);
          if (snapshot) return snapshot;
        }
        if (server.state === "failed" || server.state === "cancelled") throw serverFailure(server);
        // A provider sign-in waits on a person: the time to find the launch starts again after it.
        if (server.state === "waiting_for_sign_in") clonedAt = null;
        const signedIn = server.state === "joined" || server.state === "running" || server.state === "done";
        if (signedIn && record.snapshot.cloud.instanceId) {
          if (isCloned(server)) clonedAt ??= Date.now();
          const snapshot = takeBindPass();
          if (snapshot) return snapshot;
          bind ??= startBindPass(record, current, signal);
          // Signed in, yet no project or launch shows up there: say so instead of waiting forever.
          if (clonedAt != null && Date.now() - clonedAt > SERVER_LAUNCH_BIND_WAIT_MS && server.state !== "joined") {
            throw new LaunchStepError("The new computer started the lane, but ADE can't find it there. Retry to look again.");
          }
        }
        const pause = sleep(Date.now() - lastProgress > 60_000 ? SERVER_LAUNCH_SLOW_POLL_MS : SERVER_LAUNCH_POLL_MS);
        // Waiting on the chat's provider sign-in: the card shows the server's link, so the hand-off
        // waits for it to end (a pass that found the launch already is taken after).
        const signingIn = server.state === "waiting_for_sign_in";
        await (bind && !signingIn ? Promise.race([pause, bind.wake]) : pause);
        assertActive(record, signal);
        const ready = signingIn ? null : takeBindPass();
        if (ready) return ready;
        const before = server.updatedAt;
        server = await launcher().launchStatus(launchId).catch((error: unknown) => {
          // A read that didn't land is read again; the server's own refusal ends the launch here.
          if (error instanceof CloudApiError && error.status === 404) throw new LaunchStepError("ADE Cloud no longer has this launch. Cancel it and send again.");
          logger.info("cloud_lane_launch.server_read_failed", { launchId, error: getErrorMessage(error) });
          return server;
        });
        if (server.updatedAt !== before) lastProgress = Date.now();
        await adoptServerSize(record, server);
      }
    } finally {
      // Nothing of a pass outlives the launch's run here (a cancel, a failure, the hand-off).
      if (bind) await stopBindPass(bind);
    }
  };

  /**
   * Once the computer signed in: its account row (named as the lane),
   * pairing (while the computer still clones), then, once the clone is done,
   * the project there and the brain's launch. Null while one isn't there
   * yet; each step is kept on the record, so the next pass goes on from it.
   */
  const bindToComputer = async (record: CloudLaneLaunchRecord, current: () => CloudLaunchRecord, signal: AbortSignal): Promise<ChatLaunchSnapshot | null> => {
    const launchId = record.snapshot.launchId;
    const instanceId = record.snapshot.cloud.instanceId!;
    if (!record.snapshot.cloud.machineKey) {
      const row = await waitForCloudAccountRow(deps.creator, { client: await providerClient(), instanceId, name: record.computerName, requestId: launchId, signal });
      assertActive(record, signal);
      if (!row.machineKey) return null;
      record.snapshot.cloud.machineKey = row.machineKey;
      persist(record);
    }
    if (!record.snapshot.cloud.binding) {
      const targetId = await pairAndConnect(record, record.snapshot.cloud.machineKey!, signal);
      persist(record);
      assertActive(record, signal);
      // The computer clones the repository itself; its project shows once the clone is done.
      while (!isCloned(current())) {
        await sleep(SERVER_LAUNCH_POLL_MS);
        assertActive(record, signal);
      }
      const identity = record.project.identity;
      const project = (await deps.listProjects(targetId)).find((entry: RemoteRuntimeProjectRecord) =>
        entry.exists !== false && normalizeGitRemoteIdentity(entry.gitOriginUrl) === identity) ?? null;
      if (!project) return null;
      assertActive(record, signal);
      record.snapshot.cloud.binding = await deps.resolveBinding(targetId, project.projectId, project.rootPath);
      persist(record);
    }
    const binding = record.snapshot.cloud.binding;
    if (!binding) return null;
    const brain = await deps.callChatAction(binding, "getLaunch", { args: { launchId } })
      .catch((error: unknown) => {
        logger.info("cloud_lane_launch.brain_launch_read_failed", { launchId, error: getErrorMessage(error) });
        return null;
      }) as ChatLaunchSnapshot | null;
    return brain?.launchId === launchId ? brain : null;
  };

  /**
   * The server's cancel: before the agent starts it deletes the computer.
   * `started`: the server refused, because the computer's agent already runs
   * (it can start before this app has paired and read it), so nothing here
   * may delete it. `unreached`: no answer, so nobody knows yet. Any other
   * answer (no launch there, or one it closed but couldn't delete yet) leaves
   * this app's own delete to follow.
   */
  const cancelOnServer = async (record: CloudLaneLaunchRecord): Promise<"cancelled" | "started" | "unreached"> => {
    try {
      await launcher().cancelLaunch(record.snapshot.launchId);
      return "cancelled";
    } catch (error) {
      logger.info("cloud_lane_launch.server_cancel_failed", { launchId: record.snapshot.launchId, error: getErrorMessage(error) });
      if (!(error instanceof CloudApiError) || error.status === 0) return "unreached";
      return error.status === 409 && error.code === "launch_started" ? "started" : "cancelled";
    }
  };

  /**
   * Deletes only computers made for this launch (its request id), then takes a
   * joined one off the account. `accountRowLeft`: every computer is gone but
   * its account row couldn't be removed; the machine key stays on the record
   * for the next cleanup.
   */
  const deleteOwnComputers = async (record: CloudLaneLaunchRecord): Promise<{ found: number; deleted: number; accountRowLeft: boolean }> => {
    const result = await deleteComputersForRequest({
      client: await providerClient(),
      requestId: record.snapshot.launchId,
      knownInstanceId: record.snapshot.cloud.instanceId,
      machineKey: record.snapshot.cloud.machineKey,
      reason: "lane_launch_cancelled",
      logger,
      sleep,
      removeAccountMachine: deps.removeAccountMachine,
      forgetMachineConnections: deps.forgetMachineConnections,
      logPrefix: "cloud_lane_launch",
      logFields: { launchId: record.snapshot.launchId },
    });
    if (result.deleted === result.found) {
      if (record.snapshot.cloud.machineKey && !result.accountRowLeft) record.snapshot.cloud.machineKey = null;
      if (result.connectionsForgotten) record.targetId = null;
    }
    return { found: result.found, deleted: result.deleted, accountRowLeft: result.accountRowLeft };
  };

  return { providerClient, runServerLaunch, cancelOnServer, deleteOwnComputers, refreshServerSize, computerWords };
}

export type CloudLaneComputerStages = ReturnType<typeof createCloudLaneComputerStages>;
