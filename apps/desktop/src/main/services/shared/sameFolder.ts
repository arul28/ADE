import path from "node:path";
import { nonAsarFs } from "./nonAsarFs";
import { pathsEqual } from "./pathCompare";

/**
 * Whether two paths name the same folder on this computer.
 *
 * Lane folders reach ADE in more than one spelling: ADE's own (`path.resolve`
 * of the worktrees folder) and git's (`git worktree list` prints the real
 * path). On Windows the two differ by drive-letter case, an 8.3 short name, or
 * a OneDrive junction in front of Documents; on macOS by a `/private` prefix.
 * An exact `===` then misses ADE's own lanes and the caller quietly skips them
 * ("Cannot reclaim this folder", a lane left out of a cleanup).
 *
 * Resolved, compared without case where the platform ignores case
 * (`pathsEqual`), and only when that still differs, compared by real path.
 * The real-path read is one `realpath` per side, and only on a mismatch, so a
 * loop over many folders costs nothing for the ones that match outright.
 */
export function sameFolder(
  left: string | null | undefined,
  right: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!left || !right) return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (pathsEqual(a, b, platform)) return true;
  const realA = realPathOrNull(a);
  const realB = realPathOrNull(b);
  return realA != null && realB != null && pathsEqual(realA, realB, platform);
}

/**
 * Whether `candidate` sits directly inside `parent` (one level down), with
 * both compared by {@link sameFolder}. `parent` itself is not its own child.
 */
export function isDirectChildFolder(
  parent: string | null | undefined,
  candidate: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!parent || !candidate) return false;
  const child = path.resolve(candidate);
  if (path.basename(child).trim().length === 0) return false;
  if (pathsEqual(child, path.resolve(parent), platform)) return false;
  return sameFolder(path.dirname(child), parent, platform);
}

/**
 * Whether `candidate` sits anywhere below `parent`, with each level compared by
 * {@link sameFolder}. `parent` is not inside itself.
 */
export function isFolderInside(
  parent: string | null | undefined,
  candidate: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!parent || !candidate) return false;
  let current = path.resolve(candidate);
  for (;;) {
    const up = path.dirname(current);
    if (up === current) return false;
    if (sameFolder(up, parent, platform)) return true;
    current = up;
  }
}

function realPathOrNull(target: string): string | null {
  try {
    // Unpatched fs: under Electron a lane path through an `.asar` reads as a folder.
    return nonAsarFs.realpathSync.native(target);
  } catch {
    return null;
  }
}
