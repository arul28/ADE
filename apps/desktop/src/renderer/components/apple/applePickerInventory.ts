import type {
  AppleDeviceDiskUsage,
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleSimulatorOwner,
} from "../../../shared/types/iosSimulator";

/**
 * What the picker is allowed to say, as arithmetic rather than as prose.
 *
 * Round 5's live test found a picker that lied three ways at once, and every
 * one of them was a rule that lived inside a JSX expression:
 *
 * - Five installed simulators read as four, because the hero was lifted out of
 *   its family section and so read as a separate kind of thing.
 * - The hero was NOT the lane's device. The lane had none, so the picker fell
 *   back to "the newest installed iPhone" — a card that says *your device* and
 *   is not. There is no fallback hero here; a lane with no device gets a slot
 *   that says so.
 * - It offered Open on a simulator another lane owned, with nothing on screen
 *   to say so. The same blind spot made an agent stop and ask a human for
 *   permission rather than create its own device.
 *
 * So membership is a partition computed here, over `deviceList().owners`, and
 * the component only renders it. Pure and separately tested, because "which
 * group is this device in" is the question the picker got wrong.
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
  const heldElsewhere = new Set(
    (input.owners ?? []).filter((owner) => !owner.mine).map((owner) => owner.udid),
  );
  const cloneable = input.installed.filter(
    (entry) => entry.state !== "Booted" && !heldElsewhere.has(entry.udid),
  );
  /*
   * The last used template only wins if it is still CLONEABLE.
   *
   * It used to win on being installed alone, which put the project's last
   * template in the Create slot even when it had since been booted or taken by
   * another lane — and `simctl clone` on a booted device fails. So the one
   * source the page offered by default was the one source that could not
   * work, and the owner would have read the failure as "Create is broken".
   */
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

export type AppleInventorySummary = {
  /** `iOS 26.3`, `iOS 26.3 and iPadOS 26.3`, `iOS 26.3 and 2 more runtimes`. */
  runtimeLabel: string | null;
  installedCount: number;
  runningCount: number;
  /** `iOS 26.3 · 5 simulators installed · 2 running`. */
  text: string;
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The runtime, spelled out, because one install serves any number of devices.
 *
 * The owner did not know that. He counted his simulators and read five
 * separate things that each looked like it might cost another multi-gigabyte
 * download. Naming the runtime once, above a count of the devices sharing it,
 * is the whole point of this line — which is why the runtime comes FIRST and
 * the counts hang off it.
 */
export function appleRuntimeLabel(installed: readonly AppleInstalledSimulator[]): string | null {
  const counts = new Map<string, number>();
  for (const simulator of installed) {
    const runtime = simulator.runtime?.trim();
    if (!runtime) continue;
    counts.set(runtime, (counts.get(runtime) ?? 0) + 1);
  }
  const ordered = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([runtime]) => runtime);
  if (ordered.length === 0) return null;
  if (ordered.length === 1) return ordered[0]!;
  if (ordered.length === 2) return `${ordered[0]} and ${ordered[1]}`;
  return `${ordered[0]} and ${plural(ordered.length - 1, "more runtime", "more runtimes")}`;
}

export function appleInventorySummary(
  installed: readonly AppleInstalledSimulator[],
): AppleInventorySummary {
  const runtimeLabel = appleRuntimeLabel(installed);
  const installedCount = installed.length;
  const runningCount = installed.filter((simulator) => simulator.state === "Booted").length;
  const counts = `${plural(installedCount, "simulator installed", "simulators installed")} · ${runningCount} running`;
  return {
    runtimeLabel,
    installedCount,
    runningCount,
    text: runtimeLabel ? `${runtimeLabel} · ${counts}` : counts,
  };
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
export function appleDiskLabel(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
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
