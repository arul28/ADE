import childProcess from "node:child_process";
import path from "node:path";
import { resolveCliSpawnInvocation } from "../shared/processExecution";

let patched = false;

/**
 * Every shape `droid` can be installed as on Windows, not just the native
 * binary. `npm i -g @factory/droid` drops `droid`, `droid.cmd` and `droid.ps1`
 * side by side, and a machine with no `droid.exe` resolves to one of the shims —
 * which used to slip past this matcher and lose the `windowsHide` patch below,
 * leaving the persistent Windows Terminal window it exists to prevent.
 */
function isDroidExecutable(command: unknown): boolean {
  if (typeof command !== "string" || !command.length) return false;
  const base = path.win32.basename(command).toLowerCase();
  return base === "droid"
    || base === "droid.exe"
    || base === "droid.cmd"
    || base === "droid.bat"
    || base === "droid.ps1";
}

/**
 * Force `windowsHide` on the `droid` child process, and make a shim spawnable.
 *
 * @factory/droid-sdk's `ProcessTransport.connect()` spawns the CLI with only
 * `{ stdio, cwd, env }` — no `windowsHide`, no `shell` — and exposes no way to
 * pass spawn options through `createSession()`. Two Windows failures follow.
 *
 * 1. A console is allocated for `droid.exe`, and with Windows Terminal as the
 *    default console host it surfaces as a *visible* window titled with the
 *    droid path that lives as long as the session, not a brief flash.
 *
 *    Verified against droid v0.186.0 spawned from a CREATE_NO_WINDOW parent:
 *      without windowsHide -> conhost child + visible WindowsTerminal window
 *                             titled "C:/Users/arul2/bin/droid.exe"
 *      with    windowsHide -> hidden console, no visible window
 *
 * 2. When the install is a `.cmd`/`.bat` shim rather than a real binary, the
 *    shell-less spawn is rejected outright. Node has refused bare shim spawns
 *    since CVE-2024-27980; measured here the session died immediately with
 *    `Error: spawn …\droid.cmd EINVAL errno:-4071`. Rewriting the call through
 *    `resolveCliSpawnInvocation` turns it into the `cmd.exe /d /s /c "…"` (or
 *    `powershell.exe -File` for `.ps1`) form ADE's own PTY launches already use,
 *    which spawns cleanly. Only flags and a session id travel in that argv —
 *    user prompt text goes over the SDK's stdio transport, never the command
 *    line — so the cmd rewriting hazards do not apply here.
 *
 * The match is on the executable basename so no other spawn site in the process
 * can be affected, and an explicit `windowsHide` from a caller always wins.
 */
export function ensureDroidSpawnsAreWindowless(): void {
  if (patched || process.platform !== "win32") return;
  patched = true;

  const originalSpawn = childProcess.spawn;
  const patchedSpawn = function spawn(this: unknown, ...args: unknown[]): unknown {
    if (!isDroidExecutable(args[0])) {
      return (originalSpawn as (...callArgs: unknown[]) => unknown).apply(this, args);
    }
    // `spawn` accepts (command), (command, options), (command, args) and
    // (command, args, options). Normalize to the full triple once so the
    // rewrite below never has to track which overload the SDK used.
    const spawnArgs = Array.isArray(args[1])
      ? args[1].filter((value): value is string => typeof value === "string")
      : [];
    const optionsIndex = args.length >= 2 && typeof args[1] === "object" && !Array.isArray(args[1])
      ? 1
      : args.length >= 3 && typeof args[2] === "object"
        ? 2
        : -1;
    const options = optionsIndex === -1 ? null : args[optionsIndex] as Record<string, unknown> | null;
    const invocation = resolveCliSpawnInvocation(args[0] as string, spawnArgs);
    return (originalSpawn as (...callArgs: unknown[]) => unknown).apply(this, [
      invocation.command,
      invocation.args,
      {
        ...(options ?? {}),
        ...(options?.windowsHide === undefined ? { windowsHide: true } : {}),
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
    ]);
  };

  (childProcess as { spawn: unknown }).spawn = patchedSpawn;
}

/** Test seam: restore the unpatched spawn. */
export function resetDroidSpawnPatchForTests(original?: typeof childProcess.spawn): void {
  if (original) (childProcess as { spawn: typeof childProcess.spawn }).spawn = original;
  patched = false;
}
