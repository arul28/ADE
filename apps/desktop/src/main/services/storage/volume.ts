import fs from "node:fs";

export function readVolumeSpace(dirPath: string): { freeBytes: number; totalBytes: number } | null {
  try {
    const stats = fs.statfsSync(dirPath, { bigint: true });
    return {
      freeBytes: Number(stats.bavail * stats.bsize),
      totalBytes: Number(stats.blocks * stats.bsize),
    };
  } catch {
    return null;
  }
}

export function isNoSpaceError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /no space left|disk( is)? full|database or disk is full/i.test(message);
}
