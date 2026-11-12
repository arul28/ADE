/**
 * ADE's storage guard (`storage/diskPressure.ts`) on an ADE Cloud computer.
 * The guard is the same as on every computer; two things differ here:
 *
 * - Its lines follow this computer's own disk (`diskPressureThresholdsForSize`),
 *   read from the disk at each sample, so a 4 GB disk that grows isn't
 *   treated like a laptop's terabyte. The disk grower (`cloudDiskGrow.ts`)
 *   grows before the line that stops agent turns.
 * - Its refusal names the cloud computer's disk, not "your computer", and
 *   says what happens next, from what the grower last wrote
 *   (`$ADE_HOME/cloud/disk-grow.json`).
 *
 * Small on purpose: the brain loads it for every project runtime it starts.
 */

import fs from "node:fs";
import path from "node:path";
import {
  diskPressureThresholdsForSize,
  type DiskPressureOperationKind,
  type DiskPressureSnapshot,
  type DiskPressureThresholds,
} from "../../../../desktop/src/main/services/storage/diskPressure";

/** After a grow started the computer restarts; a "growing" note older than this is over. */
export const CLOUD_DISK_GROW_STARTED_COOLDOWN_MS = 10 * 60_000;

/**
 * What the grower last did, for the guard's refusal and a person on the
 * computer. Gone once the disk has room again.
 */
export type CloudDiskGrowState =
  | { v: 1; state: "growing"; toGb: number; at: number; instanceId?: string }
  | { v: 1; state: "refused"; reason: string; wayOut: string; at: number; instanceId?: string };

export function cloudDiskGrowStatePath(adeHome: string): string {
  return path.join(adeHome, "cloud", "disk-grow.json");
}

/**
 * The state, or null. With `instanceId`, a state another computer wrote is
 * null: the file is on the disk that `ade cloud copy` and `move` copy, so a
 * copy would otherwise inherit its source's cooldown or refusal.
 */
export function readCloudDiskGrowState(file: string, instanceId?: string | null): CloudDiskGrowState | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CloudDiskGrowState> | null;
    if (value?.v !== 1 || typeof value.at !== "number") return null;
    if (instanceId && value.instanceId !== instanceId) return null;
    if (value.state === "growing" && typeof value.toGb === "number") return value as CloudDiskGrowState;
    if (value.state === "refused" && typeof value.reason === "string" && typeof value.wayOut === "string") return value as CloudDiskGrowState;
    return null;
  } catch {
    return null;
  }
}

function sizeText(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

const PAUSED: Record<DiskPressureOperationKind, string> = {
  chat_turn: "ADE paused new agent work there to protect its chats and projects.",
  cli_launch: "ADE can't safely start a new CLI session there.",
  high_write_job: "ADE didn't start this task there to avoid writing more data.",
  compression: "ADE didn't start this task there to avoid writing more data.",
};

/**
 * The guard's refusal on an ADE Cloud computer: it names the cloud
 * computer's own disk (the person reads it on another computer, whose disk
 * may be fine), then what happens next: a grow under way, the reason a grow
 * was refused with its way out, or the grow ADE makes as soon as nothing runs.
 */
function cloudDiskRefusalMessage(
  kind: DiskPressureOperationKind,
  snapshot: Pick<DiskPressureSnapshot, "freeBytes" | "totalBytes">,
  state: CloudDiskGrowState | null,
  nowMs: number = Date.now(),
): string {
  // A grow that started long ago restarted the computer and is over; this disk is still short.
  const grow = state?.state === "growing" && nowMs - state.at > CLOUD_DISK_GROW_STARTED_COOLDOWN_MS ? null : state;
  const head = `This ADE Cloud computer's disk is almost full (${sizeText(snapshot.freeBytes)} free of ${sizeText(snapshot.totalBytes)}). `
    + "That's the cloud computer's own disk, not the disk of the computer you're using. "
    + PAUSED[kind];
  if (grow?.state === "growing") {
    return `${head} ADE is growing it to ${grow.toGb} GB now; the cloud computer restarts for a moment. Try again in a minute or two.`;
  }
  if (grow?.state === "refused") {
    return `${head} It can't grow on its own: ${grow.wayOut} To make room now, use Clear caches in Settings › ADE Cloud.`;
  }
  return `${head} ADE grows it as soon as nothing runs there (the cloud computer restarts for a moment), then try again. To make room now, use Clear caches in Settings › ADE Cloud.`;
}

/** The guard's options on an ADE Cloud computer (`createDiskPressureMonitor`). */
export function cloudDiskGuardOptions(adeHome: string): {
  thresholdsForSize: (totalBytes: number) => DiskPressureThresholds;
  refusalMessage: (kind: DiskPressureOperationKind, snapshot: DiskPressureSnapshot) => string;
} {
  const stateFile = cloudDiskGrowStatePath(adeHome);
  return {
    thresholdsForSize: diskPressureThresholdsForSize,
    // Read only when the guard refuses, so the note is as fresh as the refusal.
    refusalMessage: (kind, snapshot) => cloudDiskRefusalMessage(kind, snapshot, readCloudDiskGrowState(stateFile, process.env.ADE_CLOUD_INSTANCE_ID?.trim() || null)),
  };
}
