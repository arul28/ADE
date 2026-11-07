import type { AndroidAvd } from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import {
  readHostMemorySignals,
  readProcessMemory,
  type HostMemoryPressure,
  type HostMemorySignals,
  type ProcessMemory,
} from "../machineStats/hostMemorySignals";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import { ANDROID_QEMU_IMAGE_PREFIX } from "./androidEmulatorImage";

/*
 * The memory guard: before a boot, refuse a start that would push the
 * machine into swap. The person can start it anyway (`force`).
 *
 * It decides on what the machine has committed, not on a free-memory
 * snapshot (a machine already swapping still reads as having memory free;
 * `hostMemorySignals.ts` says why). So a start is refused when ANY of these
 * holds:
 *
 * 1. the OS says memory is under pressure (warn or worse;
 *    `hostMemorySignals.ts` reads it per OS);
 * 2. the machine is writing to swap now (`ANDROID_PAGING_REFUSE_MB_PER_S`
 *    over a 2 s sample, taken only here, at start);
 * 3. every running emulator's real memory (the user's and other brains'
 *    included), the boots in flight (less what their own qemu already
 *    measures, so a booting emulator counts once), and this one would pass
 *    `ANDROID_EMULATOR_BUDGET_SHARE` of physical memory. The first emulator
 *    is never refused by this rule alone: the other three judge it, so a
 *    small machine can still run one;
 * 4. what the OS can hand out, less the boots in flight and this one, would
 *    leave less than `ANDROID_MEMORY_RESERVE_MB`.
 *
 * "Real memory" is the macOS footprint (resident + compressed + swapped),
 * Linux RSS + swap, Windows the private commit: plain RSS read 2.3 GB for an
 * emulator whose footprint was 8.4 GB.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** The guest RAM an AVD gets when its `config.ini` does not say. */
export const ANDROID_DEFAULT_GUEST_RAM_MB = 2_048;
/**
 * The emulator's own memory beyond the guest's when nothing was measured for
 * the AVD: as much again as the guest (QEMU's copy-on-write and DMA buffers,
 * the GPU's buffers under `-gpu auto`, which falls back to SwiftShader when
 * there is no window) plus this much. A 2 GB foldable AVD measured 8.4 GB
 * footprint (6.4 GB over its guest) after a day of use; a fresh boot of a
 * 2 GB phone runs about 4–5 GB. A measured value (`overheadByAvd` in the
 * owner file, from an emulator running at least 5 minutes) replaces this.
 */
export const ANDROID_EMULATOR_OVERHEAD_BASE_MB = 1_536;
/** A measured overhead below this is a read taken before the emulator warmed up; it is not trusted lower. */
const ANDROID_EMULATOR_OVERHEAD_FLOOR_MB = 1_024;
/** All emulators together may use this share of physical memory. */
export const ANDROID_EMULATOR_BUDGET_SHARE = 0.5;
/** What the machine keeps free after the start, so the rest of it stays responsive. */
export const ANDROID_MEMORY_RESERVE_MB = 1_024;
/**
 * Swap writes this fast mean the machine is already short. Idle macOS and
 * Linux write 0; a burst from one app settles within the 2 s sample.
 */
export const ANDROID_PAGING_REFUSE_MB_PER_S = 4;
/** How long the start samples the swap-out rate. */
export const ANDROID_PAGING_SAMPLE_MS = 2_000;
/** Every emulator's qemu, whichever SDK or tool started it (`-headless` included). */
export const ANDROID_EMULATOR_PROCESS_PREFIXES = [ANDROID_QEMU_IMAGE_PREFIX] as const;

/** What one start costs, and where the number came from. */
export type AndroidStartCost = { costMb: number; guestRamMb: number; overheadMb: number; measured: boolean };

/**
 * The memory one emulator of this AVD takes: its guest RAM plus the AVD's
 * measured overhead, else the largest overhead measured on this machine,
 * else the default above.
 */
export function androidEmulatorStartCost(args: {
  guestRamMb: number | null;
  measuredOverheadMb?: number | null;
  machineOverheadMb?: number | null;
}): AndroidStartCost {
  const guestRamMb = args.guestRamMb && args.guestRamMb > 0 ? args.guestRamMb : ANDROID_DEFAULT_GUEST_RAM_MB;
  const learned = args.measuredOverheadMb ?? args.machineOverheadMb ?? null;
  const overheadMb = learned !== null && learned > 0
    ? Math.max(ANDROID_EMULATOR_OVERHEAD_FLOOR_MB, Math.round(learned))
    : guestRamMb + ANDROID_EMULATOR_OVERHEAD_BASE_MB;
  return { costMb: guestRamMb + overheadMb, guestRamMb, overheadMb, measured: learned !== null && learned > 0 };
}

/* ---------- boots in flight ---------- */

/** The emulator a boot launched: how a later start finds its qemu among the measured processes. */
export type AndroidBootEmulator = { avdName: string; consolePort: number; launcherPid: number };

/** One boot in flight: what it holds, and its emulator once launched (null before the spawn). */
export type AndroidBootInFlight = { mb: number; emulator: AndroidBootEmulator | null };

/**
 * Boots in flight in this process, every project's. Their emulators have not
 * taken all their memory yet, so a start counts the ones that began before
 * it; two lanes that start together cannot both fit into the same free
 * memory. Other brains' boots are counted through the owner file's
 * reservations.
 */
const bootsInFlight = new Map<number, AndroidBootInFlight>();
let nextBootId = 1;

export type AndroidBootReservation = {
  /** The memory of the boots that began before this one, in MB. */
  earlierMb: () => number;
  /** The boots that began before this one. */
  earlierBoots: () => AndroidBootInFlight[];
  /** The boot spawned its emulator: a later start counts only what that emulator has not taken yet. */
  launched: (emulator: AndroidBootEmulator) => void;
  /** The boot ended (booted, failed or refused). Safe to call twice. */
  release: () => void;
};

/** Holds `needMb` for one boot until `release`. */
export function reserveAndroidBootMemory(needMb: number): AndroidBootReservation {
  const id = nextBootId++;
  bootsInFlight.set(id, { mb: needMb, emulator: null });
  const earlierBoots = () => [...bootsInFlight].filter(([other]) => other < id).map(([, boot]) => ({ ...boot }));
  return {
    earlierMb: () => earlierBoots().reduce((sum, boot) => sum + boot.mb, 0),
    earlierBoots,
    launched: (emulator) => {
      const boot = bootsInFlight.get(id);
      if (boot) boot.emulator = { ...emulator };
    },
    release: () => {
      bootsInFlight.delete(id);
    },
  };
}

/**
 * The part of the earlier boots' reservations their own emulators already
 * use: per boot, the measured memory of its qemu (the discovery file's pid
 * for its AVD and console port, else the launcher's, which is qemu on macOS
 * and Linux), capped at what the boot reserved. A boot not yet launched, or
 * whose qemu is not listed yet, adds nothing, so it counts in full.
 */
export function androidBootsMeasuredMb(
  boots: readonly AndroidBootInFlight[],
  emulators: readonly ProcessMemory[],
  discovered: readonly { avdName: string; consolePort: number; pid: number }[],
): number {
  let total = 0;
  for (const boot of boots) {
    const emulator = boot.emulator;
    if (!emulator) continue;
    const qemuPid = discovered.find((entry) =>
      entry.consolePort === emulator.consolePort && entry.avdName.toLowerCase() === emulator.avdName.toLowerCase())?.pid ?? null;
    const measuredMb = emulators
      .filter((measured) => measured.pid === emulator.launcherPid || measured.pid === qemuPid)
      .reduce((sum, measured) => sum + measured.mb, 0);
    total += Math.min(boot.mb, Math.max(0, measuredMb));
  }
  return total;
}

/* ---------- the decision, pure ---------- */

export type AndroidMemoryFacts = {
  totalMb: number;
  availableMb: number | null;
  pressure: HostMemoryPressure | null;
  pagingOutMbPerSec: number | null;
  /** Every running emulator's real memory, ADE's or not. */
  emulatorsMb: number;
  emulatorCount: number;
  /** Boots that passed the guard before this one and have not finished: what they reserved. */
  earlierBootsMb: number;
  earlierBootCount: number;
  /** The part of `earlierBootsMb` already in `emulatorsMb` (`androidBootsMeasuredMb`): a booting emulator counts once. */
  earlierBootsMeasuredMb: number;
  costMb: number;
};

export type AndroidMemoryRefusal = "pressure" | "paging" | "budget" | "available";

export type AndroidMemoryVerdict = {
  /** Null when the start fits. */
  refusal: AndroidMemoryRefusal | null;
  budgetMb: number;
  /** The emulators and earlier boots, before this one. */
  usedMb: number;
  /** What the earlier boots still have to take, beyond what their emulators already use. */
  pendingBootsMb: number;
};

/** Whether one start fits, from the facts read for it. */
export function decideAndroidMemoryStart(facts: AndroidMemoryFacts): AndroidMemoryVerdict {
  const budgetMb = Math.round(facts.totalMb * ANDROID_EMULATOR_BUDGET_SHARE);
  const pendingBootsMb = Math.max(0, facts.earlierBootsMb - facts.earlierBootsMeasuredMb);
  const usedMb = facts.emulatorsMb + pendingBootsMb;
  const verdict = (refusal: AndroidMemoryRefusal | null): AndroidMemoryVerdict => ({ refusal, budgetMb, usedMb, pendingBootsMb });
  if (facts.pressure === "warn" || facts.pressure === "critical") return verdict("pressure");
  if (facts.pagingOutMbPerSec !== null && facts.pagingOutMbPerSec >= ANDROID_PAGING_REFUSE_MB_PER_S) return verdict("paging");
  const othersRunning = facts.emulatorCount + facts.earlierBootCount > 0;
  if (othersRunning && usedMb + facts.costMb > budgetMb) return verdict("budget");
  if (facts.availableMb !== null && facts.availableMb - pendingBootsMb - facts.costMb < ANDROID_MEMORY_RESERVE_MB) {
    return verdict("available");
  }
  return verdict(null);
}

/** `2.9 GB`, one decimal place. */
export function formatAndroidMemoryGb(mb: number): string {
  return `${(Math.max(0, mb) / 1024).toFixed(1)} GB`;
}

/**
 * The refusal as one sentence the pane shows whole (it cuts at 140
 * characters), naming the numbers and the way out.
 */
export function describeAndroidMemoryRefusal(
  refusal: AndroidMemoryRefusal,
  facts: AndroidMemoryFacts,
  verdict: AndroidMemoryVerdict,
  deviceName: string,
): string {
  const next = facts.emulatorCount > 0 ? "Stop an emulator first." : "Close some apps first.";
  const using = facts.emulatorCount > 0 ? `; emulators use ${formatAndroidMemoryGb(facts.emulatorsMb)}` : "";
  switch (refusal) {
    case "pressure":
      return `This machine is short of memory now (pressure: ${facts.pressure ?? "high"}${using}). ${next}`;
    case "paging":
      return `This machine is swapping to disk now (${facts.pagingOutMbPerSec ?? 0} MB/s${using}). ${next}`;
    case "budget":
      return `${deviceName} needs about ${formatAndroidMemoryGb(facts.costMb)}; emulators already use ${formatAndroidMemoryGb(verdict.usedMb)} `
        + `of the ${formatAndroidMemoryGb(verdict.budgetMb)} ADE allows. Stop an emulator first.`;
    case "available":
      return `${deviceName} needs about ${formatAndroidMemoryGb(facts.costMb)}, and this machine has `
        + `${formatAndroidMemoryGb((facts.availableMb ?? 0) - verdict.pendingBootsMb)} free. ${next}`;
  }
}

/* ---------- the guard before one start ---------- */

/** What the guard needs from the machine's owner file (`androidEmulatorSweep.ts`); absent = this process only. */
export type AndroidMemoryLedger = {
  /** This AVD's measured overhead, and the largest one measured on the machine. */
  overheadFor: (avdName: string) => { avdMb: number | null; machineMb: number | null };
  /** Records `mb` for one boot; the answer lists other brains' earlier boots, names its emulator, and releases it. */
  reserve: (mb: number) => Pick<AndroidBootReservation, "earlierBoots" | "launched" | "release">;
  /** Running emulators' real memory was read: the ledger keeps what it learns about ADE's (warm overheads). */
  observe?: (emulators: readonly ProcessMemory[]) => void;
};

export type AndroidMemoryReaders = {
  signals?: () => Promise<HostMemorySignals>;
  emulators?: (discoveryPids: readonly number[]) => Promise<ProcessMemory[]>;
};

/**
 * The guard before one start: refuse a boot that would push the machine into
 * swap, counting the boots already in flight here and in other brains. The
 * answer holds this boot's memory until the caller releases it; a forced
 * start holds it too, so the next start counts it.
 */
export async function reserveAndroidMemoryForStart(args: {
  laneId: string;
  avd: AndroidAvd;
  force: boolean;
  platform: NodeJS.Platform;
  logger: Logger | null;
  /**
   * The discovery files' emulators: their qemu pids are measured, so one with
   * a renamed binary still counts, and they match a booting emulator to its
   * boot's reservation.
   */
  discovered?: readonly { avdName: string; consolePort: number; pid: number }[];
  ledger?: AndroidMemoryLedger | null;
  readers?: AndroidMemoryReaders;
}): Promise<AndroidBootReservation & { cost: AndroidStartCost }> {
  const { laneId, avd, logger, platform } = args;
  const overhead = args.ledger?.overheadFor(avd.name) ?? { avdMb: null, machineMb: null };
  const cost = androidEmulatorStartCost({ guestRamMb: avd.ramMb, measuredOverheadMb: overhead.avdMb, machineOverheadMb: overhead.machineMb });
  const local = reserveAndroidBootMemory(cost.costMb);
  const shared = args.ledger?.reserve(cost.costMb) ?? null;
  const reservation: AndroidBootReservation & { cost: AndroidStartCost } = {
    cost,
    earlierMb: () => local.earlierMb() + (shared?.earlierBoots().reduce((sum, boot) => sum + boot.mb, 0) ?? 0),
    earlierBoots: () => [...local.earlierBoots(), ...(shared?.earlierBoots() ?? [])],
    launched: (emulator) => {
      local.launched(emulator);
      // Best effort: a busy owner file only costs the other brains' accuracy
      // (they count this boot in full), never the boot itself.
      try {
        shared?.launched(emulator);
      } catch (error) {
        logger?.warn("android.boot_ledger_update_failed", { laneId, error: error instanceof Error ? error.message : String(error) });
      }
    },
    release: () => {
      local.release();
      shared?.release();
    },
  };
  if (args.force) return reservation;
  const discovered = args.discovered ?? [];
  const [signals, emulators] = await Promise.all([
    (args.readers?.signals ?? (() => readHostMemorySignals({ platform, pagingSampleMs: ANDROID_PAGING_SAMPLE_MS })))(),
    (args.readers?.emulators ?? ((pids) => readProcessMemory({ pids, namePrefixes: ANDROID_EMULATOR_PROCESS_PREFIXES, platform })))(
      discovered.map((emulator) => emulator.pid),
    ),
  ]);
  args.ledger?.observe?.(emulators);
  if (signals.availableMb === null) logger?.warn("android.start_memory_unread", { laneId });
  // This process's boots and other brains' (the owner file's list leaves this process's out).
  const earlierBoots = reservation.earlierBoots();
  const facts: AndroidMemoryFacts = {
    totalMb: signals.totalMb,
    availableMb: signals.availableMb,
    pressure: signals.pressure,
    pagingOutMbPerSec: signals.pagingOutMbPerSec,
    emulatorsMb: emulators.reduce((sum, emulator) => sum + emulator.mb, 0),
    emulatorCount: emulators.length,
    earlierBootsMb: earlierBoots.reduce((sum, boot) => sum + boot.mb, 0),
    earlierBootCount: earlierBoots.length,
    earlierBootsMeasuredMb: androidBootsMeasuredMb(earlierBoots, emulators, discovered),
    costMb: cost.costMb,
  };
  const verdict = decideAndroidMemoryStart(facts);
  if (!verdict.refusal) return reservation;
  reservation.release();
  logger?.info("android.start_low_memory", {
    laneId,
    reason: verdict.refusal,
    costMb: cost.costMb,
    costMeasured: cost.measured,
    emulatorsMb: facts.emulatorsMb,
    emulatorCount: facts.emulatorCount,
    earlierBootsMb: facts.earlierBootsMb,
    earlierBootsMeasuredMb: facts.earlierBootsMeasuredMb,
    budgetMb: verdict.budgetMb,
    availableMb: facts.availableMb,
    pressure: facts.pressure,
    pagingOutMbPerSec: facts.pagingOutMbPerSec,
    swapUsedMb: signals.swapUsedMb,
  });
  throw new AndroidEmulatorFailure(
    "ANDROID_LOW_MEMORY",
    describeAndroidMemoryRefusal(verdict.refusal, facts, verdict, avd.displayName ?? avd.name),
  );
}
