import path from "node:path";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  countJsonlUserMessagesCheap,
  cwdIsInScope,
  firstUserTextFromRecords,
  moreCompleteFileCandidate,
  normalizeExternalSessionLimit,
  readJsonlRecords,
  recordWithFile,
  resolveHomeDir,
  safeReadDir,
  sessionFileCandidate,
  slashEscapedCwd,
  slugMatchesScopeRoots,
  sortDiscoveryRecords,
  EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionFileCandidate,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

/**
 * A session directory is the slash-escaped cwd, which for an absolute path always
 * begins with the escaped separator. Anything else is a shape ADE cannot map back
 * to a path, so only the file's own `session_start` row can place it.
 */
type DroidCandidate = ExternalSessionFileCandidate<{ inRequestedScope: boolean }>;

function droidDirectoryNamesAPath(directoryName: string): boolean {
  return directoryName.startsWith("-");
}

function moreCompleteDroidCandidate(current: DroidCandidate, next: DroidCandidate): DroidCandidate {
  if (next.inRequestedScope !== current.inRequestedScope) {
    return next.inRequestedScope ? next : current;
  }
  return moreCompleteFileCandidate(current, next);
}

export async function discoverDroidSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const sessionsDir = path.join(resolveHomeDir(args), ".factory", "sessions");
  const lookupId = args.sessionId?.trim() || null;
  // A session id can be written under more than one escaped cwd; keeping one
  // candidate per id stops duplicates from spending the read budget twice and
  // from reaching the caller as two rows for one session.
  const candidatesById = new Map<string, DroidCandidate>();

  for (const projectEntry of safeReadDir(sessionsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const namesAPath = droidDirectoryNamesAPath(projectEntry.name);
    const inRequestedScope = slugMatchesScopeRoots(projectEntry.name, args.scopeRoots, slashEscapedCwd);
    // Out-of-project directories are ruled out here, before the mtime cut that
    // would otherwise let heavy usage elsewhere crowd in-project sessions out.
    if (namesAPath && !inRequestedScope) continue;
    const projectDir = path.join(sessionsDir, projectEntry.name);
    const fileNames = lookupId
      ? [`${lookupId}.jsonl`]
      : safeReadDir(projectDir)
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name);
    for (const fileName of fileNames) {
      const id = path.basename(fileName, ".jsonl");
      if (!id) continue;
      const candidate = sessionFileCandidate(path.join(projectDir, fileName), {
        inRequestedScope: namesAPath && inRequestedScope,
      });
      if (!candidate) continue;
      const existing = candidatesById.get(id);
      candidatesById.set(id, existing ? moreCompleteDroidCandidate(existing, candidate) : candidate);
    }
  }

  // Sessions already placed in the project are read first, so ones that only
  // their own contents can place cannot displace a confirmed match.
  const ordered = Array.from(candidatesById.values())
    .sort((left, right) => {
      if (left.inRequestedScope !== right.inRequestedScope) return left.inRequestedScope ? -1 : 1;
      if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
      return left.filePath.localeCompare(right.filePath);
    })
    .slice(0, Math.max(limit * EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER, limit));

  const recordsById = new Map<string, ExternalSessionDiscoveryRecord>();
  for (const candidate of ordered) {
    const jsonl = readJsonlRecords(candidate.filePath);
    const first = asRecord(jsonl[0]);
    if (!first || asString(first.type) !== "session_start") continue;
    const id = asString(first.id) ?? path.basename(candidate.filePath, ".jsonl");
    if (!id || (lookupId && id !== lookupId)) continue;
    // The recorded id can differ from the file name; candidates arrive best-first,
    // so an earlier claim on the same id is the one worth keeping.
    if (recordsById.has(id)) continue;
    const cwd = asString(first.cwd);
    if (!cwdIsInScope(cwd, args.scopeRoots)) continue;
    const firstUserText = firstUserTextFromRecords(jsonl);
    const firstMessageTimestamp = jsonl
      .map((row) => asRecord(row))
      .find((row) => asString(row?.type) === "message" && (
        asEpochMs(row?.timestamp) != null
        || asEpochMs(asRecord(row?.message)?.timestamp) != null
      ));
    recordsById.set(id, recordWithFile({
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

  return sortDiscoveryRecords(Array.from(recordsById.values()), limit);
}
