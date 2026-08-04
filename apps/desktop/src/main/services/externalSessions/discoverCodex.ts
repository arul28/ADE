import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  clipExternalSessionText,
  closeExternalSessionDb,
  countJsonlUserMessagesCheap,
  cwdIsInScope,
  EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER,
  firstUserTextFromRecords,
  isCanonicalCodexUserRecord,
  normalizeExternalSessionLimit,
  normalizeProviderCwd,
  openExternalSessionDb,
  readFileSuffix,
  readJsonlRecords,
  readJsonlRecordsFromSuffix,
  canonicalCodexRecords,
  recentExternalSessionMessagesFromRecords,
  recordWithFile,
  resolveHomeDir,
  safeParseJson,
  safeReadDir,
  safeStat,
  sessionFileCandidate,
  sortFileCandidatesByMtime,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionFileCandidate,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";
import type {
  AgentChatCodexApprovalPolicy,
  AgentChatCodexSandbox,
  AgentChatPermissionMode,
  TerminalResumeLaunchConfig,
} from "../../../shared/types";

const CODEX_LAUNCH_BACKWARD_SCAN_CHUNK_BYTES = 256 * 1024;
const CODEX_LAUNCH_BACKWARD_SCAN_MAX_BYTES = 64 * 1024 * 1024;
const CODEX_LAUNCH_BACKWARD_SCAN_MAX_LINE_BYTES = 1024 * 1024;
const CODEX_RECENT_MESSAGES_BROWSE_BYTE_LIMIT = 64 * 1024;
const CODEX_RECENT_MESSAGES_EXACT_BYTE_LIMIT = 128 * 1024;
const CODEX_SESSION_META_MAX_BYTES = 64 * 1024;
const CODEX_RECENT_SCAN_FLOOR = 1000;

/** Codex's own thread store. Present since the multi-agent rewrite; absent on older installs. */
const CODEX_STATE_DB_BASENAME = "state_5.sqlite";
/** Upper bound on rows pulled from `threads` in one discovery pass. */
const CODEX_STATE_DB_ROW_CEILING = 20_000;
/** DB text columns only ever feed a clipped preview, so read a bounded prefix of each. */
const CODEX_STATE_DB_TEXT_MAX_CHARS = 1024;

type CodexIndexEntry = {
  id: string;
  title: string | null;
  updatedAt: number | null;
};

type CodexSessionMeta = {
  id: string;
  cwd: string | null;
  createdAt: number | null;
  title: string | null;
  /** Raw: a plain string for interactive rollouts, an object for spawned subagents. */
  source: unknown;
  originator: string | null;
  agentRole: string | null;
  /** Set when this rollout replays another thread's transcript before diverging. */
  forkedFromId: string | null;
};

type CodexSessionCandidate = ExternalSessionFileCandidate;

/**
 * Everything needed to build one discovery record, from whichever authority
 * produced it. The state DB fills these directly; the file scan reconstructs
 * them from `session_meta` prefixes.
 */
type CodexRecordSeed = {
  id: string;
  rolloutPath: string;
  cwd: string | null;
  title: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  mtimeMs: number | null;
  /** Used only when the rollout file cannot be read (compressed or dangling). */
  fallbackPreview: string | null;
  /** Parent threads collapsed into this fork; see `isCodexForkContinuation`. */
  lineageIds?: string[];
};

/**
 * Per-discovery-run classification state. The warned set keeps one telemetry
 * line per unrecognized `source` per run instead of one per rollout.
 */
type CodexClassifyContext = {
  logger: ExternalSessionDiscoveryArgs["logger"];
  warnedSources: Set<string>;
};

function readCodexIndex(indexPath: string): Map<string, CodexIndexEntry> {
  const map = new Map<string, CodexIndexEntry>();
  const text = readFileSuffix(indexPath, 2 * 1024 * 1024);
  if (!text) return map;
  for (const line of text.split(/\r?\n/u)) {
    const record = asRecord(safeParseJson(line));
    if (!record) continue;
    const id = asString(record.id) ?? asString(record.session_id) ?? asString(record.sessionId);
    if (!id) continue;
    map.set(id, {
      id,
      title: cleanSessionTitle(asString(record.thread_name))
        ?? cleanSessionTitle(asString(record.threadName))
        ?? cleanSessionTitle(asString(record.name))
        ?? cleanSessionTitle(asString(record.title)),
      updatedAt: asEpochMs(record.updated_at) ?? asEpochMs(record.updatedAt) ?? null,
    });
  }
  return map;
}

function titleFromCodexPayload(payload: Record<string, unknown>, indexed: CodexIndexEntry | undefined): string | null {
  return cleanSessionTitle(asString(payload.thread_name))
    ?? cleanSessionTitle(asString(payload.threadName))
    ?? cleanSessionTitle(asString(payload.name))
    ?? indexed?.title
    ?? null;
}

function readCodexSessionMeta(
  filePath: string,
  scratch = Buffer.allocUnsafe(CODEX_SESSION_META_MAX_BYTES),
): CodexSessionMeta | null {
  let fd: number | null = null;
  let bytesRead = 0;
  try {
    fd = fs.openSync(filePath, "r");
    bytesRead = fs.readSync(fd, scratch, 0, scratch.length, 0);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort close
      }
    }
  }
  if (bytesRead <= 0) return null;
  let lineStart = 0;
  while (lineStart < bytesRead && (scratch[lineStart] === 0x0a || scratch[lineStart] === 0x0d)) {
    lineStart += 1;
  }
  if (lineStart >= bytesRead) return null;
  const newline = scratch.subarray(lineStart, bytesRead).indexOf(0x0a);
  const lineEnd = newline >= 0 ? lineStart + newline : bytesRead;
  // Only line 1 is trusted: a fork replays the parent transcript verbatim, so a
  // forked rollout carries the parent's `session_meta` again further down.
  const first = asRecord(safeParseJson(scratch.subarray(lineStart, lineEnd).toString("utf8")));
  const payload = asRecord(first?.payload);
  const type = asString(first?.type);
  if (type !== "session_meta" || !payload || !first) return null;
  const id = asString(payload.id) ?? asString(payload.session_id) ?? asString(payload.sessionId);
  if (!id) return null;
  return {
    id,
    // The rollout's own `session_meta.cwd` is normally the clean spelling, but
    // it comes from the same CLI that writes `\\?\` into the state DB — strip
    // on both paths so the fallback file scan cannot reintroduce the prefix.
    cwd: normalizeProviderCwd(asString(payload.cwd)),
    createdAt: asEpochMs(payload.timestamp) ?? asEpochMs(first.timestamp),
    title: titleFromCodexPayload(payload, undefined),
    source: payload.source,
    originator: asString(payload.originator),
    agentRole: asString(payload.agent_role) ?? asString(payload.agentRole),
    forkedFromId: asString(payload.forked_from_id) ?? asString(payload.forkedFromId),
  };
}

function sortedChildDirs(dir: string, pattern: RegExp): string[] {
  return safeReadDir(dir)
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
}

function matchesCodexLookup(entryName: string, sessionId: string | null): boolean {
  if (!sessionId) return true;
  return entryName.endsWith(`-${sessionId}.jsonl`) || entryName.endsWith(`-${sessionId}.jsonl.zst`);
}

export function probeCodexRolloutFile(
  threadId: string,
  opts: { codexHome?: string; maxEntries?: number; maxDurationMs?: number } = {},
): boolean | null {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) return false;
  const configuredHome = opts.codexHome?.trim()
    || (typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME.trim() : "");
  const sessionsDir = path.join(configuredHome ? path.resolve(configuredHome) : path.join(resolveHomeDir({}), ".codex"), "sessions");
  const maxEntries = Math.max(1, Math.min(opts.maxEntries ?? 4_096, 20_000));
  const maxDurationMs = Math.max(1, Math.min(opts.maxDurationMs ?? 50, 500));
  const deadline = Date.now() + maxDurationMs;
  const pending = [sessionsDir];
  let scanned = 0;

  try {
    if (!fs.existsSync(sessionsDir)) return false;
    while (pending.length) {
      if (scanned >= maxEntries || Date.now() > deadline) return null;
      const dir = pending.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (scanned >= maxEntries || Date.now() > deadline) return null;
        scanned += 1;
        if (entry.isFile() && matchesCodexLookup(entry.name, normalizedThreadId)) return true;
        if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
      }
    }
    return false;
  } catch {
    return null;
  }
}

function collectCodexSessionCandidates(
  root: string,
  sessionId: string | null = null,
): CodexSessionCandidate[] {
  const candidates: CodexSessionCandidate[] = [];
  const years = sortedChildDirs(root, /^\d{4}$/u);
  for (const year of years) {
    const yearDir = path.join(root, year);
    for (const month of sortedChildDirs(yearDir, /^\d{2}$/u)) {
      const monthDir = path.join(yearDir, month);
      for (const day of sortedChildDirs(monthDir, /^\d{2}$/u)) {
        const dayDir = path.join(monthDir, day);
        for (const entry of safeReadDir(dayDir)) {
          if (!entry.isFile() || (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".jsonl.zst"))) {
            continue;
          }
          if (!matchesCodexLookup(entry.name, sessionId)) continue;
          const candidate = sessionFileCandidate(path.join(dayDir, entry.name), {});
          if (candidate) candidates.push(candidate);
        }
      }
    }
  }
  return candidates;
}

function collectRecentCodexSessionCandidates(
  root: string,
  limit: number,
  sessionId: string | null = null,
): CodexSessionCandidate[] {
  return sortFileCandidatesByMtime(collectCodexSessionCandidates(root, sessionId), limit);
}

function codexHomeDir(args: ExternalSessionDiscoveryArgs): string {
  const env = args.env ?? (args.homeDir ? undefined : process.env);
  const configured = typeof env?.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  return configured ? path.resolve(configured) : path.join(resolveHomeDir(args), ".codex");
}

/**
 * Codex spawns subagents with an object-shaped `source`. The state DB stores
 * that column as its JSON serialization, so both representations must classify
 * the same way.
 */
function structuredCodexSource(rawSource: unknown): boolean {
  if (asRecord(rawSource)) return true;
  const text = asString(rawSource);
  return text != null && (text.startsWith("{") || text.startsWith("["));
}

/**
 * External import is for interactive CLI/user-shell rollouts. Known
 * non-interactive entrypoints are dropped; an unrecognized *string* source is
 * listed anyway, because a new Codex entrypoint silently disappearing from the
 * import list is worse than one extra row the user can ignore.
 */
function isImportableCodexSource(rawSource: unknown, ctx: CodexClassifyContext): boolean {
  if (structuredCodexSource(rawSource)) return false;
  const source = asString(rawSource)?.toLowerCase();
  if (!source) return true;
  if (source === "exec" || source === "vscode") return false;
  if (source === "cli" || source === "user_shell") return true;
  if (!ctx.warnedSources.has(source)) {
    ctx.warnedSources.add(source);
    ctx.logger?.warn?.("external_sessions.codex_unknown_source", { source });
  }
  return true;
}

function isImportableCodexOriginator(originator: string | null): boolean {
  if (!originator) return true;
  const value = originator.toLowerCase();
  return !(
    value === "ade"
    || value === "ade_desktop"
    || value === "codex desktop"
    || value === "codex_exec"
    || value.startsWith("codex_sdk")
    || value.startsWith("ade-title")
  );
}

function isImportableCodexSession(meta: CodexSessionMeta, ctx: CodexClassifyContext): boolean {
  if (meta.agentRole) return false;
  if (!isImportableCodexSource(meta.source, ctx)) return false;
  return isImportableCodexOriginator(meta.originator);
}

function firstCodexUserText(records: unknown[]): string | null {
  const canonical = records.filter(isCanonicalCodexUserRecord);
  return canonical.length
    ? firstUserTextFromRecords(canonical)
    : firstUserTextFromRecords(records);
}

function recentCodexRecords(filePath: string, exactLookup: boolean): unknown[] {
  return readJsonlRecordsFromSuffix(
    filePath,
    exactLookup
      ? CODEX_RECENT_MESSAGES_EXACT_BYTE_LIMIT
      : CODEX_RECENT_MESSAGES_BROWSE_BYTE_LIMIT,
  );
}

function codexApprovalPolicy(payload: Record<string, unknown>): AgentChatCodexApprovalPolicy | null {
  const value = (
    asString(payload.approval_policy)
    ?? asString(payload.approvalPolicy)
    ?? ""
  ).toLowerCase();
  if (value === "untrusted" || value === "on-request" || value === "on-failure" || value === "never") {
    return value;
  }
  return null;
}

function codexSandbox(payload: Record<string, unknown>): AgentChatCodexSandbox | null {
  const sandbox = asRecord(payload.sandbox_policy) ?? asRecord(payload.sandboxPolicy);
  const value = (
    asString(sandbox?.type)
    ?? asString(payload.sandbox_mode)
    ?? asString(payload.sandboxMode)
    ?? ""
  ).toLowerCase();
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return null;
}

function codexPermissionMode(
  approvalPolicy: AgentChatCodexApprovalPolicy | null,
  sandbox: AgentChatCodexSandbox | null,
): AgentChatPermissionMode | null {
  if (approvalPolicy === "never" && sandbox === "danger-full-access") return "full-auto";
  if (approvalPolicy === "untrusted" && sandbox === "workspace-write") return "edit";
  if (approvalPolicy === "on-request" && sandbox === "workspace-write") return "default";
  if (approvalPolicy === "on-request" && sandbox === "read-only") return "plan";
  return null;
}

function codexLaunchFromRecords(records: unknown[]): TerminalResumeLaunchConfig | null {
  let launch: TerminalResumeLaunchConfig | null = null;
  for (const item of records) {
    const record = asRecord(item);
    if (asString(record?.type)?.toLowerCase() !== "turn_context") continue;
    const payload = asRecord(record?.payload);
    if (!payload) continue;
    const model = asString(payload.model) ?? asString(payload.model_id) ?? asString(payload.modelId);
    const reasoningEffort = asString(payload.effort)
      ?? asString(payload.reasoning_effort)
      ?? asString(payload.reasoningEffort);
    const approvalPolicy = codexApprovalPolicy(payload);
    const sandbox = codexSandbox(payload);
    const permissionMode = codexPermissionMode(approvalPolicy, sandbox);
    const serviceTier = (asString(payload.service_tier) ?? asString(payload.serviceTier) ?? "").toLowerCase();
    const next: TerminalResumeLaunchConfig = {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(approvalPolicy ? { codexApprovalPolicy: approvalPolicy } : {}),
      ...(sandbox ? { codexSandbox: sandbox } : {}),
      ...(approvalPolicy && sandbox ? { codexConfigSource: "flags" as const } : {}),
      ...(serviceTier === "fast" ? { fastMode: true } : {}),
      ...(serviceTier === "default" || serviceTier === "standard" ? { fastMode: false } : {}),
      ...(serviceTier && serviceTier !== "fast" && serviceTier !== "default" && serviceTier !== "standard"
        ? { fastMode: null }
        : {}),
    };
    if (Object.keys(next).length) launch = { ...(launch ?? {}), ...next };
  }
  return launch;
}

async function latestCodexLaunchFromFile(
  filePath: string,
  logger: ExternalSessionDiscoveryArgs["logger"],
): Promise<TerminalResumeLaunchConfig | null> {
  let handle: fs.promises.FileHandle | null = null;
  let launch: TerminalResumeLaunchConfig | null = null;
  try {
    handle = await fs.promises.open(filePath, "r");
    const stat = await handle.stat();
    let position = stat.size;
    let bytesScanned = 0;
    let partialLeadingLine = Buffer.alloc(0);
    while (position > 0 && bytesScanned < CODEX_LAUNCH_BACKWARD_SCAN_MAX_BYTES) {
      const bytesToRead = Math.min(
        CODEX_LAUNCH_BACKWARD_SCAN_CHUNK_BYTES,
        position,
        CODEX_LAUNCH_BACKWARD_SCAN_MAX_BYTES - bytesScanned,
      );
      const start = position - bytesToRead;
      const chunk = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(chunk, 0, bytesToRead, start);
      if (bytesRead <= 0) break;
      const combined = Buffer.concat([chunk.subarray(0, bytesRead), partialLeadingLine]);
      let completeStart = 0;
      if (start > 0) {
        const firstNewline = combined.indexOf(0x0a);
        if (firstNewline < 0) {
          // turn_context rows are tiny. Do not repeatedly concatenate an
          // unbounded tool-output row while walking backwards through a large
          // rollout; once its fragment exceeds this cap, discard that row and
          // keep searching for the preceding newline/context.
          partialLeadingLine = combined.length <= CODEX_LAUNCH_BACKWARD_SCAN_MAX_LINE_BYTES
            ? combined
            : Buffer.alloc(0);
          position = start;
          bytesScanned += bytesRead;
          continue;
        }
        partialLeadingLine = Buffer.from(combined.subarray(0, firstNewline));
        completeStart = firstNewline + 1;
      } else {
        partialLeadingLine = Buffer.alloc(0);
      }
      const lines = combined.subarray(completeStart).toString("utf8").split(/\r?\n/u);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line?.includes("turn_context")) continue;
        const record = safeParseJson(line);
        const olderLaunch = record ? codexLaunchFromRecords([record]) : null;
        if (!olderLaunch) continue;
        // Records are visited newest-first. Fill fields omitted by a partial
        // newest context from the prior context without overwriting newer data.
        launch = { ...olderLaunch, ...(launch ?? {}) };
        if (
          launch.model?.trim()
          && launch.reasoningEffort?.trim()
          && launch.codexApprovalPolicy
          && launch.codexSandbox
        ) return launch;
      }
      position = start;
      bytesScanned += bytesRead;
    }
    if (position > 0) {
      logger?.warn?.("external_sessions.codex_launch_scan_truncated", {
        filePath,
        bytesScanned,
        fileSize: stat.size,
      });
    }
    return launch;
  } catch {
    return launch;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function codexLaunchForFile(
  filePath: string,
  prefixRecords: unknown[],
  exactLookup: boolean,
  logger: ExternalSessionDiscoveryArgs["logger"],
): Promise<TerminalResumeLaunchConfig | null> {
  const prefixLaunch = codexLaunchFromRecords(prefixRecords);
  if (!exactLookup) return prefixLaunch;
  const latestLaunch = await latestCodexLaunchFromFile(filePath, logger);
  if (latestLaunch) return latestLaunch;
  if (!prefixLaunch) return null;
  const fallback: TerminalResumeLaunchConfig = {
    ...(prefixLaunch.model !== undefined ? { model: prefixLaunch.model } : {}),
    ...(prefixLaunch.reasoningEffort !== undefined ? { reasoningEffort: prefixLaunch.reasoningEffort } : {}),
    ...(prefixLaunch.fastMode !== undefined ? { fastMode: prefixLaunch.fastMode } : {}),
    ...(prefixLaunch.codexFastMode !== undefined ? { codexFastMode: prefixLaunch.codexFastMode } : {}),
  };
  return Object.keys(fallback).length ? fallback : null;
}

function idFromCodexFilename(filePath: string): string | null {
  const base = path.basename(filePath).replace(/\.jsonl(?:\.zst)?$/u, "");
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu);
  return match?.[1] ?? null;
}

/**
 * Resolve a Codex rollout file path by session/thread id with NO originator
 * filtering. `discoverCodexSessions` is the external-import surface and
 * deliberately excludes ADE-originated rollouts, which makes it wrong for flows
 * that need ADE's own sessions — e.g. packaging a cross-machine fork of an
 * ADE-created Codex chat. Mirrors codex's own filename-suffix lookup; returns
 * the newest match or null.
 */
export function findCodexRolloutPathBySessionId(
  sessionId: string,
  args: ExternalSessionDiscoveryArgs = {},
): string | null {
  const lookupId = sessionId.trim();
  if (!lookupId) return null;
  const sessionsDir = path.join(codexHomeDir(args), "sessions");
  if (!fs.existsSync(sessionsDir)) return null;
  const candidates = collectRecentCodexSessionCandidates(sessionsDir, 1, lookupId);
  return candidates[0]?.filePath ?? null;
}

function asDbEpochMs(value: unknown): number | null {
  if (typeof value === "bigint") return Number(value);
  return asEpochMs(value);
}

type CodexThreadRow = {
  id: string;
  rolloutPath: string;
  cwd: string | null;
  source: unknown;
  agentRole: string | null;
  name: string | null;
  createdAt: number | null;
  updatedAt: number | null;
};

function codexThreadRow(value: unknown): CodexThreadRow | null {
  const record = asRecord(value);
  const id = asString(record?.id);
  const rolloutPath = asString(record?.rolloutPath);
  if (!record || !id || !rolloutPath) return null;
  return {
    id,
    rolloutPath,
    // Codex opens the workspace through an extended-length path and stores the
    // string it was handed: 116 of the 117 cwd-bearing rows in a real
    // `state_5.sqlite` read `\\?\C:\...`. Node's path parser mistakes that for a
    // UNC root, so scope containment answers "outside" for every one of them
    // unless the prefix comes off here, at the read boundary.
    cwd: normalizeProviderCwd(asString(record.cwd)),
    source: record.source,
    agentRole: asString(record.agentRole),
    name: asString(record.name),
    createdAt: asDbEpochMs(record.createdAtMs),
    updatedAt: asDbEpochMs(record.updatedAtMs),
  };
}

/**
 * Top-level threads only: every row in `thread_spawn_edges` is a spawned
 * subagent, and the DB knows about children whose own `session_meta` carries no
 * parent id at all. `archived` rollouts move out of `sessions/`, so excluding
 * them here matches what the file scan can see.
 *
 * `*_ms` columns arrived in a later migration and backfill to 0 for rows the
 * triggers never touched, hence the COALESCE onto the second-resolution ones.
 */
function codexThreadRowsSql(exactLookup: boolean): string {
  return `
    SELECT t.id AS id,
           t.rollout_path AS rolloutPath,
           t.cwd AS cwd,
           t.source AS source,
           t.agent_role AS agentRole,
           t.name AS name,
           COALESCE(NULLIF(t.created_at_ms, 0), t.created_at * 1000) AS createdAtMs,
           COALESCE(NULLIF(t.updated_at_ms, 0), t.updated_at * 1000) AS updatedAtMs
      FROM threads t
     WHERE t.archived = 0
       AND NOT EXISTS (
             SELECT 1 FROM thread_spawn_edges e WHERE e.child_thread_id = t.id
           )
       ${exactLookup ? "AND t.id = ?" : ""}
     ORDER BY updatedAtMs DESC, t.id DESC
     LIMIT ?
  `;
}

const CODEX_THREAD_TEXT_SQL = `
  SELECT substr(t.preview, 1, ?) AS preview,
         substr(t.first_user_message, 1, ?) AS firstUserMessage,
         substr(t.title, 1, ?) AS title
    FROM threads t
   WHERE t.id = ?
`;

/**
 * Whether the store holds any threads at all, asked only when a query came back
 * empty. A freshly-migrated or truncated `state_5.sqlite` is not an authority on
 * what exists, and must not shadow the rollout tree that still is.
 */
function codexStateDbHasThreads(db: DatabaseSyncType): boolean {
  try {
    return db.prepare("SELECT 1 AS present FROM threads LIMIT 1").get() != null;
  } catch {
    return false;
  }
}

function codexThreadTextPreview(db: DatabaseSyncType, id: string): string | null {
  try {
    const row = asRecord(db.prepare(CODEX_THREAD_TEXT_SQL).get(
      CODEX_STATE_DB_TEXT_MAX_CHARS,
      CODEX_STATE_DB_TEXT_MAX_CHARS,
      CODEX_STATE_DB_TEXT_MAX_CHARS,
      id,
    ));
    return clipExternalSessionText(
      asString(row?.preview) ?? asString(row?.firstUserMessage) ?? asString(row?.title),
    );
  } catch {
    return null;
  }
}

/**
 * Hide a parent thread when a fork of it exists and the parent recorded no
 * activity after the fork point: that pair is one conversation the user
 * continued elsewhere. A parent that kept going after being forked is a
 * genuinely separate conversation and stays in the list alongside its fork.
 *
 * Only forks that are themselves listable count. ADE's own chats fork Codex
 * threads too, and collapsing a real terminal session into a fork this surface
 * refuses to show would drop the conversation entirely.
 */
function isCodexForkContinuation(row: CodexThreadRow, forkedAtById: Map<string, number>): boolean {
  const forkedAt = forkedAtById.get(row.id);
  return forkedAt != null && (row.updatedAt ?? 0) <= forkedAt;
}

function codexSeedsFromStateDb(
  args: ExternalSessionDiscoveryArgs,
  codexDir: string,
  limit: number,
  lookupId: string | null,
  ctx: CodexClassifyContext,
): CodexRecordSeed[] | null {
  const db = openExternalSessionDb(path.join(codexDir, CODEX_STATE_DB_BASENAME), args.logger);
  if (!db) return null;
  try {
    let rows: CodexThreadRow[];
    try {
      const statement = db.prepare(codexThreadRowsSql(lookupId != null));
      const raw = lookupId != null
        ? statement.all(lookupId, CODEX_STATE_DB_ROW_CEILING)
        : statement.all(CODEX_STATE_DB_ROW_CEILING);
      rows = raw.map(codexThreadRow).filter((row): row is CodexThreadRow => row != null);
    } catch (error) {
      args.logger?.warn?.("external_sessions.codex_state_db_query_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    // An empty *result* with threads present is a real answer — everything was
    // archived, spawned, or out of scope — and must not fall back to the file
    // scan, which cannot tell a subagent rollout from a session.
    if (!rows.length && !codexStateDbHasThreads(db)) return null;

    const scratch = Buffer.allocUnsafe(CODEX_SESSION_META_MAX_BYTES);
    const forkedAtById = new Map<string, number>();
    const forkSeedsByParent = new Map<string, CodexRecordSeed[]>();
    const seeds: CodexRecordSeed[] = [];
    for (const row of rows) {
      if (seeds.length >= limit) break;
      if (row.agentRole) continue;
      if (!isImportableCodexSource(row.source, ctx)) continue;
      if (!cwdIsInScope(row.cwd, args.scopeRoots)) continue;

      const compressed = row.rolloutPath.endsWith(".jsonl.zst");
      const meta = compressed ? null : readCodexSessionMeta(row.rolloutPath, scratch);
      // A dangling `rollout_path` (upstream openai/codex#21196) leaves only the
      // DB's own classification, which already passed above.
      if (meta && !isImportableCodexSession(meta, ctx)) continue;

      // Registered only once this row is known to be listable. A fork this
      // surface refuses to show — an ADE chat's own fork — contributes no seed,
      // so letting it hide its parent would drop the conversation entirely.
      const forkedFromId = meta?.forkedFromId ?? null;
      if (forkedFromId) {
        // Rows arrive newest-first, and a parent worth collapsing stopped at or
        // before the fork point, so such a parent is always seen after its fork.
        const forkedAt = row.createdAt ?? meta?.createdAt;
        if (forkedAt != null) {
          forkedAtById.set(forkedFromId, Math.max(forkedAtById.get(forkedFromId) ?? 0, forkedAt));
        }
      }

      if (isCodexForkContinuation(row, forkedAtById)) {
        // The fork that hid this parent now speaks for it, including for an
        // import the user made against the parent id before forking.
        const absorbing = forkSeedsByParent.get(row.id) ?? [];
        for (const forkSeed of absorbing) {
          forkSeed.lineageIds = [...new Set([...(forkSeed.lineageIds ?? []), row.id])];
        }
        // This row is itself a fork of something older, and is no longer here to
        // speak for it. Hand its parent claim to whatever absorbed it, so a
        // P←F1←F2 chain leaves F2 holding both P and F1.
        if (forkedFromId && absorbing.length) {
          forkSeedsByParent.set(forkedFromId, [
            ...(forkSeedsByParent.get(forkedFromId) ?? []),
            ...absorbing,
          ]);
        }
        continue;
      }

      const stat = safeStat(row.rolloutPath);
      const seed: CodexRecordSeed = {
        id: row.id,
        rolloutPath: row.rolloutPath,
        cwd: row.cwd ?? meta?.cwd ?? null,
        title: row.name ?? meta?.title ?? null,
        createdAt: row.createdAt ?? meta?.createdAt ?? null,
        updatedAt: row.updatedAt,
        mtimeMs: stat?.isFile() ? Math.floor(stat.mtimeMs) : null,
        fallbackPreview: stat?.isFile() && !compressed && meta
          ? null
          : codexThreadTextPreview(db, row.id),
      };
      seeds.push(seed);
      if (forkedFromId) {
        const siblings = forkSeedsByParent.get(forkedFromId) ?? [];
        siblings.push(seed);
        forkSeedsByParent.set(forkedFromId, siblings);
      }
    }
    return seeds;
  } finally {
    closeExternalSessionDb(db);
  }
}

/**
 * Pre-state-DB discovery: walk `sessions/YYYY/MM/DD` and classify each rollout
 * from its `session_meta` prefix. Only reachable when the state DB is missing,
 * unreadable, or shaped differently than this build expects.
 */
function codexSeedsFromFiles(
  sessionsDir: string,
  limit: number,
  lookupId: string | null,
  scopeRoots: string[] | null | undefined,
  ctx: CodexClassifyContext,
): CodexRecordSeed[] {
  if (!fs.existsSync(sessionsDir)) return [];
  const scoped = Boolean(scopeRoots?.length);
  const scanLimit = Math.max(CODEX_RECENT_SCAN_FLOOR, limit * 20);
  const candidates = scoped
    ? collectCodexSessionCandidates(sessionsDir, lookupId)
    : collectRecentCodexSessionCandidates(sessionsDir, scanLimit, lookupId);
  const scratch = Buffer.allocUnsafe(CODEX_SESSION_META_MAX_BYTES);
  const seedsById = new Map<string, CodexRecordSeed & { mtimeMs: number }>();

  for (const candidate of candidates) {
    const compressed = candidate.filePath.endsWith(".jsonl.zst");
    const meta = compressed ? null : readCodexSessionMeta(candidate.filePath, scratch);
    if (!compressed && !meta) continue;
    if (meta && !isImportableCodexSession(meta, ctx)) continue;
    const id = meta?.id ?? idFromCodexFilename(candidate.filePath);
    if (!id || (lookupId && id !== lookupId)) continue;
    if (!cwdIsInScope(meta?.cwd ?? null, scopeRoots)) continue;
    const existing = seedsById.get(id);
    if (existing && existing.mtimeMs >= candidate.mtimeMs) continue;
    seedsById.set(id, {
      id,
      rolloutPath: candidate.filePath,
      cwd: meta?.cwd ?? null,
      title: meta?.title ?? null,
      createdAt: meta?.createdAt ?? null,
      updatedAt: null,
      mtimeMs: candidate.mtimeMs,
      fallbackPreview: null,
    });
  }

  // `scanLimit` bounds how many candidates are cheaply inspected; every seed
  // that survives is then read in full (512KiB prefix plus a message count), so
  // the returned list gets the same read budget the state-DB path enforces.
  const seedLimit = scoped ? limit : Math.max(limit * EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER, limit);
  return Array.from(seedsById.values())
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.id.localeCompare(right.id))
    .slice(0, seedLimit);
}

async function codexRecordFromSeed(
  seed: CodexRecordSeed,
  indexed: CodexIndexEntry | undefined,
  exactLookup: boolean,
  logger: ExternalSessionDiscoveryArgs["logger"],
): Promise<ExternalSessionDiscoveryRecord> {
  const exists = safeStat(seed.rolloutPath)?.isFile() === true;
  const readable = exists && !seed.rolloutPath.endsWith(".jsonl.zst");
  const jsonl = readable ? readJsonlRecords(seed.rolloutPath) : [];
  const first = asRecord(jsonl[0]);
  const payload = asRecord(first?.payload);
  const updatedAt = Math.max(seed.updatedAt ?? 0, indexed?.updatedAt ?? 0, seed.mtimeMs ?? 0);
  const record = recordWithFile({
    provider: "codex",
    id: seed.id,
    cwd: seed.cwd,
    title: cleanSessionTitle(seed.title) ?? titleFromCodexPayload(payload ?? {}, indexed),
    // A readable rollout is the only source that survives ADE-guidance and
    // transport stripping intact; DB text only stands in when there is no file.
    preview: readable ? firstCodexUserText(jsonl) : seed.fallbackPreview,
    createdAt: seed.createdAt ?? asEpochMs(payload?.timestamp) ?? asEpochMs(first?.timestamp),
    updatedAt: updatedAt || null,
    messageCount: readable ? countJsonlUserMessagesCheap(seed.rolloutPath, "codex") : null,
    launch: readable ? await codexLaunchForFile(seed.rolloutPath, jsonl, exactLookup, logger) : null,
    filePath: exists ? seed.rolloutPath : null,
    sourceMtimeMs: seed.mtimeMs,
  });
  if (seed.lineageIds?.length) record.lineageIds = seed.lineageIds;
  return record;
}

export async function discoverCodexSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const lookupId = args.sessionId?.trim() || null;
  const codexDir = codexHomeDir(args);
  const index = readCodexIndex(path.join(codexDir, "session_index.jsonl"));
  const ctx: CodexClassifyContext = { logger: args.logger, warnedSources: new Set() };

  const seeds = codexSeedsFromStateDb(args, codexDir, limit, lookupId, ctx)
    ?? codexSeedsFromFiles(path.join(codexDir, "sessions"), limit, lookupId, args.scopeRoots, ctx);

  const records: ExternalSessionDiscoveryRecord[] = [];
  for (const seed of seeds) {
    records.push(await codexRecordFromSeed(seed, index.get(seed.id), lookupId != null, args.logger));
  }

  return sortDiscoveryRecords(records, limit)
    .map((record) => {
      if (!record.sourcePath || record.sourcePath.endsWith(".jsonl.zst")) return record;
      return {
        ...record,
        messages: recentExternalSessionMessagesFromRecords(
          canonicalCodexRecords(recentCodexRecords(record.sourcePath, lookupId != null)),
        ),
      };
    });
}
