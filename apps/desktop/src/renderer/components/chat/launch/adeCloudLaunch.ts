import type { ChatLaunchArgs, ChatLaunchSnapshot, OpenProjectBinding } from "../../../../shared/types";
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
export function adeCloudOptimisticSnapshot(args: ChatLaunchArgs & { laneId: string; laneName: string }, sizeId: string): ChatLaunchSnapshot {
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
      projectOrigin: "",
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
    cloud: { sizeId: input.sizeId },
  };
  registerChatLaunchLocalRecord(args.launchId, {
    args,
    pin: input.binding,
    draftSnapshot: input.draftSnapshot ?? null,
    cli: input.cli ?? null,
  });
  const snapshot = adeCloudOptimisticSnapshot(args, input.sizeId);
  insertOptimisticChatLaunch(input.binding, {
    ...snapshot,
    cloud: { ...snapshot.cloud!, projectOrigin: adeCloudProjectOrigin(input.originUrl) },
  });
  return startChatLaunch(args.launchId, { onUnsupported: input.onUnsupported ?? null });
}
