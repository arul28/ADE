import type { AgentChatCreateArgs, AgentChatSendArgs, AgentChatFileRef } from "./chat";
import type { LaneEnvInitStep } from "./config";

/**
 * A chat (or CLI session) launched into a lane that does not exist yet.
 *
 * The brain owns the whole launch: it reserves the chat's session id and the
 * lane's id up front, returns immediately, and then fetches the base, checks
 * out the worktree, applies the project's default lane template, creates the
 * chat and sends the opening message. Every client (desktop, hosted web, iOS)
 * renders the same snapshot, streamed as `chat_launch_event` runtime events
 * and readable on demand with `chat.getLaunch` / `chat.listLaunches`.
 *
 * Because the session id is reserved before anything runs, the chat a client
 * opens the instant the user hits send is the same chat the agent later runs
 * in — there is no swap from a placeholder to a real session.
 *
 * Surfaces (one contract, typed here):
 * - Brain action domain `chat`: `startLaunch`, `getLaunch`, `listLaunches`,
 *   `cancelLaunch`, `retryLaunch`, `startLaunchNow`, `queueLaunchMessage`,
 *   `completeLaunchClient`.
 * - Runtime event `{ type: "chat_launch_event", event: ChatLaunchEvent }`.
 * - Preload `window.ade.chatLaunch.{start,get,list,cancel,retry,startNow,
 *   queueMessage,completeClient,onEvent}` (every call takes an optional pin).
 * - Sync commands `chat.startLaunch` … `chat.completeLaunchClient` (same names
 *   as the action domain) and the pushed `chat_launch_event` envelope for iOS.
 * - Once the chat exists its transcript carries an `ade_card` with variant
 *   `lane_setup` and cardId `lane-setup:<launchId>` (built by
 *   `buildLaneSetupCard` in shared/chatLaunch.ts; each row's `key` is its stage
 *   id, the template name is the `Template` metric), so the setup record stays
 *   in the thread after reload and on every device.
 */

export type ChatLaunchKind = "chat" | "cli";

/** foreground = the launching client opens the chat now; background = it keeps its composer. */
export type ChatLaunchMode = "foreground" | "background";

/**
 * The stages a launch walks through, in order. Only stages that are true for
 * this launch are present in `ChatLaunchSnapshot.stages`:
 * - `fetch` is omitted when the project creates lanes from the local base.
 * - `environment` is omitted when neither a default lane template nor a
 *   project lane-environment config applies.
 * - `agent` is "Start agent" for a chat and "Start CLI session" for a CLI launch.
 */
export type ChatLaunchStageId = "fetch" | "checkout" | "environment" | "agent";

export type ChatLaunchStageStatus =
  | "pending"
  | "running"
  | "done"
  | "skipped"
  /** Finished, but not the way it was asked to (fetch failed, so the last-known base was used). */
  | "warning"
  | "failed";

export type ChatLaunchStage = {
  id: ChatLaunchStageId;
  status: ChatLaunchStageStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** Only `checkout` reports a real percentage, parsed from git's `Updating files` progress. */
  percent: number | null;
  /** Short trailing text for the row: "origin/main at 807fb2c", "4,917 files", a template name. */
  detail: string | null;
  /** Human-readable failure for this stage. */
  error: string | null;
  /** `environment` only: the lane-environment steps (env files, Docker, dependencies, setup script…). */
  steps?: LaneEnvInitStep[];
};

export type ChatLaunchPhase =
  /** Stages are running. */
  | "running"
  /** CLI only: the lane is ready and the launching client is starting the CLI session. */
  | "awaiting-client"
  /** A stage failed. The launch waits for Retry, Start anyway, or Delete. */
  | "failed"
  /** The agent is running and every stage has finished. Terminal. */
  | "completed"
  /** The user cancelled or deleted the launch; its lane and chat are gone. Terminal. */
  | "cancelled";

/**
 * A message typed into the chat while its lane was still being set up. It stays
 * in `queuedMessages` until the host has delivered it to the chat — including
 * after the launch completes, if delivery failed.
 */
export type ChatLaunchQueuedMessage = {
  id: string;
  text: string;
  displayText?: string;
  attachments?: AgentChatFileRef[];
  createdAt: string;
  /**
   * The last delivery failure, or absent/null while it has not failed. The
   * host retries on a short backoff and on every later `queueMessage`; the
   * message is never dropped. Clients show it as failed-to-send.
   */
  deliveryError?: string | null;
};

export type ChatLaunchSnapshot = {
  /** Stable id for the launch. For a chat launch this equals `sessionId`. */
  launchId: string;
  kind: ChatLaunchKind;
  mode: ChatLaunchMode;
  /**
   * The chat's session id. Reserved up front for a chat launch; for a CLI
   * launch it is null until the launching client reports the PTY session.
   */
  sessionId: string | null;
  /** Reserved lane id. The lane row exists once `laneCreated` is true. */
  laneId: string;
  laneName: string;
  /** True while the lane's AI name is still being generated. */
  laneNaming: boolean;
  branchRef: string | null;
  /** The ref the lane branches from, e.g. `origin/main`. */
  baseRef: string | null;
  worktreePath: string | null;
  /** Default lane template applied to this lane, if any. */
  templateName: string | null;
  /** Chat title / launch label derived from the prompt. */
  title: string;
  /** The opening message, shown as the user's bubble before the chat exists. */
  prompt: {
    text: string;
    displayText: string | null;
    attachments: AgentChatFileRef[];
  };
  /** Chat model id the launch runs with (for display). */
  modelId: string | null;
  phase: ChatLaunchPhase;
  stages: ChatLaunchStage[];
  /** Failure summary when `phase === "failed"`. */
  error: string | null;
  laneCreated: boolean;
  sessionCreated: boolean;
  /** The agent was started (normally, or early with Start now / Start anyway). */
  agentStarted: boolean;
  /**
   * Messages typed while the lane was being set up; sent in order once the
   * agent starts. Non-empty after the agent started only when a delivery
   * failed (see `ChatLaunchQueuedMessage.deliveryError`); later messages then
   * queue behind it to keep their order.
   */
  queuedMessages: ChatLaunchQueuedMessage[];
  /** Id of the device/window that started the launch (for "mine" filtering in the slide-out). */
  originClientId: string | null;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
  /** Monotonic per launch; clients drop snapshots older than the one they hold. */
  sequence: number;
};

export type ChatLaunchEvent =
  | { type: "launch-updated"; launch: ChatLaunchSnapshot }
  /** The launch record expired: it finished (completed or cancelled) and its retention window ran out. */
  | { type: "launch-removed"; launchId: string };

export type ChatLaunchChatArgs = {
  /** Session args minus the lane, which the launch creates. */
  create: Omit<AgentChatCreateArgs, "laneId" | "sessionId">;
  /** Opening message minus the session id, which the launch reserves. */
  message: Omit<AgentChatSendArgs, "sessionId">;
};

export type ChatLaunchArgs = {
  kind: ChatLaunchKind;
  mode: ChatLaunchMode;
  /**
   * Client-chosen launch id (a UUID). For a chat launch it also becomes the
   * chat's session id, which lets the client open the chat before this call
   * returns. Replaying a known id returns the existing launch (idempotent).
   */
  launchId: string;
  /**
   * Client-chosen id (a UUID) for the lane this launch creates, so the client
   * can open the chat under its lane immediately. Omitted = the brain picks one.
   */
  laneId?: string | null;
  /**
   * Initial lane name the client already shows. Omitted = the brain derives the
   * same deterministic name from the prompt. Either way the lane is renamed in
   * the background once its AI name arrives.
   */
  laneName?: string | null;
  /** Opening prompt text used for the lane name and title seed and the pending bubble. */
  prompt: string;
  displayPrompt?: string | null;
  attachments?: AgentChatFileRef[];
  /** Optional explicit base ref; omitted = the project's configured new-lane base. */
  baseBranch?: string | null;
  /** Registry model id used for background lane naming and for display. */
  modelId?: string | null;
  /** ADE provider of the chat (lane-naming hint). */
  provider?: string | null;
  title?: string | null;
  originClientId?: string | null;
  /** Required for kind "chat"; ignored for kind "cli". */
  chat?: ChatLaunchChatArgs;
};

export type ChatLaunchIdArgs = { launchId: string };

export type ChatLaunchQueueMessageArgs = {
  launchId: string;
  text: string;
  displayText?: string | null;
  attachments?: AgentChatFileRef[];
};

/** CLI launches: the launching client reports the PTY session it started in the lane. */
export type ChatLaunchCompleteClientArgs = {
  launchId: string;
  sessionId?: string | null;
  error?: string | null;
};
