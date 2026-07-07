import path from "node:path";
import {
  asEpochMs,
  asRecord,
  asString,
  countJsonlLinesCheap,
  cwdCandidatesIncludeScope,
  cwdIsInScope,
  firstUserTextFromRecords,
  normalizeExternalSessionLimit,
  previewFromRecords,
  readJsonlRecords,
  recordWithFile,
  cursorSlugCwdCandidates,
  resolveCursorCwdFromSlug,
  resolveHomeDir,
  safeReadDir,
  sessionFileCandidate,
  slugMatchesScopeRoots,
  sortFileCandidatesByMtime,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionFileCandidate,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

function cursorProjectSlugForCwd(cwd: string): string {
  return cwd.replace(/^[/\\]+/u, "").replace(/[\\/]/gu, "-");
}

export async function discoverCursorSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const projectsDir = path.join(resolveHomeDir(args), ".cursor", "projects");
  const candidates: Array<ExternalSessionFileCandidate<{ agentId: string; projectSlug: string }>> = [];

  for (const projectEntry of safeReadDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    if (
      !slugMatchesScopeRoots(projectEntry.name, args.scopeRoots, cursorProjectSlugForCwd)
      && !cwdCandidatesIncludeScope(cursorSlugCwdCandidates(projectEntry.name), args.scopeRoots)
    ) {
      continue;
    }
    const transcriptRoot = path.join(projectsDir, projectEntry.name, "agent-transcripts");
    for (const agentEntry of safeReadDir(transcriptRoot)) {
      if (!agentEntry.isDirectory()) continue;
      const agentId = agentEntry.name;
      if (agentId.startsWith("agent-")) continue;
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
    const transcriptCwd = cursorCwdFromRecords(jsonl);
    const cwd = transcriptCwd ?? resolveCursorCwdFromSlug(candidate.projectSlug);
    if (!cwdIsInScope(cwd, args.scopeRoots)) continue;
    records.push(recordWithFile({
      provider: "cursor",
      id: candidate.agentId,
      cwd,
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
