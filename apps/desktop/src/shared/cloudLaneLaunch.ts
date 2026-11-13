/**
 * Facts an ADE Cloud lane's computer carries in its metadata, so any list
 * (desktop, phone, the server's own) can show "ADE Cloud · <lane name>" and
 * find the lane's project without waking the computer. The launch writes
 * them when it makes the computer (`cloudLaneLaunchService.ts`), beside
 * `ade_request_id`, which is the launch id.
 */

import { CLOUD_OUT_OF_HOURS_MESSAGE, cloudOutOfHours, type CloudAccountState, type CloudAgentMaker, type CloudMachine } from "./adeCloud";
import { normalizeGitRemoteIdentity } from "./crossMachineHandoff";
import type { ChatLaunchArgs, ChatLaunchSnapshot } from "./types/chatLaunch";
import { isChatLaunchSucceeded } from "./chatLaunch";
import { CLOUD_LANE_METADATA } from "../../../account-directory/src/cloud/contract";

export type { CloudLaneWithoutComputer } from "../../../account-directory/src/cloud/contract";

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
  code: "out_of_hours" | "disk_full";
  message: string;
  /** One short line for a narrow prompt box, so a label never wraps there. */
  short: string;
};

export function cloudLaneStartBlock(
  account: CloudAccountState | null | undefined,
  options: { newLane: boolean } = { newLane: true },
): CloudLaneStartBlock | null {
  if (!account) return null;
  // A partial answer (an older server) can lack a part: that check is skipped, never thrown.
  const { extraHours, disk } = account as Partial<CloudAccountState>;
  if (cloudOutOfHours(account) && !extraHours?.enabled) {
    return { code: "out_of_hours", message: CLOUD_OUT_OF_HOURS_MESSAGE, short: "Out of ADE Cloud hours." };
  }
  if (!options.newLane) return null;
  // No plan limits how many computers an account has; only the disk can be full.
  if (disk && disk.limitGb != null && disk.usedGb >= disk.limitGb) {
    return { code: "disk_full", message: "Your ADE Cloud disk space is full.", short: "ADE Cloud disk full." };
  }
  return null;
}

/** `--machine cloud`: a new lane on its own new ADE Cloud computer (the CLI and the ADE MCP policy). */
export const CLOUD_LANE_MACHINE = "cloud";

// The server reads these too (a lane that outlives its computer), so they live in its contract.
/** The lane this computer was made for (the launch's reserved lane id). */
export const CLOUD_LANE_ID_METADATA = CLOUD_LANE_METADATA.laneId;

/** The lane's name when the computer was made. The lane may be renamed later; this is not kept in step. */
export const CLOUD_LANE_NAME_METADATA = CLOUD_LANE_METADATA.laneName;

/** The project's normalized git origin (`github.com/owner/repo`), as `normalizeGitRemoteIdentity` writes it. */
export const CLOUD_PROJECT_ORIGIN_METADATA = CLOUD_LANE_METADATA.projectOrigin;

/** The lane's branch, written once the computer's ADE named it, so a lane that outlives its computer knows where to start again. */
export const CLOUD_LANE_BRANCH_METADATA = CLOUD_LANE_METADATA.branch;

/** Every lane fact a computer carries: a move copies these to the new computer. */
export const CLOUD_LANE_METADATA_KEYS: readonly string[] = Object.values(CLOUD_LANE_METADATA);

/** The lane name for a computer list row, or null for a computer that was not made for one lane. */
function cloudLaneNameOf(metadata: Record<string, string> | null | undefined): string | null {
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
export type CloudLaneMachine = CloudMachine & {
  lane?: CloudMachineLaneFacts | null;
  /**
   * The computer this one was made to replace or copy (`ade_moved_from`,
   * `ade_copied_from`): while that one is still listed, the lane stays on it.
   */
  replacesInstanceId?: string | null;
};

/** A GitHub origin's identity (`github.com/owner/repo`, lowercased), owner and repository, or null for any other origin. */
export function githubRepoOf(originUrl: string | null | undefined): { identity: string; owner: string; repo: string } | null {
  const identity = normalizeGitRemoteIdentity(originUrl ?? null);
  const match = identity ? /^github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i.exec(identity) : null;
  return identity && match ? { identity, owner: match[1]!, repo: match[2]! } : null;
}

/** True for a GitHub origin: ADE Cloud sets up GitHub repositories only. */
function isGithubOrigin(originUrl: string | null | undefined): boolean {
  return githubRepoOf(originUrl) != null;
}

/** A start refusal: the sentence, and a short form for a narrow prompt box. */
export type CloudLaneLaunchRefusal = { message: string; short: string };

/**
 * Why a new ADE Cloud launch can't start, with a short form, or null. The
 * composer shows it before Send (the short form when the box is narrow).
 */
export function cloudLaneLaunchStartRefusal(input: { args: ChatLaunchArgs; originUrl: string | null }): CloudLaneLaunchRefusal | null {
  const args = input.args;
  // A chat, a tracked CLI session, or the lane alone can start a new ADE Cloud lane.
  if (args?.kind !== "cli" && args?.kind !== "lane" && !args?.chat) {
    return { message: "A chat launch needs its first message.", short: "Add a message first." };
  }
  if (!args.cloud?.sizeId) return { message: "Pick a size for the ADE Cloud computer.", short: "Pick a size first." };
  if (!isGithubOrigin(input.originUrl)) {
    return {
      message: "ADE Cloud sets up GitHub repositories only, and this project has no GitHub origin.",
      short: "ADE Cloud needs a GitHub origin.",
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
    /** A tab bound to a copy on another machine: main asks that machine's brain. */
    remote?: { targetId: string; projectId: string } | null;
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

/** What `cloud.lane_launch` and `cloud.lane_launch_status` answer. */
export type CloudLaneLaunchStatus = {
  launch: ChatLaunchSnapshot;
  /** The computer made for the lane, once it exists. */
  machine: { name: string; instanceId: string | null; machineKey: string | null };
  /** While the join waits for the person: the sign-in link to open. */
  approvalUrl: string | null;
  /** The agent's chat that started it, or null for a person's launch. */
  madeByChat: string | null;
  /** The kind of agent that started it, when one did. */
  madeByAgent?: CloudAgentMaker | null;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A launch status as an action answered it over the wire, or null when it
 * carries no launch (the brain no longer has it). Missing fields read as null.
 */
export function parseCloudLaneLaunchStatus(value: unknown): CloudLaneLaunchStatus | null {
  if (!isPlainRecord(value) || !isPlainRecord(value.launch)) return null;
  const machine = isPlainRecord(value.machine) ? value.machine : {};
  const text = (field: unknown): string | null => (typeof field === "string" && field.trim() ? field.trim() : null);
  return {
    launch: value.launch as unknown as ChatLaunchSnapshot,
    machine: { name: text(machine.name) ?? "", instanceId: text(machine.instanceId), machineKey: text(machine.machineKey) },
    approvalUrl: text(value.approvalUrl),
    madeByChat: text(value.madeByChat),
    madeByAgent: value.madeByAgent === "chat" || value.madeByAgent === "automation" || value.madeByAgent === "mcp" ? value.madeByAgent : null,
  };
}

export type CloudLaneLaunchFollowOutcome = "succeeded" | "failed" | "cancelled" | "timeout" | "missing";

/**
 * Follows an ADE Cloud lane launch to its end: starts it, then reads its
 * status every `pollMs` until it succeeds, fails, is cancelled, or `waitMs`
 * passes. `onStatus` sees every status; `onApprovalLink` sees the join's
 * sign-in link only when it changes, while the launch still runs. "missing":
 * an answer carried no launch. Errors from `start` and `read` reach the caller.
 * The CLI and an automation run each keep their own words and their own sleep.
 */
export async function followCloudLaneLaunch(input: {
  start: () => Promise<unknown>;
  read: () => Promise<unknown>;
  onStatus?: (status: CloudLaneLaunchStatus) => void;
  onApprovalLink?: (url: string) => void;
  pollMs: number;
  waitMs: number;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<{
  outcome: CloudLaneLaunchFollowOutcome;
  status: CloudLaneLaunchStatus | null;
  /** The last answer as the action sent it (every field, for a caller's own result). */
  answer: unknown;
}> {
  const now = input.now ?? Date.now;
  let answer = await input.start();
  const deadline = now() + input.waitMs;
  let shownLink: string | null = null;
  for (;;) {
    const status = parseCloudLaneLaunchStatus(answer);
    if (!status) return { outcome: "missing", status: null, answer };
    input.onStatus?.(status);
    const snapshot = status.launch;
    if (isChatLaunchSucceeded(snapshot)) return { outcome: "succeeded", status, answer };
    if (snapshot.phase === "failed" || snapshot.phase === "cancelled") return { outcome: snapshot.phase, status, answer };
    if (status.approvalUrl && status.approvalUrl !== shownLink) {
      shownLink = status.approvalUrl;
      input.onApprovalLink?.(status.approvalUrl);
    }
    if (now() > deadline) return { outcome: "timeout", status, answer };
    await input.sleep(input.pollMs);
    answer = await input.read();
  }
}
