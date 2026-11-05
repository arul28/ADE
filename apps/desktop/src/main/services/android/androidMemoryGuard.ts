import { execFile } from "node:child_process";
import os from "node:os";

/*
 * The RAM guard (plan §5): before a boot, compare what the emulator needs
 * with what the machine has free, and refuse a start that would push the
 * machine into swap. The person can start it anyway (`force`).
 *
 * "Free" is the memory the OS can give without swapping:
 *
 * - macOS: `os.freemem()` counts only free pages and leaves out the file
 *   cache the kernel gives back at once, so it reads far too low. The kernel's
 *   own gauge, `kern.memorystatus_level`, is the percent of memory available
 *   (what `memory_pressure` prints); times the total, it is the free memory.
 * - Windows: `os.freemem()` is the available physical memory.
 * - Linux: `os.freemem()` is `MemAvailable`.
 *
 * Node built-ins only, so it runs under `tsx`.
 */

/** The emulator process itself, beyond the guest's RAM (QEMU, the GPU, the snapshot). */
export const ANDROID_EMULATOR_OVERHEAD_MB = 900;
/** The guest RAM an AVD gets when its `config.ini` does not say. */
export const ANDROID_DEFAULT_GUEST_RAM_MB = 2_048;
/** What the machine keeps free after the start, so the rest of it stays responsive. */
export const ANDROID_MEMORY_RESERVE_MB = 1_024;

const MB = 1024 * 1024;

/** The memory one emulator of this AVD takes, in MB. */
export function androidEmulatorMemoryNeedMb(guestRamMb: number | null): number {
  const guest = guestRamMb && guestRamMb > 0 ? guestRamMb : ANDROID_DEFAULT_GUEST_RAM_MB;
  return guest + ANDROID_EMULATOR_OVERHEAD_MB;
}

function readMemorystatusLevel(timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("/usr/sbin/sysctl", ["-n", "kern.memorystatus_level"], { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const level = Number(String(stdout).trim());
      resolve(Number.isFinite(level) && level >= 0 && level <= 100 ? level : null);
    });
  });
}

/**
 * The memory the machine can give without swapping, in MB. Null on macOS when
 * the kernel's gauge cannot be read: `os.freemem()` there would refuse starts
 * that fit, so the caller skips the guard instead.
 */
export async function readHostAvailableMemoryMb(options: {
  platform?: NodeJS.Platform;
  totalBytes?: number;
  freeBytes?: number;
  readLevel?: (timeoutMs: number) => Promise<number | null>;
} = {}): Promise<number | null> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const level = await (options.readLevel ?? readMemorystatusLevel)(2_000);
    return level === null ? null : Math.round(((options.totalBytes ?? os.totalmem()) * level) / 100 / MB);
  }
  return Math.round((options.freeBytes ?? os.freemem()) / MB);
}

/**
 * Boots in flight on this machine, every project's. Their emulators have not
 * taken their memory yet, so a start subtracts the ones that began before it;
 * two lanes that start together cannot both fit into the same free memory.
 */
const bootsInFlight = new Map<number, number>();
let nextBootId = 1;

export type AndroidBootReservation = {
  /** The memory of the boots that began before this one, in MB. */
  earlierMb: () => number;
  /** The boot ended (booted, failed or refused). Safe to call twice. */
  release: () => void;
};

/** Holds `needMb` for one boot until `release`. */
export function reserveAndroidBootMemory(needMb: number): AndroidBootReservation {
  const id = nextBootId++;
  bootsInFlight.set(id, needMb);
  return {
    earlierMb: () => {
      let total = 0;
      for (const [other, mb] of bootsInFlight) if (other < id) total += mb;
      return total;
    },
    release: () => {
      bootsInFlight.delete(id);
    },
  };
}

export type AndroidMemoryShortfall = { needMb: number; availableMb: number };

/** Null when the start fits; else what it needs and what is free. */
export function androidMemoryShortfall(args: { needMb: number; availableMb: number }): AndroidMemoryShortfall | null {
  return args.availableMb - args.needMb >= ANDROID_MEMORY_RESERVE_MB ? null : { needMb: args.needMb, availableMb: args.availableMb };
}

/** `2.9 GB`, one decimal place. */
export function formatAndroidMemoryGb(mb: number): string {
  return `${(Math.max(0, mb) / 1024).toFixed(1)} GB`;
}
