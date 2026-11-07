import { parseTasklist, runText, windowsSystemTool } from "../home/homeMachine";

/*
 * Which processes are Android emulators, by executable name: one rule for
 * the memory guard, the machine's process groups, and the Windows checks
 * before ADE kills a pid it read from a discovery file.
 *
 * Windows has no process start times for ADE to compare (`processStartTime.ts`),
 * and an emulator that crashed leaves its `pid_<n>.ini` behind. Once Windows
 * hands that pid to another program, the file still names it, so on Windows a
 * pid counts as an emulator only while its image is one.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** Every emulator's qemu (`qemu-system-x86_64`, `-aarch64`, `-headless` builds), whichever SDK or tool started it. */
export const ANDROID_QEMU_IMAGE_PREFIX = "qemu-system-";

/** An executable's base name, lower-cased, without `.exe`. */
function imageBaseName(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/u, "");
}

/** qemu itself: what holds an emulator's memory. */
export function isAndroidQemuImage(name: string | null | undefined): boolean {
  return Boolean(name) && imageBaseName(name!).startsWith(ANDROID_QEMU_IMAGE_PREFIX);
}

/** qemu, or the `emulator` launcher that starts it (`emulator`, `emulator64-…`, `emulator-headless`). */
export function isAndroidEmulatorImage(name: string | null | undefined): boolean {
  if (!name) return false;
  return isAndroidQemuImage(name) || /^emulator(?:64)?(?:-|$)/u.test(imageBaseName(name));
}

/**
 * Windows: the image name of each of `pids` that runs now, from one full
 * System32 `tasklist`, spawned off the main thread. A pid that is gone is
 * absent. Null when `tasklist` could not answer, so a caller can tell "not an
 * emulator" from "not known": a failed `tasklist` can exit non-zero with empty
 * output rather than throw, and a real listing is never empty (System and
 * Idle are always there). Never throws.
 */
export async function readWindowsProcessImages(pids: readonly number[], timeoutMs = 5_000): Promise<Map<number, string> | null> {
  const wanted = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (wanted.length === 0) return new Map();
  let listing: Map<number, { name: string }>;
  try {
    listing = parseTasklist(await runText(windowsSystemTool("tasklist.exe"), ["/FO", "CSV", "/NH"], timeoutMs));
  } catch {
    return null;
  }
  if (listing.size === 0) return null;
  return new Map(wanted.flatMap((pid) => {
    const name = listing.get(pid)?.name;
    return name ? [[pid, name] as const] : [];
  }));
}

/**
 * Whether `pid` is an emulator now, as far as a kill needs to know. Off
 * Windows the discovery file plus the start-time checks already say so:
 * "emulator". On Windows: its image, or "unknown" when it could not be read.
 */
export async function androidEmulatorPidCheck(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  readImages: (pids: readonly number[]) => Promise<Map<number, string> | null> = readWindowsProcessImages,
): Promise<"emulator" | "other" | "unknown"> {
  if (platform !== "win32") return "emulator";
  const images = await readImages([pid]);
  if (!images) return "unknown";
  return isAndroidEmulatorImage(images.get(pid)) ? "emulator" : "other";
}
