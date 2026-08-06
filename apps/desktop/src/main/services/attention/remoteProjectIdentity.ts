// Reconciling the two project-id spaces an Activity click-through crosses.
//
// The push publisher stamps `project.projectId` with the OWNING machine's
// per-project `ade.db` uuid, while that same machine's `projects.list` answers
// with the machine-registry id `project_<sha256(rootPath)>`. The two spaces
// never intersect, so resolving a cross-machine Activity item by id alone
// failed every single time ("Remote project was not found on this runtime").
//
// `rootPath` is the one project identity both sides already carry, so it is the
// fallback wherever an Activity item's project is matched against a runtime.
// The path belongs to the owning machine, which may not run this OS, so the
// comparison rules are taken from the path's own shape rather than
// `process.platform`.

import { pathKey } from "../shared/pathCompare";

/** Drive-letter or UNC spelling — the only path shapes Windows can produce. */
function looksLikeWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * Comparison key for an owning-machine project root. `fold` opts into the
 * case-insensitive reading that Windows and macOS filesystems actually use;
 * callers that can be ambiguous try the exact key first.
 */
function remoteRootPathKey(value: string, fold: boolean): string {
  // `linux` keeps `pathKey` case-sensitive for POSIX spellings; folding is
  // applied here instead, so the caller — not the host platform — decides.
  const key = pathKey(value, looksLikeWindowsPath(value) ? "win32" : "linux");
  return fold ? key.toLowerCase() : key;
}

/**
 * True when two owning-machine project roots address the same directory.
 * Used for 1:1 comparisons (a window binding against an item), where there is
 * no second candidate a case-folded match could be confused with.
 */
export function remoteProjectRootPathsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = a?.trim() ?? "";
  const right = b?.trim() ?? "";
  if (!left || !right) return false;
  if (remoteRootPathKey(left, false) === remoteRootPathKey(right, false)) return true;
  return remoteRootPathKey(left, true) === remoteRootPathKey(right, true);
}

/**
 * Pick the runtime project whose root is `rootPath`. An exact (normalized,
 * case-sensitive) match wins outright; a case-folded match is accepted only
 * when it is unambiguous, so ADE never guesses between two sibling repos whose
 * paths differ solely by case.
 */
export function matchRemoteProjectByRootPath<T extends { rootPath?: string | null }>(
  candidates: readonly T[],
  rootPath: string | null | undefined,
): T | null {
  const wanted = rootPath?.trim() ?? "";
  if (!wanted) return null;
  const exactKey = remoteRootPathKey(wanted, false);
  const exact = candidates.find((candidate) => {
    const candidateRoot = candidate.rootPath?.trim() ?? "";
    return Boolean(candidateRoot) && remoteRootPathKey(candidateRoot, false) === exactKey;
  });
  if (exact) return exact;
  const foldedKey = remoteRootPathKey(wanted, true);
  const folded = candidates.filter((candidate) => {
    const candidateRoot = candidate.rootPath?.trim() ?? "";
    return Boolean(candidateRoot) && remoteRootPathKey(candidateRoot, true) === foldedKey;
  });
  return folded.length === 1 ? folded[0]! : null;
}
