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

/** `hw.ramSize` from `config.ini`: `2048`, `2048M`, `2048MB` or `2G`. */
export function parseAndroidRamSizeMb(value: string | undefined | null): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([mg])?b?\s*$/i.exec(value ?? "");
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(match[2]?.toLowerCase() === "g" ? amount * 1024 : amount);
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

/** The memory the machine can give without swapping, in MB. */
export async function readHostAvailableMemoryMb(options: {
  platform?: NodeJS.Platform;
  totalBytes?: number;
  freeBytes?: number;
  readLevel?: (timeoutMs: number) => Promise<number | null>;
} = {}): Promise<number> {
  const platform = options.platform ?? process.platform;
  const total = options.totalBytes ?? os.totalmem();
  const free = options.freeBytes ?? os.freemem();
  if (platform === "darwin") {
    const level = await (options.readLevel ?? readMemorystatusLevel)(2_000);
    if (level !== null) return Math.round((total * level) / 100 / MB);
  }
  return Math.round(free / MB);
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
