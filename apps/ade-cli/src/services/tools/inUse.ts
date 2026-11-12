import path from "node:path";
import { currentPinRoots, installDirContaining, resolveToolsRootLayout } from "./paths";

/**
 * Tool installs a process of this one runs from, with how many run from each.
 * A budgeted cache (`systemCache.ts`) and the collection (`gcTools`) never
 * remove one: on Linux a removed tree leaves the running binary alive but
 * breaks every helper and lazily loaded file it reaches for later. The record
 * of use (above) cannot say this: it is written once per spawn, a long-lived
 * app-server or chat outlives any window on it, and the write lands later.
 */
const installsInUse = new Map<string, number>();

type RunningChild = {
  pid?: number | undefined;
  once(event: "exit", listener: (...args: unknown[]) => void): unknown;
  once(event: "error", listener: (...args: unknown[]) => void): unknown;
};

/**
 * Marks the tool installs that hold any of `paths` (the executable, or the
 * script a runtime is handed) as in use until the returned release runs.
 * Paths outside the tools cache (a CLI the person installed) are ignored.
 * Never throws; the release is safe to call more than once.
 */
export function holdToolInstalls(
  paths: ReadonlyArray<string | null | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  let dirs: string[];
  try {
    const roots = currentPinRoots(resolveToolsRootLayout(env));
    dirs = [...new Set(
      paths
        .filter((entry): entry is string => typeof entry === "string" && path.isAbsolute(entry))
        .map((entry) => installDirContaining(entry, roots))
        .filter((dir): dir is string => dir !== null),
    )];
  } catch {
    // An unsupported host: nothing of the tools cache runs here.
    dirs = [];
  }
  for (const dir of dirs) installsInUse.set(dir, (installsInUse.get(dir) ?? 0) + 1);
  let released = dirs.length === 0;
  return () => {
    if (released) return;
    released = true;
    for (const dir of dirs) {
      const count = (installsInUse.get(dir) ?? 1) - 1;
      if (count > 0) installsInUse.set(dir, count);
      else installsInUse.delete(dir);
    }
  };
}

/** {@link holdToolInstalls} until `child` exits (or fails to start). */
export function holdToolInstallsWhileRunning(
  paths: ReadonlyArray<string | null | undefined>,
  child: RunningChild,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const release = holdToolInstalls(paths, env);
  child.once("exit", release);
  // A spawn that failed never runs and never exits.
  child.once("error", () => {
    if (child.pid === undefined) release();
  });
}

/** Whether a process of this one runs from the tool install at `dir` (or from inside it). */
export function toolInstallInUse(dir: string): boolean {
  const resolved = path.resolve(dir);
  for (const held of installsInUse.keys()) {
    if (held === resolved || held.startsWith(`${resolved}${path.sep}`)) return true;
  }
  return false;
}
