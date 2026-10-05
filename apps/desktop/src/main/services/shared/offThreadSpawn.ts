import { EventEmitter } from "node:events";
import { SHARE_ENV, Worker } from "node:worker_threads";
import { windowsTaskkillCommand } from "./processExecution";

/**
 * Spawn short-lived child processes from a worker thread.
 *
 * On Windows, `child_process.spawn` is not asynchronous where it matters:
 * libuv's `uv_spawn` calls `CreateProcess` on the calling thread, and process
 * creation there (image load, Defender's on-access scan, console setup) costs
 * 5 ms on a quiet machine and 100-1,000 ms on a busy one. A brain that runs
 * `git` for every lane, chat and PR pays that on its event loop. A CPU profile
 * of the installed brain on a Windows PC put 20 s of every 10 minutes inside
 * `spawn` under `runGitOnce`, in blocks of up to 1.3 s.
 *
 * Moving the `spawn` call to a worker takes `CreateProcess` off the event loop.
 * Measured on that PC, 60 `git status` calls at concurrency 6: the main loop's
 * longest block fell from 428-509 ms to 18-20 ms, and wall time did not grow.
 *
 * {@link spawnOffThread} returns a ChildProcess-shaped proxy so callers keep
 * their stream, timeout and cancel logic unchanged. It covers what capture-style
 * callers use: `pid`, `exitCode`, `signalCode`, `stdout`/`stderr` `data`,
 * `stdin.end(text)`, `kill()`, and the `spawn` / `error` / `close` events.
 * {@link terminateOffThreadChildTree} replaces `terminateProcessTree` for it.
 *
 * The worker is one per process, created on first use and unref'd so it never
 * keeps a process alive. If it dies, every child it was running reports a spawn
 * error, which is what callers already handle; nothing is retried, because a
 * command that may have half-run (a commit) must not run twice.
 */

type SpawnRequest = {
  type: "spawn";
  id: number;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin: string | null;
};

type WorkerMessage =
  | { type: "spawned"; id: number; pid: number | null }
  | { type: "stdout" | "stderr"; id: number; chunk: Uint8Array }
  | { type: "error"; id: number; code: string | null; message: string }
  | { type: "close"; id: number; code: number | null; signal: NodeJS.Signals | null };

export type OffThreadSpawnOptions = {
  cwd?: string;
  /** The child's full environment. Omit to inherit this process's. */
  env?: NodeJS.ProcessEnv;
};

class OffThreadStream extends EventEmitter {}

class OffThreadStdin extends EventEmitter {
  constructor(private readonly onEnd: (text: string) => void) {
    super();
  }

  end(text?: string): void {
    this.onEnd(text ?? "");
  }
}

export class OffThreadChild extends EventEmitter {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new OffThreadStream();
  readonly stderr = new OffThreadStream();
  readonly stdin: OffThreadStdin;
  /** Set once the worker has reported the process gone (or never started). */
  private finished = false;

  constructor(
    private readonly runner: OffThreadSpawner,
    readonly id: number,
    sendStdin: (text: string) => void,
  ) {
    super();
    this.stdin = new OffThreadStdin(sendStdin);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.finished) return false;
    return this.runner.post({ type: "kill", id: this.id, signal, tree: false });
  }

  /** @internal */
  handle(message: WorkerMessage): void {
    switch (message.type) {
      case "spawned":
        this.pid = message.pid ?? undefined;
        this.emit("spawn");
        return;
      case "stdout":
        this.stdout.emit("data", Buffer.from(message.chunk.buffer, message.chunk.byteOffset, message.chunk.byteLength));
        return;
      case "stderr":
        this.stderr.emit("data", Buffer.from(message.chunk.buffer, message.chunk.byteOffset, message.chunk.byteLength));
        return;
      case "error": {
        this.finished = true;
        const error = new Error(message.message) as NodeJS.ErrnoException;
        if (message.code) error.code = message.code;
        this.emit("error", error);
        return;
      }
      case "close":
        this.finished = true;
        this.exitCode = message.code;
        this.signalCode = message.signal;
        this.emit("exit", message.code, message.signal);
        this.emit("close", message.code, message.signal);
        return;
    }
  }

  /** @internal Tree kill, run in the worker against the live child. */
  killTree(signal: NodeJS.Signals): boolean {
    if (this.finished) return false;
    return this.runner.post({ type: "kill", id: this.id, signal, tree: true });
  }
}

/**
 * Worker body. Plain CommonJS so it runs from `eval` inside the bundled brain
 * and the Electron main process alike, with no file to ship next to the bundle.
 *
 * The tree kill mirrors `terminateProcessTree`'s Windows branch: refuse a child
 * that already reported exit (the PID-reuse guard), then run `taskkill /T /F`
 * to completion and `child.kill()` after it. Here the guard reads the real
 * ChildProcess, so it is exact rather than one message behind.
 */
const WORKER_SOURCE = String.raw`
  const { spawn, spawnSync } = require("node:child_process");
  const { parentPort, workerData } = require("node:worker_threads");
  const children = new Map();
  const toBytes = (data) => typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const post = (message) => {
    try { parentPort.postMessage(message); } catch {}
  };
  parentPort.on("message", (message) => {
    if (message.type === "spawn") {
      let child;
      try {
        child = spawn(message.command, message.args, {
          cwd: message.cwd,
          env: message.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        post({ type: "error", id: message.id, code: error && error.code ? String(error.code) : null, message: String(error && error.message || error) });
        return;
      }
      children.set(message.id, child);
      post({ type: "spawned", id: message.id, pid: typeof child.pid === "number" ? child.pid : null });
      child.stdin.on("error", () => {});
      if (message.stdin !== null) child.stdin.end(message.stdin);
      child.stdout.on("data", (data) => post({ type: "stdout", id: message.id, chunk: new Uint8Array(toBytes(data)) }));
      child.stderr.on("data", (data) => post({ type: "stderr", id: message.id, chunk: new Uint8Array(toBytes(data)) }));
      let failed = false;
      child.on("error", (error) => {
        failed = true;
        children.delete(message.id);
        post({ type: "error", id: message.id, code: error && error.code ? String(error.code) : null, message: String(error && error.message || error) });
      });
      child.on("close", (code, signal) => {
        children.delete(message.id);
        if (failed) return;
        post({ type: "close", id: message.id, code, signal });
      });
      return;
    }
    const child = children.get(message.id);
    if (!child) return;
    if (message.type === "stdin") {
      child.stdin.end(message.text);
      return;
    }
    if (message.type === "kill") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Synchronous on purpose, and before child.kill(): once the leader is
      // gone, taskkill /T can no longer find its descendants. Blocking is fine
      // here; this is the worker's thread, not the caller's event loop.
      if (message.tree && process.platform === "win32" && typeof child.pid === "number") {
        try {
          spawnSync(workerData.taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } catch {}
      }
      try { child.kill(message.signal); } catch {}
    }
  });
`;

type ControlMessage =
  | SpawnRequest
  | { type: "stdin"; id: number; text: string }
  | { type: "kill"; id: number; signal: NodeJS.Signals; tree: boolean };

class OffThreadSpawner {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly children = new Map<number, OffThreadChild>();

  spawn(command: string, args: readonly string[], options: OffThreadSpawnOptions): OffThreadChild {
    const id = this.nextId++;
    // Stdin written before the worker has the process is buffered here and
    // sent with the spawn request, so `spawn(); child.stdin.end(x)` keeps
    // working exactly as it does for a real ChildProcess.
    let pendingStdin: string | null = null;
    let requested = false;
    const child = new OffThreadChild(this, id, (text) => {
      if (!requested) pendingStdin = text;
      else this.post({ type: "stdin", id, text });
    });
    this.children.set(id, child);
    // Deferred one microtask, like a real spawn's events, so the caller can
    // attach listeners and write stdin first.
    queueMicrotask(() => {
      requested = true;
      const sent = this.post({
        type: "spawn",
        id,
        command,
        args: [...args],
        cwd: options.cwd,
        env: options.env,
        stdin: pendingStdin ?? "",
      });
      if (!sent) this.fail(id, "The off-thread spawner is unavailable.");
    });
    return child;
  }

  post(message: ControlMessage): boolean {
    const worker = this.ensureWorker();
    if (!worker) return false;
    try {
      worker.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        // The worker reads this process's live environment, so a caller that
        // passes no env gets exactly what a direct spawn would (including PATH
        // augmented after start-up) without cloning it into every request.
        env: SHARE_ENV,
        workerData: { taskkill: windowsTaskkillCommand() },
      });
    } catch {
      return null;
    }
    worker.unref();
    worker.on("message", (message: WorkerMessage) => {
      const child = this.children.get(message.id);
      if (!child) return;
      if (message.type === "error" || message.type === "close") this.children.delete(message.id);
      child.handle(message);
    });
    const onGone = (reason: string) => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const id of [...this.children.keys()]) this.fail(id, reason);
    };
    worker.on("error", (error) => onGone(`The off-thread spawner failed: ${error.message}`));
    worker.on("exit", (code) => onGone(`The off-thread spawner exited (code ${code}).`));
    this.worker = worker;
    return worker;
  }

  private fail(id: number, message: string): void {
    const child = this.children.get(id);
    if (!child) return;
    this.children.delete(id);
    child.handle({ type: "error", id, code: null, message });
  }
}

let spawner: OffThreadSpawner | null = null;

/** Whether this process moves capture-style spawns off its event loop. */
export function offThreadSpawnEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === "win32" && env.ADE_DISABLE_OFF_THREAD_SPAWN !== "1";
}

export function spawnOffThread(
  command: string,
  args: readonly string[],
  options: OffThreadSpawnOptions = {},
): OffThreadChild {
  spawner ??= new OffThreadSpawner();
  return spawner.spawn(command, args, options);
}

/** `terminateProcessTree` for an {@link OffThreadChild}; never blocks the caller. */
export function terminateOffThreadChildTree(child: OffThreadChild, signal: NodeJS.Signals = "SIGKILL"): boolean {
  return child.killTree(signal);
}
