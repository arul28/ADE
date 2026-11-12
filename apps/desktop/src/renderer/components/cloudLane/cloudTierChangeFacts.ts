import {
  CLOUD_PLAN_LABELS,
  CLOUD_PLAN_RANK,
  cloudCatalogHasPro,
  cloudCatalogOf,
  cloudPlanIdOf,
  type CloudAccountState,
} from "../../../shared/adeCloud";
import { androidFirstStartNeedMb } from "../../../shared/androidDisk";
import { cloudTierFacts, cloudTiers, type CloudTier } from "../../../shared/cloudTiers";

/**
 * What a size change means for the lane's disk, in plain words, from data
 * only: the computer's disk and its last measure, the size's disk cap, the
 * plan's disk and what the account's computers use. Nothing here knows a
 * provider, an OS or a plan by name; the catalog says what each one allows.
 */

/** The lane's computer as the change card needs it. */
export type TierChangeComputer = {
  /** Its disk now, in GB; null when ADE Cloud didn't say. */
  diskGb: number | null;
  /** What uses it, from the computer's own last measure; null before one. */
  usedGb: number | null;
};

const roundGb = (gb: number) => Math.max(0, Math.floor(gb * 10) / 10);

/** Room on the plan's disk for this one computer: the plan's disk, less what the others use. Null with no plan limit. */
function planRoomForComputerGb(account: CloudAccountState | null, currentGb: number): number | null {
  const limitGb = account?.disk?.limitGb;
  if (limitGb == null || !account) return null;
  const othersGb = Math.max(0, account.disk.usedGb - currentGb);
  return limitGb - othersGb;
}

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
 * the disk now, up to the size's cap and what the plan's disk has room for
 * (never past it, so a grow here never adds a charge for extra disk). Empty
 * with a reason when none fits.
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
  const roomGb = planRoomForComputerGb(account, currentGb);
  const maxGb = Math.min(capGb, roomGb ?? capGb);
  const choices: number[] = [];
  for (let gb = currentGb + step; gb <= maxGb && Number.isFinite(gb); gb += step) choices.push(gb);
  if (choices.length) return { choices, why: null };
  // The size could hold more, but the plan's disk is in use.
  const limitGb = account?.disk.limitGb ?? null;
  if (limitGb == null) return { choices: [], why: null };
  const better = planWithDisk(account, limitGb + step);
  return {
    choices: [],
    why: `Your computers use your plan's ${limitGb} GB of disk. Delete a computer you no longer use${better ? `, or get ${better.label}` : ""}, to grow it.`,
  };
}

/** The cheapest plan above the account's that has at least `needGb` of disk, from the catalog. */
function planWithDisk(account: CloudAccountState | null, needGb: number): { label: string; diskGb: number } | null {
  if (!account) return null;
  const catalog = cloudCatalogOf(account);
  const rank = CLOUD_PLAN_RANK[cloudPlanIdOf(account)];
  const plans = cloudCatalogHasPro(catalog)
    ? ([["plus", catalog.plans.plus], ["pro", catalog.plans.pro]] as const)
    : ([["plus", catalog.plans.paid]] as const);
  for (const [id, facts] of plans) {
    if (CLOUD_PLAN_RANK[id] <= rank) continue;
    if (facts.diskGb >= needGb) return { label: cloudCatalogHasPro(catalog) ? CLOUD_PLAN_LABELS[id] : "a paid plan", diskGb: facts.diskGb };
  }
  return null;
}

/**
 * Before a change to a size that runs Android: whether the lane's computer
 * will have the room an Android device needs on its first start (about
 * 7.2 GB free, `androidDisk.ts`), and if not, which size, cleanup or plan
 * gives it. Null for a size that doesn't run Android.
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
  const roomGb = planRoomForComputerGb(account, currentGb);
  const maxDiskGb = Math.min(to.diskMaxGb ?? Number.POSITIVE_INFINITY, roomGb ?? Number.POSITIVE_INFINITY);
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
  const limitGb = account?.disk.limitGb ?? null;
  if (limitGb != null) {
    const othersGb = Math.max(0, (account?.disk.usedGb ?? 0) - currentGb);
    if (othersGb > 0 && limitGb >= needDiskGb) ways.push(`delete other computers first (they use ${roundGb(othersGb)} GB)`);
    const plan = planWithDisk(account, othersGb + needDiskGb);
    if (plan) ways.push(`get ${plan.label} (${plan.diskGb} GB of disk)`);
  }
  const shared = limitGb != null && account
    ? ` Your plan's ${limitGb} GB of disk is shared by all your computers.`
    : "";
  const way = ways.length ? ` To run Android, ${ways.join(", or ")}.` : "";
  return {
    fits: false,
    sentence: `Android needs about ${need} free for its first start, and this lane's computer could have only about ${roundGb(Math.max(0, freeGb))} GB free.${shared}${way}`,
  };
}
