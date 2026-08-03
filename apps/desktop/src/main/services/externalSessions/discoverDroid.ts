import fs from "node:fs";
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
  slugMatchesScopeRoots,
  sortFileCandidatesByMtime,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionFileCandidate,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

/**
 * Name of the per-project directory Droid creates under `~/.factory/sessions`.
 *
 * This mirrors `sanitizePathToDirectoryName` in @factory/droid-sdk (and the
 * `droid` CLI that writes the files), which is *not* a plain separator swap:
 *
 *   posix  /Users/dev/ADE   -> "-Users-dev-ADE"
 *   win32  C:\Users\dev\ADE -> "-C-Users-dev-ADE"   (drive colon dropped)
 *
 * A generic separator swap happens to match the posix form, which is why
 * macOS worked, but on Windows it yields "C:-Users-dev-ADE" — a name
 * that can never exist on NTFS (`:` is reserved) — so every Droid project
 * directory failed the scope filter and no CLI sessions were imported.
 */
export function droidProjectSlugForCwd(cwd: string): string {
  const absolutePath = path.resolve(cwd);
  let canonicalPath = absolutePath;
  try {
    canonicalPath = fs.realpathSync(absolutePath);
  } catch {
    canonicalPath = absolutePath;
  }
  const normalized = canonicalPath.replace(/[\\/]+$/u, "");
  const slug = process.platform === "win32"
    ? `-${normalized.replace(/^([A-Za-z]):/u, "$1").replace(/[\\/]+/gu, "-")}`
    : `-${normalized.replace(/^\/+/u, "").replace(/\/+/gu, "-")}`;
  // Windows paths are case-insensitive; the on-disk directory can differ in
  // case from the scope root ADE hands us (drive letter especially).
  return process.platform === "win32" ? slug.toLowerCase() : slug;
}

function droidSlugForComparison(slug: string): string {
  return process.platform === "win32" ? slug.toLowerCase() : slug;
}

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
      && !slugMatchesScopeRoots(
        droidSlugForComparison(projectEntry.name),
        args.scopeRoots,
        droidProjectSlugForCwd,
      )
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
