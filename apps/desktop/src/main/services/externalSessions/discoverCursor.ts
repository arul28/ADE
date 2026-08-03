import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { cursorProjectSlug } from "../../../shared/cursorProjectSlug";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  countJsonlUserMessagesCheap,
  cwdCandidatesIncludeScope,
  cwdIsInScope,
  firstUserTextFromRecords,
  normalizeExternalSessionLimit,
  readFilePrefix,
  readJsonlRecords,
  recordWithFile,
  cursorSlugCwdCandidates,
  resolveCursorCwdFromSlug,
  resolveHomeDir,
  safeReadDir,
  safeParseJson,
  safeStat,
  sessionFileCandidate,
  slugMatchesScopeRoots,
  sortFileCandidatesByMtime,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionFileCandidate,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

type DatabaseSyncConstructor = new (
  dbPath: string,
  options?: { allowExtension?: boolean },
) => DatabaseSyncType;

const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

function cursorProjectSlugForCwd(cwd: string): string {
  return cursorProjectSlug(cwd);
}

/**
 * Cursor's slug keeps the Windows drive letter as its first segment
 * (`C:\repo` becomes `C-repo`), but the shared slug resolver walks down from
 * the current drive root and so never finds a directory literally named `C`.
 * Retry without the drive segment when the slug starts with one.
 */
function resolveCursorProjectCwd(slug: string): string | null {
  const direct = resolveCursorCwdFromSlug(slug);
  if (direct) return direct;
  if (process.platform !== "win32") return null;
  const withoutDrive = /^([A-Za-z])-(.+)$/u.exec(slug)?.[2];
  return withoutDrive ? resolveCursorCwdFromSlug(withoutDrive) : null;
}

function cursorProjectCwdCandidates(slug: string): string[] {
  const candidates = [...cursorSlugCwdCandidates(slug)];
  if (process.platform === "win32") {
    const withoutDrive = /^([A-Za-z])-(.+)$/u.exec(slug)?.[2];
    if (withoutDrive) candidates.push(...cursorSlugCwdCandidates(withoutDrive));
  }
  return candidates;
}

type CursorStoreCandidate = ExternalSessionFileCandidate<{
  agentId: string;
  cwd: string;
}>;

function cursorWorkspaceHash(cwd: string): string {
  return createHash("md5").update(cwd).digest("hex");
}

function trustedCursorWorkspacePath(projectDir: string): string | null {
  const text = readFilePrefix(path.join(projectDir, ".workspace-trusted"), 64 * 1024);
  const record = text ? asRecord(safeParseJson(text)) : null;
  return asString(record?.workspacePath);
}

function cursorWorkspaceByHash(
  projectsDir: string,
  scopeRoots: readonly string[] | null | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const projectEntry of safeReadDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, projectEntry.name);
    const cwd = trustedCursorWorkspacePath(projectDir) ?? resolveCursorProjectCwd(projectEntry.name);
    if (!cwd || !cwdIsInScope(cwd, scopeRoots)) continue;
    result.set(cursorWorkspaceHash(cwd), cwd);
  }
  for (const scopeRoot of scopeRoots ?? []) {
    const cwd = path.resolve(scopeRoot);
    result.set(cursorWorkspaceHash(cwd), cwd);
  }
  return result;
}

function cursorStoreMtime(storePath: string): number {
  return Math.max(
    safeStat(storePath)?.mtimeMs ?? 0,
    safeStat(`${storePath}-wal`)?.mtimeMs ?? 0,
  );
}

function readCursorStoreMeta(storePath: string): {
  agentId: string;
  title: string | null;
  createdAt: number | null;
} | null {
  let db: DatabaseSyncType | null = null;
  try {
    db = new DatabaseSync(storePath);
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: unknown } | undefined;
    const encoded = typeof row?.value === "string" ? row.value.trim() : "";
    if (!encoded) return null;
    const json = /^[0-9a-f]+$/iu.test(encoded) && encoded.length % 2 === 0
      ? Buffer.from(encoded, "hex").toString("utf8")
      : encoded;
    const record = asRecord(safeParseJson(json));
    const agentId = asString(record?.agentId);
    if (!agentId || agentId.startsWith("agent-")) return null;
    return {
      agentId,
      title: cleanSessionTitle(asString(record?.name)),
      createdAt: asEpochMs(record?.createdAt),
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function discoverCursorSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const projectsDir = path.join(resolveHomeDir(args), ".cursor", "projects");
  const chatsDir = path.join(resolveHomeDir(args), ".cursor", "chats");
  const lookupId = args.sessionId?.trim() || null;
  const candidates: Array<ExternalSessionFileCandidate<{
    agentId: string;
    projectSlug: string;
    trustedCwd: string | null;
  }>> = [];
  const workspaceByHash = cursorWorkspaceByHash(projectsDir, args.scopeRoots);
  const storeCandidates: CursorStoreCandidate[] = [];

  for (const workspaceEntry of safeReadDir(chatsDir)) {
    if (!workspaceEntry.isDirectory()) continue;
    const cwd = workspaceByHash.get(workspaceEntry.name);
    if (!cwd) continue;
    const workspaceDir = path.join(chatsDir, workspaceEntry.name);
    if (lookupId) {
      if (lookupId.startsWith("agent-")) continue;
      const storePath = path.join(workspaceDir, lookupId, "store.db");
      const stat = safeStat(storePath);
      if (stat?.isFile()) {
        storeCandidates.push({
          filePath: storePath,
          mtimeMs: Math.floor(cursorStoreMtime(storePath)),
          size: stat.size,
          agentId: lookupId,
          cwd,
        });
      }
      continue;
    }
    for (const chatEntry of safeReadDir(workspaceDir)) {
      if (!chatEntry.isDirectory() || chatEntry.name.startsWith("agent-")) continue;
      const storePath = path.join(workspaceDir, chatEntry.name, "store.db");
      const stat = safeStat(storePath);
      if (!stat?.isFile()) continue;
      storeCandidates.push({
        filePath: storePath,
        mtimeMs: Math.floor(cursorStoreMtime(storePath)),
        size: stat.size,
        agentId: chatEntry.name,
        cwd,
      });
    }
  }

  for (const projectEntry of safeReadDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, projectEntry.name);
    const trustedCwd = trustedCursorWorkspacePath(projectDir);
    if (
      !cwdIsInScope(trustedCwd, args.scopeRoots)
      && !slugMatchesScopeRoots(projectEntry.name, args.scopeRoots, cursorProjectSlugForCwd)
      && !cwdCandidatesIncludeScope(cursorProjectCwdCandidates(projectEntry.name), args.scopeRoots)
    ) {
      continue;
    }
    const transcriptRoot = path.join(projectDir, "agent-transcripts");
    if (lookupId) {
      if (lookupId.startsWith("agent-")) continue;
      const filePath = path.join(transcriptRoot, lookupId, `${lookupId}.jsonl`);
      const candidate = sessionFileCandidate(filePath, {
        agentId: lookupId,
        projectSlug: projectEntry.name,
        trustedCwd,
      });
      if (candidate) candidates.push(candidate);
      continue;
    }
    for (const agentEntry of safeReadDir(transcriptRoot)) {
      if (!agentEntry.isDirectory()) continue;
      const agentId = agentEntry.name;
      if (agentId.startsWith("agent-")) continue;
      const filePath = path.join(transcriptRoot, agentId, `${agentId}.jsonl`);
      const candidate = sessionFileCandidate(filePath, {
        agentId,
        projectSlug: projectEntry.name,
        trustedCwd,
      });
      if (candidate) candidates.push(candidate);
    }
  }

  const recordsById = new Map<string, ExternalSessionDiscoveryRecord>();
  for (const candidate of sortFileCandidatesByMtime(storeCandidates, Math.max(limit * 4, limit))) {
    const meta = readCursorStoreMeta(candidate.filePath);
    const agentId = meta?.agentId ?? candidate.agentId;
    if (!agentId || agentId.startsWith("agent-")) continue;
    recordsById.set(agentId, recordWithFile({
      provider: "cursor",
      id: agentId,
      cwd: candidate.cwd,
      title: meta?.title ?? null,
      preview: null,
      createdAt: meta?.createdAt ?? null,
      filePath: candidate.filePath,
      sourceMtimeMs: candidate.mtimeMs,
    }));
  }

  for (const candidate of sortFileCandidatesByMtime(candidates, limit)) {
    const jsonl = readJsonlRecords(candidate.filePath);
    if (!jsonl.length) continue;
    const first = asRecord(jsonl[0]);
    const transcriptCwd = cursorCwdFromRecords(jsonl);
    const cwd = transcriptCwd ?? candidate.trustedCwd ?? resolveCursorProjectCwd(candidate.projectSlug);
    if (!cwdIsInScope(cwd, args.scopeRoots)) continue;
    const existing = recordsById.get(candidate.agentId);
    const firstPrompt = firstUserTextFromRecords(jsonl);
    recordsById.set(candidate.agentId, recordWithFile({
      provider: "cursor",
      id: candidate.agentId,
      cwd: existing?.cwd ?? cwd,
      title: existing?.title ?? null,
      preview: firstPrompt,
      createdAt: existing?.createdAt ?? asEpochMs(first?.timestamp) ?? asEpochMs(asRecord(first?.message)?.timestamp),
      updatedAt: Math.max(existing?.updatedAt ?? 0, candidate.mtimeMs),
      messageCount: countJsonlUserMessagesCheap(candidate.filePath, "cursor"),
      filePath: candidate.filePath,
      sourceMtimeMs: Math.max(existing?.sourceMtimeMs ?? 0, candidate.mtimeMs),
    }));
  }

  return sortDiscoveryRecords(Array.from(recordsById.values()), limit);
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
