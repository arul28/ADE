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
  readJsonlRecords,
  recordWithFile,
  resolveHomeDir,
  safeReadDir,
  sessionFileCandidate,
  sortFileCandidatesByMtime,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionFileCandidate,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

export async function discoverDroidSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const sessionsDir = path.join(resolveHomeDir(args), ".factory", "sessions");
  const candidates: ExternalSessionFileCandidate[] = [];

  for (const projectEntry of safeReadDir(sessionsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(sessionsDir, projectEntry.name);
    for (const entry of safeReadDir(projectDir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(projectDir, entry.name);
      const candidate = sessionFileCandidate(filePath, {});
      if (candidate) candidates.push(candidate);
    }
  }

  const records: ExternalSessionDiscoveryRecord[] = [];
  for (const candidate of sortFileCandidatesByMtime(candidates, limit)) {
    const jsonl = readJsonlRecords(candidate.filePath);
    const first = asRecord(jsonl[0]);
    if (!first || asString(first.type) !== "session_start") continue;
    const id = asString(first.id) ?? path.basename(candidate.filePath, ".jsonl");
    if (!id) continue;
    const firstUserText = firstUserTextFromRecords(jsonl);
    records.push(recordWithFile({
      provider: "droid",
      id,
      cwd: asString(first.cwd),
      title: cleanSessionTitle(asString(first.title)) ?? cleanSessionTitle(asString(first.sessionTitle)),
      preview: firstUserText ?? previewFromRecords(jsonl),
      createdAt: asEpochMs(first.timestamp),
      messageCount: countJsonlLinesCheap(candidate.filePath),
      filePath: candidate.filePath,
      sourceMtimeMs: candidate.mtimeMs,
    }));
  }

  return sortDiscoveryRecords(records, limit);
}
