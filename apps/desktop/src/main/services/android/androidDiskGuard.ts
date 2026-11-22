import fs from "node:fs";
import path from "node:path";
import type { AndroidAvd } from "../../../shared/types/androidEmulator";
import { androidLowDiskSentence, androidUserdataNeedMb } from "../../../shared/androidDisk";
import type { Logger } from "../logging/logger";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import { readAndroidIniFile } from "./androidSdk";

/*
 * The disk guard: before a first start, refuse a device whose data partition
 * the disk can't hold. The emulator checks the same thing itself, but only
 * after the launch, and says it as a FATAL log line. One statfs, at the start.
 */

/** `disk.dataPartition.size`: `6G`, `6144M`, `6144MB`, or bytes. Null when it can't be read. */
export function parseAndroidPartitionMb(value: string | null | undefined): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt])?b?\s*$/i.exec(value ?? "");
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  switch (match[2]?.toLowerCase()) {
    case "t": return Math.round(amount * 1024 * 1024);
    case "g": return Math.round(amount * 1024);
    case "m": return Math.round(amount);
    case "k": return Math.round(amount / 1024);
    default: return Math.round(amount / (1024 * 1024));
  }
}

/** The data partition the emulator would make, in MB; null when the device already has one or the size is unknown. */
function partitionToMakeMb(avd: Pick<AndroidAvd, "path">): number | null {
  // The image exists after the first start; a cold boot reuses it.
  if (fs.existsSync(path.join(avd.path, "userdata-qemu.img"))) return null;
  return parseAndroidPartitionMb(readAndroidIniFile(path.join(avd.path, "config.ini"))?.get("disk.dataPartition.size"));
}

/** Free space on the filesystem that holds this folder, in MB; null when it can't be read. */
function freeMbAt(folder: string): number | null {
  try {
    const stats = fs.statfsSync(folder);
    return Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
  } catch {
    return null;
  }
}

/**
 * Throws ANDROID_LOW_DISK when the device's first start would fail for lack
 * of disk. Says nothing (and starts as before) whenever a number is unknown.
 */
export function assertAndroidDiskForStart(args: { laneId: string; avd: Pick<AndroidAvd, "path" | "name">; logger?: Logger | null }): void {
  const partitionMb = partitionToMakeMb(args.avd);
  if (partitionMb == null) return;
  const freeMb = freeMbAt(args.avd.path);
  if (freeMb == null) return;
  const neededMb = androidUserdataNeedMb(partitionMb);
  if (freeMb >= neededMb) return;
  args.logger?.info("android.start_low_disk", { laneId: args.laneId, avdName: args.avd.name, neededMb, freeMb });
  throw new AndroidEmulatorFailure("ANDROID_LOW_DISK", androidLowDiskSentence(neededMb, freeMb), null, false, { neededMb, freeMb });
}
