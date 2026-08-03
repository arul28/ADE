import { createHash } from "node:crypto";
import path from "node:path";
import { cursorProjectSlug } from "../../../shared/cursorProjectSlug";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  closeExternalSessionDb,
  countJsonlUserMessagesCheap,
  cwdCandidatesIncludeScope,
  cwdIsInScope,
  firstUserTextFromRecords,
  moreCompleteFileCandidate,
  normalizeExternalSessionLimit,
  openExternalSessionDb,
  readFilePrefix,
  readJsonlRecords,
  recordWithFile,
  cursorSlugCwdCandidates,
  resolveCursorCwdFromSlug,
  resolveHomeDir,
  safeReadDir,
  safeParseJson,
  safeStat,
  slugMatchesScopeRoots,
  sortDiscoveryRecords,
  EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

/**
 * Cursor hands this id to unrelated runs, so its artifacts belong to no single
 * conversation. Grouping them would fuse strangers into one session.
 */
const CURSOR_BLOCKED_SESSION_IDS = new Set(["00000000-0000-4000-8000-000000000000"]);

/**
 * SDK-origin `agent-<uuid>` runs are excluded everywhere: `cursor-agent --resume`
 * cannot reopen them, so surfacing them offers an import that starts empty.
 */
function isCursorConversationId(id: string): boolean {
  return id.length > 0 && !id.startsWith("agent-") && !CURSOR_BLOCKED_SESSION_IDS.has(id);
}

function cursorProjectSlugForCwd(cwd: string): string {
  return cursorProjectSlug(cwd);
}

function cursorWorkspaceHash(cwd: string): string {
  return createHash("md5").update(cwd).digest("hex");
}

function trustedCursorWorkspacePath(projectDir: string): string | null {
  const text = readFilePrefix(path.join(projectDir, ".workspace-trusted"), 64 * 1024);
  const record = text ? asRecord(safeParseJson(text)) : null;
  return asString(record?.workspacePath);
}

/**
 * Whether a scope decision could be made at all. A slug or hash that reverse-maps
 * to nothing is not evidence of being out of project — `empty-window` and buckets
 * for vanished directories land here — so those stay in the pool until an artifact
 * body can answer.
 */
type CursorScope = "in" | "unknown" | "out";

function widerCursorScope(left: CursorScope, right: CursorScope): CursorScope {
  if (left === "in" || right === "in") return "in";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "out";
}

function cursorScopeForCwd(
  cwd: string | null,
  scopeRoots: readonly string[] | null | undefined,
): CursorScope {
  if (cwdIsInScope(cwd, scopeRoots)) return "in";
  return cwd ? "out" : "unknown";
}

type CursorChatMeta = {
  cwd: string | null;
  title: string | null;
  createdAt: number | null;
};

/**
 * Newer Cursor sessions record their own cwd next to the store, which beats
 * reverse-mapping the bucket's md5 through the set of known project directories:
 * the hash is only recoverable for a cwd ADE can already name.
 */
function readCursorChatMeta(sessionDir: string): CursorChatMeta | null {
  const text = readFilePrefix(path.join(sessionDir, "meta.json"), 64 * 1024);
  const record = text ? asRecord(safeParseJson(text)) : null;
  if (!record) return null;
  return {
    cwd: asString(record.cwd),
    title: cleanSessionTitle(asString(record.title)),
    createdAt: asEpochMs(record.createdAtMs),
  };
}

function cursorStoreMtime(sessionDir: string): number {
  const storePath = path.join(sessionDir, "store.db");
  return Math.max(
    safeStat(storePath)?.mtimeMs ?? 0,
    safeStat(`${storePath}-wal`)?.mtimeMs ?? 0,
    safeStat(path.join(sessionDir, "meta.json"))?.mtimeMs ?? 0,
  );
}

function readCursorStoreMeta(
  storePath: string,
  logger: ExternalSessionDiscoveryArgs["logger"],
): {
  title: string | null;
  createdAt: number | null;
} | null {
  // A store Cursor is mid-write on can refuse a read-only open (its WAL needs
  // recovery, which only a writer may perform). The session is still resumable,
  // so discovery falls back to what the directory says about it.
  const db = openExternalSessionDb(storePath, logger);
  if (!db) return null;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: unknown } | undefined;
    const encoded = typeof row?.value === "string" ? row.value.trim() : "";
    if (!encoded) return null;
    const json = /^[0-9a-f]+$/iu.test(encoded) && encoded.length % 2 === 0
      ? Buffer.from(encoded, "hex").toString("utf8")
      : encoded;
    const record = asRecord(safeParseJson(json));
    const agentId = asString(record?.agentId);
    if (!agentId || !isCursorConversationId(agentId)) return null;
    return {
      title: cleanSessionTitle(asString(record?.name)),
      createdAt: asEpochMs(record?.createdAt),
    };
  } catch {
    // Newer session headers can carry a `blobEncryptionKey`; an unreadable body
    // still leaves a resumable session, so fall back to the directory facts.
    return null;
  } finally {
    closeExternalSessionDb(db);
  }
}

type CursorArtifact = {
  filePath: string;
  mtimeMs: number;
  size: number;
  cwd: string | null;
  meta: CursorChatMeta | null;
};

/**
 * One conversation, however many places Cursor wrote it. The bare uuid is the
 * only identity shared across md5 buckets, project slugs, and `empty-window`.
 */
type CursorSessionGroup = {
  id: string;
  store: CursorArtifact | null;
  transcript: CursorArtifact | null;
  scope: CursorScope;
  mtimeMs: number;
};

function moreCompleteCursorArtifact(
  current: CursorArtifact | null,
  next: CursorArtifact,
): CursorArtifact {
  return current ? moreCompleteFileCandidate(current, next) : next;
}

function upsertCursorGroup(
  groups: Map<string, CursorSessionGroup>,
  id: string,
  kind: "store" | "transcript",
  artifact: CursorArtifact,
  scope: CursorScope,
): void {
  const existing = groups.get(id);
  const group: CursorSessionGroup = existing ?? {
    id,
    store: null,
    transcript: null,
    scope: "out",
    mtimeMs: 0,
  };
  if (kind === "store") {
    group.store = moreCompleteCursorArtifact(group.store, artifact);
  } else {
    group.transcript = moreCompleteCursorArtifact(group.transcript, artifact);
  }
  group.scope = widerCursorScope(group.scope, scope);
  group.mtimeMs = Math.max(group.mtimeMs, artifact.mtimeMs);
  groups.set(id, group);
}

/**
 * Maps a chat bucket back to its cwd. The bucket name is md5 of the raw process
 * cwd, so it can only be recovered by hashing paths ADE already knows about.
 */
function cursorWorkspaceByHash(
  projectsDir: string,
  scopeRoots: readonly string[] | null | undefined,
  resolveSlugCwd: (slug: string) => string | null,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const projectEntry of safeReadDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, projectEntry.name);
    const cwd = trustedCursorWorkspacePath(projectDir) ?? resolveSlugCwd(projectEntry.name);
    if (cwd) result.set(cursorWorkspaceHash(cwd), cwd);
  }
  for (const scopeRoot of scopeRoots ?? []) {
    const cwd = path.resolve(scopeRoot);
    result.set(cursorWorkspaceHash(cwd), cwd);
  }
  return result;
}

function collectCursorStores(
  chatsDir: string,
  workspaceByHash: Map<string, string>,
  lookupId: string | null,
  args: ExternalSessionDiscoveryArgs,
  groups: Map<string, CursorSessionGroup>,
): void {
  for (const workspaceEntry of safeReadDir(chatsDir)) {
    if (!workspaceEntry.isDirectory()) continue;
    const hashedCwd = workspaceByHash.get(workspaceEntry.name) ?? null;
    // The bucket name is md5 of exactly one cwd, so a recognised out-of-project
    // bucket can be dropped whole — before any file in it is opened.
    if (hashedCwd && !cwdIsInScope(hashedCwd, args.scopeRoots)) continue;
    const workspaceDir = path.join(chatsDir, workspaceEntry.name);
    const ids = lookupId
      ? [lookupId]
      : safeReadDir(workspaceDir).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    for (const id of ids) {
      if (!isCursorConversationId(id)) continue;
      const sessionDir = path.join(workspaceDir, id);
      const storePath = path.join(sessionDir, "store.db");
      const stat = safeStat(storePath);
      if (!stat?.isFile()) continue;
      const meta = readCursorChatMeta(sessionDir);
      const cwd = meta?.cwd ?? hashedCwd;
      upsertCursorGroup(groups, id, "store", {
        filePath: storePath,
        mtimeMs: Math.floor(cursorStoreMtime(sessionDir)),
        size: stat.size,
        cwd,
        meta,
      }, cursorScopeForCwd(cwd, args.scopeRoots));
    }
  }
}

function cursorTranscriptScope(
  projectSlug: string,
  trustedCwd: string | null,
  args: ExternalSessionDiscoveryArgs,
  resolveSlugCwd: (slug: string) => string | null,
): CursorScope {
  if (
    cwdIsInScope(trustedCwd, args.scopeRoots)
    || slugMatchesScopeRoots(projectSlug, args.scopeRoots, cursorProjectSlugForCwd)
    || cwdCandidatesIncludeScope(cursorSlugCwdCandidates(projectSlug), args.scopeRoots)
  ) {
    return "in";
  }
  // A slug that names a real directory has answered the question; one that names
  // nothing (`empty-window`, numeric window ids) has not.
  return resolveSlugCwd(projectSlug) ? "out" : "unknown";
}

function collectCursorTranscripts(
  projectsDir: string,
  lookupId: string | null,
  args: ExternalSessionDiscoveryArgs,
  resolveSlugCwd: (slug: string) => string | null,
  groups: Map<string, CursorSessionGroup>,
): void {
  for (const projectEntry of safeReadDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, projectEntry.name);
    const trustedCwd = trustedCursorWorkspacePath(projectDir);
    const scope = cursorTranscriptScope(projectEntry.name, trustedCwd, args, resolveSlugCwd);
    if (scope === "out") continue;
    const transcriptRoot = path.join(projectDir, "agent-transcripts");
    const ids = lookupId
      ? [lookupId]
      : safeReadDir(transcriptRoot).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    for (const id of ids) {
      if (!isCursorConversationId(id)) continue;
      // Only `<id>/<id>.jsonl` is the conversation; the sibling `subagents/` tree
      // holds nested runs that are not resumable sessions of their own.
      const filePath = path.join(transcriptRoot, id, `${id}.jsonl`);
      const stat = safeStat(filePath);
      if (!stat?.isFile()) continue;
      upsertCursorGroup(groups, id, "transcript", {
        filePath,
        mtimeMs: Math.floor(stat.mtimeMs),
        size: stat.size,
        cwd: trustedCwd ?? resolveSlugCwd(projectEntry.name),
        meta: null,
      }, scope);
    }
  }
}

export async function discoverCursorSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const homeDir = resolveHomeDir(args);
  const projectsDir = path.join(homeDir, ".cursor", "projects");
  const chatsDir = path.join(homeDir, ".cursor", "chats");
  const lookupId = args.sessionId?.trim() || null;
  if (lookupId && !isCursorConversationId(lookupId)) return [];

  // De-slugging walks the filesystem, and the same slug is consulted once per
  // bucket lookup and again per transcript directory.
  const slugCwdCache = new Map<string, string | null>();
  const resolveSlugCwd = (slug: string): string | null => {
    const cached = slugCwdCache.get(slug);
    if (cached !== undefined) return cached;
    const resolved = resolveCursorCwdFromSlug(slug);
    slugCwdCache.set(slug, resolved);
    return resolved;
  };

  const groups = new Map<string, CursorSessionGroup>();
  const workspaceByHash = cursorWorkspaceByHash(projectsDir, args.scopeRoots, resolveSlugCwd);
  collectCursorStores(chatsDir, workspaceByHash, lookupId, args, groups);
  collectCursorTranscripts(projectsDir, lookupId, args, resolveSlugCwd, groups);

  // Conversations already proven in project are read first, so a machine full of
  // out-of-project Cursor usage cannot crowd them out of the read budget.
  const ordered = Array.from(groups.values())
    .filter((group) => group.scope !== "out")
    .sort((left, right) => {
      if (left.scope !== right.scope) return left.scope === "in" ? -1 : 1;
      if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
      return left.id.localeCompare(right.id);
    })
    .slice(0, Math.max(limit * EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER, limit));

  const records: ExternalSessionDiscoveryRecord[] = [];
  for (const group of ordered) {
    const storeMeta = group.store ? readCursorStoreMeta(group.store.filePath, args.logger) : null;
    const jsonl = group.transcript ? readJsonlRecords(group.transcript.filePath) : [];
    const first = asRecord(jsonl[0]);
    const cwd = group.store?.cwd
      ?? cursorCwdFromRecords(jsonl)
      ?? group.transcript?.cwd
      ?? null;
    // A conversation whose cwd nothing recorded still belongs in an unscoped
    // listing; `cwdIsInScope` is what keeps it out of a project-scoped one.
    if (!cwdIsInScope(cwd, args.scopeRoots)) continue;
    records.push(recordWithFile({
      provider: "cursor",
      id: group.id,
      cwd,
      title: storeMeta?.title ?? group.store?.meta?.title ?? null,
      preview: jsonl.length ? firstUserTextFromRecords(jsonl) : null,
      createdAt: storeMeta?.createdAt
        ?? group.store?.meta?.createdAt
        ?? asEpochMs(first?.timestamp)
        ?? asEpochMs(asRecord(first?.message)?.timestamp),
      updatedAt: group.mtimeMs,
      messageCount: group.transcript
        ? countJsonlUserMessagesCheap(group.transcript.filePath, "cursor")
        : null,
      filePath: group.transcript?.filePath ?? group.store?.filePath ?? null,
      sourceMtimeMs: group.mtimeMs,
    }));
  }

  return sortDiscoveryRecords(records, limit);
}

function cursorCwdFromRecords(records: unknown[]): string | null {
  for (const record of records) {
    const obj = asRecord(record);
    if (!obj) continue;
    const message = asRecord(obj.message);
    const payload = asRecord(obj.payload);
    const cwd = asString(obj.cwd)
      ?? asString(obj.workspacePath)
      ?? asString(obj.workspace_path)
      ?? asString(message?.cwd)
      ?? asString(payload?.cwd)
      ?? asString(payload?.workspacePath)
      ?? asString(payload?.workspace_path);
    if (cwd) return cwd;
  }
  return null;
}
