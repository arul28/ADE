/**
 * Shared plumbing for the local usage-history scanners: the `TokenEntry` they
 * all return, scan-completeness tracking, the parse helpers every ledger format
 * needs, bounded file discovery, line-streamed JSONL reads, and the read-only
 * SQLite opener.
 *
 * `localUsageLedgers.ts` (the CLI and IDE ledgers) and `acpProviderLedgers.ts`
 * (the ACP providers' own ledgers) both import from here and never from each
 * other's plumbing, so the usage-ledger worker loads them in any order.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SqlValue } from "../../state/kvDb";
import { finiteNumberOrNull, toOptionalString } from "../../shared/utils";

/**
 * Whether a scan could read everything it set out to read.
 *
 * Every failure in a scanner is swallowed — a locked SQLite file, a directory
 * that momentarily refuses to list, one unreadable transcript — and the scan
 * returns whatever it managed to collect. That is right for the page: a flaky
 * file must not blank the usage numbers. It is wrong for the cross-machine
 * dedupe, which compares this machine's per-day `provider|model` totals against
 * a peer's and reads "content on one side the other could not possibly have" as
 * proof the two read *different* files. A partial read looks exactly like that,
 * and the conclusion — two machines, count both — doubles every shared token
 * silently.
 *
 * So completeness is recorded at the granularity the failures actually happen
 * at (a directory, a file, a database) and reported per provider, where the
 * comparison's existing provider filter can use it. The state is one boolean
 * per in-flight scan; no error text is retained.
 *
 * `AsyncLocalStorage` rather than a module-level flag because the non-worker
 * path scans every provider with `Promise.all`, and a shared flag would
 * attribute one provider's failure to whichever scan happened to finish next.
 */
export type LedgerScanCompleteness = { complete: boolean };

const ledgerScanCompleteness = new AsyncLocalStorage<LedgerScanCompleteness>();

/** Record that this provider's scan could not read everything this round. */
export function markLedgerScanIncomplete(): void {
  const state = ledgerScanCompleteness.getStore();
  if (state) state.complete = false;
}

/**
 * A path that is simply not there is not an incomplete read.
 *
 * Provider roots are absent on every machine that never installed that
 * provider, and optional subtrees (`subagents/`, a `chats/` directory a project
 * never created) are absent on almost every machine that did. Treating those as
 * incompleteness would mark every provider incomplete on an ordinary machine,
 * empty the compared provider set, and leave the dedupe unable to tell a clone
 * from a shared mount — which is the failure in the other direction.
 */
function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** For directory listings: absence is normal, anything else lost content. */
export function markLedgerScanIncompleteUnlessMissing(error: unknown): void {
  if (isMissingPathError(error)) return;
  markLedgerScanIncomplete();
}

/** Run `scan` with `state` as its completeness record (see `LedgerScanCompleteness`). */
export function runInLedgerScan<T>(state: LedgerScanCompleteness, scan: () => Promise<T>): Promise<T> {
  return ledgerScanCompleteness.run(state, scan);
}

/**
 * Run one provider scan and report whether it read everything.
 *
 * The completeness verdict belongs to this call alone, so two concurrent scans
 * — or one scan that shares an in-flight promise with another, as Codex does —
 * never inherit each other's failures.
 */
export async function runLedgerScanWithCompleteness<T>(
  scan: () => Promise<T>,
): Promise<{ value: T; complete: boolean }> {
  const state: LedgerScanCompleteness = { complete: true };
  const value = await runInLedgerScan(state, scan);
  return { value, complete: state.complete };
}

export const LOCAL_COST_SCAN_MAX_FILES = 5_000;
export const LOCAL_COST_SCAN_MAX_FILE_BYTES = 768 * 1024 * 1024;
export const LOCAL_COST_SCAN_MAX_ENTRIES = 1_000_000;
export const LOCAL_COST_SCAN_ALL_DAYS = 3650;
export const LOCAL_SQLITE_SCAN_MAX_ROWS = 250_000;
const LOCAL_JSONL_MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface TokenEntry {
  messageId: string;
  model: string;
  originator?: string;
  projectPath?: string;
  projectKey?: string;
  adeOriginated?: boolean;
  estimation?: "chars" | "mixed" | "distribution";
  inputTokens: number;
  billableInputTokens?: number;
  outputTokens: number;
  billableOutputTokens?: number;
  cachedTokens: number;
  billableCachedTokens?: number;
  cacheWriteTokens?: number;
  oneHourCacheWriteTokens?: number;
  webSearchRequests?: number;
  costOverrideUsd?: number;
  /**
   * Context size of the ONE model request this entry records (uncached input
   * + cache read + cache write). Set only by scanners whose entries are single
   * requests; pricing uses it to pick a vendor's long-context tier. Absent on
   * turn or session aggregates, which are priced at the base rate.
   */
  requestContextTokens?: number;
  timestamp: number;
}

export function toNonNegativeInt(value: unknown): number {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.max(0, Math.floor(numberValue)) : 0;
}

export function normalizeUsageLabel(value: unknown, fallback: string): string {
  return toOptionalString(value) ?? fallback;
}

export function isAdeWorktreePath(value: string): boolean {
  return value.replace(/\\/g, "/").includes("/.ade/worktrees/");
}

export function numberFromRecord(record: Record<string, unknown> | undefined, ...keys: string[]): number {
  if (!record) return 0;
  for (const key of keys) {
    const value = finiteNumberOrNull(record[key]);
    if (value != null) return value;
  }
  return 0;
}

/** A timestamp in ms, or null when the value holds none a clock can read. */
export function timestampMsOrNull(value: unknown): number | null {
  const numeric = finiteNumberOrNull(value);
  if (numeric != null) return numeric;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A timestamp in ms, or now when the value holds none. */
export function timestampMsFromValue(value: unknown): number {
  return timestampMsOrNull(value) ?? Date.now();
}

export function timestampMsFromUnixish(value: unknown): number {
  const numeric = finiteNumberOrNull(value);
  if (numeric != null) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  return timestampMsFromValue(value);
}

export type RecentFileCandidate = { path: string; mtimeMs: number };

/**
 * Newest-first, then path-ascending. The tiebreak is not cosmetic: `sort` is
 * stable, so equal mtimes would otherwise resolve to `readdir` order, and two
 * clients of one NFS/SMB share are not required to agree on that. With more
 * transcript files than the cap and an mtime collision straddling the cutoff,
 * two machines reading the same directory would retain different files, count
 * different tokens, and be judged diverged by the account-usage dedupe — which
 * silently double-counts every token they actually share. Paths are unique
 * within a scan, so this makes the retained set a pure function of the files.
 */
export function compareRecentFileCandidates(a: RecentFileCandidate, b: RecentFileCandidate): number {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function newestCandidatePaths(files: RecentFileCandidate[]): string[] {
  return files
    .sort(compareRecentFileCandidates)
    .slice(0, LOCAL_COST_SCAN_MAX_FILES)
    .map((file) => file.path);
}

/**
 * Read each ledger file whole, parse it, and keep the first entry per
 * `messageId` up to the scan's entry cap. A file that was discovered a moment
 * ago and then will not read or parse is content this round missed, so it marks
 * the scan incomplete (see `markLedgerScanIncomplete`) and the rest still count.
 */
export async function collectLedgerEntries(
  files: readonly string[],
  parse: (raw: string, filePath: string) => TokenEntry[],
): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  for (const filePath of files) {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      for (const entry of parse(raw, filePath)) {
        if (seen.has(entry.messageId)) continue;
        seen.add(entry.messageId);
        entries.push(entry);
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      markLedgerScanIncomplete();
    }
  }
  return entries;
}

export async function findRecentFiles(
  dir: string,
  maxAgeDays: number,
  suffixes: string[],
  options: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number } = {},
): Promise<string[]> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? LOCAL_COST_SCAN_MAX_FILES));
  const maxFileBytes = Math.max(1, Math.floor(options.maxFileBytes ?? LOCAL_COST_SCAN_MAX_FILE_BYTES));
  const maxTotalBytes = options.maxTotalBytes !== undefined && Number.isFinite(options.maxTotalBytes)
    ? Math.max(1, Math.floor(options.maxTotalBytes))
    : Number.POSITIVE_INFINITY;
  const files: Array<{ path: string; mtimeMs: number; size: number }> = [];

  async function walk(current: string, depth: number) {
    if (depth > 6) return; // Prevent deep traversal
    try {
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      const dirPromises: Promise<void>[] = [];
      const fileStatPromises: Promise<void>[] = [];
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          dirPromises.push(walk(fullPath, depth + 1));
        } else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
          fileStatPromises.push(
            fs.promises.stat(fullPath).then((stat) => {
              if (stat.mtimeMs >= cutoff && stat.size <= maxFileBytes) {
                files.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
              }
            }).catch((error: unknown) => {
              // Skip files we can't stat
              markLedgerScanIncompleteUnlessMissing(error);
            })
          );
        }
      }
      await Promise.all([...dirPromises, ...fileStatPromises]);
    } catch (error) {
      // Skip directories we can't read
      markLedgerScanIncompleteUnlessMissing(error);
    }
  }

  await walk(dir, 0);
  const selected: string[] = [];
  let selectedBytes = 0;
  // Same determinism requirement as `newestCandidatePaths`: with a byte budget
  // and a file cap, mtime ties decided by readdir order make the retained set
  // machine-dependent on a shared filesystem.
  for (const file of files.sort(compareRecentFileCandidates)) {
    if (selected.length >= maxFiles) break;
    if (selectedBytes + file.size > maxTotalBytes) continue;
    selected.push(file.path);
    selectedBytes += file.size;
  }
  return selected;
}

export async function findJsonlFiles(
  dir: string,
  maxAgeDays: number,
  options: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number } = {},
): Promise<string[]> {
  return findRecentFiles(dir, maxAgeDays, [".jsonl"], options);
}

export async function* readJsonlLines(
  filePath: string,
  maxLineBytes = LOCAL_JSONL_MAX_LINE_BYTES,
): AsyncGenerator<string> {
  const normalizedMaxLineBytes = Number.isFinite(maxLineBytes)
    ? Math.max(1, Math.floor(maxLineBytes))
    : LOCAL_JSONL_MAX_LINE_BYTES;
  const stream = fs.createReadStream(filePath);
  let lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let discardingOversizedLine = false;

  const takeLine = (): string => {
    const line = lineChunks.length === 1
      ? lineChunks[0]!
      : Buffer.concat(lineChunks, lineBytes);
    const content = line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
    return content.toString("utf8");
  };

  try {
    for await (const chunk of stream) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(0x0a, start);
        const end = newline >= 0 ? newline : chunk.length;

        if (!discardingOversizedLine) {
          const segment = chunk.subarray(start, end);
          if (lineBytes + segment.length <= normalizedMaxLineBytes) {
            lineChunks.push(segment);
            lineBytes += segment.length;
          } else {
            lineChunks = [];
            lineBytes = 0;
            discardingOversizedLine = true;
          }
        }

        if (newline < 0) break;
        if (!discardingOversizedLine) yield takeLine();
        lineChunks = [];
        lineBytes = 0;
        discardingOversizedLine = false;
        start = newline + 1;
      }
    }

    if (!discardingOversizedLine && lineBytes > 0) yield takeLine();
  } finally {
    stream.destroy();
  }
}

type UsageSqliteStatement = {
  all: (...params: SqlValue[]) => Record<string, unknown>[];
};
export type UsageSqliteDatabase = {
  prepare: (sql: string) => UsageSqliteStatement;
  exec?: (sql: string) => void;
  close: () => void;
};
type UsageSqliteConstructor = new (dbPath: string, options?: { readOnly?: boolean }) => UsageSqliteDatabase;

const requireForUsageSqlite = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
let usageSqliteConstructor: UsageSqliteConstructor | null | undefined;

export function textFromSqliteValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  if (value == null) return "";
  return String(value);
}

function loadUsageSqliteConstructor(): UsageSqliteConstructor | null {
  if (usageSqliteConstructor !== undefined) return usageSqliteConstructor;
  try {
    const sqlite = requireForUsageSqlite("node:sqlite") as { DatabaseSync?: UsageSqliteConstructor };
    usageSqliteConstructor = sqlite.DatabaseSync ?? null;
  } catch {
    usageSqliteConstructor = null;
  }
  return usageSqliteConstructor;
}

export function openReadonlyUsageDatabase(dbPath: string): UsageSqliteDatabase | null {
  // No file is no ledger — the same on every machine reading this directory.
  if (!fs.existsSync(dbPath)) return null;
  const DatabaseSync = loadUsageSqliteConstructor();
  // From here on the ledger exists and we failed to read it: a locked database,
  // a runtime without SQLite. Whatever it holds is content this round missed.
  if (!DatabaseSync) {
    markLedgerScanIncomplete();
    return null;
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec?.("PRAGMA busy_timeout = 1000");
    } catch {
      // Best-effort only; read-only scans should still work without it.
    }
    return db;
  } catch {
    markLedgerScanIncomplete();
    return null;
  }
}

export function usageSqliteAll<T extends Record<string, unknown>>(
  db: UsageSqliteDatabase,
  sql: string,
  params: SqlValue[] = [],
): T[] {
  return db.prepare(sql).all(...params) as T[];
}
