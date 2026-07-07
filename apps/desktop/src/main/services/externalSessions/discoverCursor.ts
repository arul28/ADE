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
  resolveCursorCwdFromSlug,
  resolveHomeDir,
  safeReadDir,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

export async function discoverCursorSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const projectsDir = path.join(resolveHomeDir(args), ".cursor", "projects");
  const records: ExternalSessionDiscoveryRecord[] = [];

  for (const projectEntry of safeReadDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const transcriptRoot = path.join(projectsDir, projectEntry.name, "agent-transcripts");
    const cwd = resolveCursorCwdFromSlug(projectEntry.name);
    for (const agentEntry of safeReadDir(transcriptRoot)) {
      if (!agentEntry.isDirectory()) continue;
      const agentId = agentEntry.name;
      const filePath = path.join(transcriptRoot, agentId, `${agentId}.jsonl`);
      const jsonl = readJsonlRecords(filePath);
      if (!jsonl.length) continue;
      const first = asRecord(jsonl[0]);
      records.push(recordWithFile({
        provider: "cursor",
        id: agentId,
        cwd,
        title: firstUserTextFromRecords(jsonl),
        preview: previewFromRecords(jsonl),
        createdAt: asEpochMs(first?.timestamp) ?? asEpochMs(asRecord(first?.message)?.timestamp),
        messageCount: countJsonlLinesCheap(filePath),
        filePath,
      }));
    }
  }

  return sortDiscoveryRecords(records, limit);
}
