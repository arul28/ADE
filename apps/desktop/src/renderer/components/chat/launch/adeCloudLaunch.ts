import type { ChatLaunchArgs, ChatLaunchLaneConfig, ChatLaunchSnapshot, CloudStartBranchArgs, OpenProjectBinding } from "../../../../shared/types";
import type { CloudAccountState } from "../../../../shared/adeCloud";
import { createChatLaunchSnapshot } from "../../../../shared/chatLaunch";
import { cloudLaneLaunchStartRefusal, cloudLaneStartBlock } from "../../../../shared/cloudLaneLaunch";
import { normalizeGitRemoteIdentity } from "../../../../shared/crossMachineHandoff";
import {
  getChatLaunchOriginClientId,
  insertOptimisticChatLaunch,
  registerChatLaunchLocalRecord,
  type ChatLaunchLocalRecord,
} from "../../../state/chatLaunchStore";
import { ipcErrorMessage } from "../../../lib/format";
import { confirmDialog } from "../../ui/dialog/confirm";
import { startChatLaunch, type StartChatLaunchOutcome } from "./chatLaunchActions";

/**
 * Every renderer place that makes a lane on ADE Cloud (the composer, the new
 * lane dialog, a lane from a pull request's branch, a Linear batch) starts it
 * here: one `chatLaunch.start` with `cloud`, which main runs on a new computer
 * made for the lane alone. The card shows where launches show (the thread for
 * a foreground chat, the launches slide-out for the rest), from the first
 * frame, with the computer's own steps first.
 */

/**
 * The card an ADE Cloud launch shows before main answers: the computer, join
 * and clone steps first, then the lane's own.
 */
export function adeCloudOptimisticSnapshot(
  args: ChatLaunchArgs & { laneId: string; laneName: string },
  sizeId: string,
  projectOrigin = "",
): ChatLaunchSnapshot {
  return {
    ...createChatLaunchSnapshot({
      launch: args,
      laneId: args.laneId,
      laneName: args.laneName,
      // The computer's brain decides these; main shows them too until it answers.
      includeFetch: true,
      includeEnvironment: true,
      includeCloud: true,
      nowIso: new Date().toISOString(),
    }),
    cloud: {
      sizeId,
      projectOrigin,
      instanceId: null,
      machineKey: null,
      binding: null,
      handedOff: false,
    },
  };
}

/**
 * Why this launch can't start on ADE Cloud now, in the sentence the person
 * reads, or null: first a fact of the account (hours, computers, disk), then
 * a start refusal of the launch itself (no GitHub origin, a local file, an
 * "uncommitted" start). The same sentences main refuses with.
 */
export function adeCloudLaunchProblem(input: {
  args: ChatLaunchArgs;
  originUrl: string | null;
  account: CloudAccountState | null;
}): string | null {
  return cloudLaneStartBlock(input.account, { newLane: true })?.message
    ?? cloudLaneLaunchStartRefusal({ args: input.args, originUrl: input.originUrl })?.message
    ?? null;
}

/**
 * Why `count` new lanes can't all start on ADE Cloud now, or null. A batch
 * asks before it starts any, so it never makes some lanes and fails the rest.
 * Unknown (no account read yet) is never a block: main still refuses each.
 */
export function adeCloudCapacityProblem(account: CloudAccountState | null, count: number): string | null {
  const block = cloudLaneStartBlock(account, { newLane: true });
  if (block) return block.message;
  const computers = (account as Partial<CloudAccountState> | null)?.computers;
  if (!computers || computers.limit <= 0 || count <= 1) return null;
  const free = Math.max(0, computers.limit - computers.total);
  if (count <= free) return null;
  return `This needs ${count} ADE Cloud computers, and ${free === 1 ? "1 is" : `${free} are`} free. Pick fewer, or delete lanes you no longer use.`;
}

/**
 * "Push this branch?" before an ADE Cloud lane that starts from a branch the
 * person picked: the new computer clones from GitHub, so a branch only on
 * this computer (or its unpushed commits) would be missing there. Asks the
 * tab's own machine (no pin: the project's checkout is there), offers one
 * push, then answers whether the launch may go. The default start (the
 * saved base branch on GitHub) needs no read.
 */
export async function adeCloudStartBranchReady(
  laneConfig: ChatLaunchLaneConfig | null,
): Promise<{ go: true } | { go: false; error: string | null }> {
  if (!laneConfig) return { go: true };
  const args: CloudStartBranchArgs | null = laneConfig.mode === "existing"
    ? (laneConfig.branchRef ? { branchRef: laneConfig.branchRef } : null)
    : laneConfig.start && laneConfig.start.from !== "default" ? { start: laneConfig.start } : null;
  const lanes = window.ade?.lanes;
  if (!args || !lanes?.cloudStartBranch || !lanes.pushCloudStartBranch) return { go: true };
  try {
    const check = await lanes.cloudStartBranch(args);
    if (!check.push || !check.branch) return { go: true };
    const why = check.onRemote
      ? `${check.unpushedCommits === 1 ? "1 commit" : `${check.unpushedCommits} commits`} on ${check.branch} aren't on GitHub yet.`
      : `${check.branch} is only on this computer.`;
    const push = await confirmDialog({
      title: "Push this branch?",
      message: `${why} ADE Cloud starts from GitHub, so ADE pushes it first, then starts the lane.`,
      confirmLabel: "Push and start",
    });
    if (!push) return { go: false, error: null };
    const after = await lanes.pushCloudStartBranch(args);
    return after.push
      ? { go: false, error: `${check.branch} still isn't on GitHub. Push it, then send again.` }
      : { go: true };
  } catch (error) {
    return { go: false, error: ipcErrorMessage(error) || "ADE couldn't check the branch on GitHub. Try again." };
  }
}

/** The project the new computer clones, as main names it on the card. */
export function adeCloudProjectOrigin(originUrl: string | null): string {
  return normalizeGitRemoteIdentity(originUrl) ?? "";
}

/**
 * Starts one ADE Cloud launch. `binding` is the tab's project: on ADE Cloud
 * it only names the repository to clone, and it is the pin every later call
 * for this launch starts from (main moves it to the computer's brain).
 */
export function startAdeCloudLaunch(input: {
  args: Omit<ChatLaunchArgs, "cloud" | "originClientId"> & { laneId: string; laneName: string };
  sizeId: string;
  originUrl: string | null;
  binding: OpenProjectBinding;
  draftSnapshot?: ChatLaunchLocalRecord["draftSnapshot"];
  cli?: ChatLaunchLocalRecord["cli"];
  onUnsupported?: (() => void) | null;
}): Promise<StartChatLaunchOutcome> {
  const args: ChatLaunchArgs & { laneId: string; laneName: string } = {
    ...input.args,
    originClientId: getChatLaunchOriginClientId(),
    // The origin the caller checked before Send goes with the launch: main
    // clones that repository, so the two never disagree about it.
    cloud: { sizeId: input.sizeId, ...(input.originUrl?.trim() ? { originUrl: input.originUrl.trim() } : {}) },
  };
  registerChatLaunchLocalRecord(args.launchId, {
    args,
    pin: input.binding,
    draftSnapshot: input.draftSnapshot ?? null,
    cli: input.cli ?? null,
  });
  insertOptimisticChatLaunch(
    input.binding,
    adeCloudOptimisticSnapshot(args, input.sizeId, adeCloudProjectOrigin(input.originUrl)),
  );
  return startChatLaunch(args.launchId, { onUnsupported: input.onUnsupported ?? null });
}
