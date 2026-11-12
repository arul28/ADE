import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { currentPinRoots, installDirContaining, resolveToolsRootLayout, toolUsageRoot } from "./paths";
import { warnTools } from "./toolsLog";

/**
 * When each pinned tool last ran on this machine, kept beside the tools cache.
 *
 * "Installed" is not "used": a tool a status read once downloaded, or one an
 * old build fetched, would otherwise count as a tool the machine uses and be
 * fetched again at every pin change. This file is what counts instead: the
 * startup fetch keeps only recently used tools current, and a budgeted cache
 * (`systemCache.ts`) removes the least recently used first.
 *
 * Written only from a real use (`pinnedToolDownload`, which every spawn site
 * calls just before it runs a tool), at most once per tool per
 * {@link USE_WRITE_INTERVAL_MS} in a process, tmp-file + rename. Two processes
 * racing a write can lose one update; the next use writes it again.
 */
const USAGE_FILE = ".last-used.json";
const USAGE_SCHEMA_VERSION = 1;
/** One write per tool per process in this window; a chat that respawns never writes in a loop. */
const USE_WRITE_INTERVAL_MS = 10 * 60_000;

const lastWrittenAt = new Map<string, number>();
let writeChain: Promise<void> = Promise.resolve();

function usagePath(toolsRoot: string): string {
  return path.join(toolsRoot, USAGE_FILE);
}

/** Tool name -> epoch ms it last ran. Missing or unreadable reads as none. Sync: two small reads at most. */
export function readToolUsage(toolsRoot: string): Record<string, number> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(usagePath(toolsRoot), "utf8"));
  } catch {
    return {};
  }
  const tools = (raw as { tools?: unknown } | null)?.tools;
  const out: Record<string, number> = {};
  if (!tools || typeof tools !== "object" || Array.isArray(tools)) return out;
  for (const [name, at] of Object.entries(tools)) {
    if (typeof at === "number" && Number.isFinite(at) && /^[a-z0-9][a-z0-9._-]*$/.test(name)) out[name] = at;
  }
  return out;
}

/** Record that `name` runs now. Never throws, never blocks the caller. */
export function noteToolUse(name: string, toolsRoot: string, now = Date.now()): void {
  const key = `${toolsRoot}\0${name}`;
  const previous = lastWrittenAt.get(key);
  if (previous !== undefined && now - previous < USE_WRITE_INTERVAL_MS) return;
  lastWrittenAt.set(key, now);
  writeChain = writeChain.then(async () => {
    try {
      const usage = readToolUsage(toolsRoot);
      usage[name] = now;
      await fsp.mkdir(toolsRoot, { recursive: true });
      const target = usagePath(toolsRoot);
      const temp = `${target}.${process.pid}.${now}.tmp`;
      const sorted = Object.fromEntries(Object.entries(usage).sort(([left], [right]) => left.localeCompare(right)));
      await fsp.writeFile(temp, `${JSON.stringify({ schemaVersion: USAGE_SCHEMA_VERSION, tools: sorted }, null, 2)}\n`, "utf8");
      await fsp.rename(temp, target).catch(async (error) => {
        await fsp.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      });
    } catch (error) {
      // Best effort: a lost record only means the next use writes it.
      lastWrittenAt.delete(key);
      warnTools("tools.usage_write_failed", { tool: name, code: (error as NodeJS.ErrnoException | null)?.code ?? "unknown" });
    }
  });
}

/** The usage root for a tools context: its `toolsRoot` when given (tests), else this machine's (`toolUsageRoot`). */
export function toolUsageRootFor(context: { toolsRoot?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): string {
  if (context.toolsRoot) return path.resolve(context.toolsRoot);
  return toolUsageRoot(resolveToolsRootLayout(context.env ?? process.env, context.platform ?? process.platform));
}

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
