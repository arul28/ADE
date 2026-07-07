import path from "node:path";
import {
  asEpochMs,
  asRecord,
  asString,
  countJsonlLinesCheap,
  firstUserTextFromRecords,
  normalizeExternalSessionLimit,
  previewFromRecords,
  readJsonlRecords,
  recordWithFile,
  resolveHomeDir,
  safeReadDir,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

export async function discoverDroidSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const sessionsDir = path.join(resolveHomeDir(args), ".factory", "sessions");
  const records: ExternalSessionDiscoveryRecord[] = [];

  for (const projectEntry of safeReadDir(sessionsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(sessionsDir, projectEntry.name);
    for (const entry of safeReadDir(projectDir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(projectDir, entry.name);
      const jsonl = readJsonlRecords(filePath);
      const first = asRecord(jsonl[0]);
      if (!first || asString(first.type) !== "session_start") continue;
      const id = asString(first.id) ?? entry.name.slice(0, -".jsonl".length);
      if (!id) continue;
      records.push(recordWithFile({
        provider: "droid",
        id,
        cwd: asString(first.cwd),
        title: firstUserTextFromRecords(jsonl) ?? asString(first.title) ?? asString(first.sessionTitle),
        preview: firstUserTextFromRecords(jsonl) ?? previewFromRecords(jsonl),
        createdAt: asEpochMs(first.timestamp),
        messageCount: countJsonlLinesCheap(filePath),
        filePath,
      }));
    }
  }

  return sortDiscoveryRecords(records, limit);
}
