import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import type { SqlValue } from "../../state/kvDb";
import { isRecord, safeJsonParse } from "../../shared/utils";

const LOCAL_COST_SCAN_MAX_FILES = 5_000;
const LOCAL_COST_SCAN_MAX_FILE_BYTES = 768 * 1024 * 1024;
const LOCAL_COST_SCAN_MAX_ENTRIES = 1_000_000;
const LOCAL_COST_SCAN_ALL_DAYS = 3650;
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

const requireForUsageSqlite = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
let usageSqliteConstructor: UsageSqliteConstructor | null | undefined;

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
  if (!fs.existsSync(dbPath)) return null;
  const DatabaseSync = loadUsageSqliteConstructor();
  if (!DatabaseSync) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec?.("PRAGMA busy_timeout = 1000");
    } catch {
      // Best-effort only; read-only scans should still work without it.
    }
    return db;
  } catch {
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
  } catch {
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
    } catch {
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
      // Skip unreadable files
    }
  }

  return entries;
}

export async function scanCodexLogs(): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const sessionsDir = path.join(codexHome, "sessions");

  try {
    await fs.promises.access(sessionsDir);
  } catch {
    return entries;
  }

  const jsonlFiles = await findJsonlFiles(sessionsDir, LOCAL_COST_SCAN_ALL_DAYS);

  for (const filePath of jsonlFiles) {
    try {
      if (!await isSupportedCodexUsageSession(filePath)) continue;
      let sessionId = path.basename(filePath, ".jsonl");
      let sessionModel = "codex";
      let sessionOriginator = "";
      let previousTotals: { input: number; cached: number; output: number; reasoning: number; total: number } | null = null;

      for await (const line of readJsonlLines(filePath)) {
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
          if (previousTotals && cumulativeTotal > 0 && cumulativeTotal === previousTotals.total) continue;

          let rawInputTokens = 0;
          let cachedTokens = 0;
          let outputTokens = 0;
          let reasoningTokens = 0;

          if (lastUsage) {
            rawInputTokens = numberFromRecord(lastUsage, "input_tokens");
            cachedTokens = numberFromRecord(lastUsage, "cached_input_tokens", "cache_read_input_tokens");
            outputTokens = numberFromRecord(lastUsage, "output_tokens");
            reasoningTokens = numberFromRecord(lastUsage, "reasoning_output_tokens");
          } else if (totalUsage) {
            rawInputTokens = numberFromRecord(totalUsage, "input_tokens") - (previousTotals?.input ?? 0);
            cachedTokens = numberFromRecord(totalUsage, "cached_input_tokens", "cache_read_input_tokens") - (previousTotals?.cached ?? 0);
            outputTokens = numberFromRecord(totalUsage, "output_tokens") - (previousTotals?.output ?? 0);
            reasoningTokens = numberFromRecord(totalUsage, "reasoning_output_tokens") - (previousTotals?.reasoning ?? 0);
          }

          if (totalUsage) {
            previousTotals = {
              input: numberFromRecord(totalUsage, "input_tokens"),
              cached: numberFromRecord(totalUsage, "cached_input_tokens", "cache_read_input_tokens"),
              output: numberFromRecord(totalUsage, "output_tokens"),
              reasoning: numberFromRecord(totalUsage, "reasoning_output_tokens"),
              total: cumulativeTotal,
            };
          }

          rawInputTokens = Math.max(0, rawInputTokens);
          cachedTokens = Math.max(0, cachedTokens);
          outputTokens = Math.max(0, outputTokens) + Math.max(0, reasoningTokens);
          const billableInputTokens = Math.max(0, rawInputTokens - cachedTokens);
          const inputTokens = Math.max(0, rawInputTokens);
          if (inputTokens + outputTokens + cachedTokens === 0) continue;

          const timestamp = timestampMsFromValue(record.timestamp);
          const model = typeof payload.model === "string" && payload.model.trim()
            ? payload.model
            : sessionModel;
          const dedupeKey = `${sessionId}:${record.timestamp ?? timestamp}:${cumulativeTotal || entries.length}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          entries.push({
            messageId: dedupeKey,
            model,
            originator: sessionOriginator,
            inputTokens,
            billableInputTokens,
            outputTokens,
            cachedTokens,
            billableCachedTokens: cachedTokens,
            cacheWriteTokens: 0,
            timestamp,
          });
          if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
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

        const inputTokens = typeof record.input_tokens === "number" ? record.input_tokens :
                            typeof record.prompt_tokens === "number" ? record.prompt_tokens : 0;
        const outputTokens = typeof record.output_tokens === "number" ? record.output_tokens :
                             typeof record.completion_tokens === "number" ? record.completion_tokens : 0;
        const tokenCount = typeof record.token_count === "number" ? record.token_count : 0;

        if (inputTokens === 0 && outputTokens === 0 && tokenCount === 0) continue;

        entries.push({
          messageId: dedupeKey,
          model,
          originator: sessionOriginator,
          inputTokens: inputTokens || Math.floor(tokenCount * 0.4),
          outputTokens: outputTokens || Math.ceil(tokenCount * 0.6),
          cachedTokens: typeof record.cached_tokens === "number" ? record.cached_tokens : 0,
          billableCachedTokens: typeof record.cached_tokens === "number" ? record.cached_tokens : 0,
          cacheWriteTokens: 0,
          timestamp: typeof record.timestamp === "number" ? record.timestamp :
                     typeof record.timestamp === "string" ? new Date(record.timestamp).getTime() : Date.now(),
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable files
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

      for await (const line of readJsonlLines(filePath)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const record = safeJsonParse<Record<string, unknown>>(trimmed, {});
        const type = normalizeUsageLabel(record.type, "");

        if (type === "session") {
          if (typeof record.id === "string" && record.id.trim()) sessionId = record.id;
          if (typeof record.timestamp === "string") sessionTimestamp = record.timestamp;
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
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable or malformed session files.
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
        await fs.promises.readFile(filePath.replace(/\.jsonl$/, ".settings.json"), "utf8").catch(() => "{}"),
        {},
      );
      const tokenUsage = isRecord(settings.tokenUsage) ? settings.tokenUsage : null;
      if (!tokenUsage) continue;

      let sessionId = path.basename(filePath, ".jsonl");
      const model = typeof settings.model === "string" && settings.model.trim()
        ? stripDroidModelPrefix(settings.model)
        : "droid-auto";
      const assistantCalls: Array<{ id: string; timestamp: number }> = [];

      for await (const line of readJsonlLines(filePath)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const record = safeJsonParse<Record<string, unknown>>(trimmed, {});
        if (record.type === "session_start" && typeof record.id === "string" && record.id.trim()) {
          sessionId = record.id;
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
        entries.push({
          messageId: dedupeKey,
          model,
          inputTokens: isLast ? totalInput - inputPerCall * i : inputPerCall,
          outputTokens: (isLast ? totalOutput - outputPerCall * i : outputPerCall) +
            (isLast ? totalThinking - thinkingPerCall * i : thinkingPerCall),
          cachedTokens: isLast ? totalCacheRead - cacheReadPerCall * i : cacheReadPerCall,
          billableCachedTokens: isLast ? totalCacheRead - cacheReadPerCall * i : cacheReadPerCall,
          cacheWriteTokens: isLast ? totalCacheWrite - cacheWritePerCall * i : cacheWritePerCall,
          timestamp: call.timestamp,
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable or malformed Droid sessions.
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

export function parseCopilotEvents(raw: string, sourcePath: string): TokenEntry[] {
  const entries: TokenEntry[] = [];
  const records = raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => safeJsonParse<Record<string, unknown>>(line, {}))
    .filter((record) => isRecord(record));
  const first = records[0];
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
    });
    pendingUserMessage = "";
  }

  return entries;
}

async function discoverCopilotTranscriptFiles(
  sessionStateDir = defaultCopilotSessionStateDir(),
  workspaceStorageDirs = defaultVSCodeWorkspaceStorageDirs(),
): Promise<string[]> {
  const files: string[] = [];
  try {
    const sessionDirs = await fs.promises.readdir(sessionStateDir);
    await Promise.all(sessionDirs.map(async (sessionId) => {
      const eventsPath = path.join(sessionStateDir, sessionId, "events.jsonl");
      const stat = await fs.promises.stat(eventsPath).catch(() => null);
      if (stat?.isFile() && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) files.push(eventsPath);
    }));
  } catch {
    // Missing Copilot legacy state is expected for users who never used it.
  }

  await Promise.all(workspaceStorageDirs.map(async (workspaceStorageDir) => {
    let workspaceDirs: string[];
    try {
      workspaceDirs = await fs.promises.readdir(workspaceStorageDir);
    } catch {
      return;
    }
    await Promise.all(workspaceDirs.map(async (workspaceDir) => {
      const transcriptsDir = path.join(workspaceStorageDir, workspaceDir, "GitHub.copilot-chat", "transcripts");
      let transcriptFiles: string[];
      try {
        transcriptFiles = await fs.promises.readdir(transcriptsDir);
      } catch {
        return;
      }
      await Promise.all(transcriptFiles
        .filter((file) => file.endsWith(".jsonl"))
        .map(async (file) => {
          const filePath = path.join(transcriptsDir, file);
          const stat = await fs.promises.stat(filePath).catch(() => null);
          if (stat?.isFile() && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) files.push(filePath);
        }));
    }));
  }));

  return files.slice(0, LOCAL_COST_SCAN_MAX_FILES);
}

export async function scanCopilotLogs(
  sessionStateDir = defaultCopilotSessionStateDir(),
  workspaceStorageDirs = defaultVSCodeWorkspaceStorageDirs(),
): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const files = await discoverCopilotTranscriptFiles(sessionStateDir, workspaceStorageDirs);
  for (const filePath of files) {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      for (const entry of parseCopilotEvents(raw, filePath)) {
        if (entry.inputTokens + entry.outputTokens + entry.cachedTokens + toNonNegativeInt(entry.cacheWriteTokens) === 0) continue;
        if (seen.has(entry.messageId)) continue;
        seen.add(entry.messageId);
        entries.push(entry);
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable Copilot logs.
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

export function parseGeminiEntries(raw: string, sourcePath: string): TokenEntry[] {
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
      outputTokens: totalOutput + totalThoughts,
      cachedTokens: totalCached,
      billableCachedTokens: totalCached,
      cacheWriteTokens: 0,
      timestamp,
    });
  }
  return entries;
}

async function discoverGeminiSessionFiles(tmpDir = defaultGeminiTmpDir()): Promise<string[]> {
  const files: string[] = [];
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = await fs.promises.readdir(tmpDir, { withFileTypes: true });
  } catch {
    return files;
  }

  await Promise.all(projectDirs
    .filter((entry) => entry.isDirectory())
    .map(async (projectDir) => {
      const chatsDir = path.join(tmpDir, projectDir.name, "chats");
      let chatFiles: string[];
      try {
        chatFiles = await fs.promises.readdir(chatsDir);
      } catch {
        return;
      }
      await Promise.all(chatFiles
        .filter((file) => file.startsWith("session-") && (file.endsWith(".json") || file.endsWith(".jsonl")))
        .map(async (file) => {
          const filePath = path.join(chatsDir, file);
          const stat = await fs.promises.stat(filePath).catch(() => null);
          if (stat?.isFile() && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) files.push(filePath);
        }));
    }));

  return files.slice(0, LOCAL_COST_SCAN_MAX_FILES);
}

export async function scanGeminiLogs(tmpDir = defaultGeminiTmpDir()): Promise<TokenEntry[]> {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();
  const files = await discoverGeminiSessionFiles(tmpDir);
  for (const filePath of files) {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      for (const entry of parseGeminiEntries(raw, filePath)) {
        if (seen.has(entry.messageId)) continue;
        seen.add(entry.messageId);
        entries.push(entry);
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable Gemini logs.
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
  } catch {
    return entries;
  }

  const sinceMs = 0;
  for (const dbPath of dbFiles) {
    const db = openReadonlyUsageDatabase(dbPath);
    if (!db) continue;
    try {
      const rows = usageSqliteAll<{ id: string; sessionId: string; timeCreated: number; data: string }>(
        db,
        `
          select id, session_id as sessionId, time_created as timeCreated, cast(data as blob) as data
          from message
          where time_created >= ?
          order by time_created desc, id desc
          limit ?
        `,
        [sinceMs, LOCAL_SQLITE_SCAN_MAX_ROWS],
      );
      for (const row of rows) {
        const data = safeJsonParse<Record<string, unknown>>(textFromSqliteValue(row.data), {});
        if (data.role !== "assistant") continue;
        const tokens = isRecord(data.tokens) ? data.tokens : {};
        const cache = isRecord(tokens.cache) ? tokens.cache : {};
        const inputTokens = numberFromRecord(tokens, "input");
        const outputTokens = numberFromRecord(tokens, "output") + numberFromRecord(tokens, "reasoning");
        const cachedTokens = numberFromRecord(cache, "read");
        const cacheWriteTokens = numberFromRecord(cache, "write");
        const cost = optionalNumber(data.cost);
        if (inputTokens + outputTokens + cachedTokens + cacheWriteTokens === 0 && !(cost && cost > 0)) continue;

        const sessionId = typeof row.sessionId === "string" && row.sessionId ? row.sessionId : "unknown";
        const dedupeKey = `opencode:${sessionId}:${row.id}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        entries.push({
          messageId: dedupeKey,
          model: typeof data.modelID === "string" && data.modelID.trim() ? data.modelID : "opencode-auto",
          inputTokens,
          outputTokens,
          cachedTokens,
          billableCachedTokens: cachedTokens,
          cacheWriteTokens,
          costOverrideUsd: cost != null && cost > 0 ? cost : undefined,
          timestamp: timestampMsFromUnixish(row.timeCreated),
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unrecognized OpenCode DB schemas.
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
      });
      if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
    }

    // Cursor's bubble rows contain the real token counts surfaced by Cursor's
    // UI. The agentKv rows are text blobs that require estimation and have
    // proven noisy in parity checks, so ADE leaves them out and relies on the
    // separate Cursor Agent transcript scanner for cursor-agent sessions.
  } catch {
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

  for (const filePath of files) {
    if (!filePath.includes(`${path.sep}agent-transcripts${path.sep}`)) continue;
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
        });
        if (entries.length >= LOCAL_COST_SCAN_MAX_ENTRIES) return entries;
      }
    } catch {
      // Skip unreadable Cursor Agent transcripts.
    }
  }

  return entries;
}

async function isSupportedCodexUsageSession(filePath: string): Promise<boolean> {
  let file: fs.promises.FileHandle | null = null;
  try {
    file = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) return false;
    const entry = safeJsonParse<Record<string, unknown>>(firstLine, {});
    if (entry.type !== "session_meta" || !isRecord(entry.payload)) return false;
    const originator = normalizeUsageLabel(entry.payload.originator, "").toLowerCase();
    return !originator.startsWith("ade");
  } catch {
    return false;
  } finally {
    await file?.close().catch(() => {});
  }
}

export async function findRecentFiles(dir: string, maxAgeDays: number, suffixes: string[]): Promise<string[]> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const files: Array<{ path: string; mtimeMs: number }> = [];

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
              if (stat.mtimeMs >= cutoff && stat.size <= LOCAL_COST_SCAN_MAX_FILE_BYTES) {
                files.push({ path: fullPath, mtimeMs: stat.mtimeMs });
              }
            }).catch(() => {
              // Skip files we can't stat
            })
          );
        }
      }
      await Promise.all([...dirPromises, ...fileStatPromises]);
    } catch {
      // Skip directories we can't read
    }
  }

  await walk(dir, 0);
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, LOCAL_COST_SCAN_MAX_FILES)
    .map((file) => file.path);
}

export async function findJsonlFiles(dir: string, maxAgeDays: number): Promise<string[]> {
  return findRecentFiles(dir, maxAgeDays, [".jsonl"]);
}

async function findClaudeJsonlFilesInProjectDirs(projectDirs: string[], maxAgeDays: number): Promise<string[]> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const files = new Map<string, { path: string; mtimeMs: number }>();

  async function addJsonlFilesInDir(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
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
        } catch {
          // Skip files we can't stat
        }
      }));
  }

  for (const projectDir of projectDirs) {
    const projectPath = projectDir;
    await addJsonlFilesInDir(projectPath);
    await addJsonlFilesInDir(path.join(projectPath, "subagents"));

    let childEntries: fs.Dirent[];
    try {
      childEntries = await fs.promises.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    await Promise.all(childEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => addJsonlFilesInDir(path.join(projectPath, entry.name, "subagents"))));
  }

  return Array.from(files.values())
    .slice(0, LOCAL_COST_SCAN_MAX_FILES)
    .map((file) => file.path);
}

async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      yield line;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}
