import fs from "node:fs";
import path from "node:path";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  countJsonlLinesCheap,
  firstUserTextFromRecords,
  normalizeExternalSessionLimit,
  previewFromRecords,
  readFileSuffix,
  readJsonlRecords,
  recordWithFile,
  resolveHomeDir,
  safeParseJson,
  safeReadDir,
  safeStat,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

type CodexIndexEntry = {
  id: string;
  title: string | null;
  updatedAt: number | null;
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

function walkCodexSessionFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < 5000) {
    const dir = stack.pop()!;
    for (const entry of safeReadDir(dir)) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"))) {
        out.push(filePath);
      }
    }
  }
  return out.sort((left, right) => (safeStat(right)?.mtimeMs ?? 0) - (safeStat(left)?.mtimeMs ?? 0));
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

  for (const filePath of walkCodexSessionFiles(sessionsDir).slice(0, Math.max(limit * 8, 120))) {
    const stat = safeStat(filePath);
    if (!stat) continue;
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
        updatedAt: indexed?.updatedAt ?? Math.floor(stat.mtimeMs),
        filePath,
      }));
      continue;
    }

    const jsonl = readJsonlRecords(filePath);
    const first = asRecord(jsonl[0]);
    const payload = asRecord(first?.payload);
    const type = asString(first?.type);
    if (type !== "session_meta" || !payload) continue;
    const id = asString(payload.id) ?? asString(payload.session_id) ?? asString(payload.sessionId);
    if (!id || recordsById.has(id)) continue;
    const indexed = index.get(id);
    const firstUserText = firstUserTextFromRecords(jsonl);
    const title = cleanSessionTitle(asString(payload.thread_name))
      ?? cleanSessionTitle(asString(payload.threadName))
      ?? cleanSessionTitle(asString(payload.name))
      ?? indexed?.title
      ?? null;
    recordsById.set(id, recordWithFile({
      provider: "codex",
      id,
      cwd: asString(payload.cwd),
      title,
      preview: firstUserText ?? previewFromRecords(jsonl),
      createdAt: asEpochMs(payload.timestamp) ?? asEpochMs(first?.timestamp),
      updatedAt: indexed?.updatedAt ?? Math.floor(stat.mtimeMs),
      messageCount: countJsonlLinesCheap(filePath),
      filePath,
    }));
  }

  return sortDiscoveryRecords(Array.from(recordsById.values()), limit);
}
