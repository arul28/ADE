/**
 * The disk an Android device needs on its first start: the emulator makes the
 * device's data partition then, and refuses to start unless the disk has 1.2
 * times its size free ("Not enough space to create userdata partition.
 * Available: 2291.86 MB …, need 7372.80 MB" for a 6 GB partition). The brain
 * checks it before the start and words the refusal; the pane reads the two
 * numbers back to offer a bigger disk. One owner for both sides.
 */

/**
 * The data partition ADE gives a device it makes (`disk.dataPartition.size`
 * in `androidHardwareProfiles.ts`). With the emulator's rule below, a first
 * start needs about 7.2 GB free.
 */
export const ADE_ANDROID_DATA_PARTITION_MB = 6 * 1024;

/** The emulator's own rule: free space of at least 1.2 times the partition. */
const ANDROID_USERDATA_FREE_FACTOR = 1.2;

/** What the emulator wants free to make a data partition of this size. */
export function androidUserdataNeedMb(partitionMb: number): number {
  return Math.ceil(partitionMb * ANDROID_USERDATA_FREE_FACTOR);
}

const gb = (mb: number): string => (mb / 1024).toFixed(1);

/** What a device ADE makes needs free on its first start, in MB. */
export function androidFirstStartNeedMb(): number {
  return androidUserdataNeedMb(ADE_ANDROID_DATA_PARTITION_MB);
}

/** The refusal's one sentence. `parseAndroidLowDisk` reads the numbers back. */
export function androidLowDiskSentence(neededMb: number, freeMb: number): string {
  return `This device needs ${gb(neededMb)} GB free on the disk to start the first time, and ${gb(freeMb)} GB is free.`;
}

/** The needed and free space from a low-disk refusal, in MB; null for any other text. */
export function parseAndroidLowDisk(text: string | null | undefined): { neededMb: number; freeMb: number } | null {
  const match = /needs (\d+(?:\.\d+)?) GB free on the disk to start the first time, and (\d+(?:\.\d+)?) GB is free/.exec(text ?? "");
  if (!match) return null;
  return { neededMb: Math.round(Number(match[1]) * 1024), freeMb: Math.round(Number(match[2]) * 1024) };
}

/** The emulator's own refusal line, when a start got past the check (an older brain, a wiped device). */
export function parseEmulatorUserdataSpace(line: string | null | undefined): { neededMb: number; freeMb: number } | null {
  const match = /Not enough space to create userdata partition\.\s*Available:\s*(\d+(?:\.\d+)?)\s*MB\b.*?need\s*(\d+(?:\.\d+)?)\s*MB/i.exec(line ?? "");
  if (!match) return null;
  return { freeMb: Math.floor(Number(match[1])), neededMb: Math.ceil(Number(match[2])) };
}
