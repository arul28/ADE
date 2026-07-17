// Read/write helpers for the storage-doctor maintenance journal — a plain,
// rebuildable JSON file (no DB, no CRR) capping the last N runs. Extracted from
// storageInsightsService and parameterized on the journal path + logger so the
// I/O is testable in isolation.

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import type { MaintenanceRunReport } from "../../../shared/types/storage";

export const MAINTENANCE_JOURNAL_MAX_RUNS = 30;

export function isMaintenanceReport(value: unknown): value is MaintenanceRunReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return typeof report.startedAt === "string"
    && typeof report.finishedAt === "string"
    && typeof report.trigger === "string"
    && Array.isArray(report.actions)
    && typeof report.reclaimedBytes === "number";
}

export function readMaintenanceJournal(journalPath: string): MaintenanceRunReport[] {
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath, "utf8");
  } catch {
    // Missing or unreadable journal → treat as empty (rebuildable file).
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isMaintenanceReport) : [];
  } catch {
    return [];
  }
}

export function appendMaintenanceJournal(
  journalPath: string,
  report: MaintenanceRunReport,
  ctx: { logger: Logger; projectRoot: string },
): MaintenanceRunReport[] {
  const next = [report, ...readMaintenanceJournal(journalPath)].slice(0, MAINTENANCE_JOURNAL_MAX_RUNS);
  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    // Write to a sibling temp file then rename over the target so a crash mid-
    // write can never leave a truncated/corrupt journal in place.
    const tmpPath = `${journalPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2));
    fs.renameSync(tmpPath, journalPath);
  } catch (error) {
    ctx.logger.warn("storage.maintenance_journal_write_failed", {
      projectRoot: ctx.projectRoot,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return next;
}
