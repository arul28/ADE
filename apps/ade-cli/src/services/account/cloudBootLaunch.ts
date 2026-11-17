/**
 * A server launch, run by the new computer itself (C6, docs/plans/cloud-6/
 * c6-c8-launcher-spec.md). ADE's server made this computer for a caller with
 * no computer (the web, the phone, an automation) and put two values in its
 * env: the launch id and its join code. At brain start, with no account
 * session yet, this:
 *
 *   1. starts ADE's device sign-in (retried while the network comes up);
 *   2. joins: the server checks the code and answers a one-time sign-in link
 *      for the launch's account, which a headless Chromium here opens. When
 *      the page stops on something a person must confirm, it reports
 *      `needs_approval` and the caller shows one "Approve" tap. The whole
 *      wait stays inside the server's join window (`joinExpiresAt`); a brain
 *      that restarts inside it joins again with the same code. A join that
 *      lands while the server is still making this computer is asked again
 *      with a backoff (`join_not_ready`, up to 10 minutes);
 *   3. once signed in, reads the launch's facts, sets the repository up, and
 *      runs the launch through this brain's own launch pipeline
 *      (`chat.startLaunch`, parsed by `parseChatLaunchArgs` like every other
 *      entry) with the same launch id and lane id, so the lane is the same as
 *      one a desktop handed off;
 *   4. posts stage changes, one at a time and in order (a handful of writes
 *      per launch). The last one is retried with a backoff, and a later boot
 *      sends it when it still couldn't land.
 *
 * A chat whose provider isn't signed in here pauses before its start
 * (`waiting_for_sign_in`): this brain starts the provider's own sign-in for
 * a person on another screen (or names the key or ADE desktop step), reports
 * it, and goes on by itself once the provider can run. Messages the person
 * sent while the chat didn't exist are kept by the server; once the chat
 * started with the first one, each is claimed, sent once, and reported.
 *
 * Never a password and never a provider sign-in: the person's own account
 * approves the computer, and their providers come from the account vault.
 * The join code leaves this process's env as soon as it is read, so nothing
 * this brain starts inherits it. A state file lets a restart go on where the
 * last boot stopped.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  CloudLaunchRecord,
  CloudLaunchStage,
  CloudLaunchStagesUpdate,
  CloudRemoteSignInStatus,
  CloudServerLaunchRequest,
} from "../../../../account-directory/src/cloud/contract";
import {
  CLOUD_AUTOMATION_RUN_STAGE,
  CLOUD_LAUNCH_ENV,
  CLOUD_LAUNCH_MAX_STAGES,
} from "../../../../account-directory/src/cloud/contract";
import type { CloudProvider } from "../../../../desktop/src/main/services/adeCloud/cloudProvider";
import { parseChatLaunchArgs } from "../../../../desktop/src/main/services/chat/chatLaunchArgs";
import type { ChatLaunchService } from "../../../../desktop/src/main/services/chat/chatLaunchService";
import { CloudApiError, type CloudApiClient } from "../../../../desktop/src/shared/cloudApiClient";
import type {
  ChatLaunchArgs,
  ChatLaunchEvent,
  ChatLaunchLaneConfig,
  ChatLaunchPhase,
  ChatLaunchSnapshot,
} from "../../../../desktop/src/shared/types";
import { isUuid } from "../../../../desktop/src/shared/uuid";
import type { ProjectRegistry } from "../projects/projectRegistry";
import type { AccountAuthService } from "./accountAuthService";
import type { HeadlessApprovalResult } from "./cloudHeadlessApproval";
import { deliverQueuedMessagesWithRetry, isFinalRefusal } from "./cloudLaunchMessages";
import { SIGN_IN_STAGE, SIGN_IN_WAIT_MS, waitForProviderSignIn, type ProviderReady } from "./cloudLaunchSignInWait";

type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

export type CloudBootLaunchDeps = {
  launchId: string;
  joinCode: string | null;
  instanceId: string;
  stateFile: string;
  logger: Logger;
  /** The account server's typed client; its bearer is this brain's account token once signed in. */
  api: () => CloudApiClient | null;
  account: {
    isSignedIn: () => boolean;
    startDeviceLogin: () => Promise<{ sessionId: string; userCode: string; intervalSec: number; expiresAt: string }>;
    pollDeviceLogin: (sessionId: string) => Promise<{ status: "pending" | "slow_down" | "signed_in" | "expired" | "error"; intervalSec: number | null; message: string | null }>;
  };
  /** Opens the one-time link here; null when this computer has no headless browser. */
  approveHeadless: ((url: string, signal: AbortSignal) => Promise<HeadlessApprovalResult>) | null;
  /** Sets the GitHub repository up here with this computer's own Git sign-in. */
  setUpProject: (originUrl: string) => Promise<{ projectId: string; rootPath: string }>;
  /** This brain's own launch pipeline in that project. */
  launches: (projectId: string) => Promise<{
    start: (args: ChatLaunchArgs) => Promise<ChatLaunchSnapshot>;
    get: (launchId: string) => Promise<ChatLaunchSnapshot | null>;
    subscribe: (listener: (event: ChatLaunchEvent) => void) => () => void;
  }>;
  /** Signed in: let ADE Cloud sleep this computer when idle (its brain keeps it awake while it works), and name this machine on the computer (`ade_machine_key`). */
  afterJoin?: () => Promise<void>;
  /** Holds the computer awake from the join to the hand-off (nothing on its busy list sees them). */
  hold?: <T>(run: () => Promise<T>) => Promise<T>;
  /** Holds the computer awake for one named step, up to `ttlMs` (the provider sign-in wait outlasts `hold`'s limit). */
  holdFor?: <T>(reason: string, ttlMs: number, run: () => Promise<T>) => Promise<T>;
  /**
   * Resolves once the launch's chat ended its run (its turn finished, or it
   * stopped). For an automation's run (C9) the computer then reports the
   * `run` stage, and ADE Cloud saves its chats, pushes its work and frees it.
   */
  waitForChatEnd?: (projectId: string, sessionId: string) => Promise<{ ok: boolean; error?: string | null }>;
  /**
   * Whether the chat's provider can run here now: `missing` pauses the launch
   * for a sign-in; `unknown` goes on (the chat says so if it can't). Left
   * out, nothing pauses (`createProviderReady` builds it).
   */
  providerReady?: ProviderReady;
  /** The provider's own sign-in for a person on another screen (`ade providers sign-in --remote`). */
  remoteSignIn?: {
    start: (provider: string) => Promise<CloudRemoteSignInStatus>;
    status: (jobId: string) => Promise<CloudRemoteSignInStatus>;
  };
  /** Pulls the account vault now, so a key or a pass saved on another screen is read. */
  refreshVault?: () => Promise<void>;
  /** Sends one message to the launch's chat; `clientSendId` makes a retry a no-op. */
  sendChatMessage?: (projectId: string, sessionId: string, message: { text: string; clientSendId: string }) => Promise<void>;
  /**
   * Waits until the chat's running turn is over; false when it still runs at the
   * wait's limit. Claude takes a send during a turn and then fails that turn, so
   * a queued message goes only to an idle chat.
   */
  waitForChatIdle?: (projectId: string, sessionId: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
};

type BootState = {
  launchId: string;
  phase: "joining" | "handed_off" | "ended";
  projectId?: string | null;
  /** A setup failure's last report that never landed: a later boot sends it before anything else. */
  unsent?: CloudLaunchStagesUpdate | null;
  /**
   * The last report that landed, by its shape (phase, then each stage's id,
   * status and detail). A failed launch is followed across boots (a Retry on
   * this computer goes on after a restart its disk grow brings), and a boot
   * doesn't send the same failure again.
   */
  reported?: string | null;
  /** The chat whose queued messages aren't all sent yet: a later boot sends them. */
  messagesOwed?: { sessionId: string } | null;
};

/** A just-booted computer's device sign-in is tried this many times (each one retries the network itself). */
const JOIN_ATTEMPTS = 3;
/** A device sign-in a person still has to approve: asked again this often, each a fresh 10-minute code, never past the join window. */
const APPROVAL_ROUNDS = 6;
/** The file ids the server accepts (`launches.ts`): a file's name on disk starts with it. */
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The join's refusals a fresh device sign-in can get past (the code was given back, or the server was busy). */
const JOIN_RETRY_CODES: ReadonlySet<string> = new Set(["expired", "not_found", "already_used", "unavailable", "network", "timeout"]);
/** The server is still making this computer (its create answer was lost): asked again with a backoff, this long at most. */
const JOIN_NOT_READY_CODE = "join_not_ready";
const JOIN_NOT_READY_MAX_MS = 10 * 60_000;
const JOIN_NOT_READY_FIRST_DELAY_MS = 5_000;
const JOIN_NOT_READY_MAX_DELAY_MS = 60_000;
/** A device sign-in with less time left than this is replaced before it is named in a join. */
const LOGIN_MIN_LEFT_MS = 2 * 60_000;
/** The last stage report (`done` or `failed`) is sent this many times before a later boot is left to send it. */
const TERMINAL_REPORT_ATTEMPTS = 4;
const TERMINAL_REPORT_FIRST_DELAY_MS = 2_000;
/** The needs-approval report's refusals that end the wait: the join window closed, or the launch did. */
const JOIN_OVER_CODES: ReadonlySet<string> = new Set(["join_expired", "launch_closed", "join_refused"]);
const TERMINAL: ReadonlySet<ChatLaunchPhase> = new Set(["completed", "failed", "cancelled"]);
/** What the server records for the brain's own phase; every other phase is `running`. */
const REPORTED_STATE: Partial<Record<ChatLaunchPhase, NonNullable<CloudLaunchStagesUpdate["state"]>>> = {
  completed: "done",
  failed: "failed",
  // A person stopped it in this computer's own ADE: the caller shows it ended.
  cancelled: "failed",
};
const STOPPED_ON_COMPUTER = "The launch was stopped on the computer.";

/** Sends one stage report; true once it is settled (stored, or refused for good), false when it couldn't reach the server. */
export type ReportStages = (update: CloudLaunchStagesUpdate) => Promise<boolean>;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function readState(file: string, logger: Logger): BootState | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    // No file yet is a first boot.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("cloud_boot_launch.state_unreadable", { error: errorText(error) });
    return null;
  }
  try {
    const parsed = JSON.parse(text) as BootState;
    return parsed && typeof parsed.launchId === "string" ? parsed : null;
  } catch (error) {
    logger.warn("cloud_boot_launch.state_unreadable", { error: errorText(error) });
    return null;
  }
}

function writeState(file: string, state: BootState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

/** The two env values, taken out of this process's env so nothing it starts inherits the code. */
export function takeCloudLaunchEnv(env: NodeJS.ProcessEnv = process.env): { launchId: string; joinCode: string | null } | null {
  const launchId = env[CLOUD_LAUNCH_ENV.launchId]?.trim().toLowerCase() ?? "";
  const joinCode = env[CLOUD_LAUNCH_ENV.join]?.trim() || null;
  delete env[CLOUD_LAUNCH_ENV.join];
  delete env[CLOUD_LAUNCH_ENV.launchId];
  return isUuid(launchId) ? { launchId, joinCode } : null;
}

const doneStage = (id: string, detail: string | null = null): CloudLaunchStage => ({ id, status: "done", detail });

/** The brain's stage rows as the server keeps them. */
function stagesOf(snapshot: ChatLaunchSnapshot): CloudLaunchStage[] {
  return snapshot.stages.map((stage) => ({ id: stage.id, status: stage.status, detail: stage.detail, error: stage.error }));
}

/** A delivery round that couldn't reach the server is tried again this much later, at most this many times. */
const OWED_MESSAGE_ROUND_MS = 2 * 60_000;
const OWED_MESSAGE_ROUNDS = 15;

/**
 * What a report says, for "has it changed": the phase and each stage's id
 * and status, plus a running stage's detail (a disk grow says "growing it to
 * N GB" there, for the phone and MCP). Never progress: a detail changes only
 * when a stage's step does, a handful of writes per launch.
 */
function reportShapeOf(phase: ChatLaunchPhase, stages: CloudLaunchStage[]): string {
  return `${phase}|${stages.map((stage) => `${stage.id}:${stage.status}${stage.status === "running" ? `:${stage.detail ?? ""}` : ""}`).join(",")}`;
}

/**
 * The lane recipe: always from the pushed copy of its branch, as every ADE
 * Cloud lane starts. A name from the prompt (`autoName`) is renamed with the AI
 * name, the lane and its branch, as a lane on the person's own computer is.
 */
function laneConfigOf(request: CloudServerLaunchRequest): ChatLaunchLaneConfig {
  if (request.lane.existingBranch) return { mode: "existing", branchRef: request.lane.existingBranch };
  return {
    mode: "new",
    start: request.lane.from ? { from: "branch", branch: request.lane.from, on: "remote" } : { from: "default", on: "remote" },
    ...(request.lane.autoName === true ? { autoName: true } : {}),
  };
}

const safeFileName = (name: string): string => name.replace(/[/\\\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "file";

/**
 * The launch as `chat.startLaunch`'s raw payload, before `parseChatLaunchArgs`
 * checks it as it checks every other entry's. A launch from an ADE app
 * carries its own args (`request.launch`): they are the base, so its plan
 * mode, permission modes, lane template and the rest carry. The facts win
 * over them where both say something: the ids, names and kind, the lane's
 * start (always the pushed copy), the files this computer downloaded, and the
 * stages and clock of this launch.
 */
function launchPayloadOf(
  launchId: string,
  record: Pick<CloudLaunchRecord, "createdAt">,
  request: CloudServerLaunchRequest,
  attachments: Array<{ path: string; type: "image" | "file" }>,
  priorStages: CloudLaunchStage[],
): Record<string, unknown> {
  const chat = request.chat;
  const endedAt = new Date().toISOString();
  const base = request.launch && typeof request.launch === "object" ? request.launch : null;
  const baseChat = base?.chat && typeof base.chat === "object" ? base.chat as Record<string, unknown> : null;
  const baseMessage = baseChat?.message && typeof baseChat.message === "object" ? baseChat.message as Record<string, unknown> : null;
  const baseLane = base?.laneConfig && typeof base.laneConfig === "object" ? base.laneConfig as Record<string, unknown> : null;
  // Links need no download: they stay as the app sent them, after the files.
  const links = (list: unknown) => (Array.isArray(list) ? list : []).filter((entry) => entry && typeof entry === "object" && (entry as { type?: unknown }).type === "image-url");
  const facts = laneConfigOf(request);
  const laneConfig: Record<string, unknown> = baseLane
    ? {
        ...baseLane,
        mode: facts.mode,
        ...(facts.mode === "existing"
          ? { branchRef: facts.branchRef, start: null }
          : { start: { ...(baseLane.start && typeof baseLane.start === "object" ? baseLane.start : {}), ...facts.start } }),
        ...(facts.autoName ? { autoName: true } : { autoName: undefined }),
      }
    : facts;
  const chatPayload = chat
    ? {
        chat: {
          create: {
            ...(baseChat?.create && typeof baseChat.create === "object" ? baseChat.create as Record<string, unknown> : {}),
            provider: chat.provider,
            model: chat.modelId,
            modelId: chat.modelId,
            ...(chat.effort ? { reasoningEffort: chat.effort } : {}),
            permissionMode: chat.permissions,
            ...(chat.fast ? { fastMode: true } : {}),
          },
          message: {
            ...(baseMessage ?? {}),
            text: chat.prompt,
            attachments: [...attachments, ...links(baseMessage?.attachments)],
          },
        },
      }
    : {};
  return {
    ...(base ?? {}),
    // A CLI launch reaches the server as the lane, with `cli` kept in the app's own args.
    kind: request.kind === "lane" && base?.kind === "cli" ? "cli" : request.kind,
    mode: "background",
    launchId,
    // The server's launch start: the card's total counts making the computer, the join and the clone too.
    ...(Number.isFinite(record.createdAt) ? { setupStartedAt: new Date(record.createdAt).toISOString() } : {}),
    laneId: request.lane.id,
    laneName: request.lane.name,
    prompt: chat?.prompt ?? (typeof base?.prompt === "string" ? base.prompt : ""),
    attachments: [...attachments, ...links(base?.attachments)],
    laneConfig,
    ...(chat ? { provider: chat.provider, modelId: chat.modelId } : {}),
    ...chatPayload,
    // Never a target again: this computer is the launch's.
    cloud: null,
    priorStages: priorStages.map((stage) => ({ id: stage.id, status: "done", endedAt, detail: stage.detail ?? null })),
  };
}

export async function runCloudBootLaunch(deps: CloudBootLaunchDeps): Promise<void> {
  const { launchId, logger } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const state = readState(deps.stateFile, logger);
  const known = state?.launchId === launchId ? state : null;
  // Messages a chat was still owed when the last boot stopped go first.
  if (known?.messagesOwed && known.projectId) await deliverOwedMessages(deps, known.projectId, known.messagesOwed.sessionId, sleep);
  if (known?.phase === "ended") {
    // A setup failure whose report never landed: the caller (and an automation's run) still waits for it.
    if (known.unsent) {
      if (await reportFinal(stageReporter(deps), known.unsent, sleep)) {
        writeState(deps.stateFile, { launchId, phase: "ended", projectId: known.projectId ?? null });
        logger.info("cloud_boot_launch.final_report_resent", { launchId });
      } else {
        logger.warn("cloud_boot_launch.final_report_unsent", { launchId, phase: "resend" });
      }
      return;
    }
    // A restart after the hand-off: an automation's run may still owe its end.
    if (known.projectId) await reportAutomationRunEnd(deps, known.projectId);
    return;
  }
  const hold = deps.hold ?? (<T>(run: () => Promise<T>) => run());
  const report = stageReporter(deps);

  if (known?.phase === "handed_off" && known.projectId) {
    await follow(deps, known.projectId, report, known.reported ?? "");
    await reportAutomationRunEnd(deps, known.projectId);
    return;
  }

  await hold(async () => {
    // Before the join, so a restart mid-sign-in finds a launch in progress here.
    writeState(deps.stateFile, { launchId, phase: "joining" });
    if (!deps.account.isSignedIn()) {
      const joined = await join(deps, sleep);
      if (!joined) return;
    }
    await deps.afterJoin?.().catch((error: unknown) => {
      logger.warn("cloud_boot_launch.after_join_failed", { launchId, error: errorText(error) });
    });

    const api = deps.api();
    if (!api) {
      logger.warn("cloud_boot_launch.no_account_server", { launchId });
      return;
    }
    const record = await api.launchStatus(launchId);
    if (record.state === "cancelled" || record.state === "done" || !record.request) {
      writeState(deps.stateFile, { launchId, phase: "ended" });
      return;
    }
    const request = record.request;
    const computerStage = doneStage("computer");
    const joinStage = doneStage("join");
    const repository = request.project.origin.replace(/^github\.com\//, "");
    await report({ state: "joined", stages: [computerStage, joinStage, { id: "clone", status: "running", detail: repository }] });

    let project: { projectId: string; rootPath: string };
    try {
      project = await deps.setUpProject(`https://${request.project.origin}.git`);
    } catch (error) {
      const raw = errorText(error);
      const sentence = /repository not found|authentication failed|could not read username|permission denied|access denied|returned error: 40[34]/i.test(raw)
        ? "The new computer can't read this repository. Check that ADE Cloud can sign in to GitHub for it, then start again."
        : "ADE couldn't clone the repository on the new computer.";
      logger.warn("cloud_boot_launch.clone_failed", { launchId, error: raw });
      const update: CloudLaunchStagesUpdate = { state: "failed", stages: [computerStage, joinStage, { id: "clone", status: "failed", error: sentence }], error: sentence };
      const landed = await reportFinal(report, update, sleep);
      if (!landed) logger.warn("cloud_boot_launch.final_report_unsent", { launchId, phase: "clone_failed" });
      writeState(deps.stateFile, { launchId, phase: "ended", ...(landed ? {} : { unsent: update }) });
      return;
    }
    const cloneStage = doneStage("clone", repository);

    // Past the clone, anything that stops the hand-off is the launch's failure, reported as one.
    try {
      const attachments: Array<{ path: string; type: "image" | "file" }> = [];
      for (const file of request.chat?.attachments ?? []) {
        if (!FILE_ID.test(file.fileId)) throw new Error(`The launch names a file this computer can't keep ("${file.name}").`);
        const folder = path.join(project.rootPath, ".ade", "attachments", `launch-${launchId}`);
        fs.mkdirSync(folder, { recursive: true });
        const target = path.join(folder, `${file.fileId}-${safeFileName(file.name)}`);
        fs.writeFileSync(target, Buffer.from(await api.readLaunchFile(launchId, file.fileId)));
        attachments.push({ path: target, type: file.contentType.startsWith("image/") ? "image" : "file" });
      }
      // A chat whose provider isn't signed in here waits for the person's sign-in first.
      const startStages = [computerStage, joinStage, cloneStage];
      if (request.chat && deps.providerReady) {
        const provider = request.chat.provider;
        // The wait can outlast `hold`'s limit: its own hold keeps the computer awake through it.
        const holdFor = deps.holdFor ?? (<T>(_reason: string, _ttlMs: number, run: () => Promise<T>) => run());
        const waited = await holdFor("provider_sign_in", SIGN_IN_WAIT_MS + 10 * 60_000, () => waitForProviderSignIn(deps, provider, report, startStages, sleep));
        if (waited.kind === "cancelled") {
          writeState(deps.stateFile, { launchId, phase: "ended", projectId: project.projectId });
          return;
        }
        if (waited.kind === "failed") {
          // No `agent` row: nothing of the agent ran, so a cancel still deletes the computer.
          const update: CloudLaunchStagesUpdate = {
            state: "failed",
            stages: [...startStages, { id: SIGN_IN_STAGE, status: "failed", error: waited.error }],
            error: waited.error,
          };
          const landed = await reportFinal(report, update, sleep);
          if (!landed) logger.warn("cloud_boot_launch.final_report_unsent", { launchId, phase: "sign_in_failed" });
          writeState(deps.stateFile, { launchId, phase: "ended", projectId: project.projectId, ...(landed ? {} : { unsent: update }) });
          return;
        }
        if (waited.waited) startStages.push(doneStage(SIGN_IN_STAGE, request.chat.provider));
      }
      const args = parseChatLaunchArgs(launchPayloadOf(launchId, record, request, attachments, startStages));
      const launches = await deps.launches(project.projectId);
      await launches.start(args);
    } catch (error) {
      const raw = errorText(error);
      logger.warn("cloud_boot_launch.start_failed", { launchId, error: raw });
      // No `agent` row: nothing of the agent ran, so a cancel still deletes the computer.
      const sentence = `ADE couldn't start the lane on the new computer: ${raw}`.slice(0, 400);
      const update: CloudLaunchStagesUpdate = { state: "failed", stages: [computerStage, joinStage, cloneStage], error: sentence };
      const landed = await reportFinal(report, update, sleep);
      if (!landed) logger.warn("cloud_boot_launch.final_report_unsent", { launchId, phase: "start_failed" });
      writeState(deps.stateFile, { launchId, phase: "ended", projectId: project.projectId, ...(landed ? {} : { unsent: update }) });
      return;
    }
    writeState(deps.stateFile, { launchId, phase: "handed_off", projectId: project.projectId });
    logger.info("cloud_boot_launch.handed_off", { launchId, projectId: project.projectId });
  });

  const after = readState(deps.stateFile, logger);
  if (after?.launchId === launchId && after.phase === "handed_off" && after.projectId) {
    await follow(deps, after.projectId, report, after.reported ?? "");
    await reportAutomationRunEnd(deps, after.projectId);
  }
}

/** Sends one stage update; true when it landed, or the server refused it for good. */
function stageReporter(deps: CloudBootLaunchDeps): ReportStages {
  const { launchId, logger } = deps;
  return async (update) => {
    const api = deps.api();
    if (!api) {
      logger.warn("cloud_boot_launch.report_failed", { launchId, error: "no account server" });
      return false;
    }
    try {
      await api.reportLaunchStages(launchId, update);
      return true;
    } catch (error) {
      // The server's own no (a closed or finished launch) is final: sending it again changes nothing.
      const final = isFinalRefusal(error);
      logger.warn("cloud_boot_launch.report_failed", { launchId, final, error: errorText(error) });
      return final;
    }
  };
}

/**
 * An automation's run (C9): once its chat ends, the computer says so with the
 * `run` stage, one write. Nobody watches an automation's chat, so this is how
 * ADE Cloud knows to save its chats, push its work and free the computer.
 * Any other launch, or a run already reported, writes nothing.
 */
async function reportAutomationRunEnd(deps: CloudBootLaunchDeps, projectId: string): Promise<void> {
  const { launchId, logger } = deps;
  const api = deps.api();
  if (!api || !deps.waitForChatEnd) return;
  const record = await api.launchStatus(launchId).catch((error: unknown) => {
    // Unread, the run would hold its computer until the server's stop limit: say why.
    logger.warn("cloud_boot_launch.automation_run_status_failed", { launchId, error: errorText(error) });
    return null;
  });
  if (!record || record.request?.madeBy?.kind !== "automation" || record.state !== "done" || !record.sessionId) return;
  if (record.stages.some((stage) => stage.id === CLOUD_AUTOMATION_RUN_STAGE && (stage.status === "done" || stage.status === "failed"))) return;
  const end = await deps.waitForChatEnd(projectId, record.sessionId).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  const runStage: CloudLaunchStage = { id: CLOUD_AUTOMATION_RUN_STAGE, status: end.ok ? "done" : "failed", error: end.ok ? null : end.error ?? "The run's chat stopped with an error." };
  const stages = [...record.stages.filter((stage) => stage.id !== CLOUD_AUTOMATION_RUN_STAGE).slice(-(CLOUD_LAUNCH_MAX_STAGES - 1)), runStage];
  // The launch is `done`, and a `done` launch takes only `done` again (launches.ts `handleStages`).
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const landed = await reportFinal(stageReporter(deps), { state: "done", stages, ...(end.ok ? {} : { error: runStage.error }) }, sleep);
  if (landed) logger.info("cloud_boot_launch.automation_run_ended", { launchId, ok: end.ok });
  else logger.warn("cloud_boot_launch.automation_run_end_report_failed", { launchId });
}

/**
 * Signs this computer in with its join code. True once signed in; false
 * when it can't (a code that isn't valid any more, the join window closed,
 * or no account server).
 */
async function join(deps: CloudBootLaunchDeps, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const { launchId, instanceId, logger } = deps;
  const api = deps.api();
  const joinCode = deps.joinCode;
  if (!api || !joinCode) {
    logger.warn("cloud_boot_launch.cannot_join", { launchId, hasCode: Boolean(joinCode) });
    return false;
  }
  // The server's join window; unknown until its first answer.
  let joinEnds = Number.POSITIVE_INFINITY;
  const windowOpen = () => Date.now() < joinEnds;
  // Kept across a `join_not_ready` wait while it has time left, so the wait doesn't start a sign-in per ask.
  let pending: Awaited<ReturnType<CloudBootLaunchDeps["account"]["startDeviceLogin"]>> | null = null;
  let notReadySince: number | null = null;
  let notReadyDelay = JOIN_NOT_READY_FIRST_DELAY_MS;
  for (let attempt = 1; attempt <= JOIN_ATTEMPTS && windowOpen(); attempt += 1) {
    let login: Awaited<ReturnType<CloudBootLaunchDeps["account"]["startDeviceLogin"]>>;
    let url: string;
    try {
      login = pending && Date.parse(pending.expiresAt) - Date.now() > LOGIN_MIN_LEFT_MS ? pending : await deps.account.startDeviceLogin();
      pending = login;
      const answer = await api.joinLaunch(launchId, instanceId, { nonce: joinCode, userCode: login.userCode });
      if (typeof answer.joinExpiresAt === "number") joinEnds = answer.joinExpiresAt;
      if (!("url" in answer)) throw new Error("The account server answered the join without a link.");
      url = answer.url;
    } catch (error) {
      const code = error instanceof CloudApiError ? error.code : "unknown";
      if (code === JOIN_NOT_READY_CODE) {
        // The server is still making this computer: not a failed attempt, asked again with a backoff, for a bounded time.
        notReadySince ??= Date.now();
        if (Date.now() - notReadySince < JOIN_NOT_READY_MAX_MS) {
          logger.info("cloud_boot_launch.join_not_ready", { launchId, waitMs: notReadyDelay });
          await sleep(notReadyDelay);
          notReadyDelay = Math.min(notReadyDelay * 2, JOIN_NOT_READY_MAX_DELAY_MS);
          attempt -= 1;
          continue;
        }
        logger.warn("cloud_boot_launch.join_never_ready", { launchId, waitedMs: Date.now() - notReadySince });
        return false;
      }
      logger.warn("cloud_boot_launch.join_refused", { launchId, attempt, code, error: errorText(error) });
      // A refused join gets a fresh device sign-in next time (its code may have been given back or spent).
      pending = null;
      // A network still coming up (`unknown`: the device sign-in itself), or a link that couldn't be minted.
      if (code === "unknown" || JOIN_RETRY_CODES.has(code)) {
        await sleep(3_000);
        continue;
      }
      return false;
    }
    pending = null;
    const controller = new AbortController();
    const opened: HeadlessApprovalResult = deps.approveHeadless
      ? await deps.approveHeadless(url, controller.signal).catch((error: unknown) => {
          logger.warn("cloud_boot_launch.headless_approval_failed", { launchId, error: errorText(error) });
          return "closed" as const;
        })
      : "closed";
    logger.info("cloud_boot_launch.headless_approval", { launchId, result: opened });
    if (opened === "signed_in" && await waitSignedIn(deps, login, joinEnds, sleep)) return true;
    // A person has to confirm: one tap in their own browser, a fresh code each 10 minutes, inside the join window.
    let current = login;
    for (let round = 0; round < APPROVAL_ROUNDS && windowOpen(); round += 1) {
      try {
        const answer = await api.joinLaunch(launchId, instanceId, { nonce: joinCode, needsApproval: true, ...(round ? { userCode: current.userCode } : {}) });
        if (typeof answer.joinExpiresAt === "number") joinEnds = answer.joinExpiresAt;
      } catch (error) {
        const code = error instanceof CloudApiError ? error.code : "unknown";
        logger.warn("cloud_boot_launch.needs_approval_failed", { launchId, code, error: errorText(error) });
        if (JOIN_OVER_CODES.has(code)) return deps.account.isSignedIn();
      }
      if (await waitSignedIn(deps, current, joinEnds, sleep)) return true;
      if (deps.account.isSignedIn()) return true;
      if (!windowOpen()) break;
      try {
        current = await deps.account.startDeviceLogin();
      } catch (error) {
        logger.warn("cloud_boot_launch.device_login_failed", { launchId, error: errorText(error) });
        await sleep(3_000);
      }
    }
    return deps.account.isSignedIn();
  }
  if (!windowOpen()) logger.warn("cloud_boot_launch.join_window_closed", { launchId });
  return deps.account.isSignedIn();
}

/** Polls one device sign-in until it ends or the join window closes; true when this computer is signed in. */
async function waitSignedIn(
  deps: CloudBootLaunchDeps,
  login: { sessionId: string; intervalSec: number; expiresAt: string },
  joinEnds: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  let interval = Math.max(2, login.intervalSec);
  const until = Math.min(Date.parse(login.expiresAt) || Date.now() + 10 * 60_000, joinEnds);
  while (Date.now() < until) {
    await sleep(interval * 1_000);
    let polled: Awaited<ReturnType<CloudBootLaunchDeps["account"]["pollDeviceLogin"]>>;
    try {
      polled = await deps.account.pollDeviceLogin(login.sessionId);
    } catch (error) {
      deps.logger.warn("cloud_boot_launch.poll_failed", { launchId: deps.launchId, error: errorText(error) });
      continue;
    }
    if (polled.status === "signed_in") return true;
    if (polled.status === "expired" || polled.status === "error") return deps.account.isSignedIn();
    if (polled.intervalSec) interval = Math.max(2, polled.intervalSec);
  }
  return deps.account.isSignedIn();
}

/**
 * A launch's last report (`done` or `failed`): nothing else writes the launch
 * after it, so a blip is retried with a backoff. True once it settled.
 */
async function reportFinal(report: ReportStages, update: CloudLaunchStagesUpdate, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  let delay = TERMINAL_REPORT_FIRST_DELAY_MS;
  for (let attempt = 1; attempt <= TERMINAL_REPORT_ATTEMPTS; attempt += 1) {
    if (await report(update)) return true;
    if (attempt < TERMINAL_REPORT_ATTEMPTS) {
      await sleep(delay);
      delay *= 2;
    }
  }
  return false;
}

/**
 * Sends a chat's queued messages, tried again with a backoff; once all are
 * sent, the state file stops naming them. True when nothing is left.
 */
async function deliverOwedMessages(deps: CloudBootLaunchDeps, projectId: string, sessionId: string, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const done = await deliverQueuedMessagesWithRetry(deps, projectId, sessionId, sleep).catch((error: unknown) => {
    deps.logger.warn("cloud_boot_launch.messages_failed", { launchId: deps.launchId, error: errorText(error) });
    return false;
  });
  if (!done) return false;
  const current = readState(deps.stateFile, deps.logger);
  if (current?.launchId === deps.launchId && current.messagesOwed) {
    const { messagesOwed: _sent, ...rest } = current;
    writeState(deps.stateFile, rest);
  }
  return true;
}

/**
 * Reports the brain's own launch until it ends: a write when a stage's status
 * (or a running stage's detail) changes or the launch ends, never on a timer,
 * one after another so a later write never lands before an earlier one. A
 * failed launch is followed on, here and after a restart (opening its
 * project at boot): a Retry on this computer, and the restart a disk grow
 * brings it, go on and are reported with nobody watching.
 */
async function follow(
  deps: CloudBootLaunchDeps,
  projectId: string,
  report: ReportStages,
  reported: string,
): Promise<void> {
  const { launchId, logger } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const launches = await deps.launches(projectId);
  let last = reported;
  // A failure's shape is saved so a restart doesn't report it twice; once a Retry reports a
  // new attempt it's cleared, or a restart that fails the same step again would match it
  // (the shape leaves out errors and times) and never be reported.
  let savedFailure = reported !== "";
  // The person's queued messages go once the server knows the chat (it then takes no more of them).
  // Until all are sent the state file names the chat, so a restart sends the rest.
  let owed = readState(deps.stateFile, logger)?.messagesOwed ?? null;
  const save = (state: BootState) => writeState(deps.stateFile, owed ? { ...state, messagesOwed: owed } : state);
  let delivery: Promise<void> | null = null;
  let messagesSent = false;
  let deliveryRounds = 0;
  const sendQueued = (snapshot: ChatLaunchSnapshot): void => {
    // Only once the launch is done: the chat exists and has its opening message, so a queued one
    // can't go first (or meet the opening turn still starting).
    if (messagesSent || delivery || !snapshot.sessionId || !snapshot.sessionCreated || snapshot.phase !== "completed") return;
    const sessionId = snapshot.sessionId;
    owed = { sessionId };
    const current = readState(deps.stateFile, logger);
    if (current?.launchId === launchId) save(current);
    delivery = deliverOwedMessages(deps, projectId, sessionId, sleep).then((done) => {
      delivery = null;
      if (done) {
        owed = null;
        messagesSent = true;
        return;
      }
      // Not all sent: tried again here a while later (also after the launch ended, so a
      // server that was down doesn't need another event), a few times; a later boot tries too.
      if (deliveryRounds >= OWED_MESSAGE_ROUNDS) return;
      deliveryRounds += 1;
      const timer = setTimeout(() => sendQueued(snapshot), OWED_MESSAGE_ROUND_MS);
      timer.unref?.();
    });
  };
  const send = async (snapshot: ChatLaunchSnapshot): Promise<boolean> => {
    const stages = stagesOf(snapshot);
    const terminal = TERMINAL.has(snapshot.phase);
    // The chat's creation is part of the shape, so the report that names the chat goes even with no stage change.
    const shape = `${reportShapeOf(snapshot.phase, stages)}${snapshot.sessionCreated ? "|chat" : ""}`;
    if (shape === last) return terminal;
    last = shape;
    const error = snapshot.phase === "cancelled" ? STOPPED_ON_COMPUTER : snapshot.phase === "failed" ? snapshot.error : null;
    const update: CloudLaunchStagesUpdate = {
      state: REPORTED_STATE[snapshot.phase] ?? "running",
      stages,
      // Named only once the chat exists: the server then marks the first message sent and takes no more.
      ...(snapshot.sessionCreated && snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
      ...(error ? { error } : {}),
    };
    if (!terminal) {
      if (await report(update)) sendQueued(snapshot);
      if (savedFailure) {
        save({ launchId, phase: "handed_off", projectId });
        savedFailure = false;
      }
      return false;
    }
    if (await reportFinal(report, update, sleep)) {
      sendQueued(snapshot);
      // Failed: followed on after a restart too, for a Retry (one launch's state file, one write).
      save(snapshot.phase === "failed"
        ? { launchId, phase: "handed_off", projectId, reported: shape }
        : { launchId, phase: "ended", projectId });
      savedFailure = snapshot.phase === "failed";
      return true;
    }
    // Still unsent: the state stays `handed_off`, so the next boot follows the
    // launch again and sends it (and a later change here sends it too).
    last = "";
    logger.warn("cloud_boot_launch.final_report_unsent", { launchId, phase: snapshot.phase });
    save({ launchId, phase: "handed_off", projectId });
    savedFailure = false;
    return true;
  };
  await new Promise<void>((resolve) => {
    let ended = false;
    let unsubscribe: (() => void) | null = null;
    let queue: Promise<void> = Promise.resolve();
    const end = () => {
      if (ended) return;
      ended = true;
      unsubscribe?.();
      // Queued messages on their way finish first (the state file still names any left).
      void Promise.resolve(delivery).then(() => resolve());
    };
    /** The launch is gone here (removed, or expired after it failed): nothing more to follow at a later boot. */
    const gone = () => {
      if (ended) return;
      queue = queue.then(() => {
        const current = readState(deps.stateFile, logger);
        if (current?.launchId === launchId && current.phase === "handed_off" && !current.unsent) {
          save({ launchId, phase: "ended", projectId });
        }
      }).catch((error: unknown) => logger.warn("cloud_boot_launch.state_write_failed", { launchId, error: errorText(error) }));
      void queue.then(end);
    };
    // A failed launch waits for a retry on this computer; it is reported once and followed on.
    const onSnapshot = (snapshot: ChatLaunchSnapshot) => {
      queue = queue.then(() => send(snapshot)).then(
        (terminal) => {
          if (terminal && snapshot.phase !== "failed") end();
        },
        (error: unknown) => logger.warn("cloud_boot_launch.follow_report_failed", { launchId, error: errorText(error) }),
      );
    };
    unsubscribe = launches.subscribe((event) => {
      if (event.type === "launch-updated" && event.launch.launchId === launchId) onSnapshot(event.launch);
      if (event.type === "launch-removed" && event.launchId === launchId) gone();
    });
    launches.get(launchId).then(
      (snapshot) => {
        if (snapshot) onSnapshot(snapshot);
        else gone();
      },
      (error: unknown) => {
        logger.warn("cloud_boot_launch.follow_read_failed", { launchId, error: errorText(error) });
        end();
      },
    );
  });
}

type HoldCloudWork = <T>(reason: string, ttlMs: number, run: () => Promise<T>) => Promise<T>;

/** What the brain hands a server launch at start (`runServe`). */
export type CloudBootLaunchHost = {
  cloudInstanceId: string;
  /** `$ADE_HOME` and its secrets folder. */
  adeDir: string;
  secretsDir: string;
  logger: Logger;
  account: AccountAuthService;
  directoryBaseUrl: () => string | null;
  /** The Clerk issuer this machine signs in with (`CLERK_ISSUER`); its join link must be on its hosts. */
  clerkIssuer: () => string;
  projectRegistry: ProjectRegistry;
  /** The launch pipeline of one project's runtime, once its scope is open. */
  chatLaunchService: (projectId: string) => Promise<Pick<ChatLaunchService, "start" | "get" | "subscribe"> | null | undefined>;
  /** This brain's ADE Cloud client (`cloudBrainAccess`). */
  cloudClient: () => Promise<CloudProvider | null>;
  holdCloudWork: HoldCloudWork | null;
  /** An automation's run (C9): resolves when the run's chat ends (`CloudBootLaunchDeps.waitForChatEnd`). */
  waitForChatEnd?: CloudBootLaunchDeps["waitForChatEnd"];
  /** A chat whose provider isn't signed in waits for the person's sign-in (`CloudBootLaunchDeps`). */
  providerReady?: CloudBootLaunchDeps["providerReady"];
  remoteSignIn?: CloudBootLaunchDeps["remoteSignIn"];
  refreshVault?: CloudBootLaunchDeps["refreshVault"];
  /** The person's queued messages reach the chat through it. */
  sendChatMessage?: CloudBootLaunchDeps["sendChatMessage"];
  waitForChatIdle?: CloudBootLaunchDeps["waitForChatIdle"];
};

/**
 * Reads this machine's key from the relay identity file, or "" while there is
 * none yet. Read by hand on purpose, not through `createSyncCloudRelayStore`:
 * the store mints a key on its first read when the file is missing, and this
 * poll must only ever see the key the signed-in brain registers. The same
 * read as the desktop's join over exec (`cloudMachineCreator.ts`).
 */
function readRelayMachineKey(secretsDir: string, logger: Logger): string {
  let text: string;
  try {
    text = fs.readFileSync(path.join(secretsDir, "sync-cloud-relay.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") logger.warn("cloud_boot_launch.machine_key_unreadable", { error: errorText(error) });
    return "";
  }
  try {
    const relay = JSON.parse(text) as { machineKey?: unknown; config?: { machineKey?: unknown } };
    const value = relay.config?.machineKey ?? relay.machineKey;
    return typeof value === "string" ? value.trim() : "";
  } catch (error) {
    // Mid-write: the next read gets it.
    logger.warn("cloud_boot_launch.machine_key_unreadable", { error: errorText(error) });
    return "";
  }
}

/**
 * A server launch on this cloud computer (C6): the launch the server named in
 * this computer's env, wired to the brain's own services. Runs in the
 * background; nothing awaits it, and a failure is logged.
 */
export function startCloudBootLaunch(launchEnv: { launchId: string; joinCode: string | null }, host: CloudBootLaunchHost): void {
  const { logger } = host;
  void (async () => {
    const [{ createCloudApiClient }, headless, { setUpRepositoryOnThisMachine }, { enableCloudSleep }, { recordCloudMachineKey }] = await Promise.all([
      import("../../../../desktop/src/shared/cloudApiClient"),
      import("./cloudHeadlessApproval"),
      import("../../multiProjectRpcServer"),
      import("../../../../desktop/src/main/services/adeCloud/cloudSleep"),
      import("../../../../desktop/src/main/services/adeCloud/cloudMachines"),
    ]);
    const chromium = headless.findHeadlessChromium();
    const { account, cloudInstanceId } = host;
    await runCloudBootLaunch({
      launchId: launchEnv.launchId,
      joinCode: launchEnv.joinCode,
      instanceId: cloudInstanceId,
      stateFile: path.join(host.adeDir, "cloud", "boot-launch.json"),
      logger,
      api: () => {
        const base = host.directoryBaseUrl();
        return base
          ? createCloudApiClient({
              baseUrl: base,
              accessToken: async () => {
                if (!account.getStatus().signedIn) return null;
                return await account.getAccessToken().catch((error: unknown) => {
                  logger.warn("cloud_boot_launch.token_failed", { error: errorText(error) });
                  return null;
                });
              },
            })
          : null;
      },
      account: {
        isSignedIn: () => account.getStatus().signedIn,
        // A computer that just booted can start its sign-in before its network is up.
        startDeviceLogin: () => account.startDeviceLogin({ retryUnreachableForMs: 60_000 }),
        pollDeviceLogin: (sessionId) => account.pollDeviceLogin(sessionId),
      },
      approveHeadless: (url, signal) => headless.approveSignInLink({
        url,
        signal,
        binary: chromium,
        trust: () => ({ clerkIssuer: host.clerkIssuer(), directoryBaseUrl: host.directoryBaseUrl() }),
        logger,
      }),
      setUpProject: async (originUrl) => await setUpRepositoryOnThisMachine(host.projectRegistry, originUrl, host.holdCloudWork),
      waitForChatEnd: host.waitForChatEnd,
      providerReady: host.providerReady,
      remoteSignIn: host.remoteSignIn,
      refreshVault: host.refreshVault,
      sendChatMessage: host.sendChatMessage,
      waitForChatIdle: host.waitForChatIdle,
      launches: async (projectId) => {
        const service = await host.chatLaunchService(projectId);
        if (!service) throw new Error("This ADE runtime can't run a lane launch.");
        return {
          start: (args) => service.start(args),
          get: async (launchId) => service.get({ launchId }),
          subscribe: (listener) => service.subscribe(listener),
        };
      },
      afterJoin: async () => {
        const client = await host.cloudClient();
        if (!client) return;
        await enableCloudSleep(client, cloudInstanceId, { logger });
        // Written once the signed-in brain registers, so it is read for up to a minute,
        // off the launch's path: the clone and the agent don't wait on it.
        void (async () => {
          let machineKey = readRelayMachineKey(host.secretsDir, logger);
          for (let tries = 0; !machineKey && tries < 20; tries += 1) {
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            machineKey = readRelayMachineKey(host.secretsDir, logger);
          }
          if (machineKey) await recordCloudMachineKey(client, cloudInstanceId, machineKey, logger);
          else logger.warn("cloud_boot_launch.machine_key_missing", { launchId: launchEnv.launchId });
        })().catch((error: unknown) => {
          logger.warn("cloud_boot_launch.machine_key_record_failed", { error: errorText(error) });
        });
      },
      hold: host.holdCloudWork ? (run) => host.holdCloudWork!("lane_launch", 30 * 60_000, run) : undefined,
      holdFor: host.holdCloudWork ?? undefined,
    });
  })().catch((error: unknown) => {
    logger.warn("cloud_boot_launch.failed", { error: errorText(error) });
  });
}
