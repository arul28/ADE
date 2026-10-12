import fs from "node:fs";
import path from "node:path";
import type { ProjectDataProblem } from "../../../shared/types/recovery";

/** How often each open project's database file is checked. */
const WATCH_INTERVAL_MS = 5_000;

type Known = { dev: bigint; ino: bigint; reported: ProjectDataProblem | null };

/**
 * Notices when an open project's `ade.db` disappears or another file takes
 * its place, so the window can show the recovery screen instead of every
 * panel failing. Restoring the same file clears it.
 *
 * Only "not found" counts as missing; any other error (a volume that is
 * asleep or slow to answer) skips the tick. A project folder that is itself
 * gone, an unplugged drive included, also reads as missing: the recovery
 * screen tells that case apart and offers nothing that would recreate the
 * folder. The stat is asynchronous so a hung mount never blocks the main
 * process.
 */
export function createOpenProjectDataWatch(args: {
  /** Roots of the projects open right now. */
  openRoots: () => Iterable<string>;
  onChange: (projectRoot: string, status: ProjectDataProblem) => void;
}) {
  const known = new Map<string, Known>();
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      const roots = new Set(args.openRoots());
      for (const root of known.keys()) {
        if (!roots.has(root)) known.delete(root);
      }
      for (const root of roots) {
        let current: fs.BigIntStats | null;
        try {
          current = await fs.promises.stat(path.join(root, ".ade", "ade.db"), { bigint: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT" && code !== "ENOTDIR") continue;
          current = null;
        }
        const entry = known.get(root);
        if (!entry) {
          // Nothing to compare against until the project has a database.
          if (current) known.set(root, { dev: current.dev, ino: current.ino, reported: null });
          continue;
        }
        const status: ProjectDataProblem | null = !current
          ? "missing"
          : current.dev !== entry.dev || current.ino !== entry.ino ? "replaced" : null;
        if (status === entry.reported) continue;
        entry.reported = status;
        if (status) args.onChange(root, status);
      }
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => void tick(), WATCH_INTERVAL_MS);
  timer.unref?.();

  return {
    status: (projectRoot: string): ProjectDataProblem | null => known.get(projectRoot)?.reported ?? null,
    /** Start over for a project that is closing or opening with new data. */
    forget: (projectRoot: string): void => {
      known.delete(projectRoot);
    },
    dispose: (): void => clearInterval(timer),
  };
}
