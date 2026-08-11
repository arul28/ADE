import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { SqlValue } from "../../state/kvDb";
import { isRecord, safeJsonParse } from "../../shared/utils";

/**
 * Whether a scan could read everything it set out to read.
 *
 * Every failure in this file is swallowed — a locked SQLite file, a directory
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
 * path scans all nine providers with `Promise.all`, and a shared flag would
 * attribute one provider's failure to whichever scan happened to finish next.
 */
type LedgerScanCompleteness = { complete: boolean };

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
function markLedgerScanIncompleteUnlessMissing(error: unknown): void {
  if (isMissingPathError(error)) return;
  markLedgerScanIncomplete();
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
  const value = await ledgerScanCompleteness.run(state, scan);
  return { value, complete: state.complete };
}

const LOCAL_COST_SCAN_MAX_FILES = 5_000;
const LOCAL_COST_SCAN_MAX_FILE_BYTES = 768 * 1024 * 1024;
const LOCAL_JSONL_MAX_LINE_BYTES = 16 * 1024 * 1024;
const LOCAL_COST_SCAN_MAX_ENTRIES = 1_000_000;
const LOCAL_COST_SCAN_ALL_DAYS = 3650;
// Codex rollouts are the largest ledger on disk by an order of magnitude: a
// single long-running session can pass 200 MB, and a heavy user's whole history
// runs to tens of gigabytes. These budgets are the *lifetime* total the Usage
// page reports, so a tight cap does not "degrade gracefully" — it silently
// reports a fraction of the user's real usage. Only token_count lines are
// parsed, the scan streams line by line in a separate worker process, and the
// result is cached for an hour, so the cost of a wide budget is bounded.
const CODEX_COST_SCAN_MAX_FILE_BYTES = 1024 * 1024 * 1024;
const CODEX_COST_SCAN_MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const CODEX_COST_SCAN_MAX_FILES = 50_000;
const CODEX_COST_SCAN_MAX_ENTRIES = 1_000_000;
const LOCAL_SQLITE_SCAN_MAX_ROWS = 250_000;
const LOCAL_CURSOR_SQLITE_RECENT_ROWS = 250_000;
const CURSOR_CHARS_PER_TOKEN = 4;

type UsageSqliteStatement = {
  all: (...params: SqlValue[]) => Record<string, unknown>[];
};
type UsageSqliteDatabase = {
  prepare: (sql: string) => UsageSqliteStatement;
  exec?: (sql: string) => void;
  close: () => void;
};
type UsageSqliteConstructor = new (dbPath: string, options?: { readOnly?: boolean }) => UsageSqliteDatabase;
type RecentFileCandidate = { path: string; mtimeMs: number };

const requireForUsageSqlite = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
let usageSqliteConstructor: UsageSqliteConstructor | null | undefined;
type CodexLogScanInFlight = { promise: Promise<TokenEntry[]>; state: LedgerScanCompleteness };
let codexLogScanInFlight: CodexLogScanInFlight | null = null;

type CodexLogScanOptions = {
  maxJsonlLineBytes?: number;
  maxEntries?: number;
};

function toFiniteNumber(value: unknown): number {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function toNonNegativeInt(value: unknown): number {
  return Math.max(0, Math.floor(toFiniteNumber(value)));
}

function normalizeUsageLabel(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : fallback;
}

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
  timestamp: number;
}

/**
 * Claude Code names its per-project directory under `~/.claude/projects/` by
 * replacing every non-alphanumeric character in the absolute cwd with `-`.
 * Runs are *not* collapsed and leading dashes are *not* trimmed, which is why
 * real directories look like `-Users-me-repo` on macOS and
 * `C--Users-me-repo` on Windows (the drive colon and the separator each become
 * their own dash).
 *
 * This must match Claude byte for byte: the result is compared against the
 * directory basename Claude itself wrote (`TokenEntry.projectKey`). Replacing
 * only `/`, `\` and `.` left the Windows drive colon in the name, so the key
 * never matched, and callers that built a path from it hit `mkdir` EINVAL/ENOENT
 * because NTFS cannot hold a colon inside a name.
 */
export function sanitizeClaudeProjectPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/gu, "-");
}

function isAdeWorktreePath(value: string): boolean {
  return value.replace(/\\/g, "/").includes("/.ade/worktrees/");
}

export function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberFromRecord(record: Record<string, unknown> | undefined, ...keys: string[]): number {
  if (!record) return 0;
  for (const key of keys) {
    const value = optionalNumber(record[key]);
    if (value != null) return value;
  }
  return 0;
}

function timestampMsFromValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

function timestampMsFromUnixish(value: unknown): number {
  const numeric = optionalNumber(value);
  if (numeric != null) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  return timestampMsFromValue(value);
}

function estimateTokensFromText(value: string): number {
  if (!value) return 0;
  return Math.ceil(value.length / CURSOR_CHARS_PER_TOKEN);
}

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

function newestCandidatePaths(files: RecentFileCandidate[]): string[] {
  return files
    .sort(compareRecentFileCandidates)
    .slice(0, LOCAL_COST_SCAN_MAX_FILES)
    .map((file) => file.path);
}

function textFromSqliteValue(value: unknown): string {
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

function openReadonlyUsageDatabase(dbPath: string): UsageSqliteDatabase | null {
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

function usageSqliteAll<T extends Record<string, unknown>>(
  db: UsageSqliteDatabase,
  sql: string,
  params: SqlValue[] = [],
): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function claudeCacheCreationTokens(usage: Record<string, unknown>): { total: number; oneHour: number } {
  const legacyTotal = numberFromRecord(usage, "cache_creation_input_tokens");
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const fiveMinute = numberFromRecord(cacheCreation, "ephemeral_5m_input_tokens");
  const oneHour = numberFromRecord(cacheCreation, "ephemeral_1h_input_tokens");
  const splitTotal = fiveMinute + oneHour;
  if (splitTotal === 0) return { total: legacyTotal, oneHour: 0 };
  const total = Math.max(legacyTotal, splitTotal);
  return { total, oneHour: Math.min(oneHour, total) };
}

function expandUsageHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function dedupeResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawPath of paths) {
    const resolved = path.resolve(expandUsageHome(rawPath));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function getClaudeConfigDirs(): string[] {
  const multi = process.env.CLAUDE_CONFIG_DIRS;
  if (multi?.trim()) {
    const dirs = multi
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (dirs.length > 0) return dedupeResolvedPaths(dirs);
  }

  const single = process.env.CLAUDE_CONFIG_DIR;
  if (single?.trim()) return dedupeResolvedPaths([single]);

  return [path.join(os.homedir(), ".claude")];
}

function getClaudeDesktopSessionsDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions");
  }
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "Claude", "local-agent-mode-sessions");
  }
  return path.join(os.homedir(), ".config", "Claude", "local-agent-mode-sessions");
}

async function addClaudeProjectsFromProjectsDir(projectsDir: string, seen: Set<string>, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch (error) {
    markLedgerScanIncompleteUnlessMissing(error);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, entry.name);
    const resolved = path.resolve(projectDir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(projectDir);
  }
}

async function findClaudeDesktopProjectDirs(base: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      markLedgerScanIncompleteUnlessMissing(error);
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") return;
      const fullPath = path.join(dir, entry.name);
      if (entry.name === "projects") {
        await addClaudeProjectsFromProjectsDir(fullPath, new Set(results.map((value) => path.resolve(value))), results);
        return;
      }
      await walk(fullPath, depth + 1);
    }));
  }

  await walk(base, 0);
  return dedupeResolvedPaths(results);
}

export async function discoverClaudeProjectDirs(): Promise<string[]> {
  const seen = new Set<string>();
  const projectDirs: string[] = [];

  for (const claudeDir of getClaudeConfigDirs()) {
    await addClaudeProjectsFromProjectsDir(path.join(claudeDir, "projects"), seen, projectDirs);
  }

  for (const desktopProjectDir of await findClaudeDesktopProjectDirs(getClaudeDesktopSessionsDir())) {
    const resolved = path.resolve(desktopProjectDir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    projectDirs.push(desktopProjectDir);
  }

  return projectDirs;
}

export async function scanClaudeLogs(projectDirsOverride?: string[]): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seenMessageIds = new Set<string>();
  const projectDirs = projectDirsOverride ?? await discoverClaudeProjectDirs();
  if (projectDirs.length === 0) return [];

  const jsonlFiles = await findClaudeJsonlFilesInProjectDirs(projectDirs, LOCAL_COST_SCAN_ALL_DAYS);

  for (const filePath of jsonlFiles) {
    try {
      const resolvedFilePath = path.resolve(filePath);
      const sourceProjectDir = projectDirs
        .map((projectDir) => path.resolve(projectDir))
        .filter((projectDir) => resolvedFilePath === projectDir || resolvedFilePath.startsWith(`${projectDir}${path.sep}`))
        .sort((a, b) => b.length - a.length)[0];
      const sourceProjectKey = sourceProjectDir ? path.basename(sourceProjectDir) : "";
      const firstTimestampByMessageId = new Map<string, number>();
      const lastEntryByMessageId = new Map<string, TokenEntry>();
      const messageOrder: string[] = [];

      for await (const line of readJsonlLines(filePath)) {
        if (!line.trim()) continue;
        const record = safeJsonParse<Record<string, unknown>>(line, {});
        if (record.type !== "assistant") continue;

        const message = record.message as Record<string, unknown> | undefined;
        if (!message) continue;

        const usage = message.usage as Record<string, unknown> | undefined;
        if (!usage) continue;

        const messageId = typeof message.id === "string" ? message.id : "";
        const requestId = typeof record.requestId === "string" ? record.requestId : "";
        const dedupeKey = messageId || `claude:${record.timestamp ?? ""}:${requestId}`;
        const timestamp = typeof record.timestamp === "number" ? record.timestamp :
          typeof record.timestamp === "string" ? new Date(record.timestamp).getTime() : Date.now();

        const model = typeof message.model === "string" ? message.model :
                      typeof record.model === "string" ? record.model : "unknown";
        const projectPath = typeof record.cwd === "string" && record.cwd.trim() ? record.cwd : undefined;
        const cacheCreation = claudeCacheCreationTokens(usage);
        const webSearchRequests = isRecord(usage.server_tool_use)
          ? numberFromRecord(usage.server_tool_use, "web_search_requests")
          : 0;

        if (!firstTimestampByMessageId.has(dedupeKey)) {
          firstTimestampByMessageId.set(dedupeKey, timestamp);
          messageOrder.push(dedupeKey);
        }

        lastEntryByMessageId.set(dedupeKey, {
          messageId: dedupeKey,
          model,
          ...(projectPath ? { projectPath } : {}),
          ...(sourceProjectKey ? { projectKey: sourceProjectKey } : {}),
          // Claude does not persist ADE's launcher originator. ADE lane cwd is
          // the strongest durable launch signal present in its JSONL ledger.
          adeOriginated: Boolean(
            (projectPath && isAdeWorktreePath(projectPath))
            || sourceProjectKey.includes("--ade-worktrees-"),
          ),
          inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
          cachedTokens: typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : typeof usage.cached_tokens === "number" ? usage.cached_tokens : 0,
          cacheWriteTokens: cacheCreation.total,
          oneHourCacheWriteTokens: cacheCreation.oneHour,
          webSearchRequests,
          timestamp,
        });
      }

      for (const dedupeKey of messageOrder) {
        if (seenMessageIds.has(dedupeKey)) continue;
        const entry = lastEntryByMessageId.get(dedupeKey);
        if (!entry) continue;
        seenMessageIds.add(dedupeKey);
        entry.timestamp = firstTimestampByMessageId.get(dedupeKey) ?? entry.timestamp;
        entries.push(entry);
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable files. The file was discovered a moment ago, so
      // whatever it holds is content this round has and a peer's may not.
      markLedgerScanIncomplete();
    }
  }

  return entries;
}

export function scanCodexLogs(
  options: CodexLogScanOptions = {},
): Promise<TokenEntry[]> {
  // Production callers share one machine-history pass. Without this guard,
  // two project runtimes opening Stats together can each retain a full Codex
  // entry set and multiply both CPU and peak memory. Test-only custom limits
  // bypass the shared promise so fixtures remain isolated.
  if (options.maxJsonlLineBytes !== undefined || options.maxEntries !== undefined) {
    return scanCodexLogsOnce(options);
  }
  // A caller that joins an in-flight scan must inherit its completeness too:
  // the failures happened inside the *first* caller's async context, so without
  // this the second caller would report a clean read of a partial scan.
  const join = async (shared: CodexLogScanInFlight): Promise<TokenEntry[]> => {
    try {
      return await shared.promise;
    } finally {
      if (!shared.state.complete) markLedgerScanIncomplete();
    }
  };
  if (codexLogScanInFlight) return join(codexLogScanInFlight);

  const state: LedgerScanCompleteness = { complete: true };
  let current!: CodexLogScanInFlight;
  current = {
    state,
    promise: ledgerScanCompleteness.run(state, () => scanCodexLogsOnce(options)).finally(() => {
      if (codexLogScanInFlight === current) codexLogScanInFlight = null;
    }),
  };
  codexLogScanInFlight = current;
  return join(current);
}

async function scanCodexLogsOnce(
  options: CodexLogScanOptions,
): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const maxEntries = options.maxEntries !== undefined && Number.isFinite(options.maxEntries)
    ? Math.max(1, Math.floor(options.maxEntries))
    : CODEX_COST_SCAN_MAX_ENTRIES;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const maxJsonlEntries = maxEntries;
  const sessionsDir = path.join(codexHome, "sessions");
  const archivedSessionsDir = path.join(codexHome, "archived_sessions");
  const sessionRoots = [sessionsDir, archivedSessionsDir].filter((root) => fs.existsSync(root));
  // One shared budget consumed in root order rather than an even split. The two
  // roots are wildly asymmetric — live `sessions/` typically holds tens of GB
  // while `archived_sessions/` holds a fraction of that — so an even split
  // starves the root that holds nearly all of the history.
  let remainingBytes = CODEX_COST_SCAN_MAX_TOTAL_BYTES;
  let remainingFiles = CODEX_COST_SCAN_MAX_FILES;
  // Codex archives a session by MOVING its rollout to `archived_sessions/`,
  // keeping the basename. Skip a basename already taken from `sessions/` so the
  // same rollout is never read twice.
  const seenSessionFileNames = new Set<string>();
  const jsonlFiles: string[] = [];
  for (const root of sessionRoots) {
    if (remainingBytes <= 0 || remainingFiles <= 0) break;
    const found = await findJsonlFiles(root, LOCAL_COST_SCAN_ALL_DAYS, {
      maxFiles: remainingFiles,
      maxFileBytes: CODEX_COST_SCAN_MAX_FILE_BYTES,
      maxTotalBytes: remainingBytes,
    });
    for (const filePath of found) {
      const name = path.basename(filePath);
      if (seenSessionFileNames.has(name)) continue;
      seenSessionFileNames.add(name);
      jsonlFiles.push(filePath);
      remainingFiles -= 1;
      try {
        remainingBytes -= (await fs.promises.stat(filePath)).size;
      } catch (error) {
        markLedgerScanIncompleteUnlessMissing(error);
      }
    }
  }

  for (const filePath of jsonlFiles) {
    try {
      let sessionId = path.basename(filePath, ".jsonl");
      let sessionModel = "codex";
      let sessionOriginator = "";
      let sessionProjectPath = "";
      let forkedFromId = "";
      let previousTotals: { input: number; cached: number; output: number; reasoning: number } | null = null;
      // Tracked separately from `previousTotals` because it must advance even on
      // events that carry no `total_token_usage` at all (compact boundaries).
      let previousCumulativeTotal: number | null = null;

      for await (const line of readJsonlLines(filePath, options.maxJsonlLineBytes)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const mayContainUsage =
          trimmed.includes("\"token_count\"") ||
          trimmed.includes("\"session_meta\"") ||
          trimmed.includes("\"turn_context\"") ||
          trimmed.includes("\"input_tokens\"") ||
          trimmed.includes("\"prompt_tokens\"") ||
          trimmed.includes("\"token_count\"");
        if (!mayContainUsage) continue;
        const record = safeJsonParse<Record<string, unknown>>(trimmed, {});

        const payload = isRecord(record.payload) ? record.payload : undefined;
        if (record.type === "session_meta" && payload) {
          const payloadSessionId = typeof payload.id === "string"
            ? payload.id
            : typeof payload.session_id === "string"
              ? payload.session_id
              : null;
          if (payloadSessionId) sessionId = payloadSessionId;
          if (typeof payload.model === "string" && payload.model.trim()) sessionModel = payload.model;
          if (typeof payload.originator === "string" && payload.originator.trim()) sessionOriginator = payload.originator;
          if (typeof payload.cwd === "string" && payload.cwd.trim()) sessionProjectPath = payload.cwd;
          const payloadForkedFromId = typeof payload.forkedFromId === "string"
            ? payload.forkedFromId
            : typeof payload.forked_from_id === "string"
              ? payload.forked_from_id
              : "";
          if (payloadForkedFromId.trim()) forkedFromId = payloadForkedFromId;
          continue;
        }

        if (record.type === "turn_context" && payload) {
          if (typeof payload.model === "string" && payload.model.trim()) sessionModel = payload.model;
          continue;
        }

        if (record.type === "event_msg" && payload?.type === "token_count") {
          const info = isRecord(payload.info) ? payload.info : undefined;
          if (!info) continue;

          const totalUsage = isRecord(info.total_token_usage) ? info.total_token_usage : undefined;
          const lastUsage = isRecord(info.last_token_usage) ? info.last_token_usage : undefined;
          const cumulativeTotal = numberFromRecord(totalUsage, "total_tokens");
          // Consecutive-duplicate guard. The null sentinel on `previousCumulativeTotal`
          // (not a 0-initialized baseline) makes the FIRST event always pass, so
          // a session that never reports a cumulative total does not lose its
          // opening turn. The equality test then applies REGARDLESS of whether
          // the total is zero: a compact-boundary event carries only
          // `last_token_usage`, so it reports cumulativeTotal=0 on every event
          // and a `> 0` guard would double-count every compaction.
          if (previousCumulativeTotal !== null && cumulativeTotal === previousCumulativeTotal) continue;
          previousCumulativeTotal = cumulativeTotal;

          let rawInputTokens = 0;
          let cachedTokens = 0;
          let outputTokens = 0;

          if (lastUsage) {
            rawInputTokens = numberFromRecord(lastUsage, "input_tokens");
            cachedTokens = numberFromRecord(lastUsage, "cached_input_tokens", "cache_read_input_tokens");
            outputTokens = numberFromRecord(lastUsage, "output_tokens");
          } else if (cumulativeTotal > 0 && totalUsage) {
            rawInputTokens = numberFromRecord(totalUsage, "input_tokens") - (previousTotals?.input ?? 0);
            cachedTokens = numberFromRecord(totalUsage, "cached_input_tokens", "cache_read_input_tokens") - (previousTotals?.cached ?? 0);
            outputTokens = numberFromRecord(totalUsage, "output_tokens") - (previousTotals?.output ?? 0);
          }

          // Advance the running baseline on every event that reports a
          // cumulative total, not only on the delta branch: a session that mixes
          // `last_token_usage` events with cumulative-only events would
          // otherwise compute the next delta against a stale baseline and
          // re-count the whole window.
          if (totalUsage) {
            previousTotals = {
              input: numberFromRecord(totalUsage, "input_tokens"),
              cached: numberFromRecord(totalUsage, "cached_input_tokens", "cache_read_input_tokens"),
              output: numberFromRecord(totalUsage, "output_tokens"),
              reasoning: numberFromRecord(totalUsage, "reasoning_output_tokens"),
            };
          }

          rawInputTokens = Math.max(0, rawInputTokens);
          cachedTokens = Math.max(0, cachedTokens);
          outputTokens = Math.max(0, outputTokens);
          // Codex counts reasoning INSIDE `output_tokens`, unlike Droid,
          // Gemini and OpenCode which report it as a sibling field. Verified
          // against 46,398 real `last_token_usage` records: 46,010 satisfy
          // `total == input + output`, none satisfy
          // `total == input + output + reasoning`, and `reasoning > output`
          // never occurs. Adding it again billed every Codex reasoning token
          // twice at the output rate.
          //
          // The displayed `outputTokens` therefore keeps the provider's own
          // figure rather than subtracting reasoning out: `total_tokens` is
          // defined as `input + output` at the source, and netting reasoning
          // off display would drop the machine total below the provider's own
          // accounting (the figure just reconciled against codeburn).
          const billableOutputTokens = outputTokens;
          // Codex reports cached input as a subset of input_tokens. Normalize
          // to the same mutually exclusive split used by Claude/codeburn so
          // input + cache read does not double-count the cached portion.
          const inputTokens = Math.max(0, rawInputTokens - cachedTokens);
          const billableInputTokens = inputTokens;
          if (inputTokens + billableOutputTokens + cachedTokens === 0) continue;

          const timestamp = timestampMsFromValue(record.timestamp);
          const model = typeof payload.model === "string" && payload.model.trim()
            ? payload.model
            : sessionModel;
          // Forked sessions copy the parent's entire token_count history and
          // RE-TIMESTAMP it, so a key containing the timestamp cannot collide on
          // exactly the replays that must collide. Namespace on the parent
          // (`forkedFromId`) and deliberately omit the per-session id so a
          // replay lands on the parent's own key. `cumulativeTotal` alone is too
          // coarse — a genuine post-divergence event whose running total happens
          // to equal some parent total would be lost — so the key also carries
          // the cumulative breakdown, which a replay reproduces verbatim. The
          // CUMULATIVE figures are used rather than the per-event deltas on
          // purpose: deltas are computed against a running baseline that a fork
          // advances differently once some replays are skipped, so a delta-based
          // key would spuriously diverge on a replay and double-count it.
          const dedupeKey = `codex:${forkedFromId || sessionId}:${cumulativeTotal}`
            + `:${numberFromRecord(totalUsage, "input_tokens")}`
            + `:${numberFromRecord(totalUsage, "cached_input_tokens", "cache_read_input_tokens")}`
            + `:${numberFromRecord(totalUsage, "output_tokens")}`
            + `:${numberFromRecord(totalUsage, "reasoning_output_tokens")}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          entries.push({
            messageId: dedupeKey,
            model,
            originator: sessionOriginator,
            ...(sessionProjectPath ? { projectPath: sessionProjectPath } : {}),
            adeOriginated: sessionOriginator.trim().toLowerCase().startsWith("ade"),
            inputTokens,
            billableInputTokens,
            outputTokens,
            billableOutputTokens,
            cachedTokens,
            billableCachedTokens: cachedTokens,
            cacheWriteTokens: 0,
            timestamp,
          });
          if (entries.length >= maxJsonlEntries) {
            return entries;
          }
          continue;
        }

        // Codex uses event_msg format
        const eventType = typeof record.type === "string" ? record.type :
                          typeof record.event_type === "string" ? record.event_type : "";

        if (!eventType.includes("token") && !eventType.includes("usage") && !eventType.includes("msg")) {
          // Also check for direct usage fields
          if (typeof record.input_tokens !== "number" && typeof record.token_count !== "number") continue;
        }

        const requestId = typeof record.requestId === "string" ? record.requestId :
                          typeof record.request_id === "string" ? record.request_id :
                          typeof record.id === "string" ? record.id : "";
        const messageId = typeof record.message_id === "string" ? record.message_id : "";
        const dedupeKey = `${messageId}:${requestId}`;
        if (dedupeKey !== ":" && seen.has(dedupeKey)) continue;
        if (dedupeKey !== ":") seen.add(dedupeKey);

        const model = typeof record.model === "string" ? record.model : "codex";

        const rawInputTokens = typeof record.input_tokens === "number" ? record.input_tokens :
                               typeof record.prompt_tokens === "number" ? record.prompt_tokens : 0;
        const outputTokens = typeof record.output_tokens === "number" ? record.output_tokens :
                             typeof record.completion_tokens === "number" ? record.completion_tokens : 0;
        const tokenCount = typeof record.token_count === "number" ? record.token_count : 0;
        const cachedTokens = typeof record.cached_tokens === "number" ? record.cached_tokens : 0;

        if (rawInputTokens === 0 && outputTokens === 0 && tokenCount === 0) continue;

        const inputTokens = rawInputTokens > 0
          ? Math.max(0, rawInputTokens - cachedTokens)
          : Math.floor(tokenCount * 0.4);

        entries.push({
          messageId: `${sessionId}:${dedupeKey === ":" ? record.timestamp ?? entries.length : dedupeKey}`,
          model,
          originator: sessionOriginator,
          ...(sessionProjectPath ? { projectPath: sessionProjectPath } : {}),
          adeOriginated: sessionOriginator.trim().toLowerCase().startsWith("ade"),
          inputTokens,
          billableInputTokens: inputTokens,
          outputTokens: outputTokens || Math.ceil(tokenCount * 0.6),
          cachedTokens,
          billableCachedTokens: cachedTokens,
          cacheWriteTokens: 0,
          timestamp: typeof record.timestamp === "number" ? record.timestamp :
                     typeof record.timestamp === "string" ? new Date(record.timestamp).getTime() : Date.now(),
        });
        if (entries.length >= maxJsonlEntries) {
          return entries;
        }
      }
    } catch {
      // Skip unreadable files; see `scanClaudeLogs` for why that is incomplete.
      markLedgerScanIncomplete();
    }
  }

  return entries;
}

function defaultOpenClawAgentRoots(): string[] {
  return [
    path.join(os.homedir(), ".openclaw", "agents"),
    path.join(os.homedir(), ".clawdbot", "agents"),
    path.join(os.homedir(), ".moltbot", "agents"),
    path.join(os.homedir(), ".moldbot", "agents"),
  ];
}

export async function scanOpenClawLogs(agentRoots = defaultOpenClawAgentRoots()): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();

  const jsonlFiles: string[] = [];
  for (const root of agentRoots) {
    jsonlFiles.push(...await findJsonlFiles(root, LOCAL_COST_SCAN_ALL_DAYS));
  }

  for (const filePath of jsonlFiles.slice(0, LOCAL_COST_SCAN_MAX_FILES)) {
    try {
      let sessionId = path.basename(filePath, ".jsonl");
      let currentModel = "openclaw-auto";
      let sessionTimestamp = "";
      let sessionCwd = "";

      for await (const line of readJsonlLines(filePath)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const record = safeJsonParse<Record<string, unknown>>(trimmed, {});
        const type = normalizeUsageLabel(record.type, "");

        if (type === "session") {
          if (typeof record.id === "string" && record.id.trim()) sessionId = record.id;
          if (typeof record.timestamp === "string") sessionTimestamp = record.timestamp;
          if (typeof record.cwd === "string" && record.cwd.trim()) sessionCwd = record.cwd.trim();
          continue;
        }

        if (type === "model_change") {
          if (typeof record.modelId === "string" && record.modelId.trim()) currentModel = record.modelId;
          continue;
        }

        if (type === "custom" && record.customType === "model-snapshot" && isRecord(record.data)) {
          if (typeof record.data.modelId === "string" && record.data.modelId.trim()) {
            currentModel = record.data.modelId;
          }
          continue;
        }

        if (type !== "message" || !isRecord(record.message)) continue;
        const message = record.message;
        if (message.role !== "assistant" || !isRecord(message.usage)) continue;

        const usage = message.usage;
        const inputTokens = numberFromRecord(usage, "input");
        const outputTokens = numberFromRecord(usage, "output");
        const cachedTokens = numberFromRecord(usage, "cacheRead");
        const cacheWriteTokens = numberFromRecord(usage, "cacheWrite");
        if (inputTokens + outputTokens + cachedTokens + cacheWriteTokens === 0) continue;

        const timestamp = timestampMsFromValue(record.timestamp ?? sessionTimestamp);
        const cost = isRecord(usage.cost) ? optionalNumber(usage.cost.total) : null;
        const model = typeof message.model === "string" && message.model.trim()
          ? message.model
          : currentModel;
        const dedupeKey = `openclaw:${sessionId}:${typeof record.id === "string" && record.id ? record.id : `${record.timestamp ?? timestamp}:${entries.length}`}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        entries.push({
          messageId: dedupeKey,
          model,
          inputTokens,
          outputTokens,
          cachedTokens,
          billableCachedTokens: cachedTokens,
          cacheWriteTokens,
          costOverrideUsd: cost != null && cost > 0 ? cost : undefined,
          timestamp,
          // OpenClaw writes the session's working directory on its `session`
          // record, which is always the first line of the file — so every
          // message below it can be attributed to a project.
          ...(sessionCwd ? { projectPath: sessionCwd } : {}),
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable or malformed session files.
      markLedgerScanIncomplete();
    }
  }

  return entries;
}

function defaultDroidSessionsDir(): string {
  return path.join(process.env.FACTORY_DIR ?? path.join(os.homedir(), ".factory"), "sessions");
}

function stripDroidModelPrefix(raw: string): string {
  return raw
    .replace(/^custom:/, "")
    .replace(/\[.*?\]/g, "")
    .replace(/-\d+$/, "")
    .replace(/-+$/, "")
    .replace(/^-/, "");
}

export async function scanDroidLogs(sessionsDir = defaultDroidSessionsDir()): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const jsonlFiles = await findJsonlFiles(sessionsDir, LOCAL_COST_SCAN_ALL_DAYS);

  for (const filePath of jsonlFiles) {
    try {
      const settings = safeJsonParse<Record<string, unknown>>(
        await fs.promises.readFile(filePath.replace(/\.jsonl$/, ".settings.json"), "utf8").catch((error: unknown) => {
          // A session with no settings file has no token usage to read; one
          // whose settings file exists and will not open is a session's worth
          // of tokens this round is missing.
          markLedgerScanIncompleteUnlessMissing(error);
          return "{}";
        }),
        {},
      );
      const tokenUsage = isRecord(settings.tokenUsage) ? settings.tokenUsage : null;
      if (!tokenUsage) continue;

      let sessionId = path.basename(filePath, ".jsonl");
      // Droid records the session's working directory on `session_start`. The
      // containing directory name encodes it too, but only as a lossy
      // dash-sanitized key, so prefer the literal path.
      let sessionCwd = "";
      const model = typeof settings.model === "string" && settings.model.trim()
        ? stripDroidModelPrefix(settings.model)
        : "droid-auto";
      const assistantCalls: Array<{ id: string; timestamp: number }> = [];

      for await (const line of readJsonlLines(filePath)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const record = safeJsonParse<Record<string, unknown>>(trimmed, {});
        if (record.type === "session_start") {
          if (typeof record.id === "string" && record.id.trim()) sessionId = record.id;
          if (typeof record.cwd === "string" && record.cwd.trim()) sessionCwd = record.cwd.trim();
          continue;
        }
        if (record.type !== "message" || !isRecord(record.message)) continue;
        const message = record.message;
        if (message.role !== "assistant") continue;
        const content = Array.isArray(message.content) ? message.content : [];
        const hasAssistantActivity = content.some((block) => (
          isRecord(block) &&
          ((block.type === "text" && typeof block.text === "string" && block.text.trim()) || block.type === "tool_use")
        ));
        if (!hasAssistantActivity) continue;
        assistantCalls.push({
          id: typeof record.id === "string" && record.id ? record.id : `msg-${assistantCalls.length}`,
          timestamp: timestampMsFromValue(record.timestamp),
        });
      }

      if (assistantCalls.length === 0) continue;
      const totalInput = numberFromRecord(tokenUsage, "inputTokens");
      const totalOutput = numberFromRecord(tokenUsage, "outputTokens");
      const totalCacheWrite = numberFromRecord(tokenUsage, "cacheCreationTokens");
      const totalCacheRead = numberFromRecord(tokenUsage, "cacheReadTokens");
      const totalThinking = numberFromRecord(tokenUsage, "thinkingTokens");
      if (totalInput + totalOutput + totalCacheWrite + totalCacheRead + totalThinking === 0) continue;

      const inputPerCall = Math.floor(totalInput / assistantCalls.length);
      const outputPerCall = Math.floor(totalOutput / assistantCalls.length);
      const cacheWritePerCall = Math.floor(totalCacheWrite / assistantCalls.length);
      const cacheReadPerCall = Math.floor(totalCacheRead / assistantCalls.length);
      const thinkingPerCall = Math.floor(totalThinking / assistantCalls.length);

      for (let i = 0; i < assistantCalls.length; i++) {
        const call = assistantCalls[i]!;
        const isLast = i === assistantCalls.length - 1;
        const dedupeKey = `droid:${sessionId}:${call.id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        // Reasoning ("thinking") tokens bill at the output rate but are not
        // output: keep them out of the displayed output count and fold them in
        // only through `billableOutputTokens`, which is all `calculateTokenEntryCost`
        // reads.
        const callOutputTokens = isLast ? totalOutput - outputPerCall * i : outputPerCall;
        const callThinkingTokens = isLast ? totalThinking - thinkingPerCall * i : thinkingPerCall;
        entries.push({
          messageId: dedupeKey,
          model,
          inputTokens: isLast ? totalInput - inputPerCall * i : inputPerCall,
          outputTokens: callOutputTokens,
          billableOutputTokens: callOutputTokens + callThinkingTokens,
          cachedTokens: isLast ? totalCacheRead - cacheReadPerCall * i : cacheReadPerCall,
          billableCachedTokens: isLast ? totalCacheRead - cacheReadPerCall * i : cacheReadPerCall,
          cacheWriteTokens: isLast ? totalCacheWrite - cacheWritePerCall * i : cacheWritePerCall,
          timestamp: call.timestamp,
          estimation: "distribution",
          ...(sessionCwd ? { projectPath: sessionCwd } : {}),
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable or malformed Droid sessions.
      markLedgerScanIncomplete();
    }
  }

  return entries;
}

function defaultCopilotSessionStateDir(): string {
  return path.join(os.homedir(), ".copilot", "session-state");
}

function defaultVSCodeWorkspaceStorageDirs(): string[] {
  if (process.platform === "darwin") {
    return [
      path.join(os.homedir(), "Library", "Application Support", "Code", "User", "workspaceStorage"),
      path.join(os.homedir(), "Library", "Application Support", "Code - Insiders", "User", "workspaceStorage"),
    ];
  }
  if (process.platform === "win32") {
    return [
      path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "workspaceStorage"),
      path.join(os.homedir(), "AppData", "Roaming", "Code - Insiders", "User", "workspaceStorage"),
    ];
  }
  return [
    path.join(os.homedir(), ".config", "Code", "User", "workspaceStorage"),
    path.join(os.homedir(), ".config", "Code - Insiders", "User", "workspaceStorage"),
    path.join(os.homedir(), ".vscode-server", "data", "User", "workspaceStorage"),
  ];
}

function inferCopilotModelFromToolCalls(events: Record<string, unknown>[]): string {
  const modelCounts = new Map<string, number>();
  const bump = (model: string, weight: number) => {
    if (!model.trim()) return;
    modelCounts.set(model, (modelCounts.get(model) ?? 0) + weight);
  };

  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {};
    if (typeof data.model === "string" && data.model.trim()) bump(data.model, 100);
    if (event.type !== "assistant.message") continue;
    const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
    for (const tool of toolRequests) {
      if (!isRecord(tool) || typeof tool.toolCallId !== "string") continue;
      const toolCallId = tool.toolCallId;
      if (toolCallId.startsWith("call_")) bump("copilot-openai-auto", 1);
      if (toolCallId.startsWith("toolu_") || toolCallId.startsWith("tooluse_")) bump("copilot-anthropic-auto", 1);
    }
  }

  return [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "copilot-auto";
}

export function parseCopilotEvents(raw: string, sourcePath: string, fallbackProjectPath?: string): TokenEntry[] {
  const entries: TokenEntry[] = [];
  const records = raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => safeJsonParse<Record<string, unknown>>(line, {}))
    .filter((record) => isRecord(record));
  const first = records[0];
  // Copilot's own `session.start` carries the working directory it ran in.
  // VS Code chat transcripts have no such record, so the caller supplies the
  // workspace folder it read from `workspace.json` instead.
  const sessionCwd = (() => {
    for (const record of records) {
      if (record.type !== "session.start" || !isRecord(record.data)) continue;
      const context = isRecord(record.data.context) ? record.data.context : null;
      if (!context) continue;
      for (const key of ["cwd", "gitRoot"]) {
        const value = context[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
    return fallbackProjectPath?.trim() ?? "";
  })();
  const isTranscript = first?.type === "session.start" && isRecord(first.data) && first.data.producer === "copilot-agent";
  const sessionId = path.basename(sourcePath, ".jsonl").length === 36
    ? path.basename(sourcePath, ".jsonl")
    : path.basename(path.dirname(sourcePath));
  let currentModel = "";
  let pendingUserMessage = "";

  if (isTranscript) {
    const inferredModel = inferCopilotModelFromToolCalls(records);
    for (const record of records) {
      const data = isRecord(record.data) ? record.data : {};
      if (record.type === "user.message") {
        pendingUserMessage = typeof data.content === "string" ? data.content.slice(0, 500) : "";
        continue;
      }
      if (record.type !== "assistant.message") continue;
      const messageId = typeof data.messageId === "string" && data.messageId ? data.messageId : `${record.timestamp ?? entries.length}`;
      const content = typeof data.content === "string" ? data.content : "";
      const reasoning = typeof data.reasoningText === "string" ? data.reasoningText : "";
      const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      if (!content && !reasoning && toolRequests.length === 0) continue;
      let outputTokens = numberFromRecord(data, "outputTokens");
      let reasoningTokens = 0;
      if (outputTokens === 0) {
        outputTokens = estimateTokensFromText(content);
        reasoningTokens = estimateTokensFromText(reasoning);
      }
      entries.push({
        messageId: `copilot:${sessionId}:${messageId}`,
        model: typeof data.model === "string" && data.model.trim() ? data.model : inferredModel,
        inputTokens: estimateTokensFromText(pendingUserMessage),
        outputTokens,
        billableOutputTokens: outputTokens + reasoningTokens,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        timestamp: timestampMsFromValue(record.timestamp),
        estimation: numberFromRecord(data, "outputTokens") > 0 ? "mixed" : "chars",
        ...(sessionCwd ? { projectPath: sessionCwd } : {}),
      });
      pendingUserMessage = "";
    }
    return entries;
  }

  for (const record of records) {
    const data = isRecord(record.data) ? record.data : {};
    if (typeof data.model === "string" && data.model.trim()) currentModel = data.model;
    if (record.type === "session.model_change") {
      if (typeof data.newModel === "string" && data.newModel.trim()) currentModel = data.newModel;
      continue;
    }
    if (record.type === "user.message") {
      pendingUserMessage = typeof data.content === "string" ? data.content : "";
      continue;
    }
    if (record.type !== "assistant.message") continue;
    const outputTokens = numberFromRecord(data, "outputTokens");
    if (outputTokens === 0 || !currentModel) continue;
    const messageId = typeof data.messageId === "string" && data.messageId ? data.messageId : `${record.timestamp ?? entries.length}`;
    entries.push({
      messageId: `copilot:${sessionId}:${messageId}`,
      model: currentModel,
      inputTokens: estimateTokensFromText(pendingUserMessage),
      outputTokens,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      timestamp: timestampMsFromValue(record.timestamp),
      estimation: "mixed",
      ...(sessionCwd ? { projectPath: sessionCwd } : {}),
    });
    pendingUserMessage = "";
  }

  return entries;
}

/**
 * VS Code stores a workspace's chat transcripts under an opaque hash directory
 * and records which folder that hash stands for in a sibling `workspace.json`.
 * Without this lookup a Copilot transcript has no project at all, and project
 * scope drops it.
 */
async function readVSCodeWorkspaceFolder(workspaceDir: string): Promise<string> {
  const manifestPath = path.join(workspaceDir, "workspace.json");
  let raw: string;
  try {
    raw = await fs.promises.readFile(manifestPath, "utf8");
  } catch (error) {
    markLedgerScanIncompleteUnlessMissing(error);
    return "";
  }
  const manifest = safeJsonParse<Record<string, unknown>>(raw, {});
  const folder = typeof manifest.folder === "string" ? manifest.folder : "";
  if (!folder.startsWith("file://")) return "";
  try {
    return fileURLToPath(folder);
  } catch {
    return "";
  }
}

async function discoverCopilotTranscriptFiles(
  sessionStateDir = defaultCopilotSessionStateDir(),
  workspaceStorageDirs = defaultVSCodeWorkspaceStorageDirs(),
): Promise<{ paths: string[]; projectPathByFile: Map<string, string> }> {
  const files: RecentFileCandidate[] = [];
  const projectPathByFile = new Map<string, string>();
  try {
    const sessionDirs = await fs.promises.readdir(sessionStateDir);
    await Promise.all(sessionDirs.map(async (sessionId) => {
      const eventsPath = path.join(sessionStateDir, sessionId, "events.jsonl");
      const stat = await fs.promises.stat(eventsPath).catch((error: unknown) => {
        markLedgerScanIncompleteUnlessMissing(error);
        return null;
      });
      if (stat?.isFile() && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) {
        files.push({ path: eventsPath, mtimeMs: stat.mtimeMs });
      }
    }));
  } catch (error) {
    // Missing Copilot legacy state is expected for users who never used it.
    markLedgerScanIncompleteUnlessMissing(error);
  }

  await Promise.all(workspaceStorageDirs.map(async (workspaceStorageDir) => {
    let workspaceDirs: string[];
    try {
      workspaceDirs = await fs.promises.readdir(workspaceStorageDir);
    } catch (error) {
      markLedgerScanIncompleteUnlessMissing(error);
      return;
    }
    await Promise.all(workspaceDirs.map(async (workspaceDir) => {
      const transcriptsDir = path.join(workspaceStorageDir, workspaceDir, "GitHub.copilot-chat", "transcripts");
      let transcriptFiles: string[];
      try {
        transcriptFiles = await fs.promises.readdir(transcriptsDir);
      } catch (error) {
        markLedgerScanIncompleteUnlessMissing(error);
        return;
      }
      const workspaceFolder = await readVSCodeWorkspaceFolder(path.join(workspaceStorageDir, workspaceDir));
      await Promise.all(transcriptFiles
        .filter((file) => file.endsWith(".jsonl"))
        .map(async (file) => {
          const filePath = path.join(transcriptsDir, file);
          const stat = await fs.promises.stat(filePath).catch((error: unknown) => {
            markLedgerScanIncompleteUnlessMissing(error);
            return null;
          });
          if (stat?.isFile() && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) {
            files.push({ path: filePath, mtimeMs: stat.mtimeMs });
            if (workspaceFolder) projectPathByFile.set(filePath, workspaceFolder);
          }
        }));
    }));
  }));

  return { paths: newestCandidatePaths(files), projectPathByFile };
}

export async function scanCopilotLogs(
  sessionStateDir = defaultCopilotSessionStateDir(),
  workspaceStorageDirs = defaultVSCodeWorkspaceStorageDirs(),
): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const { paths, projectPathByFile } = await discoverCopilotTranscriptFiles(sessionStateDir, workspaceStorageDirs);
  for (const filePath of paths) {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      for (const entry of parseCopilotEvents(raw, filePath, projectPathByFile.get(filePath))) {
        if (entry.inputTokens + entry.outputTokens + entry.cachedTokens + toNonNegativeInt(entry.cacheWriteTokens) === 0) continue;
        if (seen.has(entry.messageId)) continue;
        seen.add(entry.messageId);
        entries.push(entry);
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable Copilot logs.
      markLedgerScanIncomplete();
    }
  }
  return entries;
}

function defaultGeminiTmpDir(): string {
  return path.join(os.homedir(), ".gemini", "tmp");
}

function parseGeminiSession(raw: string): { sessionId: string; startTime: string; messages: Record<string, unknown>[] } | null {
  const parsed = safeJsonParse<Record<string, unknown>>(raw, {});
  if (isRecord(parsed) && typeof parsed.sessionId === "string" && Array.isArray(parsed.messages)) {
    return {
      sessionId: parsed.sessionId,
      startTime: typeof parsed.startTime === "string" ? parsed.startTime : "",
      messages: parsed.messages.filter((message): message is Record<string, unknown> => isRecord(message)),
    };
  }

  let sessionId = "";
  let startTime = "";
  const messages: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = safeJsonParse<Record<string, unknown>>(line, {});
    if (record.$set !== undefined) continue;
    if (!sessionId && typeof record.sessionId === "string" && typeof record.startTime === "string") {
      sessionId = record.sessionId;
      startTime = record.startTime;
      continue;
    }
    if (typeof record.id === "string" && typeof record.type === "string") {
      messages.push(record);
    }
  }
  return sessionId ? { sessionId, startTime, messages } : null;
}

export function parseGeminiEntries(raw: string, sourcePath: string, projectPath?: string): TokenEntry[] {
  const session = parseGeminiSession(raw);
  if (!session) return [];
  const entries: TokenEntry[] = [];
  let ordinal = 0;

  for (const message of session.messages) {
    if (message.type === "user") continue;
    if (message.type !== "gemini" || !isRecord(message.tokens)) continue;
    const model = typeof message.model === "string" && message.model.trim() ? message.model : "gemini-auto";
    const tokens = message.tokens;
    const totalInput = numberFromRecord(tokens, "input");
    const totalOutput = numberFromRecord(tokens, "output");
    const totalCached = numberFromRecord(tokens, "cached");
    const totalThoughts = numberFromRecord(tokens, "thoughts");
    if (totalInput + totalOutput + totalCached + totalThoughts === 0) continue;
    const freshInput = Math.max(0, totalInput - totalCached);
    const timestamp = timestampMsFromValue(message.timestamp ?? session.startTime);
    if (timestamp < 1_000_000_000_000) continue;
    const messageId = typeof message.id === "string" && message.id ? message.id : `${path.basename(sourcePath)}:${ordinal}`;
    ordinal += 1;
    entries.push({
      messageId: `gemini:${session.sessionId}:${messageId}`,
      model,
      inputTokens: freshInput,
      // Gemini bills "thoughts" at the output rate but they are not output:
      // report them only through the billable field so display totals stay
      // reasoning-free while cost still charges for them.
      outputTokens: totalOutput,
      billableOutputTokens: totalOutput + totalThoughts,
      cachedTokens: totalCached,
      billableCachedTokens: totalCached,
      cacheWriteTokens: 0,
      timestamp,
      ...(projectPath?.trim() ? { projectPath: projectPath.trim() } : {}),
    });
  }
  return entries;
}

/**
 * Gemini names its per-project temp directory after the project's basename (or
 * basename + hash), which is not a path. The real working directory is written
 * to a `.project_root` file beside the chat log — the only place the full path
 * survives, and therefore the only way Gemini usage can be project-scoped.
 */
async function readGeminiProjectRoot(projectDir: string): Promise<string> {
  try {
    return (await fs.promises.readFile(path.join(projectDir, ".project_root"), "utf8")).trim();
  } catch (error) {
    markLedgerScanIncompleteUnlessMissing(error);
    return "";
  }
}

async function discoverGeminiSessionFiles(
  tmpDir = defaultGeminiTmpDir(),
): Promise<{ paths: string[]; projectPathByFile: Map<string, string> }> {
  const files: RecentFileCandidate[] = [];
  const projectPathByFile = new Map<string, string>();
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = await fs.promises.readdir(tmpDir, { withFileTypes: true });
  } catch (error) {
    markLedgerScanIncompleteUnlessMissing(error);
    return { paths: [], projectPathByFile };
  }

  await Promise.all(projectDirs
    .filter((entry) => entry.isDirectory())
    .map(async (projectDir) => {
      const chatsDir = path.join(tmpDir, projectDir.name, "chats");
      const projectRoot = await readGeminiProjectRoot(path.join(tmpDir, projectDir.name));
      let chatFiles: string[];
      try {
        chatFiles = await fs.promises.readdir(chatsDir);
      } catch (error) {
        markLedgerScanIncompleteUnlessMissing(error);
        return;
      }
      await Promise.all(chatFiles
        .filter((file) => file.startsWith("session-") && (file.endsWith(".json") || file.endsWith(".jsonl")))
        .map(async (file) => {
          const filePath = path.join(chatsDir, file);
          const stat = await fs.promises.stat(filePath).catch((error: unknown) => {
            markLedgerScanIncompleteUnlessMissing(error);
            return null;
          });
          if (stat?.isFile() && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) {
            files.push({ path: filePath, mtimeMs: stat.mtimeMs });
            if (projectRoot) projectPathByFile.set(filePath, projectRoot);
          }
        }));
    }));

  return { paths: newestCandidatePaths(files), projectPathByFile };
}

export async function scanGeminiLogs(tmpDir = defaultGeminiTmpDir()): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const { paths, projectPathByFile } = await discoverGeminiSessionFiles(tmpDir);
  for (const filePath of paths) {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      for (const entry of parseGeminiEntries(raw, filePath, projectPathByFile.get(filePath))) {
        if (seen.has(entry.messageId)) continue;
        seen.add(entry.messageId);
        entries.push(entry);
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable Gemini logs.
      markLedgerScanIncomplete();
    }
  }
  return entries;
}

function defaultOpenCodeDataDir(): string {
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "opencode");
}

export async function scanOpenCodeLogs(dataDir = defaultOpenCodeDataDir()): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  let dbFiles: string[] = [];
  try {
    dbFiles = (await fs.promises.readdir(dataDir))
      .filter((name) => name.startsWith("opencode") && name.endsWith(".db"))
      .map((name) => path.join(dataDir, name));
  } catch (error) {
    markLedgerScanIncompleteUnlessMissing(error);
    return entries;
  }

  const sinceMs = 0;
  for (const dbPath of dbFiles) {
    const db = openReadonlyUsageDatabase(dbPath);
    if (!db) continue;
    try {
      type OpenCodeMessageRow = {
        id: string;
        sessionId: string;
        timeCreated: number;
        data: string;
        directory: string | null;
      };
      const selectMessages = (withSession: boolean) => usageSqliteAll<OpenCodeMessageRow>(
        db,
        `
          select
            m.id as id,
            m.session_id as sessionId,
            m.time_created as timeCreated,
            cast(m.data as blob) as data,
            ${withSession ? "s.directory as directory" : "null as directory"}
          from message m
          ${withSession ? "left join session s on s.id = m.session_id" : ""}
          where m.time_created >= ?
          order by m.time_created desc, m.id desc
          limit ?
        `,
        [sinceMs, LOCAL_SQLITE_SCAN_MAX_ROWS],
      );
      // `session.directory` is the working directory OpenCode ran the session
      // in — the only project attribution this ledger has. Left-joined so a
      // message whose session row was pruned still counts toward the machine.
      // Older OpenCode installs have no `session` table at all; losing every
      // message because the project column is unavailable would be a far worse
      // trade than losing the project column, so fall back to the plain read.
      let rows: OpenCodeMessageRow[];
      try {
        rows = selectMessages(true);
      } catch {
        rows = selectMessages(false);
      }
      for (const row of rows) {
        const data = safeJsonParse<Record<string, unknown>>(textFromSqliteValue(row.data), {});
        if (data.role !== "assistant") continue;
        const tokens = isRecord(data.tokens) ? data.tokens : {};
        const cache = isRecord(tokens.cache) ? tokens.cache : {};
        const inputTokens = numberFromRecord(tokens, "input");
        const outputTokens = numberFromRecord(tokens, "output");
        const reasoningTokens = numberFromRecord(tokens, "reasoning");
        const cachedTokens = numberFromRecord(cache, "read");
        const cacheWriteTokens = numberFromRecord(cache, "write");
        const cost = optionalNumber(data.cost);
        if (inputTokens + outputTokens + reasoningTokens + cachedTokens + cacheWriteTokens === 0 && !(cost && cost > 0)) continue;

        const sessionId = typeof row.sessionId === "string" && row.sessionId ? row.sessionId : "unknown";
        const dedupeKey = `opencode:${sessionId}:${row.id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        entries.push({
          messageId: dedupeKey,
          model: typeof data.modelID === "string" && data.modelID.trim() ? data.modelID : "opencode-auto",
          inputTokens,
          // Reasoning is billed at the output rate but is not output; it reaches
          // cost through `billableOutputTokens` and stays out of display totals.
          outputTokens,
          billableOutputTokens: outputTokens + reasoningTokens,
          cachedTokens,
          billableCachedTokens: cachedTokens,
          cacheWriteTokens,
          costOverrideUsd: cost != null && cost > 0 ? cost : undefined,
          timestamp: timestampMsFromUnixish(row.timeCreated),
          ...(typeof row.directory === "string" && row.directory.trim()
            ? { projectPath: row.directory.trim() }
            : {}),
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unrecognized OpenCode DB schemas. The database is there and its
      // messages went unread, so this round did not see everything.
      markLedgerScanIncomplete();
    } finally {
      db.close();
    }
  }

  return entries;
}

function defaultCursorDbPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(os.homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

export async function scanCursorLogs(dbPath = defaultCursorDbPath()): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const db = openReadonlyUsageDatabase(dbPath);
  if (!db) return entries;

  try {
    const cursorRows = usageSqliteAll<{
      key: string;
      value: string | Uint8Array | null;
    }>(
      db,
      `
        select
          key,
          cast(value as blob) as value
        from cursorDiskKV
        order by rowid desc
        limit ?
      `,
      [LOCAL_CURSOR_SQLITE_RECENT_ROWS],
    );

    for (const row of cursorRows) {
      if (!row.key.startsWith("bubbleId:")) continue;
      const value = safeJsonParse<Record<string, unknown>>(textFromSqliteValue(row.value), {});
      const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
      if (!createdAt) continue;
      const tokenCount = isRecord(value.tokenCount) ? value.tokenCount : {};
      let inputTokens = numberFromRecord(tokenCount, "inputTokens");
      let outputTokens = numberFromRecord(tokenCount, "outputTokens");
      if (inputTokens + outputTokens === 0) {
        const estimated = typeof value.text === "string" ? estimateTokensFromText(value.text) : 0;
        if (value.type === 1) inputTokens = estimated;
        else outputTokens = estimated;
      }
      if (inputTokens + outputTokens === 0) continue;
      const dedupeKey = `cursor:bubble:${row.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const modelInfo = isRecord(value.modelInfo) ? value.modelInfo : {};
      const rawModel = typeof modelInfo.modelName === "string" ? modelInfo.modelName.trim() : "";
      const model = rawModel && rawModel !== "default"
        ? rawModel
        : "cursor-auto";
      entries.push({
        messageId: dedupeKey,
        model,
        inputTokens,
        outputTokens,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        timestamp: timestampMsFromValue(createdAt),
        estimation: "mixed",
      });
      if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
    }

    // Cursor's bubble rows contain the real token counts surfaced by Cursor's
    // UI. The agentKv rows are text blobs that require estimation and have
    // proven noisy in parity checks, so ADE leaves them out and relies on the
    // separate Cursor Agent transcript scanner for cursor-agent sessions.
  } catch {
    markLedgerScanIncomplete();
    return entries;
  } finally {
    db.close();
  }

  return entries;
}

function extractCursorAgentUserQuery(text: string): string {
  const matches = Array.from(text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g))
    .map((match) => (match[1] ?? "").trim())
    .filter(Boolean);
  return (matches.length > 0 ? matches.join(" ") : text).replace(/\s+/g, " ").trim().slice(0, 500);
}

function parseCursorAgentJsonlTranscript(raw: string): Array<{ inputText: string; outputText: string; reasoningText: string }> {
  const turns: Array<{ inputText: string; outputText: string; reasoningText: string }> = [];
  let currentUser = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = safeJsonParse<Record<string, unknown>>(line, {});
    if (record.role === "user" && isRecord(record.message)) {
      const content = Array.isArray(record.message.content) ? record.message.content : [];
      const text = content
        .map((block) => isRecord(block) && typeof block.text === "string" ? block.text : "")
        .filter(Boolean)
        .join(" ");
      currentUser = extractCursorAgentUserQuery(text);
      continue;
    }
    if (record.role === "assistant" && currentUser && isRecord(record.message)) {
      const content = Array.isArray(record.message.content) ? record.message.content : [];
      const outputText = content
        .map((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "")
        .filter(Boolean)
        .join("\n");
      turns.push({ inputText: currentUser, outputText, reasoningText: "" });
      currentUser = "";
    }
  }
  return turns;
}

function parseCursorAgentTextTranscript(raw: string): Array<{ inputText: string; outputText: string; reasoningText: string }> {
  const turns: Array<{ inputText: string; outputText: string; reasoningText: string }> = [];
  const pendingUsers: string[] = [];
  let active: "none" | "user" | "assistant" = "none";
  let userLines: string[] = [];
  let assistantLines: string[] = [];

  const flushUser = () => {
    if (userLines.length === 0) return;
    const inputText = extractCursorAgentUserQuery(userLines.join("\n"));
    if (inputText) pendingUsers.push(inputText);
    userLines = [];
  };

  const flushAssistant = () => {
    if (assistantLines.length === 0) return;
    let outputText = "";
    let reasoningText = "";
    for (const line of assistantLines) {
      if (/^\s*\[Tool result\]\b/i.test(line)) continue;
      const thinkingMatch = line.match(/^\s*\[Thinking\]\s*/);
      if (thinkingMatch) {
        const body = line.replace(/^\s*\[Thinking\]\s*/, "").trim();
        if (body) reasoningText += `${body}\n`;
        continue;
      }
      if (/^\s*\[Tool call\]\s*(.+?)\s*$/i.test(line)) continue;
      outputText += `${line}\n`;
    }
    if (pendingUsers.length > 0) {
      turns.push({
        inputText: pendingUsers.shift()!,
        outputText: outputText.trim(),
        reasoningText: reasoningText.trim(),
      });
    }
    assistantLines = [];
  };

  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*user:\s*/i.test(line)) {
      if (active === "user") flushUser();
      if (active === "assistant") flushAssistant();
      active = "user";
      userLines = [line.replace(/^\s*user:\s*/i, "")];
      continue;
    }
    if (/^\s*A:\s*/.test(line)) {
      if (active === "user") flushUser();
      if (active === "assistant") flushAssistant();
      active = "assistant";
      assistantLines = [line.replace(/^\s*A:\s*/, "")];
      continue;
    }
    if (active === "user") userLines.push(line);
    if (active === "assistant") assistantLines.push(line);
  }
  if (active === "user") flushUser();
  if (active === "assistant") flushAssistant();
  return turns;
}

function cursorAgentConversationId(filePath: string): string {
  return createHash("sha1").update(filePath).digest("hex").slice(0, 16);
}

export async function scanCursorAgentLogs(projectsDir = path.join(os.homedir(), ".cursor", "projects")): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const files = await findRecentFiles(projectsDir, LOCAL_COST_SCAN_ALL_DAYS, [".jsonl", ".txt"]);
  const resolvedProjectsDir = path.resolve(projectsDir);

  for (const filePath of files) {
    if (!filePath.includes(`${path.sep}agent-transcripts${path.sep}`)) continue;
    // Cursor Agent's transcripts live under a directory named for the project
    // path with separators dashed out (and, for long paths, truncated with a
    // hash suffix that no longer matches). That name is the only project
    // attribution the transcripts carry.
    const relative = path.relative(resolvedProjectsDir, path.resolve(filePath));
    const projectKey = relative.startsWith("..") ? "" : relative.split(path.sep)[0] ?? "";
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const turns = filePath.endsWith(".jsonl")
        ? parseCursorAgentJsonlTranscript(raw)
        : parseCursorAgentTextTranscript(raw);
      if (turns.length === 0) continue;
      const stat = await fs.promises.stat(filePath);
      const sessionId = cursorAgentConversationId(filePath);
      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i]!;
        const inputTokens = estimateTokensFromText(turn.inputText);
        const outputTokens = estimateTokensFromText(turn.outputText);
        const reasoningTokens = estimateTokensFromText(turn.reasoningText);
        if (inputTokens + outputTokens === 0) continue;
        const dedupeKey = `cursor-agent:${sessionId}:${i}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        entries.push({
          messageId: dedupeKey,
          model: "cursor-agent-auto",
          inputTokens,
          outputTokens,
          billableOutputTokens: outputTokens + reasoningTokens,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          timestamp: stat.mtimeMs,
          estimation: "chars",
          ...(projectKey ? { projectKey } : {}),
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable Cursor Agent transcripts.
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

async function findClaudeJsonlFilesInProjectDirs(projectDirs: string[], maxAgeDays: number): Promise<string[]> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const files = new Map<string, { path: string; mtimeMs: number }>();

  async function addJsonlFilesInDir(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      markLedgerScanIncompleteUnlessMissing(error);
      return;
    }
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.mtimeMs >= cutoff && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) {
            files.set(filePath, { path: filePath, mtimeMs: stat.mtimeMs });
          }
        } catch (error) {
          // Skip files we can't stat
          markLedgerScanIncompleteUnlessMissing(error);
        }
      }));
  }

  async function addJsonlFilesInTree(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      markLedgerScanIncompleteUnlessMissing(error);
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await addJsonlFilesInTree(entryPath);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
      try {
        const stat = await fs.promises.stat(entryPath);
        if (stat.mtimeMs >= cutoff && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) {
          files.set(entryPath, { path: entryPath, mtimeMs: stat.mtimeMs });
        }
      } catch (error) {
        // Skip files we can't stat.
        markLedgerScanIncompleteUnlessMissing(error);
      }
    }));
  }

  for (const projectDir of projectDirs) {
    const projectPath = projectDir;
    await addJsonlFilesInDir(projectPath);
    await addJsonlFilesInTree(path.join(projectPath, "subagents"));

    let childEntries: fs.Dirent[];
    try {
      childEntries = await fs.promises.readdir(projectPath, { withFileTypes: true });
    } catch (error) {
      markLedgerScanIncompleteUnlessMissing(error);
      continue;
    }
    await Promise.all(childEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => addJsonlFilesInTree(path.join(projectPath, entry.name, "subagents"))));
  }

  return newestCandidatePaths(Array.from(files.values()));
}

/**
 * Where each provider keeps the transcripts this file reads.
 *
 * Only ever consulted for existence, and only to answer one question: a scan
 * that returned nothing — was there nothing to read, or did we fail to read it?
 * A provider that was never installed has no root and is genuinely empty on
 * every machine that mounts this home. A provider whose root is *there* and
 * still yielded no rows is the silent half of a partial read: no exception was
 * thrown, so nothing marked it incomplete, yet a peer scanning the same
 * directory a minute earlier may hold a full set of keys that this side now
 * reads as unreachable — a false `diverged` over an empty list.
 *
 * Paths are built with `path.join` from the same platform-branching helpers the
 * scanners use, so this agrees with them on Windows as well as POSIX.
 */
export function usageLedgerTranscriptRoots(): Record<string, string[]> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return {
    claude: [
      ...getClaudeConfigDirs().map((dir) => path.join(dir, "projects")),
      getClaudeDesktopSessionsDir(),
    ],
    codex: [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")],
    cursor: [defaultCursorDbPath()],
    "cursor-agent": [path.join(os.homedir(), ".cursor", "projects")],
    openclaw: defaultOpenClawAgentRoots(),
    opencode: [defaultOpenCodeDataDir()],
    droid: [defaultDroidSessionsDir()],
    copilot: [defaultCopilotSessionStateDir(), ...defaultVSCodeWorkspaceStorageDirs()],
    gemini: [defaultGeminiTmpDir()],
  };
}

/**
 * True when at least one of a provider's transcript roots is present.
 *
 * A provider with no entry in the map answers `true`, not `false`. The caller
 * reads `false` as "genuinely not installed, so an empty scan proves the root
 * is empty" — and a missing mapping proves nothing of the kind. It means this
 * function was never taught where that provider keeps its transcripts, which is
 * exactly when the empty scan is least trustworthy. Same direction as the
 * unreadable-root case below.
 */
export function usageLedgerTranscriptRootExists(
  provider: string,
  roots: Record<string, string[]> = usageLedgerTranscriptRoots(),
): boolean {
  const providerRoots = roots[provider];
  if (!providerRoots) return true;
  return providerRoots.some((root) => {
    try {
      return fs.existsSync(root);
    } catch {
      // An unreadable root is not an absent one; the caller's zero-row scan
      // stays suspect, which is the safe direction.
      return true;
    }
  });
}

async function* readJsonlLines(
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
