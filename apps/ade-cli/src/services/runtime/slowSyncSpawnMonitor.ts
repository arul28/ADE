import childProcess from "node:child_process";
import path from "node:path";

/**
 * Names the synchronous child processes that freeze the brain.
 *
 * Most of the brain's event-loop near misses spend almost no CPU: the main
 * thread is waiting, not working. The usual cause is a synchronous spawn
 * (`execFileSync`, `spawnSync`, `execSync`): on Windows each PowerShell start
 * alone costs 0.2-2 s, more under Defender. The watchdog reports such a freeze
 * only after it ends, and names a command only when an RPC was running, so
 * background work reads as "idle". This wraps the three calls once, at brain
 * start, and logs any that ran longer than a second with the program and the
 * code that called it.
 *
 * Nothing is captured for a fast call: the clock is read before and after, and
 * the stack is taken only when the call was slow, still inside the wrapper, so
 * it names the caller. One line per program and caller every ten
 * minutes, with a count of the slow calls in between.
 */

export const SLOW_SYNC_SPAWN_MS = 1_000;
const REPEAT_INTERVAL_MS = 10 * 60_000;
const MAX_TRACKED_SITES = 200;
const STACK_FRAMES = 6;

type Warn = (event: string, meta: Record<string, unknown>) => void;
type SyncSpawnName = "execFileSync" | "spawnSync" | "execSync";

type SiteState = { lastLoggedAt: number; slowSinceLog: number; maxMsSinceLog: number };

let installed = false;

/** The program alone: arguments can carry tokens, and the caller already says what it was for. */
function programName(name: SyncSpawnName, args: unknown[]): string {
  const command = typeof args[0] === "string" ? args[0] : "";
  // `execSync` takes a whole shell line; its first word is the program.
  const program = name === "execSync" ? command.trim().split(/\s+/)[0] ?? "" : command;
  return path.basename(program.replace(/^"|"$/g, "")) || "unknown";
}

/** The caller's frames, without this wrapper's own. */
function callerFrames(stack: string | undefined): string[] {
  return (stack ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim().replace(/^at\s+/, ""))
    .filter((line) => line && !line.includes("slowSyncSpawnMonitor"))
    .slice(0, STACK_FRAMES);
}

function timedOut(name: SyncSpawnName, result: unknown, thrown: unknown): boolean {
  const error = name === "spawnSync" ? (result as { error?: unknown } | undefined)?.error : thrown;
  return (error as { code?: unknown } | undefined)?.code === "ETIMEDOUT";
}

export function installSlowSyncSpawnMonitor(args: { warn: Warn; now?: () => number }): void {
  if (installed) return;
  installed = true;
  const now = args.now ?? Date.now;
  const sites = new Map<string, SiteState>();

  const report = (
    name: SyncSpawnName,
    callArgs: unknown[],
    durationMs: number,
    wasTimedOut: boolean,
    stack: string | undefined,
  ): void => {
    const frames = callerFrames(stack);
    const program = programName(name, callArgs);
    const key = `${program}\u0000${frames[0] ?? ""}`;
    const at = now();
    let site = sites.get(key);
    if (!site) {
      if (sites.size >= MAX_TRACKED_SITES) sites.clear();
      site = { lastLoggedAt: 0, slowSinceLog: 0, maxMsSinceLog: 0 };
      sites.set(key, site);
    }
    site.slowSinceLog += 1;
    site.maxMsSinceLog = Math.max(site.maxMsSinceLog, durationMs);
    if (site.lastLoggedAt > 0 && at - site.lastLoggedAt < REPEAT_INTERVAL_MS) return;
    args.warn("brain.slow_sync_spawn", {
      call: name,
      program,
      durationMs,
      timedOut: wasTimedOut,
      // Slow calls from this site since its last line, this one included.
      occurrences: site.slowSinceLog,
      maxMs: site.maxMsSinceLog,
      caller: frames,
    });
    site.lastLoggedAt = at;
    site.slowSinceLog = 0;
    site.maxMsSinceLog = 0;
  };

  const wrap = (name: SyncSpawnName): void => {
    const original = childProcess[name] as (...callArgs: unknown[]) => unknown;
    const wrapped = function slowSyncSpawnMonitor(this: unknown, ...callArgs: unknown[]): unknown {
      const startedAt = performance.now();
      let result: unknown;
      let thrown: unknown;
      try {
        result = original.apply(this, callArgs);
        return result;
      } catch (error) {
        thrown = error;
        throw error;
      } finally {
        const durationMs = Math.round(performance.now() - startedAt);
        if (durationMs >= SLOW_SYNC_SPAWN_MS) {
          try {
            // Taken here, so the frames below the wrapper are the caller's.
            report(name, callArgs, durationMs, timedOut(name, result, thrown), new Error().stack);
          } catch {
            // A diagnostic must never change what the call returned or threw.
          }
        }
      }
    };
    (childProcess as unknown as Record<SyncSpawnName, unknown>)[name] = wrapped;
  };

  wrap("execFileSync");
  wrap("spawnSync");
  wrap("execSync");
}
