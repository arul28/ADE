/**
 * The rules for a disk grow that ADE or an agent asks for on an ADE Cloud
 * computer, and for the paid extra disk an agent nobody watches may use.
 * `adeCloud.ts` re-exports all of it.
 */

import type {
  CloudAccountState,
  CloudDiskLimitLane,
  CloudDiskRefusalReason,
} from "../../../account-directory/src/cloud/contract";
import { formatCloudCents } from "../../../account-directory/src/cloud/contract";
import {
  cloudCatalogOf,
  cloudInstanceType,
  cloudMachineKindOf,
  type CloudAgentLimits,
  type CloudMachine,
} from "./adeCloud";

/** Room beyond what is asked for, for the filesystem's share of a grown disk. */
const CLOUD_DISK_GROW_MARGIN_MB = 256;

/** One computer of the account and its disk, as a grow at the account's storage limit names it. */
export type CloudDiskLaneUse = CloudDiskLimitLane;

/** The paid extra disk a grow uses: past the plan by `pastGb`, the account's extra disk then costing about `monthCents` a month. */
export type CloudDiskGrowExtra = { pastGb: number; monthCents: number };

/** Why a grow can't happen: the server's reason, or `agent_limit` (the agent limits held an unattended agent back). */
export type CloudDiskLimitReason = CloudDiskRefusalReason | "agent_limit";

/** Whether a refusal names the computers that hold the account's disk. The size's cap and "can't ask now" don't. */
export function cloudDiskLimitNamesLanes(reason: CloudDiskLimitReason): boolean {
  return reason !== "tier_limit" && reason !== "unavailable";
}

/**
 * What a disk grow ADE or an agent asks for may do (Pricing v2: no plan or
 * account disk, only each size's own maximum):
 * - `plan`: inside the size's own maximum. It grows with nothing to ask.
 * - `extra`: only from servers before Pricing v2 (paid extra disk); ADE no
 *   longer offers it.
 * - `limit`: it can't grow: the size's maximum (`tier_limit`), or an account
 *   ADE couldn't read. `reason` is the server's reason for the same answer.
 *
 * The server checks all of it again on the grow.
 */
export type CloudDiskGrowFit =
  | { kind: "plan"; fromGb: number; toGb: number; sentence: string }
  | { kind: "extra"; fromGb: number; toGb: number; pastGb: number; limitGb: number; monthCents: number; limitCents: number; sentence: string }
  | {
    kind: "limit";
    fromGb: number;
    toGb: number;
    reason: CloudDiskRefusalReason;
    sentence: string;
    /** The way out is in Settings (extra disk, its limit). */
    settings: boolean;
    /** Past a paid plan's disk: by how much, and the plan's disk. */
    pastGb?: number;
    limitGb?: number;
    /** Extra disk never decided (`off`): its price for each 10 GB a month. The server asks the person once, on the grow. */
    undecidedCentsPer10Gb?: number;
  };

/** A computer as the grow reads it: the provider's type ("default" or "vm"), its size and its disk now. */
type CloudDiskGrowComputer = { type: string | null; cpu: number; memoryGb: number; diskGb: number };

/**
 * Whether a computer's disk may grow, by `shortMb` (to the smallest whole
 * number of steps that frees it) or to `toGb`, and the sentence that says
 * so. `account` null (not read) is a `limit`: an unknown plan never spends.
 */
export function cloudDiskGrowFit(
  computer: CloudDiskGrowComputer,
  account: CloudAccountState | null,
  want: { shortMb: number } | { toGb: number },
): CloudDiskGrowFit {
  const catalog = cloudCatalogOf(account);
  const fromGb = computer.diskGb;
  const stepGb = catalog.diskStepGb;
  const toGb = "toGb" in want
    ? Math.max(fromGb + stepGb, fromGb + stepGb * Math.ceil((want.toGb - fromGb) / stepGb))
    : fromGb + stepGb * Math.max(1, Math.ceil((want.shortMb + CLOUD_DISK_GROW_MARGIN_MB) / (stepGb * 1024)));
  const limit = (
    reason: CloudDiskRefusalReason,
    sentence: string,
    extra: { settings?: boolean; pastGb?: number; limitGb?: number; undecidedCentsPer10Gb?: number } = {},
  ): CloudDiskGrowFit => ({
    kind: "limit",
    fromGb,
    toGb,
    reason,
    sentence,
    settings: extra.settings ?? false,
    ...(extra.pastGb != null ? { pastGb: extra.pastGb, limitGb: extra.limitGb } : {}),
    ...(extra.undecidedCentsPer10Gb != null ? { undecidedCentsPer10Gb: extra.undecidedCentsPer10Gb } : {}),
  });
  const type = computer.type === "vm" ? "vm" : "default";
  const maxGb = catalog.sizes.find((size) => size.type === type && size.cpu === computer.cpu && size.memoryGb === computer.memoryGb)?.diskMaxGb;
  if (maxGb != null && toGb > maxGb) {
    return limit("tier_limit", `This size's disk grows to ${maxGb} GB, and ${toGb} GB is needed. Move it to a bigger size.`);
  }
  if (!account) return limit("unavailable", "ADE couldn't read your ADE Cloud account, so it didn't grow this disk. Try again in a minute.");
  // Since Pricing v2 there is no plan or account disk (`disk.limitGb` is
  // null): a disk grows up to its size's own maximum, nothing else. The
  // server checks it again on the grow.
  return { kind: "plan", fromGb, toGb, sentence: `Grow this computer's disk from ${fromGb} GB to ${toGb} GB. The computer restarts.` };
}

/**
 * What a person's disk grow would do under the plan rules. `within`: `plan`
 * or `extra` when ADE read that it fits; null when the server decides (the
 * account wasn't read, or extra disk was never decided). `settings` sends the
 * person to turn on extra disk.
 */
export type CloudDiskGrowPlan =
  | { grow: false; sentence: string; settings?: boolean }
  | { grow: true; sentence: string; toGb: number; within: "plan" | "extra" | null };

/**
 * The pane's grow (a person pressing Grow the disk): `cloudDiskGrowFit`,
 * except that a grow into extra disk never decided is offered (the server
 * asks once, on the grow), and an account not read leaves it to the server.
 */
export function cloudDiskGrowPlan(box: CloudMachine, account: CloudAccountState | null, shortMb: number): CloudDiskGrowPlan {
  const resources = box.resources;
  const currentGb = resources?.diskGb ?? null;
  if (!resources || currentGb == null || currentGb <= 0) {
    return { grow: false, sentence: "ADE Cloud didn't say how big this computer's disk is, so ADE can't offer a bigger one." };
  }
  const fit = cloudDiskGrowFit(
    { type: cloudInstanceType(cloudMachineKindOf(box.type)), cpu: resources.cpu, memoryGb: resources.memoryGb, diskGb: currentGb },
    account,
    { shortMb },
  );
  if (fit.kind !== "limit") return { grow: true, toGb: fit.toGb, sentence: fit.sentence, within: fit.kind };
  const growTo = `Grow this computer's disk from ${currentGb} GB to ${fit.toGb} GB.`;
  if (fit.reason === "unavailable") return { grow: true, toGb: fit.toGb, sentence: `${growTo} The computer restarts.`, within: null };
  if (fit.undecidedCentsPer10Gb != null) {
    return {
      grow: true,
      toGb: fit.toGb,
      sentence: `${growTo} It goes ${fit.pastGb} GB past your plan's ${fit.limitGb} GB at one time. Extra disk costs ${formatCloudCents(fit.undecidedCentsPer10Gb)} for each 10 GB a month. The computer restarts.`,
      within: null,
    };
  }
  return { grow: false, sentence: fit.sentence, ...(fit.settings ? { settings: true } : {}) };
}

/**
 * The sentence an at-the-limit grow adds: the computers that hold the
 * account's disk, biggest first, so the person can pick one to delete.
 */
export function cloudDiskLanesSentence(lanes: readonly CloudDiskLaneUse[] | null | undefined): string | null {
  if (!lanes?.length) return null;
  const sorted = [...lanes].sort((a, b) => b.diskGb - a.diskGb);
  const shown = sorted.slice(0, 6).map((lane) => `${lane.laneName} (${lane.diskGb} GB)`);
  const more = sorted.length - shown.length;
  return `Your computers' disk: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
}

/* The paid extra disk an agent nobody watches may use (`CloudAgentLimits.extraDiskMonthCents`). */

/** Settings' choices for `extraDiskMonthCents` besides "up to your extra-disk limit" (null). */
export const CLOUD_AGENT_EXTRA_DISK_CHOICES = [0, 500, 1000, 2500] as const;
/** The most `extraDiskMonthCents` may be set to: $1,000 a month. */
export const CLOUD_AGENT_EXTRA_DISK_MAX_CENTS = 100_000;

/** `extraDiskMonthCents` as saved: a whole number of cents from 0 to the max, or null (the account's own limit). */
export function cloudAgentExtraDiskCentsOf(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= CLOUD_AGENT_EXTRA_DISK_MAX_CENTS ? raw : null;
}

/** Whether `next` lets agents use more paid extra disk than `was` (null, the account's own limit, is the most). */
export function cloudAgentExtraDiskLooser(next: number | null | undefined, was: number | null | undefined): boolean {
  if (next == null) return was != null;
  return was != null && next > was;
}

/** "none", "up to $10 a month", "up to your extra-disk limit". */
export function describeCloudAgentExtraDisk(cents: number | null | undefined): string {
  if (cents == null) return "up to your extra-disk limit";
  return cents === 0 ? "none" : `up to ${formatCloudCents(cents)} a month`;
}

/** Where the person changes the agents' extra disk. */
const CLOUD_AGENT_EXTRA_DISK_SETTING = "Settings › ADE Cloud › What agents may do alone › Paid extra disk";

/**
 * Whether an agent nobody watches (a full-auto chat, an automation, an ADE
 * MCP app) may grow a disk into paid extra disk on its own, under the agent
 * limits: null when it may, else the sentence for the agent and the card
 * that names the computers holding the disk. The account's own switch and
 * monthly limit come first (`cloudDiskGrowFit` answers `limit` before this
 * is asked), and the server checks them again on the grow. Limits that
 * didn't come from the account (`fallback`) never allow it: the person may
 * have set "None" on another computer.
 */
export function cloudAgentExtraDiskRefusal(
  limits: CloudAgentLimits,
  fit: Pick<Extract<CloudDiskGrowFit, { kind: "extra" }>, "toGb" | "monthCents">,
): string | null {
  const place = "Grow it from the lane's row in Settings › ADE Cloud, or delete a computer you no longer use.";
  if (!limits.unattendedSpend) {
    return `Your settings say agents nobody watches ask before they spend, so ADE didn't grow this disk to ${fit.toGb} GB with paid extra disk. ${place}`;
  }
  if (limits.fallback) {
    return `ADE couldn't read the limits you set for agents from your account, so an agent nobody watches can't use paid extra disk now. ADE didn't grow this disk to ${fit.toGb} GB. ${place}`;
  }
  const cap = cloudAgentExtraDiskCentsOf(limits.extraDiskMonthCents);
  if (cap == null || fit.monthCents <= cap) return null;
  if (cap === 0) {
    return `Your settings say agents nobody watches don't use paid extra disk, so ADE didn't grow this disk to ${fit.toGb} GB. ${place}`;
  }
  return `A ${fit.toGb} GB disk would bring your extra disk to about ${formatCloudCents(fit.monthCents)} a month, past the ${formatCloudCents(cap)} you let agents use alone (${CLOUD_AGENT_EXTRA_DISK_SETTING}). ${place}`;
}
