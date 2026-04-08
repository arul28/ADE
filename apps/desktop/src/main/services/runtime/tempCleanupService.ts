import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";

const DAY_MS = 24 * 60 * 60 * 1000;
const SHIPIT_RETENTION_MS = 7 * DAY_MS;
const SCREENSHOT_RETENTION_MS = DAY_MS;
const ATTACHMENTS_RETENTION_MS = 7 * DAY_MS;

type CleanupSummary = {
  shipItEntriesRemoved: number;
  screenshotEntriesRemoved: number;
  attachmentEntriesRemoved: number;
  attachmentDirRemoved: boolean;
};

function isOlderThan(targetPath: string, cutoffMs: number): boolean {
  try {
    return fs.statSync(targetPath).mtimeMs < cutoffMs;
  } catch {
    return false;
  }
}

function removePath(targetPath: string): boolean {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleAttachmentEntries(attachmentsDir: string, cutoffMs: number): { removedEntries: number; removedDir: boolean } {
  let removedEntries = 0;

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(attachmentsDir, { withFileTypes: true });
  } catch {
    return { removedEntries, removedDir: false };
  }

  for (const entry of entries) {
    const entryPath = path.join(attachmentsDir, entry.name);
    if (!isOlderThan(entryPath, cutoffMs)) continue;
    if (removePath(entryPath)) {
      removedEntries += 1;
    }
  }

  let removedDir = false;
  try {
    if (fs.readdirSync(attachmentsDir).length === 0) {
      removedDir = removePath(attachmentsDir);
    }
  } catch {
    // Directory may already be gone.
  }

  return { removedEntries, removedDir };
}

export function cleanupStaleTempArtifacts(args: {
  tempRoot: string;
  logger: Pick<Logger, "info" | "warn">;
  nowMs?: number;
}): void {
  const nowMs = args.nowMs ?? Date.now();
  const summary: CleanupSummary = {
    shipItEntriesRemoved: 0,
    screenshotEntriesRemoved: 0,
    attachmentEntriesRemoved: 0,
    attachmentDirRemoved: false,
  };

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(args.tempRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      args.logger.warn("tempCleanup.scan_failed", {
        tempRoot: args.tempRoot,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(args.tempRoot, entry.name);

    if (entry.name.startsWith("com.ade.desktop.ShipIt.")) {
      if (isOlderThan(entryPath, nowMs - SHIPIT_RETENTION_MS) && removePath(entryPath)) {
        summary.shipItEntriesRemoved += 1;
      }
      continue;
    }

    if (entry.name.startsWith("ade-screenshot-")) {
      if (isOlderThan(entryPath, nowMs - SCREENSHOT_RETENTION_MS) && removePath(entryPath)) {
        summary.screenshotEntriesRemoved += 1;
      }
      continue;
    }

    if (entry.name === "ade-attachments" && entry.isDirectory()) {
      const attachmentCleanup = cleanupStaleAttachmentEntries(entryPath, nowMs - ATTACHMENTS_RETENTION_MS);
      summary.attachmentEntriesRemoved += attachmentCleanup.removedEntries;
      summary.attachmentDirRemoved = summary.attachmentDirRemoved || attachmentCleanup.removedDir;
    }
  }

  if (
    summary.shipItEntriesRemoved > 0
    || summary.screenshotEntriesRemoved > 0
    || summary.attachmentEntriesRemoved > 0
    || summary.attachmentDirRemoved
  ) {
    args.logger.info("tempCleanup.removed_stale_entries", {
      tempRoot: args.tempRoot,
      shipItEntriesRemoved: summary.shipItEntriesRemoved,
      screenshotEntriesRemoved: summary.screenshotEntriesRemoved,
      attachmentEntriesRemoved: summary.attachmentEntriesRemoved,
      attachmentDirRemoved: summary.attachmentDirRemoved,
    });
  }
}
