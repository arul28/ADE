// Read/write helpers for the storage-doctor maintenance journal — a plain,
// rebuildable JSON file (no DB, no CRR) capping the last N runs. Extracted from
// storageInsightsService and parameterized on the journal path + logger so the
// I/O is testable in isolation.

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logging/logger";
import type { MaintenanceRunReport } from "../../../shared/types/storage";

export const MAINTENANCE_JOURNAL_MAX_RUNS = 30;

const MAINTENANCE_TRIGGERS = new Set(["daily", "post_boot", "manual", "post_migration"]);
const MAINTENANCE_ACTION_KINDS = new Set(["prune", "compress", "delete", "vacuum", "compact", "checkpoint"]);

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isMaintenanceAction(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  return typeof action.ledgerId === "string"
    && action.ledgerId.length > 0
    && typeof action.kind === "string"
    && MAINTENANCE_ACTION_KINDS.has(action.kind)
    && isFiniteNonNegativeNumber(action.itemsAffected)
    && isFiniteNonNegativeNumber(action.bytesReclaimed)
    && isFiniteNonNegativeNumber(action.durationMs)
    && Object.hasOwn(action, "skippedReason")
    && isNullableString(action.skippedReason)
    && Object.hasOwn(action, "error")
    && isNullableString(action.error);
}

export function isMaintenanceReport(value: unknown): value is MaintenanceRunReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return typeof report.startedAt === "string"
    && report.startedAt.length > 0
    && typeof report.finishedAt === "string"
    && report.finishedAt.length > 0
    && typeof report.trigger === "string"
    && MAINTENANCE_TRIGGERS.has(report.trigger)
    && Array.isArray(report.actions)
    && report.actions.every(isMaintenanceAction)
    && isFiniteNonNegativeNumber(report.reclaimedBytes)
    && (report.dbSizeBytes === null || isFiniteNonNegativeNumber(report.dbSizeBytes));
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

/**
 * How long a files-only run (files the person confirmed in Settings) waits for
 * the manual maintenance run that "Clean up safely" starts right after it.
 */
export const FILES_RUN_FOLD_WINDOW_MS = 10 * 60_000;

function foldsInto(previous: MaintenanceRunReport, next: MaintenanceRunReport): boolean {
  if (!previous.filesOnly || next.filesOnly || next.trigger !== "manual") return false;
  const gap = Date.parse(next.startedAt) - Date.parse(previous.finishedAt);
  return Number.isFinite(gap) && gap >= -1_000 && gap <= FILES_RUN_FOLD_WINDOW_MS;
}

/**
 * One cleanup is one journal entry. "Clean up safely" removes the confirmed
 * files first and then runs maintenance; without this the journal showed two
 * runs, and the maintenance one ("reclaimed 13.6 MB") hid the files it had
 * just removed.
 */
function foldRuns(files: MaintenanceRunReport, maintenance: MaintenanceRunReport): MaintenanceRunReport {
  return {
    ...maintenance,
    startedAt: files.startedAt,
    actions: [...files.actions, ...maintenance.actions],
    reclaimedBytes: files.reclaimedBytes + maintenance.reclaimedBytes,
  };
}

export function appendMaintenanceJournal(
  journalPath: string,
  report: MaintenanceRunReport,
  ctx: { logger: Logger; projectRoot: string },
): MaintenanceRunReport[] {
  const existing = readMaintenanceJournal(journalPath);
  const [newest, ...older] = existing;
  const next = (newest && foldsInto(newest, report)
    ? [foldRuns(newest, report), ...older]
    : [report, ...existing]
  ).slice(0, MAINTENANCE_JOURNAL_MAX_RUNS);
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
