import fs from "node:fs";
import path from "node:path";

/**
 * Validation for renderer-supplied project roots.
 *
 * Diagnostics reads logs and volume space at the path it is given; recovery
 * mutates on-disk state there. Both used to accept whatever string the
 * renderer sent, trimmed. Trimming is not validation: a compromised or simply
 * buggy renderer could point either at any directory on the machine.
 *
 * The rule is that a renderer may only name a project main already knows —
 * the one that is open, or one in the recent-projects list.
 */

export type KnownProjectRootSources = {
  /** `getCtx().project.rootPath`, when a project is open. */
  openProjectRoot?: string | null;
  /** Local entries from the recent-projects list; remote ones have no root. */
  recentProjectRoots?: readonly (string | null | undefined)[];
};

/**
 * Best effort by design: a project on a volume that is not mounted right now
 * still resolves through `path.resolve` alone, and refusing it would be a
 * regression on a path that is otherwise legitimate.
 */
export function canonicalProjectPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Returns the known root that `requested` refers to — in the registry's own
 * spelling, so the rest of the flow works with a canonical path — or null when
 * it is not a project this machine knows about.
 */
export function resolveKnownProjectRoot(
  requested: string | null | undefined,
  sources: KnownProjectRootSources,
): string | null {
  const trimmed = typeof requested === "string" ? requested.trim() : "";
  if (!trimmed) return null;
  const target = canonicalProjectPath(trimmed);
  const known: string[] = [];
  const openRoot = sources.openProjectRoot?.trim();
  if (openRoot) known.push(openRoot);
  for (const root of sources.recentProjectRoots ?? []) {
    if (typeof root === "string" && root.trim()) known.push(root);
  }
  return known.find((candidate) => canonicalProjectPath(candidate) === target) ?? null;
}
