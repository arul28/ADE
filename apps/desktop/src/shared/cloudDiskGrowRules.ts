/**
 * The rules for a disk grow that ADE or an agent asks for on an ADE Cloud
 * computer. `adeCloud.ts` re-exports all of it.
 */

import type { CloudAccountState, CloudDiskRefusalReason } from "../../../account-directory/src/cloud/contract";
import {
  cloudCatalogOf,
  cloudInstanceType,
  cloudMachineKindOf,
  type CloudMachine,
} from "./adeCloud";
import { BRAND } from "./brand";

/** Room beyond what is asked for, for the filesystem's share of a grown disk. */
const CLOUD_DISK_GROW_MARGIN_MB = 256;

/**
 * What a disk grow ADE or an agent asks for may do. There is no plan or
 * account disk, only each size's own maximum:
 * - `plan`: inside the size's own maximum. It grows with nothing to ask.
 * - `limit`: it can't grow: the size's maximum (`tier_limit`), or an account
 *   ADE couldn't read (`unavailable`), the server's reasons for the same answer.
 *
 * The server checks all of it again on the grow.
 */
export type CloudDiskGrowFit =
  | { kind: "plan"; fromGb: number; toGb: number; sentence: string }
  | { kind: "limit"; fromGb: number; toGb: number; reason: CloudDiskRefusalReason; sentence: string };

/** A computer as the grow reads it: the provider's type ("default" or "vm"), its size and its disk now. */
type CloudDiskGrowComputer = { type: string | null; cpu: number; memoryGb: number; diskGb: number };

/**
 * Whether a computer's disk may grow, by `shortMb` (to the smallest whole
 * number of steps that frees it) or to `toGb`, and the sentence that says
 * so. `account` null (not read) is a `limit`: an unknown account never grows.
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
  const type = computer.type === "vm" ? "vm" : "default";
  const maxGb = catalog.sizes.find((size) => size.type === type && size.cpu === computer.cpu && size.memoryGb === computer.memoryGb)?.diskMaxGb;
  if (maxGb != null && toGb > maxGb) {
    return { kind: "limit", fromGb, toGb, reason: "tier_limit", sentence: `This size's disk grows to ${maxGb} GB, and ${toGb} GB is needed. Move it to a bigger size.` };
  }
  if (!account) {
    return { kind: "limit", fromGb, toGb, reason: "unavailable", sentence: `${BRAND.NAME} couldn't read your ${BRAND.CLOUD_NAME} account, so it didn't grow this disk. Try again in a minute.` };
  }
  return { kind: "plan", fromGb, toGb, sentence: `Grow this computer's disk from ${fromGb} GB to ${toGb} GB. The computer restarts.` };
}

/**
 * What a person's disk grow would do. `within`: `plan` when ADE read that it
 * fits the size; null when the server decides (the account wasn't read).
 */
export type CloudDiskGrowPlan =
  | { grow: false; sentence: string }
  | { grow: true; sentence: string; toGb: number; within: "plan" | null };

/**
 * The pane's grow (a person pressing Grow the disk): `cloudDiskGrowFit`,
 * except that an account not read leaves it to the server.
 */
export function cloudDiskGrowPlan(box: CloudMachine, account: CloudAccountState | null, shortMb: number): CloudDiskGrowPlan {
  const resources = box.resources;
  const currentGb = resources?.diskGb ?? null;
  if (!resources || currentGb == null || currentGb <= 0) {
    return { grow: false, sentence: `${BRAND.CLOUD_NAME} didn't say how big this computer's disk is, so ${BRAND.NAME} can't offer a bigger one.` };
  }
  const fit = cloudDiskGrowFit(
    { type: cloudInstanceType(cloudMachineKindOf(box.type)), cpu: resources.cpu, memoryGb: resources.memoryGb, diskGb: currentGb },
    account,
    { shortMb },
  );
  if (fit.kind === "plan") return { grow: true, toGb: fit.toGb, sentence: fit.sentence, within: "plan" };
  if (fit.reason === "unavailable") {
    return { grow: true, toGb: fit.toGb, sentence: `Grow this computer's disk from ${currentGb} GB to ${fit.toGb} GB. The computer restarts.`, within: null };
  }
  return { grow: false, sentence: fit.sentence };
}
