/**
 * Facts an ADE Cloud lane's computer carries in its metadata, so any list
 * (desktop, phone, the server's own) can show "ADE Cloud · <lane name>" and
 * find the lane's project without waking the computer. The launch writes
 * them when it makes the computer (`cloudLaneLaunchService.ts`), beside
 * `ade_request_id`, which is the launch id.
 */

import { CLOUD_OUT_OF_HOURS_MESSAGE, cloudOutOfHours, type CloudAccountState, type CloudMachine } from "./adeCloud";
import { normalizeGitRemoteIdentity } from "./crossMachineHandoff";
import type { ChatLaunchArgs } from "./types/chatLaunch";

/**
 * Why the account can't start a new ADE Cloud lane now, from facts of the
 * account (hours, computers, disk), or null. One wording for every caller:
 * the composer's label above the prompt box, `cloud.status`'s
 * `canStartLane`, and the early refusal of `cloud.lane_launch` and
 * `cloud.create`. `newLane: false` (a send to a lane that exists) checks
 * hours only: a sleeping lane wakes on hours too.
 *
 * Unknown (no account read) is never a block here: the server still refuses,
 * and each caller says what it does with unknown.
 */
export type CloudLaneStartBlock = {
  code: "out_of_hours" | "computers_full" | "disk_full";
  message: string;
};

export function cloudLaneStartBlock(
  account: CloudAccountState | null | undefined,
  options: { newLane: boolean } = { newLane: true },
): CloudLaneStartBlock | null {
  if (!account) return null;
  // A partial answer (an older server) can lack a part: that check is skipped, never thrown.
  const { extraHours, computers, disk } = account as Partial<CloudAccountState>;
  if (cloudOutOfHours(account) && !extraHours?.enabled) {
    return { code: "out_of_hours", message: CLOUD_OUT_OF_HOURS_MESSAGE };
  }
  if (!options.newLane) return null;
  if (computers && computers.limit > 0 && computers.total >= computers.limit) {
    const count = computers.limit;
    return {
      code: "computers_full",
      message: count === 1
        ? "You're using your one ADE Cloud computer."
        : `You're using all ${count} ADE Cloud computers.`,
    };
  }
  if (disk && disk.limitGb != null && disk.usedGb >= disk.limitGb) {
    return { code: "disk_full", message: "Your ADE Cloud disk space is full." };
  }
  return null;
}

/** The lane this computer was made for (the launch's reserved lane id). */
export const CLOUD_LANE_ID_METADATA = "ade_lane_id";

/** The lane's name when the computer was made. The lane may be renamed later; this is not kept in step. */
export const CLOUD_LANE_NAME_METADATA = "ade_lane_name";

/** The project's normalized git origin (`github.com/owner/repo`), as `normalizeGitRemoteIdentity` writes it. */
export const CLOUD_PROJECT_ORIGIN_METADATA = "ade_project_origin";

/** The lane name for a computer list row, or null for a computer that was not made for one lane. */
export function cloudLaneNameOf(metadata: Record<string, string> | null | undefined): string | null {
  const name = metadata?.[CLOUD_LANE_NAME_METADATA]?.trim();
  return metadata?.[CLOUD_LANE_ID_METADATA]?.trim() && name ? name : null;
}

/**
 * What a computer's metadata says about the lane it was made for, read with
 * no wake. The computer list carries it (`CloudLaneMachine.lane`), so the
 * composer can list a project's ADE Cloud lanes before any of them is awake.
 */
export type CloudMachineLaneFacts = {
  laneId: string;
  laneName: string;
  /** The project's normalized origin (`github.com/owner/repo`), or null when the computer did not record one. */
  projectOrigin: string | null;
};

/** The lane facts in a computer's metadata, or null for a computer that was not made for one lane. */
export function cloudMachineLaneFactsOf(metadata: Record<string, string> | null | undefined): CloudMachineLaneFacts | null {
  const laneId = metadata?.[CLOUD_LANE_ID_METADATA]?.trim();
  const laneName = cloudLaneNameOf(metadata);
  if (!laneId || !laneName) return null;
  return {
    laneId,
    laneName,
    projectOrigin: metadata?.[CLOUD_PROJECT_ORIGIN_METADATA]?.trim().toLowerCase() || null,
  };
}

/** A computer of the account, with its lane facts when it was made for one lane. */
export type CloudLaneMachine = CloudMachine & { lane?: CloudMachineLaneFacts | null };

/** True for a GitHub origin: ADE Cloud sets up GitHub repositories only. */
export function isGithubOrigin(originUrl: string | null | undefined): boolean {
  const identity = normalizeGitRemoteIdentity(originUrl ?? null);
  return identity != null && /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/i.test(identity);
}

/** A local file on this computer means nothing on the new one. Links are fine. */
function hasLocalAttachments(attachments: ChatLaunchArgs["attachments"]): boolean {
  return (attachments ?? []).some((attachment) => attachment.type !== "image-url");
}

/** A start refusal: the sentence, and a short form for a narrow prompt box. */
export type CloudLaneLaunchRefusal = { message: string; short: string };

/**
 * Why a new ADE Cloud launch can't start, with a short form, or null. The
 * composer shows it before Send (the short form when the box is narrow).
 */
export function cloudLaneLaunchStartRefusal(input: { args: ChatLaunchArgs; originUrl: string | null }): CloudLaneLaunchRefusal | null {
  const args = input.args;
  if (args?.kind === "cli" || !args?.chat) {
    return { message: "An ADE Cloud lane starts with a chat.", short: "ADE Cloud lanes start as chats." };
  }
  if (!args.cloud?.sizeId) return { message: "Pick a size for the ADE Cloud computer.", short: "Pick a size first." };
  if (!isGithubOrigin(input.originUrl)) {
    return {
      message: "ADE Cloud sets up GitHub repositories only, and this project has no GitHub origin.",
      short: "ADE Cloud needs a GitHub origin.",
    };
  }
  if (hasLocalAttachments(args.attachments) || hasLocalAttachments(args.chat.message?.attachments)) {
    return {
      message: "Files from this computer can't go to a new ADE Cloud computer yet. Send without them, then add them once the chat starts.",
      short: "Send without local files.",
    };
  }
  if (args.laneConfig?.start?.on === "uncommitted") {
    return {
      message: "An ADE Cloud lane starts from the pushed copy of its branch, so it can't bring uncommitted changes.",
      short: "Uncommitted changes stay here.",
    };
  }
  return null;
}

/**
 * Why a new ADE Cloud launch can't start, in the sentence the person reads,
 * or null. Main's `start` refuses with it; the composer shows the same
 * sentence before Send, so the person never meets it as an error after.
 */
export function cloudLaneLaunchStartProblem(input: { args: ChatLaunchArgs; originUrl: string | null }): string | null {
  return cloudLaneLaunchStartRefusal(input)?.message ?? null;
}

/** The `chatLaunch` methods `IPC.cloudLaneLaunchCall` answers. */
export type CloudLaneLaunchMethod =
  | "start"
  | "get"
  | "list"
  | "cancel"
  | "retry"
  | "startNow"
  | "queueMessage"
  | "completeClient";

export type CloudLaneLaunchCallRequest = {
  method: CloudLaneLaunchMethod;
  args?: unknown;
  /**
   * The project the call comes from: `start` clones its origin on the new
   * computer, `list` shows only that project's cloud launches. Null lists all.
   */
  source?: {
    gitOriginUrl: string | null;
    /** A project on this computer whose binding has no origin yet: main reads it from the checkout. */
    localRootPath?: string | null;
  } | null;
};

/**
 * `owned: false` means this app holds no ADE Cloud launch by that id: the
 * caller sends the call down its ordinary runtime route instead.
 */
export type CloudLaneLaunchCallResult = {
  owned: boolean;
  result?: unknown;
  /**
   * From `start` and `list`: the source project's origin as main read it
   * (`github.com/owner/repo`), or null when it has none. The preload shows a
   * subscription only the cloud launches of that project.
   */
  projectIdentity?: string | null;
};
