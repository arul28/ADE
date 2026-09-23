/**
 * Process-level guards for the Cursor SDK worker.
 *
 * The worker is a forked child of the brain. When the brain dies without
 * unwinding (its loop watchdog SIGKILLs it), the worker loses its IPC channel
 * and its stdio pipes. Before these guards, the next `process.send` raised
 * ERR_IPC_CHANNEL_CLOSED as an uncaught exception, the exception handler sent
 * again, and the worker looped at 100% CPU. That loop starved the microtask
 * queue, so every exit path that waited on a promise hung, SIGTERM included.
 *
 * The helpers take the process as an argument so tests can drive them with a
 * fake. The worker passes the real `process`.
 */

/**
 * The argv marker that names the brain which forked a worker.
 *
 * It sits in argv, not the env, so `ps` on macOS/Linux and the CIM command line
 * on Windows show it without reading another process's environment. The orphan
 * sweep in `cursorSdkWorkerOrphans.ts` reads it back.
 */
export const CURSOR_SDK_OWNER_PID_ARG = "--ade-owner-pid=";

/**
 * How long any exit path may take before the worker exits anyway.
 *
 * A timer, because timers still fire when a starved microtask queue keeps
 * every promise from settling.
 */
export const CURSOR_SDK_WORKER_EXIT_DEADLINE_MS = 2_000;

/** How often the worker checks that its owner is still there. */
export const CURSOR_SDK_OWNER_POLL_MS = 2_000;

export function cursorSdkOwnerPidArg(pid: number): string {
  return `${CURSOR_SDK_OWNER_PID_ARG}${pid}`;
}

/** Parses the owner pid from argv tokens or a whole command line. */
export function readCursorSdkOwnerPid(source: readonly string[] | string): number | null {
  const text = typeof source === "string" ? source : source.join(" ");
  // Strict digits, like `readEmbeddedParentPid`: a malformed value must not
  // resolve to some unrelated live pid.
  const match = text.match(new RegExp(`${CURSOR_SDK_OWNER_PID_ARG}(\\d+)(?![\\w.])`));
  if (!match) return null;
  const pid = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

type IpcProcessLike = {
  readonly connected?: boolean;
  send?: (
    message: unknown,
    sendHandle?: undefined,
    options?: undefined,
    callback?: (error: Error | null) => void,
  ) => boolean;
};

/**
 * Sends one message to the parent, or drops it when the channel is gone.
 *
 * A closed channel never throws and never becomes a process `'error'` event.
 * Any other throw reaches the caller: a message that cannot be serialized
 * (a circular value, a BigInt) must fail the request that sent it, or the
 * pool waits for a reply that never comes. Returns true only when the message
 * was handed to the channel.
 */
export function sendToCursorSdkParent(proc: IpcProcessLike, message: unknown): boolean {
  if (typeof proc.send !== "function" || !proc.connected) return false;
  try {
    // With a callback, a send that fails after the check above (the channel
    // closed mid-flight) reports here instead of emitting `'error'`.
    return proc.send(message, undefined, undefined, () => {});
  } catch (error) {
    if (!proc.connected) return false;
    throw error;
  }
}

type ErrorEmitterLike = {
  on(event: "error", listener: (error: Error) => void): unknown;
};

/**
 * Swallows `'error'` on the process and on its stdio streams.
 *
 * After the parent dies, a write to the stderr pipe raises EPIPE as a stream
 * `'error'`. With no listener that is an uncaught exception, and the handler
 * for it logs, so it writes again. Nothing useful can be done with these
 * errors: the only reader is gone.
 */
export function ignoreCursorSdkWorkerPipeErrors(
  proc: ErrorEmitterLike,
  streams: ReadonlyArray<ErrorEmitterLike | null | undefined>,
): void {
  proc.on("error", () => {});
  for (const stream of streams) {
    stream?.on("error", () => {});
  }
}

type TimerLike = { unref?: () => unknown };

/**
 * Builds the single exit path every trigger in the worker goes through.
 *
 * The first call wins. It arms a hard deadline before it starts `dispose`, so
 * a dispose that never settles cannot keep the worker alive.
 */
export function createCursorSdkWorkerExit(args: {
  dispose: () => Promise<void>;
  exit: (code: number) => void;
  deadlineMs?: number;
  setTimer?: (callback: () => void, ms: number) => TimerLike;
}): (code: number) => void {
  const setTimer = args.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  let exiting = false;
  return (code: number) => {
    if (exiting) return;
    exiting = true;
    // Unref: when nothing else holds the loop open, the worker ends on its own
    // and the deadline does not have to wait.
    setTimer(() => args.exit(code), args.deadlineMs ?? CURSOR_SDK_WORKER_EXIT_DEADLINE_MS).unref?.();
    void Promise.resolve()
      .then(args.dispose)
      .catch(() => {})
      .finally(() => args.exit(code));
  };
}

/**
 * Whether the brain that forked this worker is still its owner.
 *
 * A closed IPC channel is decisive: no one can send the worker work again. The
 * pid probe covers a parent that died without closing the channel cleanly. On
 * POSIX an orphan is reparented, so a changed ppid also means the owner is
 * gone, even if its pid was already reused. Windows keeps the original ppid, so
 * the check does not apply there.
 */
export function cursorSdkOwnerStillOwns(args: {
  ownerPid: number;
  proc: { readonly connected?: boolean; readonly ppid: number };
  platform: NodeJS.Platform;
  isAlive: (pid: number) => boolean;
}): boolean {
  if (args.proc.connected === false) return false;
  if (args.platform !== "win32" && args.proc.ppid !== args.ownerPid) return false;
  return args.isAlive(args.ownerPid);
}
