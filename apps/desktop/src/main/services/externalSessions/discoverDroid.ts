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
  moreCompleteFileCandidate,
  normalizeExternalSessionLimit,
  readJsonlRecords,
  recordWithFile,
  resolveHomeDir,
  safeReadDir,
  sessionFileCandidate,
  slugMatchesScopeRoots,
  sortDiscoveryRecords,
  EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER,
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

function droidSlugForComparison(slug: string): string {
  return process.platform === "win32" ? slug.toLowerCase() : slug;
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
    // Must use droidProjectSlugForCwd, not slashEscapedCwd: the latter yields
    // "C:-Users-..." on Windows, a name NTFS can never hold, so every project
    // directory failed this filter and no Droid session was ever importable.
    // Verified byte-exact against droid v0.186.0's own on-disk directory names.
    const inRequestedScope = slugMatchesScopeRoots(
      droidSlugForComparison(projectEntry.name),
      args.scopeRoots,
      droidProjectSlugForCwd,
    );
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
