import {
  cloudCatalogOf,
  type CloudAccountState,
  type CloudMachine,
} from "../../../shared/adeCloud";
import { androidFirstStartNeedMb } from "../../../shared/androidDisk";
import { cloudTierFacts, cloudTiers, type CloudTier } from "../../../shared/cloudTiers";

/**
 * What a size change means for the lane's disk, in plain words, from data
 * only: the computer's disk and its last measure and the size's disk cap.
 * Since Pricing v2 no plan limits disk: each computer's disk is its own, up
 * to its size's cap. Nothing here knows a provider, an OS or a plan by name;
 * the catalog says what each size allows.
 */

/** The lane's computer as the change card needs it. */
export type TierChangeComputer = {
  /** Its disk now, in GB; null when ADE Cloud didn't say. */
  diskGb: number | null;
  /** What uses it, from the computer's own last measure; null before one. */
  usedGb: number | null;
  /** Asleep or stopped: no turn runs on it, so there is no turn to stop. */
  resting?: boolean;
};

/** A cloud computer's disk facts for the change card. */
export function tierChangeComputerOf(machine: Pick<CloudMachine, "resources" | "diskUsage" | "state">): TierChangeComputer {
  return {
    diskGb: machine.resources?.diskGb ?? null,
    usedGb: machine.diskUsage?.totalGb ?? null,
    resting: machine.state === "asleep" || machine.state === "stopped",
  };
}

const roundGb = (gb: number) => Math.max(0, Math.floor(gb * 10) / 10);

/**
 * One line on the disk at the new size: a size change keeps the disk as it is
 * ("Disk stays 4 GB; Medium lets it grow to 20 GB."); a move gets a new computer.
 */
export function tierChangeDiskLine(input: { to: CloudTier; move: boolean; currentGb: number | null }): string | null {
  const { to, move, currentGb } = input;
  const max = to.diskMaxGb;
  if (move) return max != null ? `The new computer's disk can grow to ${max} GB at ${to.label}.` : null;
  if (currentGb == null) return max != null ? `The disk keeps its size; ${to.label} lets it grow to ${max} GB.` : null;
  if (max != null && max > currentGb) return `Disk stays ${currentGb} GB; ${to.label} lets it grow to ${max} GB.`;
  return `Disk stays ${currentGb} GB.`;
}

/**
 * The disk sizes a resize can grow to in the same restart: whole steps above
 * the disk now, up to the size's cap. Empty when the size holds no more.
 */
export function tierChangeDiskChoices(input: {
  account: CloudAccountState | null;
  to: CloudTier;
  currentGb: number | null;
}): { choices: number[]; why: string | null } {
  const { account, to, currentGb } = input;
  if (currentGb == null) return { choices: [], why: null };
  const catalog = cloudCatalogOf(account);
  const step = catalog.diskStepGb > 0 ? catalog.diskStepGb : 4;
  const capGb = to.diskMaxGb ?? Number.POSITIVE_INFINITY;
  if (capGb <= currentGb) return { choices: [], why: null };
  const choices: number[] = [];
  for (let gb = currentGb + step; gb <= capGb && Number.isFinite(gb); gb += step) choices.push(gb);
  return { choices, why: null };
}

/**
 * Before a change to a size that runs Android: whether the lane's computer
 * will have the room an Android device needs on its first start (about
 * 7.2 GB free, `androidDisk.ts`), and if not, which size gives it. Null for a size that doesn't run Android.
 */
export function tierChangeAndroidNote(input: {
  account: CloudAccountState | null;
  to: CloudTier;
  computer: TierChangeComputer;
}): { fits: boolean; sentence: string } | null {
  const { account, to, computer } = input;
  if (!cloudTierFacts(to).full) return null;
  const needGb = androidFirstStartNeedMb() / 1024;
  const need = `${roundGb(needGb)} GB`;
  const currentGb = computer.diskGb;
  // The lane's files come along; before a first measure, the whole disk counts.
  const usedGb = computer.usedGb ?? currentGb;
  if (usedGb == null || currentGb == null) {
    return { fits: true, sentence: `Android needs about ${need} free on the disk for its first start.` };
  }
  const maxDiskGb = to.diskMaxGb ?? Number.POSITIVE_INFINITY;
  const freeGb = maxDiskGb - usedGb;
  if (!Number.isFinite(freeGb) || freeGb >= needGb) {
    return {
      fits: true,
      sentence: Number.isFinite(freeGb)
        ? `Android needs about ${need} free for its first start; this lane's computer can have about ${roundGb(freeGb)} GB free.`
        : `Android needs about ${need} free on the disk for its first start.`,
    };
  }
  const needDiskGb = usedGb + needGb;
  const ways: string[] = [];
  // A bigger size first, when this one's disk can't hold it at all.
  if (to.diskMaxGb != null && to.diskMaxGb < needDiskGb) {
    const bigger = cloudTiers(cloudCatalogOf(account)).find((tier) => cloudTierFacts(tier).full && (tier.diskMaxGb ?? 0) >= needDiskGb);
    if (bigger) ways.push(`pick ${bigger.label}`);
  }
  const way = ways.length ? ` To run Android, ${ways.join(", or ")}.` : " To run Android, free up space on it first.";
  return {
    fits: false,
    sentence: `Android needs about ${need} free for its first start, and this lane's computer could have only about ${roundGb(Math.max(0, freeGb))} GB free.${way}`,
  };
}
