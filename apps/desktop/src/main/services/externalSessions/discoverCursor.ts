import path from "node:path";
import {
  asEpochMs,
  asRecord,
  countJsonlLinesCheap,
  firstUserTextFromRecords,
  normalizeExternalSessionLimit,
  previewFromRecords,
  readJsonlRecords,
  recordWithFile,
  resolveCursorCwdFromSlug,
  resolveHomeDir,
  safeReadDir,
  sessionFileCandidate,
  sortFileCandidatesByMtime,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionFileCandidate,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

export async function discoverCursorSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const projectsDir = path.join(resolveHomeDir(args), ".cursor", "projects");
  const candidates: Array<ExternalSessionFileCandidate<{ agentId: string; projectSlug: string }>> = [];

  for (const projectEntry of safeReadDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const transcriptRoot = path.join(projectsDir, projectEntry.name, "agent-transcripts");
    for (const agentEntry of safeReadDir(transcriptRoot)) {
      if (!agentEntry.isDirectory()) continue;
      const agentId = agentEntry.name;
      const filePath = path.join(transcriptRoot, agentId, `${agentId}.jsonl`);
      const candidate = sessionFileCandidate(filePath, { agentId, projectSlug: projectEntry.name });
      if (candidate) candidates.push(candidate);
    }
  }

  const records: ExternalSessionDiscoveryRecord[] = [];
  for (const candidate of sortFileCandidatesByMtime(candidates, limit)) {
    const jsonl = readJsonlRecords(candidate.filePath);
    if (!jsonl.length) continue;
    const first = asRecord(jsonl[0]);
    records.push(recordWithFile({
      provider: "cursor",
      id: candidate.agentId,
      cwd: resolveCursorCwdFromSlug(candidate.projectSlug),
      title: null,
      preview: firstUserTextFromRecords(jsonl) ?? previewFromRecords(jsonl),
      createdAt: asEpochMs(first?.timestamp) ?? asEpochMs(asRecord(first?.message)?.timestamp),
      messageCount: countJsonlLinesCheap(candidate.filePath),
      filePath: candidate.filePath,
      sourceMtimeMs: candidate.mtimeMs,
    }));
  }

  return sortDiscoveryRecords(records, limit);
}
