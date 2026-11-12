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
  CloudServerLaunchRequest,
} from "../../../../account-directory/src/cloud/contract";
import { CLOUD_AUTOMATION_RUN_STAGE, CLOUD_LAUNCH_ENV, CLOUD_LAUNCH_MAX_STAGES } from "../../../../account-directory/src/cloud/contract";
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
  /**
   * Resolves once the launch's chat ended its run (its turn finished, or it
   * stopped). For an automation's run (C9) the computer then reports the
   * `run` stage, and ADE Cloud saves its chats, pushes its work and frees it.
   */
  waitForChatEnd?: (projectId: string, sessionId: string) => Promise<{ ok: boolean; error?: string | null }>;
  sleep?: (ms: number) => Promise<void>;
};

type BootState = { launchId: string; phase: "joining" | "handed_off" | "ended"; projectId?: string | null };

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
/** The 4xx answers a stage report is sent again after (a token on its way, a timeout, a busy server). */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([401, 408, 429]);

/** Sends one stage report; true once it is settled (stored, or refused for good), false when it couldn't reach the server. */
type ReportStages = (update: CloudLaunchStagesUpdate) => Promise<boolean>;

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

/** The lane recipe: always from the pushed copy of its branch, as every ADE Cloud lane starts. */
function laneConfigOf(request: CloudServerLaunchRequest): ChatLaunchLaneConfig {
  if (request.lane.existingBranch) return { mode: "existing", branchRef: request.lane.existingBranch };
  return {
    mode: "new",
    start: request.lane.from ? { from: "branch", branch: request.lane.from, on: "remote" } : { from: "default", on: "remote" },
  };
}

const safeFileName = (name: string): string => name.replace(/[/\\\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "file";

/**
 * The launch as `chat.startLaunch`'s raw payload, before `parseChatLaunchArgs`
 * checks it as it checks every other entry's.
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
  return {
    kind: request.kind,
    mode: "background",
    launchId,
    // The server's launch start: the card's total counts making the computer, the join and the clone too.
    ...(Number.isFinite(record.createdAt) ? { setupStartedAt: new Date(record.createdAt).toISOString() } : {}),
    laneId: request.lane.id,
    laneName: request.lane.name,
    prompt: chat?.prompt ?? "",
    laneConfig: laneConfigOf(request),
    ...(chat ? {
      provider: chat.provider,
      modelId: chat.modelId,
      chat: {
        create: {
          provider: chat.provider,
          model: chat.modelId,
          modelId: chat.modelId,
          ...(chat.effort ? { reasoningEffort: chat.effort } : {}),
          permissionMode: chat.permissions,
          ...(chat.fast ? { fastMode: true } : {}),
        },
        message: { text: chat.prompt, ...(attachments.length ? { attachments } : {}) },
      },
    } : {}),
    priorStages: priorStages.map((stage) => ({ id: stage.id, status: "done", endedAt, detail: stage.detail ?? null })),
  };
}

export async function runCloudBootLaunch(deps: CloudBootLaunchDeps): Promise<void> {
  const { launchId, logger } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const state = readState(deps.stateFile, logger);
  const known = state?.launchId === launchId ? state : null;
  if (known?.phase === "ended") {
    // A restart after the hand-off: an automation's run may still owe its end.
    if (known.projectId) await reportAutomationRunEnd(deps, known.projectId);
    return;
  }
  const hold = deps.hold ?? (<T>(run: () => Promise<T>) => run());

  const report: ReportStages = async (update) => {
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
      const final = error instanceof CloudApiError && error.status >= 400 && error.status < 500 && !RETRYABLE_STATUSES.has(error.status);
      logger.warn("cloud_boot_launch.report_failed", { launchId, final, error: errorText(error) });
      return final;
    }
  };

  if (known?.phase === "handed_off" && known.projectId) {
    await follow(deps, known.projectId, report);
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
      if (!await reportFinal(report, { state: "failed", stages: [computerStage, joinStage, { id: "clone", status: "failed", error: sentence }], error: sentence }, sleep)) {
        logger.warn("cloud_boot_launch.final_report_unsent", { launchId, phase: "clone_failed" });
      }
      writeState(deps.stateFile, { launchId, phase: "ended" });
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
      const args = parseChatLaunchArgs(launchPayloadOf(launchId, record, request, attachments, [computerStage, joinStage, cloneStage]));
      const launches = await deps.launches(project.projectId);
      await launches.start(args);
    } catch (error) {
      const raw = errorText(error);
      logger.warn("cloud_boot_launch.start_failed", { launchId, error: raw });
      // No `agent` row: nothing of the agent ran, so a cancel still deletes the computer.
      const sentence = `ADE couldn't start the lane on the new computer: ${raw}`.slice(0, 400);
      if (!await reportFinal(report, { state: "failed", stages: [computerStage, joinStage, cloneStage], error: sentence }, sleep)) {
        logger.warn("cloud_boot_launch.final_report_unsent", { launchId, phase: "start_failed" });
      }
      writeState(deps.stateFile, { launchId, phase: "ended", projectId: project.projectId });
      return;
    }
    writeState(deps.stateFile, { launchId, phase: "handed_off", projectId: project.projectId });
    logger.info("cloud_boot_launch.handed_off", { launchId, projectId: project.projectId });
  });

  const after = readState(deps.stateFile, logger);
  if (after?.launchId === launchId && after.phase === "handed_off" && after.projectId) {
    await follow(deps, after.projectId, report);
    await reportAutomationRunEnd(deps, after.projectId);
  }
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
  const record = await api.launchStatus(launchId).catch(() => null);
  if (!record || record.request?.madeBy?.kind !== "automation" || record.state !== "done" || !record.sessionId) return;
  if (record.stages.some((stage) => stage.id === CLOUD_AUTOMATION_RUN_STAGE && (stage.status === "done" || stage.status === "failed"))) return;
  const end = await deps.waitForChatEnd(projectId, record.sessionId).catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  const runStage: CloudLaunchStage = { id: CLOUD_AUTOMATION_RUN_STAGE, status: end.ok ? "done" : "failed", error: end.ok ? null : end.error ?? "The run's chat stopped with an error." };
  const stages = [...record.stages.filter((stage) => stage.id !== CLOUD_AUTOMATION_RUN_STAGE).slice(-(CLOUD_LAUNCH_MAX_STAGES - 1)), runStage];
  try {
    await api.reportLaunchStages(launchId, { stages, ...(end.ok ? {} : { error: runStage.error }) });
    logger.info("cloud_boot_launch.automation_run_ended", { launchId, ok: end.ok });
  } catch (error) {
    logger.warn("cloud_boot_launch.automation_run_end_report_failed", { launchId, error: error instanceof Error ? error.message : String(error) });
  }
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
 * Reports the brain's own launch until it ends: a write when a stage's status
 * changes or the launch ends, never on a timer, one after another so a later
 * write never lands before an earlier one.
 */
async function follow(
  deps: CloudBootLaunchDeps,
  projectId: string,
  report: ReportStages,
): Promise<void> {
  const { launchId, logger } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const launches = await deps.launches(projectId);
  let last = "";
  const send = async (snapshot: ChatLaunchSnapshot): Promise<boolean> => {
    const stages = stagesOf(snapshot);
    const terminal = TERMINAL.has(snapshot.phase);
    const shape = `${snapshot.phase}|${stages.map((stage) => `${stage.id}:${stage.status}`).join(",")}`;
    if (shape === last) return terminal;
    last = shape;
    const error = snapshot.phase === "cancelled" ? STOPPED_ON_COMPUTER : snapshot.phase === "failed" ? snapshot.error : null;
    const update: CloudLaunchStagesUpdate = {
      state: REPORTED_STATE[snapshot.phase] ?? "running",
      stages,
      sessionId: snapshot.sessionId,
      ...(error ? { error } : {}),
    };
    if (!terminal) {
      await report(update);
      return false;
    }
    if (await reportFinal(report, update, sleep)) {
      writeState(deps.stateFile, { launchId, phase: "ended", projectId });
      return true;
    }
    // Still unsent: the state stays `handed_off`, so the next boot follows the
    // launch again and sends it (and a later change here sends it too).
    last = "";
    logger.warn("cloud_boot_launch.final_report_unsent", { launchId, phase: snapshot.phase });
    writeState(deps.stateFile, { launchId, phase: "handed_off", projectId });
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
      resolve();
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
      if (event.type === "launch-removed" && event.launchId === launchId) end();
    });
    launches.get(launchId).then(
      (snapshot) => {
        if (snapshot) onSnapshot(snapshot);
        else end();
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
  projectRegistry: ProjectRegistry;
  /** The launch pipeline of one project's runtime, once its scope is open. */
  chatLaunchService: (projectId: string) => Promise<Pick<ChatLaunchService, "start" | "get" | "subscribe"> | null | undefined>;
  /** This brain's ADE Cloud client (`cloudBrainAccess`). */
  cloudClient: () => Promise<CloudProvider | null>;
  holdCloudWork: HoldCloudWork | null;
  /** An automation's run (C9): resolves when the run's chat ends (`CloudBootLaunchDeps.waitForChatEnd`). */
  waitForChatEnd?: CloudBootLaunchDeps["waitForChatEnd"];
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
      approveHeadless: chromium
        ? (url, signal) => headless.approveInHeadlessChromium({ url, signal, binary: chromium, logger })
        : null,
      setUpProject: async (originUrl) => await setUpRepositoryOnThisMachine(host.projectRegistry, originUrl, host.holdCloudWork),
      waitForChatEnd: host.waitForChatEnd,
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
    });
  })().catch((error: unknown) => {
    logger.warn("cloud_boot_launch.failed", { error: errorText(error) });
  });
}
