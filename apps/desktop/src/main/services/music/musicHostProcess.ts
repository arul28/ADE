import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * The player host: a separate process that runs MusicKit JS in the OS web
 * engine and speaks newline-delimited JSON over stdio.
 *
 * Every platform implements the same `MusicHost`. Windows runs
 * `ade-music-host.exe` (WebView2, `native/ADEMusicHostWin`). macOS has no host
 * yet: `resolveMusicHostExecutable` returns null there and the Music tab says
 * Music on Mac is coming. A WKWebView helper only has to speak this protocol.
 *
 * Protocol (see `native/ADEMusicHostWin/page/player.js`):
 *   → {"rid":"r1","cmd":"<name>",...}         one line per command
 *   ← {"reply":"r1","ok":true,"result":...}   the answer
 *   ← {"event":"<name>",...}                  everything else
 *   → {"cmd":"quit"}                          close; EOF on stdin does the same
 */

export type MusicHostEvent = { event: string; [key: string]: unknown };

export type MusicHost = {
  readonly pid: number | null;
  /** Resolves on `hostReady`; rejects on `hostError` or an early exit. */
  ready: Promise<{ browserPid: number | null; origin: string | null }>;
  request: <T = unknown>(cmd: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  /** Write a host-level line (`show`/`hide`) without waiting for a reply. */
  send: (line: Record<string, unknown>) => void;
  onEvent: (cb: (event: MusicHostEvent) => void) => () => void;
  onExit: (cb: (info: { code: number | null; signal: string | null }) => void) => () => void;
  /** Quit cleanly, then kill the whole process tree if it has not left in time. */
  stop: (graceMs?: number) => Promise<void>;
};

export class MusicHostError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "MusicHostError";
    this.code = code;
  }
}

export function resolveMusicHostExecutable(input: {
  platform?: NodeJS.Platform;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  env?: NodeJS.ProcessEnv;
}): string | null {
  if ((input.platform ?? process.platform) !== "win32") return null;
  const override = (input.env ?? process.env).ADE_MUSIC_HOST_PATH?.trim();
  if (override && fs.existsSync(override)) return override;
  return input.isPackaged
    ? path.join(input.resourcesPath, "native", "ade-music-host", "ade-music-host.exe")
    : path.join(input.appPath, "resources", "native", "ade-music-host", "ade-music-host.exe");
}

/** Kill a process and everything under it. Windows only needs taskkill /T. */
function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      resolve();
    }
  });
}

export function startMusicHost(args: {
  executable: string;
  userDataDir: string;
  logger?: { info: (event: string, data?: Record<string, unknown>) => void; warn: (event: string, data?: Record<string, unknown>) => void };
  show?: boolean;
}): MusicHost {
  fs.mkdirSync(args.userDataDir, { recursive: true });
  const child: ChildProcessWithoutNullStreams = spawn(
    args.executable,
    [
      "--udf", args.userDataDir,
      "--page", path.join(path.dirname(args.executable), "page"),
      "--parent-pid", String(process.pid),
      ...(args.show ? ["--show"] : []),
      // The host runs without a GPU process (half the memory). Escape hatch if
      // some machine's DRM playback ever needs it.
      ...(process.env.ADE_MUSIC_HOST_GPU === "1" ? ["--gpu"] : []),
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const eventListeners = new Set<(event: MusicHostEvent) => void>();
  const exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let seq = 0;
  let exited = false;
  let exitPromiseResolve: () => void = () => {};
  const exitPromise = new Promise<void>((resolve) => {
    exitPromiseResolve = resolve;
  });

  let readyResolve!: (v: { browserPid: number | null; origin: string | null }) => void;
  let readyReject!: (e: Error) => void;
  const ready = new Promise<{ browserPid: number | null; origin: string | null }>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {});

  child.stdin.on("error", () => {
    // EPIPE after the host exits; the exit handler reports it.
  });

  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const rid = typeof message.reply === "string" ? message.reply : null;
    if (rid && pending.has(rid)) {
      const entry = pending.get(rid)!;
      pending.delete(rid);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new MusicHostError(String(message.error ?? "failed"), String(message.error ?? "failed")));
      return;
    }
    if (typeof message.event !== "string") return;
    if (message.event === "hostReady") {
      readyResolve({
        browserPid: typeof message.browserPid === "number" ? message.browserPid : null,
        origin: typeof message.origin === "string" ? message.origin : null,
      });
    } else if (message.event === "hostError" && message.code !== "process_failed" && message.code !== "popup_failed") {
      readyReject(new MusicHostError(String(message.error ?? "The music player failed to start."), String(message.code ?? "host_error")));
    }
    for (const cb of eventListeners) cb(message as MusicHostEvent);
  });

  // The host's stderr is a human log without tokens. Keep the tail for errors.
  const stderrTail: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => {
    stderrTail.push(line);
    if (stderrTail.length > 20) stderrTail.shift();
  });

  const onGone = (code: number | null, signal: string | null) => {
    if (exited) return;
    exited = true;
    exitPromiseResolve();
    readyReject(new MusicHostError("The music player exited before it was ready.", "exited"));
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new MusicHostError("The music player closed.", "exited"));
    }
    pending.clear();
    if (code !== 0) args.logger?.warn("music.host_exit", { code, signal, log: stderrTail.slice(-6) });
    for (const cb of exitListeners) cb({ code, signal });
  };
  child.on("exit", onGone);
  child.on("error", (error) => {
    readyReject(new MusicHostError(`The music player could not start: ${error.message}`, "spawn_failed"));
    onGone(null, null);
  });

  const write = (line: Record<string, unknown>) => {
    if (exited || !child.stdin.writable) return false;
    child.stdin.write(`${JSON.stringify(line)}\n`);
    return true;
  };

  return {
    get pid() {
      return child.pid ?? null;
    },
    ready,
    request: <T>(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30_000) =>
      new Promise<T>((resolve, reject) => {
        const rid = `r${++seq}`;
        const timer = setTimeout(() => {
          pending.delete(rid);
          reject(new MusicHostError(`The music player did not answer "${cmd}".`, "timeout"));
        }, timeoutMs);
        pending.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer });
        if (!write({ ...params, cmd, rid })) {
          clearTimeout(timer);
          pending.delete(rid);
          reject(new MusicHostError("The music player is not running.", "exited"));
        }
      }),
    send: (line) => {
      write(line);
    },
    onEvent: (cb) => {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    stop: async (graceMs = 4_000) => {
      if (exited) return;
      write({ cmd: "quit" });
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      const timedOut = await Promise.race([
        exitPromise.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs)),
      ]);
      if (timedOut && child.pid) {
        args.logger?.warn("music.host_kill_tree", { pid: child.pid });
        await killTree(child.pid);
      }
    },
  };
}
