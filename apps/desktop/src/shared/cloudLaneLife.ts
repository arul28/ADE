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

import type { AdeCardPayload, AdeCardRow } from "./adeCard";
import type { CloudTierId } from "./cloudTiers";
import type { CloudLaneWithoutComputer } from "./cloudLaneLaunch";
import type { ChatLaunchStageStatus } from "./types/chatLaunch";

export type { CloudLaneWithoutComputer };

/** One lane on a computer as its work check read it (`ade cloud push-work --check`). */
export type CloudLaneWorkLane = {
  laneId: string;
  laneName: string;
  branchRef: string;
  primary: boolean;
  dirty: boolean;
  ahead: number;
  state: "clean" | "pushed" | "failed" | "unpushed";
};

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
};

export type CloudLaneDeleteResult = {
  ok: boolean;
  /** One plain line: what happened, or why not. */
  message: string;
  /** From the work check before the delete, when it ran; null when it was skipped or couldn't run. */
  unpushed: boolean | null;
  unpushedLanes: CloudLaneWorkLane[];
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
};

// ---------------------------------------------------------------------------
// An agent asks for a tier change
// ---------------------------------------------------------------------------

/** The card an agent's `cloud.tier_request` posts in its chat. A person confirms it; the agent never changes a tier. */
export const CLOUD_TIER_REQUEST_CARD_VARIANT = "cloud_tier_request";

/** The card's buttons. The client answers `idle` and `now` with `changeTier`. */
export const CLOUD_TIER_REQUEST_ACTIONS = {
  idle: "cloud_tier_change_idle",
  now: "cloud_tier_change_now",
  dismiss: "cloud_tier_request_dismiss",
} as const;

export type CloudTierRequest = {
  requestId: string;
  instanceId: string;
  /** The computer's name (the lane's name). */
  computerName: string;
  fromSizeId: CloudTierId | null;
  toSizeId: CloudTierId;
  /** The agent's reason, in its words. */
  reason: string;
  chatSessionId: string;
};

/** Row keys the card carries its request in, so a client reads it back without parsing text. */
const ROW = { computer: "tier_request_computer", size: "tier_request_size", reason: "tier_request_reason", from: "tier_request_from" } as const;

export function buildCloudTierRequestCard(request: CloudTierRequest, labels: { from: string | null; to: string; rate: string | null }): AdeCardPayload {
  const rows: AdeCardRow[] = [
    { key: ROW.computer, icon: "info", text: request.computerName, detail: request.instanceId },
    { key: ROW.size, icon: "info", text: `To ${labels.to}${labels.rate ? `, ${labels.rate}` : ""}`, detail: request.toSizeId },
    ...(request.fromSizeId ? [{ key: ROW.from, icon: "info" as const, text: `Now ${labels.from ?? request.fromSizeId}`, detail: request.fromSizeId }] : []),
    { key: ROW.reason, icon: "info", text: request.reason, detail: null },
  ];
  return {
    cardId: `cloud-tier-request:${request.requestId}`,
    variant: CLOUD_TIER_REQUEST_CARD_VARIANT,
    state: "live",
    title: `Change ${request.computerName} to ${labels.to}?`,
    subtitle: "The agent asks. It changes nothing until you confirm.",
    rows,
    actions: [
      { id: CLOUD_TIER_REQUEST_ACTIONS.idle, label: "Change when the agent is idle", kind: "primary" },
      { id: CLOUD_TIER_REQUEST_ACTIONS.now, label: "Do it now", kind: "default" },
      { id: CLOUD_TIER_REQUEST_ACTIONS.dismiss, label: "Keep the size", kind: "default" },
    ],
    fallbackText: `The agent asks to change ${request.computerName} to ${labels.to}: ${request.reason} Change it in ADE (Settings › ADE Cloud).`,
  };
}

/** The request a `cloud_tier_request` card carries, or null for any other card. */
export function cloudTierRequestOfCard(card: AdeCardPayload, chatSessionId: string): CloudTierRequest | null {
  if (card.variant !== CLOUD_TIER_REQUEST_CARD_VARIANT) return null;
  const requestId = card.cardId.startsWith("cloud-tier-request:") ? card.cardId.slice("cloud-tier-request:".length) : "";
  const row = (key: string) => card.rows?.find((entry) => entry.key === key) ?? null;
  const computer = row(ROW.computer);
  const size = row(ROW.size);
  if (!requestId || !computer?.detail || !size?.detail) return null;
  return {
    requestId,
    instanceId: computer.detail,
    computerName: computer.text,
    fromSizeId: (row(ROW.from)?.detail as CloudTierId | undefined) ?? null,
    toSizeId: size.detail as CloudTierId,
    reason: row(ROW.reason)?.text ?? "",
    chatSessionId,
  };
}

// ---------------------------------------------------------------------------
// A new lane's computer waits for the person to approve it joining the account
// ---------------------------------------------------------------------------

/**
 * The card a lane launch posts in the agent's chat when no desktop window can
 * approve its new computer (no desktop attached to the brain that runs it).
 * Only the brain posts it; agents can't post cards. The same card id again
 * marks it done or ended.
 */
export const CLOUD_JOIN_APPROVAL_CARD_VARIANT = "cloud_join_approval";

const JOIN_ROW = { link: "join_approval_link", state: "join_approval_state" } as const;

/** How long a new computer waits for the person's approval: as long as the account keeps a sign-in code (DEVICE_CODE_TTL_SECONDS). */
export const CLOUD_JOIN_APPROVAL_WAIT_MS = 10 * 60_000;

/** "10 minutes": the wait in the card, its text and the error when nobody approved. */
export function cloudJoinApprovalWaitText(): string {
  const minutes = Math.round(CLOUD_JOIN_APPROVAL_WAIT_MS / 60_000);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export type CloudJoinApproval = {
  launchId: string;
  computerName: string;
  /** The account service's own approval page for this computer's code (`…/device?user_code=…`). */
  url: string;
  /** `waiting` until the computer joined (`joined`) or the launch stopped waiting (`ended`). */
  state: "waiting" | "joined" | "ended";
};

/** Only the account service's approval page: https, `/device`, with a code. */
export function isCloudJoinApprovalUrl(raw: string | null | undefined): boolean {
  try {
    const url = new URL(String(raw ?? ""));
    return url.protocol === "https:" && url.pathname.replace(/\/+$/, "") === "/device" && Boolean(url.searchParams.get("user_code")) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function buildCloudJoinApprovalCard(input: CloudJoinApproval): AdeCardPayload {
  const waiting = input.state === "waiting";
  return {
    cardId: `cloud-join-approval:${input.launchId}`,
    variant: CLOUD_JOIN_APPROVAL_CARD_VARIANT,
    state: waiting ? "live" : "terminal",
    title: input.state === "joined"
      ? `${input.computerName} joined your ADE account`
      : input.state === "ended" ? `${input.computerName} no longer waits for approval` : `Approve ${input.computerName} joining your ADE account`,
    subtitle: waiting ? `A new ADE Cloud computer for this lane. The lane waits up to ${cloudJoinApprovalWaitText()}.` : null,
    rows: [
      { key: JOIN_ROW.link, icon: "info", text: input.computerName, detail: input.url },
      { key: JOIN_ROW.state, icon: waiting ? "running" : input.state === "joined" ? "pass" : "skipped", text: input.state, detail: input.state },
    ],
    fallbackText: waiting
      ? `Approve "${input.computerName}" joining your ADE account: open ${input.url} on your phone or in a browser signed in to ADE. The lane waits up to ${cloudJoinApprovalWaitText()}.`
      : input.state === "joined" ? `"${input.computerName}" joined your ADE account.` : `"${input.computerName}" no longer waits for approval.`,
  };
}

/** What a `cloud_join_approval` card carries, or null for any other card (or a link that isn't the approval page). */
export function cloudJoinApprovalOfCard(card: AdeCardPayload): CloudJoinApproval | null {
  if (card.variant !== CLOUD_JOIN_APPROVAL_CARD_VARIANT || !card.cardId.startsWith("cloud-join-approval:")) return null;
  const row = card.rows?.find((entry) => entry.key === JOIN_ROW.link) ?? null;
  if (!row?.detail || !isCloudJoinApprovalUrl(row.detail)) return null;
  const stated = card.rows?.find((entry) => entry.key === JOIN_ROW.state)?.detail;
  return {
    launchId: card.cardId.slice("cloud-join-approval:".length),
    computerName: row.text,
    url: row.detail,
    state: card.state === "live" ? "waiting" : stated === "joined" ? "joined" : "ended",
  };
}
