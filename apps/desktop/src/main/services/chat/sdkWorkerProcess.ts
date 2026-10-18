import { fork, spawn, type ChildProcess, type ForkOptions } from "node:child_process";

/**
 * The hidden `ade` commands that run an SDK worker inside the CLI itself
 * (`apps/ade-cli/src/cli.ts`). The standalone runtime is one Node SEA
 * executable: no `<name>SdkWorker.cjs` ships beside it, and `fork()` from it
 * re-enters the CLI instead of running a script, so a Copilot, Cursor, Droid or
 * Pi chat on that runtime starts its worker through these, like the PTY host and
 * the usage ledger worker already do.
 */
export const SDK_WORKER_COMMANDS = {
  copilot: "__ade-copilot-sdk-worker",
  cursor: "__ade-cursor-sdk-worker",
  droid: "__ade-droid-sdk-worker",
  pi: "__ade-pi-sdk-worker",
} as const;

export function isEmbeddedAdeRuntime(): boolean {
  const sea = process.getBuiltinModule?.("node:sea") as { isSea?: () => boolean } | undefined;
  return sea?.isSea?.() === true;
}

/**
 * Start an SDK worker with an IPC channel: fork its bundled script, or on the
 * standalone runtime run it through the executable's hidden command.
 */
export function startSdkWorker(args: {
  worker: keyof typeof SDK_WORKER_COMMANDS;
  workerPath: () => string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ChildProcess {
  const options = { cwd: args.cwd, env: args.env, stdio: ["ignore", "pipe", "pipe", "ipc"] as const, windowsHide: true };
  if (isEmbeddedAdeRuntime()) {
    return spawn(process.execPath, [SDK_WORKER_COMMANDS[args.worker], ...args.argv], { ...options, stdio: [...options.stdio] });
  }
  // fork() forwards its options to spawn(), which supports windowsHide, but
  // the installed @types/node ForkOptions declaration omits that property.
  return fork(args.workerPath(), args.argv, {
    ...options,
    stdio: [...options.stdio],
    execArgv: [],
  } as ForkOptions & { windowsHide: boolean });
}
