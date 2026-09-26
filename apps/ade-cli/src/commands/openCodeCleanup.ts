import {
  OpenCodeStoreError,
  applyOpenCodeStorePrune,
  openCodeStoreHasActiveWriter,
  planOpenCodeStorePrune,
  resolveOpenCodeStoreTarget,
} from "../../../desktop/src/shared/opencodeStoreMaintenance";

export type OpenCodeCleanupRequest = {
  store: string;
  olderThanMs: number;
  apply: boolean;
  vacuum: boolean;
  force: boolean;
};

export class OpenCodeCleanupUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeCleanupUsageError";
  }
}

const POINTER = "pass --apply to delete; without it this is a dry run.";
const IN_USE =
  "the OpenCode store is in use by a writer; quit your OpenCode chats (or the OpenCode TUI/CLI) and retry, or pass --force if you know the writer is gone";

/**
 * `ade storage opencode` — prune whole old sessions from an OpenCode store.
 *
 * Always plans first and only deletes with `--apply`. Never targets the user's
 * personal store unless asked with `--store user`; ADE's own store is the
 * default. VACUUM is opt-in and only runs when no writer holds the store,
 * because SQLite cannot shrink the file otherwise and a concurrent writer makes
 * VACUUM fail after doing the row deletes.
 */
export async function runOpenCodeCleanupCommand(
  request: OpenCodeCleanupRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, unknown>> {
  let target;
  try {
    target = resolveOpenCodeStoreTarget(request.store, env);
  } catch (error) {
    if (error instanceof OpenCodeStoreError) throw new OpenCodeCleanupUsageError(error.message);
    throw error;
  }

  const cutoffMs = Date.now() - request.olderThanMs;
  let plan;
  try {
    plan = planOpenCodeStorePrune({ dbPath: target.dbPath, cutoffMs });
  } catch (error) {
    if (error instanceof OpenCodeStoreError) throw new OpenCodeCleanupUsageError(error.message);
    throw error;
  }

  const base = {
    store: target.kind === "path" ? target.dbPath : target.kind,
    dbPath: target.dbPath,
    olderThanMs: request.olderThanMs,
    cutoff: new Date(cutoffMs).toISOString(),
    totalSessions: plan.totalSessions,
    eligibleSessions: plan.eligibleSessions.length,
    reclaimablePayloadBytes: plan.reclaimablePayloadBytes,
    byTable: plan.byTable,
    largestTables: plan.tableSizes.slice(0, 8),
    fileBytes: plan.fileBytes,
  };

  if (!request.apply) {
    return {
      ok: true,
      mode: "dry-run",
      ...base,
      hint: POINTER,
    };
  }

  const activeWriter = openCodeStoreHasActiveWriter(target.dbPath);
  if (activeWriter && !request.force) {
    throw new OpenCodeCleanupUsageError(`Refusing --apply: ${IN_USE}.`);
  }
  // VACUUM needs exclusive access and takes a write lock for its whole run, so
  // even --force must not start one over a live writer: the deletes would
  // commit and the VACUUM would fail after them.
  if (activeWriter && request.vacuum) {
    throw new OpenCodeCleanupUsageError(
      "Refusing --vacuum: a writer holds the store, and VACUUM needs exclusive access. Stop the writer and retry (deletes already applied will still shrink then).",
    );
  }

  const result = applyOpenCodeStorePrune({ plan, vacuum: request.vacuum });
  return {
    ok: true,
    mode: "applied",
    ...base,
    deletedSessions: result.deletedSessions,
    deletedEvents: result.deletedEvents,
    deletedMessages: result.deletedMessages,
    deletedParts: result.deletedParts,
    vacuumed: result.vacuumed,
    fileBytesBefore: result.fileBytesBefore,
    fileBytesAfter: result.fileBytesAfter,
    reclaimedBytes: Math.max(0, result.fileBytesBefore - result.fileBytesAfter),
    ...(request.vacuum
      ? {}
      : { hint: "Rows are deleted but the file only shrinks after VACUUM; rerun with --vacuum while no server is running." }),
  };
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let current = value;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current >= 100 || index === 0 ? Math.round(current) : current.toFixed(1)} ${units[index]}`;
}

export function openCodeCleanupText(value: Record<string, unknown>): string {
  const lines: string[] = [];
  const mode = value.mode === "applied" ? "Applied" : "Dry run";
  lines.push(`${mode} — OpenCode store ${String(value.store ?? "")}`);
  lines.push(`  database: ${String(value.dbPath ?? "")} (${formatBytes(Number(value.fileBytes ?? 0))})`);
  lines.push(`  sessions: ${String(value.totalSessions ?? 0)} total, ${String(value.eligibleSessions ?? 0)} old enough to prune`);
  lines.push(`  reclaimable rows: ${formatBytes(Number(value.reclaimablePayloadBytes ?? 0))} of payload`);
  const byTable = Array.isArray(value.byTable) ? value.byTable : [];
  for (const entry of byTable) {
    if (!entry || typeof entry !== "object") continue;
    const table = entry as Record<string, unknown>;
    lines.push(`    ${String(table.table ?? "?")}: ${String(table.rows ?? 0)} rows, ${formatBytes(Number(table.bytes ?? 0))}`);
  }
  if (value.mode === "applied") {
    lines.push(`  deleted: ${String(value.deletedSessions ?? 0)} sessions, ${String(value.deletedEvents ?? 0)} events`);
    lines.push(`  file: ${formatBytes(Number(value.fileBytesBefore ?? 0))} -> ${formatBytes(Number(value.fileBytesAfter ?? 0))} (freed ${formatBytes(Number(value.reclaimedBytes ?? 0))})`);
  }
  if (typeof value.hint === "string" && value.hint.length) lines.push(`  ${value.hint}`);
  return lines.join("\n");
}
