import { createHash } from "node:crypto";
import path from "node:path";
import { cursorProjectSlug } from "../../../shared/cursorProjectSlug";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanExternalSessionUserText,
  cleanSessionTitle,
  closeExternalSessionDb,
  countJsonlUserMessagesCheap,
  cwdCandidatesIncludeScope,
  cwdIsInScope,
  extractText,
  isAdeContinuityPrompt,
  firstUserTextFromRecords,
  moreCompleteFileCandidate,
  normalizeExternalSessionLimit,
  normalizeProviderCwd,
  openExternalSessionDb,
  readFilePrefix,
  readJsonlRecords,
  recordWithFile,
  cursorSlugCwdCandidates,
  createSlugDirCache,
  resolveCursorCwdFromSlug,
  type SlugDirCache,
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
    cwd: normalizeProviderCwd(asString(record.cwd)),
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

/** Bounds for reading prompts out of a store with no transcript beside it. */
const CURSOR_STORE_PROMPT_SCAN_MESSAGES = 1000;
const CURSOR_STORE_PROMPT_MAX_BLOB_BYTES = 256 * 1024;

export type CursorStorePrompts = {
  firstUserText: string | null;
  userCount: number;
  /** ADE's CTO agent drove this chat through the Cursor SDK. */
  adeOrigin: boolean;
};

function blobText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return null;
}

/**
 * Cursor sends its environment block (`<user_info>` then `<git_status>`) as a
 * user message of its own; it is not a prompt the user typed.
 */
export function isCursorEnvironmentMessage(raw: string): boolean {
  return /^<user_info>/u.test(raw.trim());
}

/**
 * The prompts of a Cursor chat that exists only as `store.db` (no
 * agent-transcript), walked in conversation order so a repeated prompt (one
 * content-addressed blob listed twice) counts each time. Without this, such
 * chats listed as "Untitled Cursor chat" with no preview — 11 of 27 Cursor
 * rows on 2026-09-23. Bounded by message count and blob size.
 */
export function readCursorStorePrompts(
  storePath: string,
  logger: ExternalSessionDiscoveryArgs["logger"],
): CursorStorePrompts | null {
  const conversation = openCursorStoreConversation(storePath, logger);
  if (!conversation) return null;
  try {
    let firstUserText: string | null = null;
    let userCount = 0;
    let adeOrigin = false;
    for (const id of conversation.messageIds.slice(0, CURSOR_STORE_PROMPT_SCAN_MESSAGES)) {
      const size = conversation.messageSize(id);
      if (size === null || size > CURSOR_STORE_PROMPT_MAX_BLOB_BYTES) continue;
      const record = conversation.readMessage(id);
      if (asString(record?.role) !== "user") continue;
      const raw = extractText(record?.content);
      if (!raw) continue;
      const cleaned = cleanExternalSessionUserText(raw);
      if (isAdeContinuityPrompt(cleaned)) adeOrigin = true;
      if (!cleaned || isCursorEnvironmentMessage(raw)) continue;
      userCount += 1;
      firstUserText ??= cleaned;
    }
    return { firstUserText, userCount, adeOrigin };
  } catch {
    return null;
  } finally {
    conversation.close();
  }
}

/**
 * Top-level fields of a protobuf message: field number and raw bytes
 * (length-delimited) or number (varint). Null when the bytes are not one.
 */
function protobufFields(bytes: Uint8Array): Array<[number, Uint8Array | number]> | null {
  const fields: Array<[number, Uint8Array | number]> = [];
  let offset = 0;
  const varint = (): number | null => {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10 && offset < bytes.length; i += 1) {
      const byte = bytes[offset++]!;
      value += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return value;
      scale *= 128;
    }
    return null;
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (tag === null) return null;
    const field = Math.floor(tag / 8);
    switch (tag % 8) {
      case 0: {
        const value = varint();
        if (value === null) return null;
        fields.push([field, value]);
        break;
      }
      case 1:
        offset += 8;
        break;
      case 2: {
        const length = varint();
        if (length === null || offset + length > bytes.length) return null;
        fields.push([field, bytes.subarray(offset, offset + length)]);
        offset += length;
        break;
      }
      case 5:
        offset += 4;
        break;
      default:
        return null;
    }
  }
  return offset === bytes.length ? fields : null;
}

/** Repeated 32-byte blob references (content hashes) under `field`, in order. */
function protobufBlobRefs(fields: Array<[number, Uint8Array | number]>, field: number): string[] {
  const refs: string[] = [];
  for (const [number, value] of fields) {
    if (number === field && value instanceof Uint8Array && value.length === 32) {
      refs.push(Buffer.from(value).toString("hex"));
    }
  }
  return refs;
}

/** Bytes of the largest message blob the conversation reader will decode. */
export const CURSOR_STORE_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/**
 * The conversation inside a Cursor `store.db`, verified on 2026-09-24 against
 * 42 stores. `blobs` is content-addressed (`id` = sha256 of `data`), so row
 * order is not conversation order. `meta['0']` (hex JSON) names
 * `latestRootBlobId`; that root is a protobuf whose repeated field 1 lists the
 * message blob ids oldest first. Each message blob is AI SDK JSON
 * `{ role, content }`. After a summarization the root starts over from the
 * summary, and its field 13 names a summary blob whose field 1 lists the
 * messages it replaced and field 4 the summary message the root carries.
 */
export type CursorStoreConversation = {
  /** Message blob ids, oldest first (ids repeat when a message does). */
  messageIds: string[];
  /** Index in `messageIds` where the latest summarization's messages end. */
  summaryIndex: number | null;
  /** Summary blob id of that summarization. */
  summaryId: string | null;
  /** Byte length of one message blob, or null when it is missing. */
  messageSize: (id: string) => number | null;
  /** One message as `{ role, content }`, or null when it is not readable JSON. */
  readMessage: (id: string) => Record<string, unknown> | null;
  close: () => void;
};

export function openCursorStoreConversation(
  storePath: string,
  logger: ExternalSessionDiscoveryArgs["logger"],
): CursorStoreConversation | null {
  const db = openExternalSessionDb(storePath, logger);
  if (!db) return null;
  try {
    const metaRow = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: unknown } | undefined;
    const encoded = typeof metaRow?.value === "string" ? metaRow.value.trim() : "";
    const json = /^[0-9a-f]+$/iu.test(encoded) && encoded.length % 2 === 0
      ? Buffer.from(encoded, "hex").toString("utf8")
      : encoded;
    const rootId = asString(asRecord(safeParseJson(json))?.latestRootBlobId);
    if (!rootId) {
      closeExternalSessionDb(db);
      return null;
    }
    const selectData = db.prepare("SELECT data FROM blobs WHERE id = ?");
    const selectSize = db.prepare("SELECT length(data) AS size FROM blobs WHERE id = ?");
    const readProtobuf = (id: string) => {
      const row = selectData.get(id) as { data?: unknown } | undefined;
      return row?.data instanceof Uint8Array ? protobufFields(row.data) : null;
    };
    const root = readProtobuf(rootId);
    const rootIds = root ? protobufBlobRefs(root, 1) : [];
    if (!root || rootIds.length === 0) {
      closeExternalSessionDb(db);
      return null;
    }
    let messageIds = rootIds;
    let summaryIndex: number | null = null;
    let summaryId: string | null = null;
    // A summarized chat's root holds only what followed the summary; the
    // summary blob keeps the turns it replaced.
    const summaryRef = protobufBlobRefs(root, 13)[0] ?? null;
    const summary = summaryRef ? readProtobuf(summaryRef) : null;
    if (summary) {
      const replaced = protobufBlobRefs(summary, 1);
      const summaryMessage = protobufBlobRefs(summary, 4)[0] ?? null;
      const resumeAt = summaryMessage ? rootIds.indexOf(summaryMessage) : -1;
      if (replaced.length > 0 && resumeAt >= 0) {
        messageIds = [...replaced, ...rootIds.slice(resumeAt + 1)];
        summaryIndex = replaced.length;
        summaryId = summaryRef;
      }
    }
    return {
      messageIds,
      summaryIndex,
      summaryId,
      messageSize: (id) => {
        const row = selectSize.get(id) as { size?: unknown } | undefined;
        return typeof row?.size === "number" ? row.size : null;
      },
      readMessage: (id) => {
        const row = selectData.get(id) as { data?: unknown } | undefined;
        const text = blobText(row?.data);
        if (!text || !text.trimStart().startsWith("{")) return null;
        return asRecord(safeParseJson(text));
      },
      close: () => closeExternalSessionDb(db),
    };
  } catch {
    closeExternalSessionDb(db);
    return null;
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
  slugDirCache: SlugDirCache,
): CursorScope {
  if (
    cwdIsInScope(trustedCwd, args.scopeRoots)
    || slugMatchesScopeRoots(projectSlug, args.scopeRoots, cursorProjectSlugForCwd)
    || cwdCandidatesIncludeScope(cursorSlugCwdCandidates(projectSlug, slugDirCache), args.scopeRoots)
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
  slugDirCache: SlugDirCache,
): void {
  for (const projectEntry of safeReadDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, projectEntry.name);
    const trustedCwd = trustedCursorWorkspacePath(projectDir);
    const scope = cursorTranscriptScope(projectEntry.name, trustedCwd, args, resolveSlugCwd, slugDirCache);
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
  const slugDirCache = createSlugDirCache();
  const resolveSlugCwd = (slug: string): string | null => {
    const cached = slugCwdCache.get(slug);
    if (cached !== undefined) return cached;
    const resolved = resolveCursorCwdFromSlug(slug, slugDirCache);
    slugCwdCache.set(slug, resolved);
    return resolved;
  };

  const groups = new Map<string, CursorSessionGroup>();
  const workspaceByHash = cursorWorkspaceByHash(projectsDir, args.scopeRoots, resolveSlugCwd);
  collectCursorStores(chatsDir, workspaceByHash, lookupId, args, groups);
  collectCursorTranscripts(projectsDir, lookupId, args, resolveSlugCwd, groups, slugDirCache);

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
    const storePrompts = !group.transcript && group.store
      ? readCursorStorePrompts(group.store.filePath, args.logger)
      : null;
    if (storePrompts?.adeOrigin) continue;
    const first = asRecord(jsonl[0]);
    const cwd = group.store?.cwd
      ?? cursorCwdFromRecords(jsonl)
      ?? group.transcript?.cwd
      ?? null;
    // A conversation whose cwd nothing recorded still belongs in an unscoped
    // listing; `cwdIsInScope` is what keeps it out of a project-scoped one.
    if (!cwdIsInScope(cwd, args.scopeRoots)) continue;
    const record = recordWithFile({
      provider: "cursor",
      id: group.id,
      cwd,
      title: storeMeta?.title ?? group.store?.meta?.title ?? null,
      preview: jsonl.length ? firstUserTextFromRecords(jsonl) : storePrompts?.firstUserText ?? null,
      createdAt: storeMeta?.createdAt
        ?? group.store?.meta?.createdAt
        ?? asEpochMs(first?.timestamp)
        ?? asEpochMs(asRecord(first?.message)?.timestamp),
      updatedAt: group.mtimeMs,
      messageCount: group.transcript
        ? countJsonlUserMessagesCheap(group.transcript.filePath, "cursor")
        : storePrompts?.userCount ?? null,
      filePath: group.transcript?.filePath ?? group.store?.filePath ?? null,
      sourceMtimeMs: group.mtimeMs,
    });
    // The same file `filePath` names above, so the size describes the source.
    record.sizeBytes = group.transcript?.size ?? group.store?.size ?? null;
    records.push(record);
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
    // See `normalizeProviderCwd`: whichever key carried it, the value is a path
    // the CLI recorded verbatim and may wear Windows' `\\?\` prefix.
    if (cwd) return normalizeProviderCwd(cwd);
  }
  return null;
}
