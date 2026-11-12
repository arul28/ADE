/**
 * A server launch, run by the new computer itself (C6, docs/plans/cloud-6/
 * c6-c8-launcher-spec.md). ADE's server made this computer for a caller with
 * no computer (the web, the phone, an automation) and put two values in its
 * env: the launch id and a one-time join code. At brain start, with no account
 * session yet, this:
 *
 *   1. starts ADE's device sign-in (retried while the network comes up);
 *   2. joins: the server checks the code and answers a one-time sign-in link
 *      for the launch's account, which a headless Chromium here opens. When
 *      the page stops on something a person must confirm, it reports
 *      `needs_approval` and the caller shows one "Approve" tap;
 *   3. once signed in, reads the launch's facts, sets the repository up, and
 *      runs the launch through this brain's own launch pipeline
 *      (`chat.startLaunch`) with the same launch id and lane id, so the lane
 *      is the same as one a desktop handed off;
 *   4. posts stage changes (a handful of writes per launch).
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
import { CLOUD_LAUNCH_ENV } from "../../../../account-directory/src/cloud/contract";
import { CloudApiError, type CloudApiClient } from "../../../../desktop/src/shared/cloudApiClient";
import type {
  AgentChatCreateArgs,
  AgentChatFileRef,
  ChatLaunchArgs,
  ChatLaunchEvent,
  ChatLaunchLaneConfig,
  ChatLaunchSnapshot,
  ChatLaunchStage,
} from "../../../../desktop/src/shared/types";
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
  sleep?: (ms: number) => Promise<void>;
};

type BootState = { launchId: string; phase: "joining" | "handed_off" | "ended"; projectId?: string | null };

/** A just-booted computer's device sign-in is tried this many times (each one retries the network itself). */
const JOIN_ATTEMPTS = 3;
/** A device sign-in a person still has to approve: asked again this often, each a fresh 10-minute code. */
const APPROVAL_ROUNDS = 6;
const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

function readState(file: string): BootState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as BootState;
    return parsed && typeof parsed.launchId === "string" ? parsed : null;
  } catch {
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(launchId) ? { launchId, joinCode } : null;
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

export async function runCloudBootLaunch(deps: CloudBootLaunchDeps): Promise<void> {
  const { launchId, logger } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const state = readState(deps.stateFile);
  const known = state?.launchId === launchId ? state : null;
  if (known?.phase === "ended") return;
  const hold = deps.hold ?? (<T>(run: () => Promise<T>) => run());

  const report = async (update: CloudLaunchStagesUpdate): Promise<CloudLaunchRecord | null> => {
    try {
      return await deps.api()?.reportLaunchStages(launchId, update) ?? null;
    } catch (error) {
      logger.warn("cloud_boot_launch.report_failed", { launchId, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };

  if (known?.phase === "handed_off" && known.projectId) {
    await follow(deps, known.projectId, report);
    return;
  }

  await hold(async () => {
    if (!deps.account.isSignedIn()) {
      const joined = await join(deps, sleep);
      if (!joined) return;
    }
    writeState(deps.stateFile, { launchId, phase: "joining" });
    await deps.afterJoin?.().catch((error: unknown) => {
      logger.warn("cloud_boot_launch.after_join_failed", { launchId, error: error instanceof Error ? error.message : String(error) });
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
    await report({ state: "joined", stages: [computerStage, joinStage, { id: "clone", status: "running", detail: request.project.origin.replace(/^github\.com\//, "") }] });

    let project: { projectId: string; rootPath: string };
    try {
      project = await deps.setUpProject(`https://${request.project.origin}.git`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const sentence = /repository not found|authentication failed|could not read username|permission denied|access denied|returned error: 40[34]/i.test(raw)
        ? "The new computer can't read this repository. Check that ADE Cloud can sign in to GitHub for it, then start again."
        : "ADE couldn't clone the repository on the new computer.";
      logger.warn("cloud_boot_launch.clone_failed", { launchId, error: raw });
      await report({ state: "failed", stages: [computerStage, joinStage, { id: "clone", status: "failed", error: sentence }], error: sentence });
      writeState(deps.stateFile, { launchId, phase: "ended" });
      return;
    }
    const cloneStage = doneStage("clone", request.project.origin.replace(/^github\.com\//, ""));

    const attachments: AgentChatFileRef[] = [];
    for (const file of request.chat?.attachments ?? []) {
      const folder = path.join(project.rootPath, ".ade", "attachments", `launch-${launchId}`);
      fs.mkdirSync(folder, { recursive: true });
      const target = path.join(folder, `${file.fileId}-${safeFileName(file.name)}`);
      fs.writeFileSync(target, Buffer.from(await api.readLaunchFile(launchId, file.fileId)));
      attachments.push({ path: target, type: file.contentType.startsWith("image/") ? "image" : "file" } as AgentChatFileRef);
    }

    const chat = request.chat;
    const args: ChatLaunchArgs = {
      kind: request.kind,
      mode: "background",
      launchId,
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
            permissionMode: chat.permissions as AgentChatCreateArgs["permissionMode"],
            ...(chat.fast ? { fastMode: true } : {}),
          },
          message: { text: chat.prompt, ...(attachments.length ? { attachments } : {}) },
        },
      } : {}),
      priorStages: [computerStage, joinStage, cloneStage].map((stage): ChatLaunchStage => ({
        id: stage.id as ChatLaunchStage["id"],
        status: "done",
        startedAt: null,
        endedAt: new Date().toISOString(),
        percent: null,
        detail: stage.detail ?? null,
        error: null,
      })),
    } as ChatLaunchArgs;
    const launches = await deps.launches(project.projectId);
    await launches.start(args);
    writeState(deps.stateFile, { launchId, phase: "handed_off", projectId: project.projectId });
    logger.info("cloud_boot_launch.handed_off", { launchId, projectId: project.projectId });
  });

  const after = readState(deps.stateFile);
  if (after?.launchId === launchId && after.phase === "handed_off" && after.projectId) await follow(deps, after.projectId, report);
}

/**
 * Signs this computer in with its join code. True once signed in; false
 * when it can't (a code that isn't valid any more, or no account server).
 */
async function join(deps: CloudBootLaunchDeps, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const { launchId, instanceId, logger } = deps;
  const api = deps.api();
  if (!api || !deps.joinCode) {
    logger.warn("cloud_boot_launch.cannot_join", { launchId, hasCode: Boolean(deps.joinCode) });
    return false;
  }
  for (let attempt = 1; attempt <= JOIN_ATTEMPTS; attempt += 1) {
    const login = await deps.account.startDeviceLogin();
    let url: string;
    try {
      const answer = await api.joinLaunch(launchId, instanceId, { nonce: deps.joinCode, userCode: login.userCode });
      if (!("url" in answer)) throw new Error("The account server answered the join without a link.");
      url = answer.url;
    } catch (error) {
      const code = error instanceof CloudApiError ? error.code : "unknown";
      logger.warn("cloud_boot_launch.join_refused", { launchId, attempt, code });
      // The link couldn't be minted for this sign-in and the code was given back: a fresh sign-in.
      if (code === "expired" || code === "not_found" || code === "already_used" || code === "unavailable" || code === "network" || code === "timeout") {
        await sleep(3_000);
        continue;
      }
      return false;
    }
    const controller = new AbortController();
    const opened = deps.approveHeadless ? await deps.approveHeadless(url, controller.signal).catch(() => "closed" as const) : "closed";
    logger.info("cloud_boot_launch.headless_approval", { launchId, result: opened });
    if (opened === "signed_in" && await waitSignedIn(deps, login, sleep)) return true;
    // A person has to confirm: one tap in their own browser, a fresh code each 10 minutes.
    let current = login;
    for (let round = 0; round < APPROVAL_ROUNDS; round += 1) {
      await api.joinLaunch(launchId, instanceId, { nonce: deps.joinCode, needsApproval: true, ...(round ? { userCode: current.userCode } : {}) }).catch((error: unknown) => {
        logger.warn("cloud_boot_launch.needs_approval_failed", { launchId, code: error instanceof CloudApiError ? error.code : "unknown" });
      });
      if (await waitSignedIn(deps, current, sleep)) return true;
      if (deps.account.isSignedIn()) return true;
      current = await deps.account.startDeviceLogin();
    }
    return deps.account.isSignedIn();
  }
  return deps.account.isSignedIn();
}

/** Polls one device sign-in until it ends; true when this computer is signed in. */
async function waitSignedIn(
  deps: CloudBootLaunchDeps,
  login: { sessionId: string; intervalSec: number; expiresAt: string },
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  let interval = Math.max(2, login.intervalSec);
  const until = Date.parse(login.expiresAt) || Date.now() + 10 * 60_000;
  while (Date.now() < until) {
    await sleep(interval * 1_000);
    const polled = await deps.account.pollDeviceLogin(login.sessionId).catch(() => null);
    if (!polled) continue;
    if (polled.status === "signed_in") return true;
    if (polled.status === "expired" || polled.status === "error") return deps.account.isSignedIn();
    if (polled.intervalSec) interval = Math.max(2, polled.intervalSec);
  }
  return deps.account.isSignedIn();
}

/**
 * Reports the brain's own launch until it ends: a write when a stage's status
 * changes or the launch ends, never on a timer.
 */
async function follow(
  deps: CloudBootLaunchDeps,
  projectId: string,
  report: (update: CloudLaunchStagesUpdate) => Promise<CloudLaunchRecord | null>,
): Promise<void> {
  const { launchId } = deps;
  const launches = await deps.launches(projectId);
  let last = "";
  const send = async (snapshot: ChatLaunchSnapshot): Promise<boolean> => {
    const stages = stagesOf(snapshot);
    const terminal = TERMINAL.has(snapshot.phase);
    const shape = `${snapshot.phase}|${stages.map((stage) => `${stage.id}:${stage.status}`).join(",")}`;
    if (shape === last) return terminal;
    last = shape;
    await report({
      state: snapshot.phase === "completed" ? "done" : snapshot.phase === "failed" ? "failed" : "running",
      stages,
      sessionId: snapshot.sessionId,
      ...(snapshot.phase === "failed" && snapshot.error ? { error: snapshot.error } : {}),
    });
    if (terminal) writeState(deps.stateFile, { launchId, phase: "ended", projectId });
    return terminal;
  };
  await new Promise<void>((resolve) => {
    let ended = false;
    let unsubscribe: (() => void) | null = null;
    const end = () => {
      if (ended) return;
      ended = true;
      unsubscribe?.();
      resolve();
    };
    // A failed launch waits for a retry on this computer; it is reported once and followed on.
    const onSnapshot = (snapshot: ChatLaunchSnapshot) => {
      void send(snapshot).then((terminal) => {
        if (terminal && snapshot.phase !== "failed") end();
      });
    };
    unsubscribe = launches.subscribe((event) => {
      if (event.type === "launch-updated" && event.launch.launchId === launchId) onSnapshot(event.launch);
      if (event.type === "launch-removed" && event.launchId === launchId) end();
    });
    void launches.get(launchId).then((snapshot) => {
      if (snapshot) onSnapshot(snapshot);
      else end();
    });
  });
}
