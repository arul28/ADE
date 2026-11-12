import path from "node:path";
import {
  antigravityConversationsDir,
  readAntigravityConversationMeta,
  readAntigravityMessageWindow,
  type AntigravityConversationMeta,
  type AntigravityMessageWindow,
} from "../chat/acpHost/acpDialects/antigravitySessionLog";
import {
  EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER,
  cwdIsInScope,
  normalizeExternalSessionLimit,
  normalizeProviderCwd,
  resolveHomeDir,
  safeReadDir,
  safeStat,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";
import {
  acpDiscoveryRecord,
  collectNewestSessions,
  compact,
  neutralRecord,
  safeLookupId,
  startsWithAdeGuidance,
  summarizeNeutralRecords,
} from "./discoverAcpShared";

/**
 * Antigravity's agy CLI (verified 1.5.6) keeps every conversation, from its
 * TUI or from an ACP client, in one SQLite file:
 * `~/.gemini/antigravity-cli/conversations/<conversationId>.db`, with its
 * write-ahead log beside it while agy has it open. `antigravitySessionLog.ts`
 * reads the format.
 *
 * Left out: a subagent's conversation (it opens with its parent's message),
 * and a conversation ADE's own chat opened (its system prompt is ADE's
 * guidance). A live ADE chat is also matched by its session id.
 */
function antigravityCliDirFor(args: ExternalSessionDiscoveryArgs): string {
  return path.join(resolveHomeDir(args), ".gemini", "antigravity-cli");
}

type AntigravityCandidate = {
  id: string;
  file: string;
  mtimeMs: number;
  size: number;
};

function listAntigravityCandidates(args: ExternalSessionDiscoveryArgs, lookupId: string | null): AntigravityCandidate[] {
  const dir = antigravityConversationsDir(antigravityCliDirFor(args));
  const names = lookupId ? [`${lookupId}.db`] : safeReadDir(dir).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const candidates: AntigravityCandidate[] = [];
  for (const name of names) {
    const match = /^([\w-]+)\.db$/u.exec(name);
    if (!match) continue;
    const file = path.join(dir, name);
    const stat = safeStat(file);
    if (!stat?.isFile()) continue;
    // While agy has a conversation open, its newest steps are in the WAL.
    const wal = safeStat(`${file}-wal`);
    candidates.push({
      id: match[1]!,
      file,
      mtimeMs: Math.floor(Math.max(stat.mtimeMs, wal?.mtimeMs ?? 0)),
      size: stat.size + (wal?.size ?? 0),
    });
  }
  return candidates;
}

/**
 * What a log said, kept while its file (and WAL) keeps its mtime and size.
 * Every list open used to open each log twice: 200 logs cost 250 ms warm on
 * an M3 Pro, all on the event loop. The window is read only for a log that
 * gets that far, then kept too.
 */
type CachedLog = {
  mtimeMs: number;
  size: number;
  meta: AntigravityConversationMeta | undefined;
  window?: AntigravityMessageWindow | undefined;
  /** The last record built from this log, for the scope it was built for. */
  record?: { scope: string; value: ExternalSessionDiscoveryRecord | null };
};
const logCache = new Map<string, CachedLog>();
const LOG_CACHE_MAX = 4_000;

function cachedLog(candidate: AntigravityCandidate): CachedLog {
  const hit = logCache.get(candidate.file);
  if (hit && hit.mtimeMs === candidate.mtimeMs && hit.size === candidate.size) return hit;
  const entry: CachedLog = { mtimeMs: candidate.mtimeMs, size: candidate.size, meta: readAntigravityConversationMeta(candidate.file) };
  logCache.delete(candidate.file);
  logCache.set(candidate.file, entry);
  if (logCache.size > LOG_CACHE_MAX) logCache.delete(logCache.keys().next().value!);
  return entry;
}

function isCached(candidate: AntigravityCandidate): boolean {
  const hit = logCache.get(candidate.file);
  return Boolean(hit && hit.mtimeMs === candidate.mtimeMs && hit.size === candidate.size);
}

/** Reads not yet cached before the event loop gets a turn. */
const READS_PER_YIELD = 10;

function antigravityRecordFromCandidate(
  candidate: AntigravityCandidate,
  scopeRoots: readonly string[] | null | undefined,
  includeAdeOwned: boolean,
): ExternalSessionDiscoveryRecord | null {
  const log = cachedLog(candidate);
  const scope = `${includeAdeOwned ? 1 : 0}\u0000${(scopeRoots ?? []).join("\u0000")}`;
  if (log.record?.scope === scope) return log.record.value;
  const value = buildAntigravityRecord(candidate, log, scopeRoots, includeAdeOwned);
  log.record = { scope, value };
  return value;
}

function buildAntigravityRecord(
  candidate: AntigravityCandidate,
  log: CachedLog,
  scopeRoots: readonly string[] | null | undefined,
  includeAdeOwned: boolean,
): ExternalSessionDiscoveryRecord | null {
  const meta = log.meta;
  if (!meta || meta.isSubagent) return null;
  if (!includeAdeOwned && startsWithAdeGuidance(meta.systemPrompt)) return null;
  const cwd = normalizeProviderCwd(meta.workspace);
  if (!cwdIsInScope(cwd, scopeRoots)) return null;

  if (!("window" in log)) log.window = readAntigravityMessageWindow(candidate.file);
  const window = log.window;
  if (!window) return null;
  const toNeutral = (steps: typeof window.head) => compact(steps.map((step) => (step.kind === "user"
    ? neutralRecord("user", step.text, null)
    : neutralRecord("assistant", step.text, null))));
  const head = toNeutral(window.head);
  // The whole conversation fit in the window: every count below is exact.
  const complete = window.userMessageCount <= window.head.filter((step) => step.kind === "user").length;
  const summary = summarizeNeutralRecords("antigravity", {
    head,
    tail: toNeutral(window.tail),
    all: complete ? head : null,
  });
  if (!summary.hasPrompt) return null;

  return acpDiscoveryRecord({
    provider: "antigravity",
    id: candidate.id,
    cwd,
    title: null,
    preview: summary.preview,
    messages: summary.messages,
    createdAt: meta.createdAtMs,
    updatedAt: candidate.mtimeMs || null,
    messageCount: window.userMessageCount,
    launch: null,
    filePath: candidate.file,
    sourceMtimeMs: candidate.mtimeMs,
    sizeBytes: candidate.size,
  });
}

/** Lists agy conversations from the CLI's own on-disk store. */
export async function discoverAntigravitySessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const lookupId = safeLookupId(args.sessionId);
  if (lookupId === false) return [];
  const candidates = listAntigravityCandidates(args, lookupId);
  const limit = normalizeExternalSessionLimit(args.limit);
  const read = (candidate: AntigravityCandidate) => antigravityRecordFromCandidate(candidate, args.scopeRoots, args.includeAdeOwned === true);
  if (!lookupId) {
    // Fill the cache newest first, the way the collection below reads, and
    // give the event loop a turn between batches of real reads.
    const ordered = candidates.slice().sort((left, right) => right.mtimeMs - left.mtimeMs);
    const readCap = Math.max(limit * EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER, 200);
    let found = 0;
    let reads = 0;
    for (const candidate of ordered.slice(0, readCap)) {
      if (!isCached(candidate) && ++reads % READS_PER_YIELD === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      if (read(candidate) && ++found >= limit) break;
    }
  }
  return collectNewestSessions({ candidates, limit, lookupId, read });
}
