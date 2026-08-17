import fs from "node:fs";
import path from "node:path";
import { pathsEqual } from "../shared/pathCompare";

/**
 * Validation for renderer-supplied project roots.
 *
 * Diagnostics reads logs and volume space at the path it is given; recovery
 * mutates on-disk state there. Both used to accept whatever string the
 * renderer sent, trimmed. Trimming is not validation: a compromised or simply
 * buggy renderer could point either at any directory on the machine.
 *
 * The rule is that a renderer may only name a project main already knows —
 * the one that is open, one in the recent-projects list, or one main itself
 * just tried to open. That last source is what keeps the recovery screen
 * working: a folder whose FIRST open failed (disk full, db integrity, brain
 * not installed) never reaches the recent-projects list, because that list is
 * only written after a successful init. Without it, the one root the recovery
 * screen exists to repair is the one root it would be refused.
 */

export type KnownProjectRootSources = {
  /** `getCtx().project.rootPath`, when a project is open. */
  openProjectRoot?: string | null;
  /** Local entries from the recent-projects list; remote ones have no root. */
  recentProjectRoots?: readonly (string | null | undefined)[];
  /**
   * Roots main recently attempted to open, successfully or not. See
   * {@link AttemptedProjectRoots}.
   */
  attemptedProjectRoots?: readonly (string | null | undefined)[];
};

/**
 * Resolves symlinks when it can, and falls back to `path.resolve` when it
 * cannot — a project on a volume that is not mounted right now has no
 * realpath, and refusing it would be a regression on a path that is otherwise
 * legitimate. The result is therefore normalized, not guaranteed canonical, so
 * comparisons still have to go through {@link pathsEqual} for case folding.
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
 * Bounded, expiring record of the roots main has tried to open.
 *
 * Bounded and expiring because it widens what a renderer may name: an entry is
 * a directory the user themselves picked moments ago, and it stops being one
 * shortly after. Insertion order is the eviction order, with a re-attempt
 * moving its root back to the newest slot.
 */
export class AttemptedProjectRoots {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly limit = 10,
    private readonly ttlMs = 30 * 60 * 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an open/switch attempt for `root`. Ignores empty input. */
  record(root: string | null | undefined): void {
    const trimmed = typeof root === "string" ? root.trim() : "";
    if (!trimmed) return;
    // Delete first so a re-attempt moves to the end of the insertion order
    // rather than keeping its original (about-to-be-evicted) slot.
    this.entries.delete(trimmed);
    this.entries.set(trimmed, this.now());
    this.prune();
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** The still-live attempts, oldest first. */
  list(): string[] {
    this.prune();
    return [...this.entries.keys()];
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [root, at] of this.entries) {
      if (at <= cutoff) this.entries.delete(root);
    }
  }
}

/**
 * Returns the known root that `requested` refers to — in the registry's own
 * spelling, which is what the user picked and what the recent-projects list
 * shows, NOT the canonical form the comparison runs on — or null when it is not
 * a project this machine knows about. Callers that need an absolute path
 * resolve it themselves.
 */
export function resolveKnownProjectRoot(
  requested: string | null | undefined,
  sources: KnownProjectRootSources,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const trimmed = typeof requested === "string" ? requested.trim() : "";
  if (!trimmed) return null;
  const target = canonicalProjectPath(trimmed);
  const known: string[] = [];
  const openRoot = sources.openProjectRoot?.trim();
  if (openRoot) known.push(openRoot);
  for (const list of [sources.recentProjectRoots, sources.attemptedProjectRoots]) {
    for (const root of list ?? []) {
      if (typeof root === "string" && root.trim()) known.push(root);
    }
  }
  // `pathsEqual` rather than `===`: realpath only case-normalizes a path that
  // exists, so on Windows and macOS two spellings of the same live directory
  // still differ whenever either side skipped the realpath (unmounted volume,
  // permission error) — and a case-only mismatch would read as "unknown".
  return known.find((candidate) => pathsEqual(canonicalProjectPath(candidate), target, platform)) ?? null;
}
