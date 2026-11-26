/**
 * The life of an ADE Cloud lane's computer after its launch: delete the lane
 * (and its computer), keep the lane on a fresh computer, a lane without a
 * computer, and a tier change or move that shows its steps like a launch.
 *
 * All of it is account-level: it acts on a computer of the account by its
 * ADE Cloud id, through this app's main process (`IPC.cloudLaneLifeCall`),
 * never through a project pin. A tier change runs in the main process so it
 * goes on with every window closed.
 */

import type { AdeCardPayload } from "./adeCard";
import type { CloudTierId } from "./cloudTiers";
import type { CloudLaneWithoutComputer } from "./cloudLaneLaunch";
import type { ChatLaunchStageStatus } from "./types/chatLaunch";
import type { OpenProjectBinding } from "./types/core";

export type { CloudLaneWithoutComputer };

/** One lane on a computer as its work check read it (`ade cloud push-work --check`). */
export type CloudLaneWorkLane = {
  laneId: string;
  laneName: string;
  branchRef: string;
  primary: boolean;
  dirty: boolean;
  ahead: number;
  /** Files changed and not committed, when the lane's backup counted them; unset from the computer's own check. */
  files?: number;
  state: "clean" | "pushed" | "failed" | "unpushed";
  /** Why GitHub stopped a failed lane (`github_refused`, `github_unreachable`), from the computer's own check. */
  reason?: string | null;
};

/** A work lane's name for people: the primary lane is the "main checkout". */
export function cloudWorkLaneName(lane: Pick<CloudLaneWorkLane, "laneName" | "branchRef" | "primary">): string {
  if (lane.primary) return "main checkout";
  return lane.laneName || lane.branchRef;
}

/**
 * Whether a computer holds work that isn't on GitHub. `unpushed` is null when
 * the check couldn't run (an older computer, no answer): the caller then warns
 * as if there were.
 */
export type CloudLaneWorkState = {
  unpushed: boolean | null;
  /** The lanes with work only on the computer (uncommitted changes or unpushed commits). */
  unpushedLanes: CloudLaneWorkLane[];
  /** Why the check couldn't run, or null. */
  message: string | null;
  /**
   * How it was read: on the computer (`computer`, which wakes an asleep one),
   * or from the lane backups of an asleep computer saved at rest (`backups`,
   * no wake). Unset when the check couldn't run.
   */
  checkedBy?: "computer" | "backups";
};

/** What a person picked when they deleted a cloud lane. */
export type CloudLaneDeleteOptions = {
  /** Keep its saved chats on ADE Cloud. Off: they go with the lane. */
  keepChats?: boolean;
  /**
   * Delete only these saved chats of the computer, by chat id: the ones a
   * move carried to another machine. The rest stay readable from ADE Cloud.
   */
  onlyChats?: readonly string[];
};

export type CloudLaneDeleteResult = {
  ok: boolean;
  /** One plain line: what happened, or why not. */
  message: string;
  /** From the work check before the delete, when it ran; null when it was skipped or couldn't run. */
  unpushed: boolean | null;
  unpushedLanes: CloudLaneWorkLane[];
  /** Whether its saved chats are still on ADE Cloud: asked to keep them, or their delete failed. */
  chatsKept: boolean;
};

export type CloudLaneFreeResult = {
  ok: boolean;
  message: string;
  /** The lane, now without a computer. Null when it failed. */
  lane: CloudLaneWithoutComputer | null;
};

/** When a tier change starts: once the agent is idle, or now (the running turn stops). */
export type CloudLaneTierTiming = "idle" | "now";

/**
 * `resize`: the same kind of computer, a new size in place (it restarts).
 * `move`: to the other kind (standard ↔ full): a new computer gets the files.
 */
export type CloudLaneJobKind = "resize" | "move";

/**
 * The steps of a tier change. A resize runs save, resize, start, connect; a
 * move runs save, computer, copy, start, remove, connect: the old computer
 * goes once ADE on the new one has the lane, and Connect is last because the
 * lane says Online only when it passes.
 */
export type CloudLaneJobStageId = "save" | "resize" | "computer" | "copy" | "start" | "connect" | "remove";

export const CLOUD_LANE_JOB_STAGE_LABELS: Record<CloudLaneJobStageId, string> = {
  save: "Save work",
  resize: "Change size",
  computer: "Make computer",
  copy: "Copy lane",
  start: "Start ADE",
  connect: "Connect",
  remove: "Remove old computer",
};

export function cloudLaneJobStageIds(kind: CloudLaneJobKind): CloudLaneJobStageId[] {
  switch (kind) {
    case "resize":
      return ["save", "resize", "start", "connect"];
    case "move":
      return ["save", "computer", "copy", "start", "remove", "connect"];
  }
}

export type CloudLaneJobStage = {
  id: CloudLaneJobStageId;
  status: ChatLaunchStageStatus;
  detail: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

/** The save step's detail when it couldn't write the chats' saved copy (a stuck brain): the job goes on. */
export const CLOUD_LANE_SAVE_WARNING_DETAIL = "The chats' saved copy may be a few minutes old";

/**
 * `waiting`: for the agent to be idle. `running`: the steps. `online`: ADE on
 * the computer answers (the lane says Online only now). `failed`: a step
 * failed; Retry runs it again. `cancelled`: stopped before the size changed.
 */
export type CloudLaneJobPhase = "waiting" | "running" | "online" | "failed" | "cancelled";

export type CloudLaneJobSnapshot = {
  jobId: string;
  kind: CloudLaneJobKind;
  timing: CloudLaneTierTiming;
  /** The computer the lane is on now: the new one once a move made it. */
  instanceId: string;
  /** The computer the job started on. */
  fromInstanceId: string;
  /** The ADE machine key of `instanceId`, once known. */
  machineKey: string | null;
  laneId: string | null;
  /** The lane's name: the computer keeps (or a moved one gets) this name. */
  laneName: string;
  projectOrigin: string | null;
  fromSizeId: CloudTierId | null;
  toSizeId: CloudTierId;
  phase: CloudLaneJobPhase;
  stages: CloudLaneJobStage[];
  error: string | null;
  /** The agent's chat whose request card the person confirmed, or null. */
  requestedByChat: string | null;
  /** That request card's id, so the card matches this job and no later one. Absent on older records. */
  requestId?: string | null;
  /**
   * A resize that also grows the disk: the disk's new size in GB. Null (or
   * absent, from an older record) keeps the disk as it is.
   */
  diskGb?: number | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  /**
   * The person closed the job's card (a failure read, a finish seen). It
   * leaves every view; nothing about the computer changes. Absent on older records.
   */
  dismissedAt?: string | null;
};

/** The job still waits for the agent or runs its steps. */
export function cloudLaneJobIsLive(job: Pick<CloudLaneJobSnapshot, "phase">): boolean {
  return job.phase === "waiting" || job.phase === "running";
}

/** One change of a computer at a time: a second one (a confirm, a Retry) is refused with this. */
export const CLOUD_LANE_CHANGE_RUNNING_MESSAGE = "A change is already running for this lane.";

/**
 * A send to the lane's chats goes to the account's queue now, which holds it
 * until the change is done: a move from its making on (once it no longer
 * waits for the agent; the server's `HOLDING_STEPS` in
 * `account-directory/src/cloud/moves.ts`), a size change once its resize was
 * asked (before that its ADE still answers, and the restart would cut the
 * turn the message started).
 */
export function cloudLaneJobHoldsSends(job: CloudLaneJobSnapshot): boolean {
  if (job.phase !== "running") return false;
  if (job.kind === "move") return true;
  return job.stages.some((stage) => stage.id === "resize" && (stage.status === "done" || stage.status === "warning" || stage.status === "skipped"));
}

/** The calls `IPC.cloudLaneLifeCall` answers. */
export type CloudLaneLifeMethod =
  | "workState"
  | "deleteLane"
  | "freeLane"
  | "lanesWithoutComputer"
  | "forgetLaneWithoutComputer"
  | "changeTier"
  | "listJobs"
  | "retryJob"
  | "cancelJob"
  | "dismissJob";

export type CloudLaneLifeCallRequest<M extends CloudLaneLifeMethod = CloudLaneLifeMethod> = { method: M; args?: unknown };

/** What each `IPC.cloudLaneLifeCall` method answers. */
export type CloudLaneLifeResults = {
  workState: CloudLaneWorkState;
  deleteLane: CloudLaneDeleteResult;
  freeLane: CloudLaneFreeResult;
  lanesWithoutComputer: CloudLaneWithoutComputer[];
  forgetLaneWithoutComputer: { forgotten: boolean };
  changeTier: CloudLaneJobSnapshot;
  listJobs: CloudLaneJobSnapshot[];
  retryJob: CloudLaneJobSnapshot | null;
  cancelJob: CloudLaneJobSnapshot | null;
  dismissJob: CloudLaneJobSnapshot | null;
};

export type CloudLaneChangeTierArgs = {
  instanceId: string;
  sizeId: CloudTierId;
  timing: CloudLaneTierTiming;
  /**
   * A resize only: grow the disk to this many GB in the same step. A size
   * change never shrinks the disk, and keeps it as it is without this.
   */
  diskGb?: number | null;
  /** The request card the person confirmed, if any (`CloudTierRequest.requestId`). */
  requestId?: string | null;
  requestedByChat?: string | null;
  /**
   * That chat's runtime pin: the layer that runs the change tells the chat's
   * own machine how it ended (`cloud.tier_request_answer` with its outcome).
   */
  requestedByChatPin?: OpenProjectBinding | null;
};

// ---------------------------------------------------------------------------
// A delete or free the person said yes to, in the agent's chat
// ---------------------------------------------------------------------------

/**
 * One card in the agent's chat for a lane delete, a free or a saved copy's
 * delete the person approved on its card: "Deleting Stall Repro…", then its
 * outcome. The verb's result also goes to the command that asked. The
 * generic `ade_card` draws it (`KNOWN_ADE_CARD_VARIANTS`): live while it
 * runs, one quiet line when done, amber with the reason when it failed.
 */
export const CLOUD_LANE_ACTION_CARD_VARIANT = "cloud_lane_action";

export function buildCloudLaneActionCard(input: {
  cardId: string;
  state: "live" | "terminal";
  title: string;
  /** The outcome's sentence; null while it runs. */
  detail?: string | null;
  failed?: boolean;
}): AdeCardPayload {
  const detail = input.detail?.trim() || null;
  return {
    cardId: input.cardId,
    variant: CLOUD_LANE_ACTION_CARD_VARIANT,
    state: input.state,
    title: input.title,
    // A failure's reason is its amber row; a subtitle too would say it twice.
    subtitle: input.failed ? null : detail,
    rows: detail ? [{ key: "cloud_lane_action_outcome", icon: input.failed ? "fail" : input.state === "live" ? "running" : "pass", text: detail, tone: input.failed ? "warning" : "neutral" }] : [],
    fallbackText: detail ? `${input.title}. ${detail}` : input.title,
  };
}

// ---------------------------------------------------------------------------
// A new computer waits for the person to approve it joining the account
// ---------------------------------------------------------------------------

/** How long a new computer waits for the person's approval: as long as the account keeps a sign-in code (DEVICE_CODE_TTL_SECONDS). */
export const CLOUD_JOIN_APPROVAL_WAIT_MS = 10 * 60_000;

/** "10 minutes": the wait in the card, its text and the error when nobody approved. */
export function cloudJoinApprovalWaitText(): string {
  const minutes = Math.round(CLOUD_JOIN_APPROVAL_WAIT_MS / 60_000);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** A resize that keeps the size and grows only the disk (the Android pane's Grow the disk). */
export function cloudLaneJobGrowsDiskOnly(job: CloudLaneJobSnapshot): job is CloudLaneJobSnapshot & { diskGb: number } {
  return job.kind === "resize" && job.fromSizeId === job.toSizeId && typeof job.diskGb === "number" && job.diskGb > 0;
}

// ---------------------------------------------------------------------------
// The account's ADE Cloud lanes, one list (`cloud.lanes`, `ade cloud lanes`)
// ---------------------------------------------------------------------------

/** Why a lane's computer is gone: a saved chat's `computer.reason`, or a kept lane's (`inactive` is the old 30-day rule). */
export type CloudComputerFate = "you" | "freed" | "idle" | "plan" | "automation" | "project" | "launch" | "other" | "inactive";

/** A kept lane's server reason as the fate people read. */
export const CLOUD_KEPT_LANE_FATE: Record<CloudLaneWithoutComputer["reason"], CloudComputerFate> = {
  freed: "freed",
  idle_cleanup: "idle",
  plan_limit: "plan",
  inactive: "inactive",
};

/** What happened to a lane's computer, in one sentence; `when` is " on Nov 18" or "". */
export function cloudComputerFateSentence(fate: CloudComputerFate | null | undefined, when: string): string {
  switch (fate) {
    case "you":
      return `You deleted its computer${when}.`;
    case "freed":
      return `You freed its computer${when}.`;
    case "idle":
      return `ADE deleted its computer${when} because it wasn't used.`;
    case "plan":
      return `ADE deleted its computer${when} to fit your plan.`;
    case "inactive":
      return `ADE deleted its computer${when} after 30 days without use.`;
    case "automation":
      return `Its automation finished${when}, and ADE deleted its computer.`;
    case "project":
      return `Its project's computers were deleted${when}.`;
    case "launch":
      return `Its launch didn't finish, so ADE deleted its computer${when}.`;
    default:
      return `Its computer was deleted${when}.`;
  }
}

/**
 * Where a lane is: on a computer (`awake`, `asleep`, `starting`, `stopping`,
 * `deleting`, `error`), or `computer_deleted`: the lane and its chats stay,
 * and the next message makes a new computer on its branch.
 */
export type CloudLaneEntryState = "awake" | "asleep" | "starting" | "stopping" | "deleting" | "error" | "computer_deleted";

export type CloudLaneEntry = {
  laneId: string;
  name: string;
  /** The branch, as the lane's computer or its kept record named it; null when ADE never learned it. */
  branch: string | null;
  /** `github.com/owner/repo`, or null. */
  projectOrigin: string | null;
  state: CloudLaneEntryState;
  /** The computer the lane lives on; null when it was deleted. */
  computer: {
    instanceId: string;
    machineKey: string | null;
    name: string | null;
    sizeLabel: string;
    hoursRate: number | null;
    lastUsedAt: string | null;
    /** The idle cleanup's planned delete (ISO); "Keep it" (`ade cloud lanes keep`) stops it. */
    deletesAt: string | null;
    diskGb: number | null;
  } | null;
  /** Why and when its computer went, for `computer_deleted`; `sentence` is the one line people read. */
  deleted: { at: string | null; fate: CloudComputerFate; sentence: string } | null;
  /** Saved chats of this lane on ADE Cloud (the account's newest, so a large account may count fewer). */
  chats: number;
  /** Its newest lane backup: the work not on GitHub that ADE saved at rest. */
  backup: { commits: number; files: number; savedAt: string; bytes: number } | null;
  /** The account machine keys its saved chats and backups are kept under (a delete clears them). */
  machineKeys: string[];
  /** Opens the lane in ADE on any device (`ade://` and `https://ade-app.dev/open/lane`). */
  link: string;
};

export type CloudLanesAnswer = {
  lanes: CloudLaneEntry[];
  /** Parts ADE couldn't read (the computers, the kept lanes, the chats, the backups), each as a sentence. */
  unread: string[];
  /** A filter picked these (a project, --deleted, --stale): an empty list means none matched. */
  filtered?: boolean;
};
