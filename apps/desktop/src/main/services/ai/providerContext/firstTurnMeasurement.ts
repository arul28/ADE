/**
 * The measured first turn: the median size of a chat's first request, from
 * the machine's turn ledger (`<adeDir>/usage/turns-YYYY-MM.jsonl`).
 *
 * Every inventory call reads about five weeks of the ledger, and a person
 * flips between provider pages, so the few fields the median needs are kept
 * per month file and re-read only when that file's size or mtime moves.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import type { AdeTurnUsageRecord } from "../../../../shared/types/turnUsage";
import type { ProviderContextMeasurement } from "../../../../shared/types/providerContext";
import { pathsEqual } from "../../shared/pathCompare";
import { MAX_FILE_READ_BYTES, MAX_LINE_BYTES, mergeTurnUsageLines, turnLedgerMonthFiles } from "../../usage/turnUsageLedger";
import type { ProviderContextLogger } from "./fsScan";

/** Fewer chats than this give no figure: one odd chat would be the whole answer. */
const MIN_MEASURE_SAMPLES = 3;

/**
 * The median size of a chat's first request, from first turns that made one
 * request. A first turn that called tools reports its last request, which
 * holds the tool results too (a Claude chat in ADE's repo: 58k for one request,
 * 117k with tools), so those turns say nothing about what a chat starts with.
 * This project's chats come first, because its instruction files are part of
 * the figure; with too few of them, the machine's chats answer.
 */
export function medianFirstTurnContext(
  rows: readonly AdeTurnUsageRecord[],
  provider: string,
  sinceMs: number,
  projectRoot: string | null = null,
): ProviderContextMeasurement | null {
  const first = new Map<string, AdeTurnUsageRecord>();
  const startedMs = (row: AdeTurnUsageRecord) => Date.parse(row.startedAt ?? row.at);
  for (const row of rows) {
    if (row.provider !== provider || row.surface === "personal") continue;
    const existing = first.get(row.sessionId);
    if (!existing || startedMs(row) < startedMs(existing)) first.set(row.sessionId, row);
  }
  const samples = [...first.values()]
    // A session whose earliest row is older than the window started before it,
    // so that row is not its first turn.
    .filter((row) => startedMs(row) >= sinceMs
      && typeof row.contextTokens === "number" && row.contextTokens > 0
      && row.requestCount === 1);
  const root = projectRoot ? path.resolve(projectRoot) : null;
  const inProject = root ? samples.filter((row) => row.projectRoot && pathsEqual(path.resolve(row.projectRoot), root)) : [];
  const [chosen, scope] = inProject.length >= MIN_MEASURE_SAMPLES
    ? [inProject, "project" as const]
    : [samples, "machine" as const];
  if (chosen.length < MIN_MEASURE_SAMPLES) return null;
  const values = chosen.map((row) => row.contextTokens as number).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 ? values[middle]! : Math.round((values[middle - 1]! + values[middle]!) / 2);
  const oldest = chosen.reduce((min, row) => Math.min(min, startedMs(row)), Number.POSITIVE_INFINITY);
  return { firstTurnTokens: median, sampleCount: chosen.length, since: new Date(oldest).toISOString(), scope };
}

// ---------------------------------------------------------------------------
// Reading the ledger
// ---------------------------------------------------------------------------

/** The fields `medianFirstTurnContext` and the amendment merge read; the rest of a row is dropped. */
const KEPT_FIELDS = ["v", "key", "at", "provider", "sessionId", "surface", "startedAt", "contextTokens", "requestCount", "projectRoot"] as const;

type CachedMonth = { mtimeMs: number; size: number; lines: unknown[] };

/** Slim parsed lines per month file. Only the files of the last read's window stay. */
const monthCache = new Map<string, CachedMonth>();

function pick(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of KEPT_FIELDS) if (value[field] !== undefined) out[field] = value[field];
  return out;
}

/** A row keeps its measured fields; an amendment keeps the same fields of its patch. */
function slimLine(line: unknown): unknown {
  if (!line || typeof line !== "object") return null;
  const record = line as Record<string, unknown>;
  if (typeof record.amend === "string") {
    const patch = record.patch && typeof record.patch === "object" ? pick(record.patch as Record<string, unknown>) : record.patch;
    return { v: record.v, amend: record.amend, at: record.at, patch };
  }
  return pick(record);
}

async function readMonthLines(file: string): Promise<unknown[]> {
  const lines: unknown[] = [];
  const reader = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    for await (const line of reader) {
      if (!line || line.length > MAX_LINE_BYTES) continue;
      try {
        const slim = slimLine(JSON.parse(line));
        if (slim) lines.push(slim);
      } catch {
        // A torn last line from a crash mid-append; the rest of the file is fine.
      }
    }
  } finally {
    reader.close();
  }
  return lines;
}

/**
 * The ledger's turns that finished since `sinceMs`, amendments applied, with
 * only the fields the median reads. An unchanged month file is not re-read.
 */
export async function readFirstTurnRows(
  dir: string,
  sinceMs: number,
  logger: ProviderContextLogger | null | undefined,
): Promise<AdeTurnUsageRecord[]> {
  const files = await turnLedgerMonthFiles(dir, sinceMs);

  let lines: unknown[] = [];
  for (const file of files) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_READ_BYTES) {
      logger?.warn("provider_context.turn_ledger_file_too_large", { path: file, bytes: stat.size });
      continue;
    }
    let cached = monthCache.get(file);
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      cached = { mtimeMs: stat.mtimeMs, size: stat.size, lines: await readMonthLines(file) };
      monthCache.set(file, cached);
    }
    lines = lines.concat(cached.lines);
  }
  const keep = new Set(files);
  for (const key of monthCache.keys()) if (!keep.has(key)) monthCache.delete(key);
  return mergeTurnUsageLines(lines).filter((row) => Date.parse(row.at) >= sinceMs);
}
