import childProcess from "node:child_process";
import path from "node:path";

let patched = false;

function isDroidExecutable(command: unknown): boolean {
  if (typeof command !== "string" || !command.length) return false;
  const base = path.win32.basename(command).toLowerCase();
  return base === "droid" || base === "droid.exe";
}

/**
 * Force `windowsHide` on the `droid` child process.
 *
 * @factory/droid-sdk's `ProcessTransport.connect()` spawns the CLI with only
 * `{ stdio, cwd, env }` — no `windowsHide` — and exposes no way to pass spawn
 * options through `createSession()`. On Windows that means a console is
 * allocated for `droid.exe`, and with Windows Terminal as the default console
 * host it surfaces as a *visible* window titled with the droid path that lives
 * as long as the session, not a brief flash.
 *
 * Verified against droid v0.186.0 spawned from a CREATE_NO_WINDOW parent:
 *   without windowsHide -> conhost child + visible WindowsTerminal window
 *                          titled "C:/Users/arul2/bin/droid.exe"
 *   with    windowsHide -> hidden console, no visible window
 *
 * The match is on the executable basename so no other spawn site in the process
 * can be affected, and an explicit `windowsHide` from a caller always wins.
 */
export function ensureDroidSpawnsAreWindowless(): void {
  if (patched || process.platform !== "win32") return;
  patched = true;

  const originalSpawn = childProcess.spawn;
  const patchedSpawn = function spawn(this: unknown, ...args: unknown[]): unknown {
    if (isDroidExecutable(args[0])) {
      const optionsIndex = args.length >= 2 && typeof args[1] === "object" && !Array.isArray(args[1])
        ? 1
        : args.length >= 3 && typeof args[2] === "object"
          ? 2
          : -1;
      if (optionsIndex === -1) {
        args.push({ windowsHide: true });
      } else {
        const options = args[optionsIndex] as Record<string, unknown> | null;
        if (options && options.windowsHide === undefined) {
          args[optionsIndex] = { ...options, windowsHide: true };
        } else if (!options) {
          args[optionsIndex] = { windowsHide: true };
        }
      }
    }
    return (originalSpawn as (...callArgs: unknown[]) => unknown).apply(this, args);
  };

  (childProcess as { spawn: unknown }).spawn = patchedSpawn;
}

/** Test seam: restore the unpatched spawn. */
export function resetDroidSpawnPatchForTests(original?: typeof childProcess.spawn): void {
  if (original) (childProcess as { spawn: typeof childProcess.spawn }).spawn = original;
  patched = false;
}
