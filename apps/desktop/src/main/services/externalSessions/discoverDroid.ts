import path from "node:path";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  countJsonlUserMessagesCheap,
  cwdIsInScope,
  firstUserTextFromRecords,
  normalizeExternalSessionLimit,
  readJsonlRecords,
  recordWithFile,
  resolveHomeDir,
  safeReadDir,
  sessionFileCandidate,
  slashEscapedCwd,
  slugMatchesScopeRoots,
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
  const lookupId = args.sessionId?.trim() || null;
  const candidates: ExternalSessionFileCandidate[] = [];

  for (const projectEntry of safeReadDir(sessionsDir)) {
    if (!projectEntry.isDirectory()) continue;
    if (
      projectEntry.name.startsWith("-")
      && !slugMatchesScopeRoots(projectEntry.name, args.scopeRoots, slashEscapedCwd)
    ) {
      continue;
    }
    const projectDir = path.join(sessionsDir, projectEntry.name);
    if (lookupId) {
      const candidate = sessionFileCandidate(path.join(projectDir, `${lookupId}.jsonl`), {});
      if (candidate) candidates.push(candidate);
      continue;
    }
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
    if (!id || (lookupId && id !== lookupId)) continue;
    const cwd = asString(first.cwd);
    if (!cwdIsInScope(cwd, args.scopeRoots)) continue;
    const firstUserText = firstUserTextFromRecords(jsonl);
    const firstMessageTimestamp = jsonl
      .map((row) => asRecord(row))
      .find((row) => asString(row?.type) === "message" && (
        asEpochMs(row?.timestamp) != null
        || asEpochMs(asRecord(row?.message)?.timestamp) != null
      ));
    records.push(recordWithFile({
      provider: "droid",
      id,
      cwd,
      title: cleanSessionTitle(asString(first.title)) ?? cleanSessionTitle(asString(first.sessionTitle)),
      preview: firstUserText,
      createdAt: asEpochMs(first.timestamp)
        ?? asEpochMs(firstMessageTimestamp?.timestamp)
        ?? asEpochMs(asRecord(firstMessageTimestamp?.message)?.timestamp),
      messageCount: countJsonlUserMessagesCheap(candidate.filePath, "droid"),
      filePath: candidate.filePath,
      sourceMtimeMs: candidate.mtimeMs,
    }));
  }

  return sortDiscoveryRecords(records, limit);
}
