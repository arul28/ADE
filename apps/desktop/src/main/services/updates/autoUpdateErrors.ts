import fs from "node:fs";
import path from "node:path";
import type { UpdateInfo } from "electron-updater";
import type { AutoUpdateErrorKind, AutoUpdatePhase } from "../../../shared/types";

const MIB = 1024 * 1024;
const DEFAULT_UPDATE_DOWNLOAD_BYTES = 512 * MIB;
const UPDATE_SPACE_HEADROOM_BYTES = 512 * MIB;

// electron-updater's MacUpdater hands the downloaded zip to native Squirrel.Mac,
// which buffers the whole archive into one contiguous CFData grown by doubling.
// Past 1 GiB that asks for a 2 GiB reallocation, which Chromium's PartitionAlloc
// refuses: the app dies with EXC_BREAKPOINT roughly a minute after launch,
// before the user can decline the update. Refusing the download is strictly
// better than crashing. CI's 800 MiB artifact budget is the primary defense and
// this matches it, so a build that passed CI can never trip this guard.
export const MAC_UPDATE_ARTIFACT_MAX_BYTES = 800 * MIB;

export const MAC_UPDATE_ARTIFACT_TOO_LARGE_MESSAGE =
  "This update is too large for macOS to install safely.";

/**
 * Size metadata is advisory: `null` means the feed omitted it, and the CI gate
 * already guarantees published artifacts are within budget, so allow it through
 * rather than blocking every update on a malformed manifest.
 */
export function exceedsMacUpdateArtifactLimit(
  platform: NodeJS.Platform,
  compressedBytes: number | null,
): boolean {
  if (platform !== "darwin") return false;
  const size = finitePositive(compressedBytes);
  return size != null && size > MAC_UPDATE_ARTIFACT_MAX_BYTES;
}

export type DiskSpaceInfo = {
  availableBytes: number;
  volumePath: string;
};

function nearestExistingPath(targetPath: string): string {
  let candidate = path.resolve(targetPath);
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

export function readDiskSpace(targetPath: string): DiskSpaceInfo {
  const volumePath = nearestExistingPath(targetPath);
  const stats = fs.statfsSync(volumePath, { bigint: true });
  return {
    availableBytes: Number(stats.bavail * stats.bsize),
    volumePath,
  };
}

export function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function updateDownloadBytes(info: UpdateInfo | null | undefined): number | null {
  if (!info || !Array.isArray(info.files)) return null;
  let largest = 0;
  for (const file of info.files) {
    const size = finitePositive(file.size);
    if (size && size > largest) largest = size;
  }
  return largest || null;
}

// electron-updater keeps the pending archive and a second update.zip used for
// future differential downloads. Squirrel.Mac then fetches that archive again
// and expands/replaces the app. These are deliberately conservative estimates:
// two compressed copies for download; one staged copy plus a 4x expansion
// allowance for install; and 512 MiB of filesystem/rollback headroom.
export function estimateUpdateRequiredBytes(
  phase: "download" | "install",
  compressedBytes: number | null,
): number {
  const archiveBytes = compressedBytes ?? DEFAULT_UPDATE_DOWNLOAD_BYTES;
  return phase === "download"
    ? (archiveBytes * 2) + UPDATE_SPACE_HEADROOM_BYTES
    : (archiveBytes * 5) + UPDATE_SPACE_HEADROOM_BYTES;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code.toUpperCase() : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}

export function classifyUpdateError(
  error: unknown,
  fallbackPhase: AutoUpdatePhase,
): { kind: AutoUpdateErrorKind; phase: AutoUpdatePhase } {
  const code = errorCode(error);
  const message = errorMessage(error).toLowerCase();
  const phase = /extract|staging|shipit|unpack/.test(message) ? "staging" : fallbackPhase;
  // "artifact_too_large" is never recovered from a message: the only producer is
  // our own preflight, which passes the kind to setErrorSnapshot explicitly.
  if (code === "ENOSPC" || /no space left|disk(?: is)? full/.test(message)) {
    return { kind: "disk_full", phase };
  }
  if (code === "EDQUOT" || /quota exceeded|disk quota/.test(message)) {
    return { kind: "quota", phase };
  }
  if (/not enough (?:free )?(?:disk )?space|insufficient (?:disk )?(?:space|capacity)/.test(message)) {
    return { kind: "insufficient_space", phase };
  }
  if (/signature|code requirement|notariz/.test(message)) {
    return { kind: "signature", phase: "verification" };
  }
  if (/sha(?:512)?|checksum|verify|verification|corrupt/.test(message)) {
    return { kind: "verification", phase: "verification" };
  }
  if (
    code === "EACCES"
    || code === "EPERM"
    || code === "EROFS"
    || /permission denied|not permitted|read-only file system/.test(message)
  ) {
    return { kind: "permission", phase };
  }
  if (
    /\b(?:enotfound|econnreset|econnrefused|etimedout|network|offline|http 4\d\d|http 5\d\d)\b/.test(`${code.toLowerCase()} ${message}`)
  ) {
    return { kind: "network", phase };
  }
  if (phase === "install" || phase === "staging") {
    return { kind: "installer", phase };
  }
  return { kind: "unknown", phase };
}
