import type {
  AppleDeviceDiskUsage,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleSimulatorOwner,
} from "../../../shared/types/iosSimulator";

/**
 * Which group each installed device is in, computed over
 * `deviceList().owners`. The picker only renders it: the lane's own device (no
 * fallback), free devices, and devices another lane holds (never offered an
 * Open).
 */

export type ApplePickerElsewhereEntry = {
  simulator: AppleInstalledSimulator;
  owner: AppleSimulatorOwner;
};

export type ApplePickerPartition = {
  /** This lane's own device, and only ever this lane's own device. */
  mine: AppleInstalledSimulator | null;
  /**
   * The lane owns a device record whose simulator is not installed any more.
   *
   * A real state — the user deleted it in Xcode — and one that must not read
   * as "this lane has no device", because the lane's registry row is still
   * there and still points at a udid.
   */
  laneDeviceMissing: boolean;
  /** Installed, and no lane holds it. */
  available: AppleInstalledSimulator[];
  /** Installed, and another lane holds it. Never offered an Open. */
  elsewhere: ApplePickerElsewhereEntry[];
};

export type ApplePickerPartitionInput = {
  installed: readonly AppleInstalledSimulator[];
  owners?: readonly AppleSimulatorOwner[] | null;
  laneDevice?: AppleLaneDevice | null;
};

/**
 * The lane's own udid.
 *
 * `laneDevice` is the direct answer; `owners`' own `mine` flag is the fallback
 * for a caller that has one and not the other. Both come from the same
 * `deviceList` payload, so they cannot disagree — and if they ever do, the
 * lane record wins, because it is the row the service starts from.
 */
export function appleLaneOwnedUdid(input: ApplePickerPartitionInput): string | null {
  const direct = input.laneDevice?.udid?.trim();
  if (direct) return direct;
  const flagged = (input.owners ?? []).find((owner) => owner.mine);
  return flagged?.udid?.trim() || null;
}

export function partitionApplePickerDevices(input: ApplePickerPartitionInput): ApplePickerPartition {
  const owners = new Map<string, AppleSimulatorOwner>();
  for (const owner of input.owners ?? []) owners.set(owner.udid, owner);

  const mineUdid = appleLaneOwnedUdid(input);
  let mine: AppleInstalledSimulator | null = null;
  const available: AppleInstalledSimulator[] = [];
  const elsewhere: ApplePickerElsewhereEntry[] = [];

  for (const simulator of input.installed) {
    if (mineUdid && simulator.udid === mineUdid) {
      mine = simulator;
      continue;
    }
    const owner = owners.get(simulator.udid);
    // `mine` on a udid that is not this lane's own record would be a payload
    // contradiction; treat it as free rather than inventing a fourth group.
    if (owner && !owner.mine) {
      elsewhere.push({ simulator, owner });
      continue;
    }
    available.push(simulator);
  }

  return {
    mine,
    laneDeviceMissing: Boolean(mineUdid) && mine === null,
    available,
    elsewhere,
  };
}

/** Udids another lane holds. */
export function appleUdidsHeldElsewhere(
  owners: readonly AppleSimulatorOwner[] | null | undefined,
): Set<string> {
  return new Set((owners ?? []).filter((owner) => !owner.mine).map((owner) => owner.udid));
}

/**
 * A device a copy can be made from: not booted (`simctl clone` refuses a
 * booted device) and not held by another lane.
 */
export function isAppleCloneSource(
  simulator: Pick<AppleInstalledSimulator, "udid" | "state">,
  heldElsewhere: Pick<ReadonlySet<string>, "has">,
): boolean {
  return simulator.state !== "Booted" && !heldElsewhere.has(simulator.udid);
}

/**
 * Which device the Create control starts on.
 *
 * `pickAppleTemplate`'s precedence on the service side — the project's
 * last-used template, then the newest iPhone, then the newest anything — with
 * two candidates ruled out first, both for reasons `simctl` enforces or the
 * picker just learned:
 *
 * - A BOOTED device cannot be cloned. `simctl clone` refuses with "Unable to
 *   clone device in current state: Booted", so defaulting to one hands the
 *   user a button that cannot work.
 * - A device another LANE owns is not this page's to copy by default. It can
 *   still be chosen deliberately; it is not the resting position.
 *
 * Both are preferences, not prohibitions: if every installed device is booted
 * or owned, the full pool comes back, because a control with no default is
 * worse than one whose default the service will explain.
 *
 * This is a TEMPLATE to copy and says nothing about ownership. The fallback
 * that must never exist is a hero card, not a pre-selected clone source.
 */
export function appleDefaultTemplateUdid(input: {
  installed: readonly AppleInstalledSimulator[];
  lastUsedUdid?: string | null;
  owners?: readonly AppleSimulatorOwner[] | null;
}): string {
  const heldElsewhere = appleUdidsHeldElsewhere(input.owners);
  const cloneable = input.installed.filter((entry) => isAppleCloneSource(entry, heldElsewhere));
  // The last used template only wins while it is still cloneable.
  const lastUsed = input.lastUsedUdid?.trim();
  if (lastUsed && cloneable.some((entry) => entry.udid === lastUsed)) return lastUsed;
  const candidates = cloneable.length > 0 ? cloneable : input.installed;
  const phones = candidates.filter((entry) => entry.family === "iphone");
  const pool = phones.length > 0 ? phones : candidates;
  const newest = [...pool].sort((a, b) => {
    const byRuntime = b.runtime.localeCompare(a.runtime, undefined, { numeric: true });
    return byRuntime !== 0 ? byRuntime : a.name.localeCompare(b.name);
  })[0];
  return newest?.udid ?? "";
}

/**
 * Bytes as the owner reads them: `18.2 GB`, `612 MB`.
 *
 * One decimal from a gigabyte up, none below it — the number that matters to
 * someone at 15 GB free is the gigabytes, and `18.23 GB` spends two digits
 * saying nothing. Anything under a kilobyte is `0 KB` rather than a byte
 * count, because a device directory measured in bytes is a directory that is
 * not really there.
 */
function appleDiskLabel(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const KIB = 1024;
  if (bytes < KIB) return "0 KB";
  if (bytes < KIB ** 2) return `${Math.round(bytes / KIB)} KB`;
  if (bytes < KIB ** 3) return `${Math.round(bytes / KIB ** 2)} MB`;
  if (bytes < KIB ** 4) return `${(bytes / KIB ** 3).toFixed(1)} GB`;
  return `${(bytes / KIB ** 4).toFixed(1)} TB`;
}

/** One device's measured cost, or null when nothing measured it. */
export function appleDeviceDiskLabel(
  disk: AppleDeviceDiskUsage | null | undefined,
  udid: string,
): string | null {
  const row = disk?.devices.find((entry) => entry.udid === udid);
  return row ? appleDiskLabel(row.bytes) : null;
}

/**
 * How to name the lane holding a device.
 *
 * The display name when there is one. Never the raw id: "in use by lane
 * dca9f144" names nothing a person recognises, and a lane whose name cannot be
 * resolved is better described as "another lane" than as a hex string the
 * reader has to go and look up.
 */
export function appleOwnerLaneLabel(owner: Pick<AppleSimulatorOwner, "laneName">): string {
  const name = owner.laneName?.trim();
  return name ? `lane ${name}` : "another lane";
}
