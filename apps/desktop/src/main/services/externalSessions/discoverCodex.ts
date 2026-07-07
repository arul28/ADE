import fs from "node:fs";
import path from "node:path";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  countJsonlLinesCheap,
  cwdIsInScope,
  firstUserTextFromRecords,
  normalizeExternalSessionLimit,
  previewFromRecords,
  readFilePrefix,
  readFileSuffix,
  readJsonlRecords,
  recordWithFile,
  resolveHomeDir,
  safeParseJson,
  safeReadDir,
  sessionFileCandidate,
  sortFileCandidatesByMtime,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionFileCandidate,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

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
  first: Record<string, unknown>;
  payload: Record<string, unknown>;
};

type CodexSessionCandidate = ExternalSessionFileCandidate<{ meta?: CodexSessionMeta | null }>;

const CODEX_PROJECT_SCOPE_SCAN_CEILING = 2000;

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

function readCodexSessionMeta(filePath: string): CodexSessionMeta | null {
  const text = readFilePrefix(filePath, 64 * 1024);
  const line = text?.split(/\r?\n/u).find((entry) => entry.trim().length > 0);
  if (!line) return null;
  const first = asRecord(safeParseJson(line));
  const payload = asRecord(first?.payload);
  const type = asString(first?.type);
  if (type !== "session_meta" || !payload || !first) return null;
  const id = asString(payload.id) ?? asString(payload.session_id) ?? asString(payload.sessionId);
  if (!id) return null;
  return {
    id,
    cwd: asString(payload.cwd),
    createdAt: asEpochMs(payload.timestamp) ?? asEpochMs(first.timestamp),
    title: titleFromCodexPayload(payload, undefined),
    first,
    payload,
  };
}

function sortedChildDirs(dir: string, pattern: RegExp): string[] {
  return safeReadDir(dir)
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
}

function collectRecentCodexSessionCandidates(root: string, limit: number): CodexSessionCandidate[] {
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
          const candidate = sessionFileCandidate(path.join(dayDir, entry.name), {});
          if (candidate) candidates.push(candidate);
        }
        if (candidates.length >= limit) return sortFileCandidatesByMtime(candidates, limit);
      }
    }
  }
  return sortFileCandidatesByMtime(candidates, limit);
}

function collectProjectScopedCodexSessionCandidates(
  root: string,
  limit: number,
  scopeRoots: string[],
  logger: ExternalSessionDiscoveryArgs["logger"],
): CodexSessionCandidate[] {
  const candidates: CodexSessionCandidate[] = [];
  let scanned = 0;
  let ceilingHit = false;
  const finish = (): CodexSessionCandidate[] => {
    if (ceilingHit && candidates.length < limit) {
      logger?.warn?.("external_sessions.codex_project_scope_scan_truncated", {
        ceiling: CODEX_PROJECT_SCOPE_SCAN_CEILING,
        scanned,
        matched: candidates.length,
        limit,
      });
    }
    return sortFileCandidatesByMtime(candidates, limit);
  };

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
          const candidate = sessionFileCandidate(path.join(dayDir, entry.name), {});
          if (!candidate) continue;
          if (scanned >= CODEX_PROJECT_SCOPE_SCAN_CEILING) {
            ceilingHit = true;
            return finish();
          }
          scanned += 1;
          if (candidate.filePath.endsWith(".jsonl.zst")) continue;
          const meta = readCodexSessionMeta(candidate.filePath);
          if (!cwdIsInScope(meta?.cwd, scopeRoots)) continue;
          candidates.push({ ...candidate, meta });
          if (candidates.length >= limit) return finish();
        }
      }
    }
  }
  return finish();
}

function idFromCodexFilename(filePath: string): string | null {
  const base = path.basename(filePath).replace(/\.jsonl(?:\.zst)?$/u, "");
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu);
  return match?.[1] ?? null;
}

export async function discoverCodexSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const codexDir = path.join(resolveHomeDir(args), ".codex");
  const sessionsDir = path.join(codexDir, "sessions");
  const index = readCodexIndex(path.join(codexDir, "session_index.jsonl"));
  const recordsById = new Map<string, ExternalSessionDiscoveryRecord>();
  if (!fs.existsSync(sessionsDir)) return [];

  const candidates = args.scopeRoots?.length
    ? collectProjectScopedCodexSessionCandidates(sessionsDir, limit, args.scopeRoots, args.logger)
    : collectRecentCodexSessionCandidates(sessionsDir, limit);

  for (const candidate of candidates) {
    const filePath = candidate.filePath;
    const compressed = filePath.endsWith(".jsonl.zst");
    if (compressed) {
      const id = idFromCodexFilename(filePath);
      if (!id || recordsById.has(id)) continue;
      const indexed = index.get(id);
      recordsById.set(id, recordWithFile({
        provider: "codex",
        id,
        cwd: null,
        title: indexed?.title ?? null,
        preview: null,
        updatedAt: indexed?.updatedAt ?? candidate.mtimeMs,
        filePath,
        sourceMtimeMs: candidate.mtimeMs,
      }));
      continue;
    }

    const jsonl = readJsonlRecords(filePath);
    const first = candidate.meta?.first ?? asRecord(jsonl[0]);
    const payload = candidate.meta?.payload ?? asRecord(first?.payload);
    const type = asString(first?.type);
    if (type !== "session_meta" || !payload) continue;
    const id = candidate.meta?.id ?? asString(payload.id) ?? asString(payload.session_id) ?? asString(payload.sessionId);
    if (!id || recordsById.has(id)) continue;
    const indexed = index.get(id);
    const firstUserText = firstUserTextFromRecords(jsonl);
    const title = candidate.meta?.title ?? titleFromCodexPayload(payload, indexed);
    recordsById.set(id, recordWithFile({
      provider: "codex",
      id,
      cwd: candidate.meta?.cwd ?? asString(payload.cwd),
      title,
      preview: firstUserText ?? previewFromRecords(jsonl),
      createdAt: candidate.meta?.createdAt ?? asEpochMs(payload.timestamp) ?? asEpochMs(first?.timestamp),
      updatedAt: indexed?.updatedAt ?? candidate.mtimeMs,
      messageCount: countJsonlLinesCheap(filePath),
      filePath,
      sourceMtimeMs: candidate.mtimeMs,
    }));
  }

  return sortDiscoveryRecords(Array.from(recordsById.values()), limit);
}
