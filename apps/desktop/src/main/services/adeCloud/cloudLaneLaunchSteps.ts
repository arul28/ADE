import type { CloudAgentMaker } from "../../../shared/adeCloud";
import { githubRepoOf } from "../../../shared/cloudLaneLaunch";
import type { CloudGitPreflight } from "../../../shared/cloudGitCredential";
import { DEFAULT_LANE_START } from "../../../shared/laneStart";
import { requireNormalizedUuid } from "../../../shared/uuid";
import type {
  ChatLaunchArgs,
  ChatLaunchEvent,
  ChatLaunchLaneConfig,
  ChatLaunchStage,
  ChatLaunchStageId,
  OpenProjectBinding,
  RemoteRuntimeProjectRecord,
} from "../../../shared/types";
import { getErrorMessage } from "../shared/utils";
import type { CloudMachineCreatorDeps } from "./cloudMachineCreator";
import { CloudProviderError } from "./cloudProvider";

/**
 * The pure parts of an ADE Cloud lane launch (`cloudLaneLaunchService.ts`):
 * its dependencies' shape, its timings and sentences, and the helpers that
 * read a launch's args or an error without touching anything.
 */

export type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
  error?: (event: string, meta?: Record<string, unknown>) => void;
};

export type RemoteBinding = OpenProjectBinding & { kind: "remote" };

export type CloudLaneLaunchDeps = {
  /** The folder that holds one record per launch (in the app's data folder). */
  recordsDir: string;
  logger: Logger;
  /** Every snapshot change, as a renderer's `chatLaunch.onEvent` expects it. */
  emit: (event: ChatLaunchEvent) => void;
  /**
   * The provider (deletes, metadata), the account (its token, the account
   * machines list) and the account service's address for the server
   * launcher. Its approval parts are never used: a launch's computer joins
   * with the server's join key.
   */
  creator: Omit<CloudMachineCreatorDeps, "pendingCreates">;
  /** This machine's update track: the launch's computer follows the same one. */
  updateChannel?: () => "stable" | "beta" | null;
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  /**
   * A cancel deleted the launch's computer: forget this app's saved
   * connection to it, as Delete computer does. Unset where no connections
   * are saved (a brain).
   */
  forgetMachineConnections?: (machine: { machineKey: string | null; instanceId: string }) => void;
  /**
   * Streams one file from this computer to the project on the new computer;
   * the path there (a message queued while the lane is set up). Unset (a
   * brain host): files from here are refused.
   */
  uploadAttachment?: (binding: RemoteBinding, input: { sourcePath: string; filename: string }) => Promise<{ path: string }>;
  /** Pairs this app with an account machine; this app's remote target id for it. */
  pairMachine: (machineKey: string) => Promise<{ targetId: string }>;
  /** Connects to a saved remote target (waking a sleeping cloud computer). Truthy once connected. */
  connect: (targetId: string) => Promise<unknown>;
  /** The projects on a connected computer: the launch's shows up once the computer cloned it. */
  listProjects: (targetId: string) => Promise<RemoteRuntimeProjectRecord[]>;
  /**
   * Contract C4, at the start, before anything is made: can a new cloud
   * computer clone this repository (`cloudGitPreflight` in
   * `cloudGitCredential.ts`)? A refusal ends the start with its words.
   * Unset: no check.
   */
  gitPreflight?: (originUrl: string) => Promise<CloudGitPreflight>;
  resolveBinding: (targetId: string, projectId: string, rootPath: string) => Promise<RemoteBinding>;
  /** One `chat` action on the computer's brain, through its pin. */
  callChatAction: (binding: RemoteBinding, action: string, args: Record<string, unknown>) => Promise<unknown>;
  /** The brain's `chat_launch_event`s while subscribed. `onEnded` fires when the stream stops by itself. */
  subscribeChatLaunchEvents: (
    binding: RemoteBinding,
    onEvent: (event: ChatLaunchEvent) => void,
    onEnded: () => void,
  ) => Promise<() => void>;
  /**
   * A launch made a new cloud computer. A brain passes it on to the sign-in
   * renewal (`providerLoginCloudComputers.ts`), as its maker does. Unset in
   * the app, where nothing listens.
   */
  onComputerCreated?: () => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How long after creation the service resumes launches a quit left behind. */
  resumeDelayMs?: number;
  /** How long a finished launch stays readable here. */
  finishedRetentionMs?: number;
};

export type CloudLaneLaunchStartInput = {
  args: ChatLaunchArgs;
  /** The git origin of the project the person pressed Send in. */
  originUrl: string | null;
  /** An agent's chat that started it: written on the computer, so the agent limits count it. */
  madeByChat?: string | null;
  /** The kind of agent that started it, also with no chat (an automation, ADE MCP); null for a person. */
  madeByAgent?: CloudAgentMaker | null;
};

export const MAX_QUEUED_MESSAGES = 10;
export const CANCEL_PIPELINE_WAIT_MS = 15_000;
export const DEFAULT_RESUME_DELAY_MS = 15_000;
export const DEFAULT_FINISHED_RETENTION_MS = 10 * 60_000;
/** A start the server can't answer yet (a create in flight, no answer, a busy server) is sent again this often, this long. */
export const CREATE_IN_PROGRESS_POLL_MS = 5_000;
export const CREATE_IN_PROGRESS_WAIT_MS = 6 * 60_000;
/** The server's launch record is read this often while the computer sets itself up; slower once nothing changed for a minute. */
export const SERVER_LAUNCH_POLL_MS = 3_000;
export const SERVER_LAUNCH_SLOW_POLL_MS = 10_000;
/** Past its clone, how long the computer's project and launch may take to show there before the launch fails. */
export const SERVER_LAUNCH_BIND_WAIT_MS = 10 * 60_000;
/** A cancel that found no computer yet keeps looking this long in case ADE Cloud still makes it. */
export const CANCELLED_CREATE_FOLLOW_MS = 10 * 60_000;
export const CANCELLED_CREATE_FOLLOW_POLL_MS = 15_000;
export const CONNECT_RETRY_MS = 3_000;
/** After the hand-off, how often a dropped event stream is followed again, and how many times. */
export const RESUBSCRIBE_MS = 15_000;
export const RESUBSCRIBE_ATTEMPTS = 20;

export const CANT_MAKE_COMPUTER = "ADE Cloud can't make a computer right now. Try again soon.";
/** Where this launch can't send files to the new computer (a brain host has no upload route to it). */
export const CANT_CARRY_FILES = "Files from this computer can't go to a new ADE Cloud computer from here. Start without them, then add them once it runs.";

/** A cancelled launch's computer that is still there, named so a person can find and delete it. */
export const cantDeleteComputer = (name: string): string =>
  `ADE couldn't delete the computer "${name}" it made. It tries again when ADE next opens, or delete it in Settings › ADE Cloud.`;

export class LaunchCancelled extends Error {
  constructor() { super("Launch cancelled."); }
}

/** A failure whose message is already the plain sentence to show. */
export class LaunchStepError extends Error {}

export const requireLaunchId = (value: unknown): string => requireNormalizedUuid(value, "launchId must be a UUID.");

export function isFinished(stage: ChatLaunchStage | null | undefined): boolean {
  return stage?.status === "done" || stage?.status === "skipped" || stage?.status === "warning";
}

export function clip(text: string, max = 240): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `https://github.com/owner/repo.git` for a GitHub origin, else null: only GitHub repositories are cloned on another computer. */
export function githubClone(originUrl: string | null): { identity: string; cloneUrl: string; repoName: string } | null {
  const repo = githubRepoOf(originUrl);
  if (!repo) return null;
  // The identity is lowercased; the folder keeps the repository's own spelling.
  const spelled = /([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(originUrl).trim().replace(/[?#].*$/, ""))?.[1];
  const repoName = spelled && spelled.toLowerCase() === repo.repo.toLowerCase() ? spelled : repo.repo;
  return { identity: repo.identity, cloneUrl: `https://github.com/${repo.owner}/${repo.repo}.git`, repoName };
}

/**
 * The lane recipe the computer's brain gets: always from the pushed copy of
 * its branch. A lane on an existing branch keeps that branch.
 *
 * Named exactly as a lane on this computer is (chatLaunchService
 * `laneIsAutoNamed`): a launch with no recipe, or one asking for it
 * (`autoName`), starts on the name from the prompt and a placeholder branch in
 * the project's pattern, and the brain there renames both with the AI name.
 * The name the person chose is kept. A rename follows the lane to its
 * computer's metadata (cloudLaneNameSync.ts), so the ADE Cloud page shows the
 * new name, and the launcher renames the computer and its account machine to
 * it (`recordName` in cloudLaneLaunchService.ts).
 */
export function cloudLaneConfig(config: ChatLaunchLaneConfig | null | undefined): ChatLaunchLaneConfig {
  if (config?.mode === "existing") return config;
  const autoName = !config || config.autoName === true;
  const { autoName: _autoName, ...base }: ChatLaunchLaneConfig = config ?? { mode: "new" };
  return { ...base, mode: "new", start: { ...(base.start ?? DEFAULT_LANE_START), on: "remote" }, ...(autoName ? { autoName: true } : {}) };
}

/** A file on this computer: it goes to the new computer at the hand-off. Links need nothing. */
export function hasLocalAttachments(attachments: ChatLaunchArgs["attachments"]): boolean {
  return (attachments ?? []).some((attachment) => attachment.type !== "image-url");
}

/**
 * The one plain sentence for a failed stage. ADE's own cloud steps and the
 * server already say what happened in plain words; raw git or connection
 * errors are mapped, and the raw text stays in the log.
 */
export function cloudLaneLaunchFailureSentence(stage: ChatLaunchStageId, error: unknown): string {
  if (error instanceof LaunchStepError) return error.message;
  const raw = getErrorMessage(error);
  if (/no space left on device|ENOSPC|disk is full/i.test(raw)) {
    return "The computer's disk is full. Pick a bigger size or free up space on it, then retry.";
  }
  if (stage === "computer" || stage === "join") {
    return clip(raw) || (stage === "computer" ? CANT_MAKE_COMPUTER : "The new computer couldn't join your account.");
  }
  if (stage === "clone") {
    if (/repository not found|authentication failed|could not read username|permission denied|access denied|returned error: 40[34]/i.test(raw)) {
      return "The new computer can't read this repository. Check that ADE Cloud can sign in to GitHub for it, then retry.";
    }
    if (error instanceof CloudProviderError) return clip(raw);
    return "ADE couldn't clone the repository on the new computer.";
  }
  return "ADE couldn't start setting up the lane on the new computer.";
}
