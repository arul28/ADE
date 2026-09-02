import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireCursorSdkConnection,
  buildCursorSdkPaths,
  CURSOR_SDK_LOCAL_ONESHOT_MAX_WORKERS,
  CURSOR_SDK_ONESHOT_AGENT_NAME,
  buildCursorSdkWorkerEnv,
  cleanupCursorSdkRuntimePaths,
  CURSOR_SDK_REPLACE_WAIT_MS,
  isCursorSdkPooledAlive,
  MAX_CURSOR_SDK_SOCKET_PATH_BYTES,
  poisonCursorSdkConnection,
  releaseCursorSdkConnection,
  runCursorSdkLocalPrompt,
  releaseCursorSdkConnectionAfterIdle,
  resolveCursorSdkUserHome,
} from "./cursorSdkPool";
import { CURSOR_SDK_ONESHOT_POLICY } from "./cursorSdkPolicy";
import { buildPackagedRuntimeNodeModulePaths } from "../runtime/packagedNodePath";

const forkMock = vi.hoisted(() => vi.fn());

/** The guarded agent-mode policy every pool test acquires with. */
const TEST_POLICY = {
  chatMode: "agent",
  approvalPolicy: "on-request",
  sandbox: "ade",
  fullAuto: false,
  hardGuards: true,
  orchestrationLead: false,
  autoReview: true,
} as const;
const tempDirs: string[] = [];

vi.mock("node:child_process", () => ({
  fork: (...args: unknown[]) => forkMock(...args),
}));

class FakeSdkChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  exitCode: number | null = null;
  killed = false;
  connected = true;
  disposeCount = 0;
  sent: unknown[] = [];
  private exited = false;

  send(message: { type?: string; requestId?: string; payload?: unknown }): boolean {
    this.sent.push(message);
    if (message.type === "init" && message.requestId) {
      queueMicrotask(() => {
        this.emit("message", {
          type: "response",
          requestId: message.requestId,
          ok: true,
          result: { agentId: "agent-1" },
        });
      });
    }
    if (message.type === "send" && message.requestId) {
      queueMicrotask(() => {
        this.emit("message", {
          type: "response",
          requestId: message.requestId,
          ok: true,
          result: {},
        });
      });
    }
    if (message.type === "dispose") {
      this.disposeCount += 1;
      queueMicrotask(() => this.finishExit(0, null));
    }
    return true;
  }

  finishExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.connected = false;
    this.emit("exit", code, signal);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.finishExit(null, signal ?? "SIGTERM");
    return true;
  }
}

class DelayedExitChild extends FakeSdkChild {
  override send(message: { type?: string; requestId?: string }): boolean {
    if (message.type === "init" && message.requestId) {
      queueMicrotask(() => {
        this.emit("message", {
          type: "response",
          requestId: message.requestId,
          ok: true,
          result: { agentId: "agent-1" },
        });
      });
    }
    if (message.type === "dispose") {
      this.disposeCount += 1;
    }
    return true;
  }
}

/** Dispose/kill never reaps the pid — the replace wait must not fork over it. */
class StuckExitChild extends DelayedExitChild {
  override kill(): boolean {
    this.killed = true;
    return true;
  }
}

/**
 * The worker the replace wait actually exists for: wedged on an expired token
 * or a poisoned agent thread, so it answers neither the IPC `dispose` nor the
 * SIGTERM and only dies once the escalation SIGKILLs it.
 */
class WedgedWorkerChild extends DelayedExitChild {
  override kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    if (signal === "SIGKILL") this.finishExit(null, "SIGKILL");
    return true;
  }
}

class ExitingBeforeInitChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  connected = true;

  send(message: { type?: string; requestId?: string }): boolean {
    if (message.type === "init") {
      queueMicrotask(() => {
        this.exitCode = 1;
        this.connected = false;
        this.emit("exit", 1, null);
      });
      return true;
    }
    if (message.type === "dispose") {
      throw Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" });
    }
    return true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  }
}

class ExitingWithStderrBeforeInitChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  connected = true;

  send(message: { type?: string }): boolean {
    if (message.type === "init") {
      queueMicrotask(() => {
        this.stderr.emit(
          "data",
          [
            "ConnectError: [internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
            "  rawMessage: 'Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM'",
            "Node.js v26.0.0",
          ].join("\n"),
        );
        this.exitCode = 1;
        this.connected = false;
        this.emit("exit", 1, null);
      });
      return true;
    }
    return true;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.emit("exit", null, signal ?? "SIGTERM");
    return true;
  }
}

/** Init itself is rejected — the fork happened, so its socket directory exists. */
class FailingInitChild extends FakeSdkChild {
  override send(message: { type?: string; requestId?: string }): boolean {
    if (message.type === "init" && message.requestId) {
      queueMicrotask(() => {
        this.emit("message", {
          type: "response",
          requestId: message.requestId,
          ok: false,
          error: "Cursor SDK init failed: listen EINVAL: invalid argument (code=EINVAL)",
        });
      });
      return true;
    }
    return super.send(message);
  }
}

class FailingSendChild extends FakeSdkChild {
  override send(message: { type?: string; requestId?: string }): boolean {
    if (message.type === "send" && message.requestId) {
      queueMicrotask(() => {
        this.emit("message", {
          type: "response",
          requestId: message.requestId,
          ok: false,
          error: "Cursor rate limited this request: [resource_exhausted] Error",
          errorCode: "rate_limited",
          errorDetail: {
            message: "[resource_exhausted] Error",
            code: "resource_exhausted",
            status: 429,
            requestId: "req-cursor-1",
            operation: "Agent.send",
            endpoint: "/agent/send",
            isRetryable: true,
          },
        });
      });
      return true;
    }
    return super.send(message);
  }
}

/** Answers `send` with a terminal run result instead of an empty object. */
class OneShotSdkChild extends FakeSdkChild {
  constructor(private readonly runResult: unknown = { status: "finished", result: " named it " }) {
    super();
  }

  override send(message: { type?: string; requestId?: string; payload?: unknown }): boolean {
    if (message.type === "send" && message.requestId) {
      this.sent.push(message);
      const requestId = message.requestId;
      queueMicrotask(() => {
        this.emit("message", { type: "response", requestId, ok: true, result: this.runResult });
      });
      return true;
    }
    return super.send(message);
  }
}

/** Never answers `send`, so the one-shot deadline is the only way out. */
class StalledSendChild extends FakeSdkChild {
  cancelCount = 0;

  override send(message: { type?: string; requestId?: string }): boolean {
    if (message.type === "send") {
      this.sent.push(message);
      return true;
    }
    if (message.type === "cancel" && message.requestId) {
      this.cancelCount += 1;
      const requestId = message.requestId;
      queueMicrotask(() => {
        this.emit("message", { type: "response", requestId, ok: true, result: null });
      });
      return true;
    }
    return super.send(message);
  }
}

/** Reports how many `send` requests were in flight at the same moment. */
class OverlapCountingChild extends FakeSdkChild {
  inFlight = 0;
  maxInFlight = 0;

  override send(message: { type?: string; requestId?: string }): boolean {
    if (message.type === "send" && message.requestId) {
      this.sent.push(message);
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      const requestId = message.requestId;
      setTimeout(() => {
        this.inFlight -= 1;
        this.emit("message", {
          type: "response",
          requestId,
          ok: true,
          result: { status: "finished", result: "done" },
        });
      }, 20).unref?.();
      return true;
    }
    return super.send(message);
  }
}

function sentMessagesOfType(
  child: FakeSdkChild,
  type: string,
): Array<{ type?: string; payload?: Record<string, unknown> }> {
  return child.sent.filter((message): message is { type?: string; payload?: Record<string, unknown> } => (
    Boolean(message && typeof message === "object" && (message as { type?: string }).type === type)
  ));
}

/** Answers `send` with a rejection, the way a worker reports its own fault. */
class RejectingSendChild extends FakeSdkChild {
  override send(message: { type?: string; requestId?: string }): boolean {
    if (message.type === "send" && message.requestId) {
      this.sent.push(message);
      const requestId = message.requestId;
      queueMicrotask(() => {
        this.emit("message", {
          type: "response",
          requestId,
          ok: false,
          error: "Cursor SDK worker is not initialized.",
        });
      });
      return true;
    }
    return super.send(message);
  }
}

function oneShotArgs(workspacePath: string) {
  return {
    projectRoot: path.join(os.tmpdir(), "ade-project"),
    workspacePath,
    apiKey: "cursor-test-key",
    modelSdkId: "grok-4.6",
    promptText: "Name this chat.",
    feature: "session_title",
    timeoutMs: 5_000,
  };
}

afterEach(() => {
  forkMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function forkedSocketPath(callIndex: number): string | undefined {
  const options = forkMock.mock.calls[callIndex]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
  return options?.env?.ADE_CURSOR_SDK_SOCKET;
}

describe("Cursor SDK pool paths", () => {
  it("uses the real user home while keeping ADE runtime state under the project cache", () => {
    const projectRoot = path.join(os.tmpdir(), "ade-project");
    const userHomeDir = path.join(os.tmpdir(), "real-home");
    const paths = buildCursorSdkPaths({
      projectRoot,
      poolKey: "lane:/repo:session",
      instanceId: "worker-a",
      userHomeDir,
    });

    expect(paths.userHomeDir).toBe(userHomeDir);
    expect(paths.cacheRoot).toContain(path.join(projectRoot, ".ade", "cache", "cursor-sdk"));
    expect(paths.stateRoot).toBe(path.join(paths.cacheRoot, "state"));
    if (process.platform === "win32") {
      expect(paths.socketPath).toContain("\\\\.\\pipe\\ade-cursor-sdk-");
    } else {
      expect(paths.socketPath).toContain(`ade-cursor-sdk-${process.getuid?.() ?? ""}`);
      expect(path.basename(paths.socketPath)).toBe("hook.sock");
    }
  });

  it("gives each worker instance its own hook socket while sharing the pool state root", () => {
    const projectRoot = path.join(os.tmpdir(), "ade-project");
    const args = {
      projectRoot,
      poolKey: "lane:/repo:session",
      userHomeDir: path.join(os.tmpdir(), "real-home"),
    };
    const first = buildCursorSdkPaths({ ...args, instanceId: "worker-a" });
    const second = buildCursorSdkPaths({ ...args, instanceId: "worker-b" });
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(first.stateRoot).toBe(second.stateRoot);
    if (process.platform === "win32") {
      expect(first.socketPath.startsWith("\\\\.\\pipe\\ade-cursor-sdk-")).toBe(true);
      expect(second.socketPath.startsWith("\\\\.\\pipe\\ade-cursor-sdk-")).toBe(true);
    } else {
      expect(path.dirname(first.socketPath)).not.toBe(path.dirname(second.socketPath));
      expect(path.basename(first.socketPath)).toBe("hook.sock");
    }
  });

  it("retries one-shot SDK state removal until the worker releases its handles", async () => {
    // Cleanup runs while the worker is still shutting down. On Windows the
    // SDK's open `state/index.db` makes the first `rmSync` fail with EBUSY and
    // the state directory is leaked; POSIX unlinks it on the first try.
    const cacheRoot = makeTempDir("ade-cursor-cleanup-");
    const stateRoot = path.join(cacheRoot, "state");
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "index.db"), "held");

    const realRm = fs.rmSync;
    let busyAttempts = 2;
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(((target: fs.PathLike, options?: fs.RmOptions) => {
      if (busyAttempts > 0) {
        busyAttempts -= 1;
        const error = new Error(`EBUSY: resource busy or locked, rmdir '${String(target)}'`) as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return realRm(target, options);
    }) as typeof fs.rmSync);

    try {
      cleanupCursorSdkRuntimePaths({ cacheRoot, stateRoot, cleanupStateRoot: true });
      const deadline = Date.now() + 5_000;
      while (fs.existsSync(cacheRoot) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(busyAttempts).toBe(0);
      expect(fs.existsSync(cacheRoot)).toBe(false);
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("leaves SDK state alone when cleanup was not requested", () => {
    const cacheRoot = makeTempDir("ade-cursor-keep-");
    const stateRoot = path.join(cacheRoot, "state");
    fs.mkdirSync(stateRoot, { recursive: true });
    cleanupCursorSdkRuntimePaths({ cacheRoot, stateRoot, cleanupStateRoot: false });
    expect(fs.existsSync(stateRoot)).toBe(true);
  });

  it("keeps durable SDK state stable while pool-specific socket paths change", () => {
    const projectRoot = path.join(os.tmpdir(), "ade-project");
    const first = buildCursorSdkPaths({
      projectRoot,
      poolKey: "session-1:composer-2.5:full-auto",
      instanceId: "shared",
      stateKey: "session-1:lane-1:state",
    });
    const second = buildCursorSdkPaths({
      projectRoot,
      poolKey: "session-1:claude-sonnet-5:edit",
      instanceId: "shared",
      stateKey: "session-1:lane-1:state",
    });

    expect(second.stateRoot).toBe(first.stateRoot);
    expect(second.cacheRoot).toBe(first.cacheRoot);
    expect(second.socketPath).not.toBe(first.socketPath);
  });

  it("gives each worker instance its own hook socket while keeping durable state stable", () => {
    const projectRoot = path.join(os.tmpdir(), "ade-project");
    const shared = {
      projectRoot,
      poolKey: "session-1:composer-2.5:full-auto",
      stateKey: "session-1:lane-1:state",
    };
    const first = buildCursorSdkPaths({ ...shared, instanceId: "worker-a" });
    const second = buildCursorSdkPaths({ ...shared, instanceId: "worker-b" });

    expect(second.stateRoot).toBe(first.stateRoot);
    expect(second.cacheRoot).toBe(first.cacheRoot);
    expect(second.socketPath).not.toBe(first.socketPath);
    if (process.platform !== "win32") {
      expect(path.basename(first.socketPath)).toBe("hook.sock");
      expect(path.basename(second.socketPath)).toBe("hook.sock");
      expect(path.dirname(second.socketPath)).not.toBe(path.dirname(first.socketPath));
    }
  });

  it.skipIf(process.platform === "win32")("keeps the hook socket path inside the POSIX sun_path budget", () => {
    // A real bind() on macOS fails with EINVAL past 104 bytes, and the default
    // tmpdir (`/var/folders/<2>/<30>/T`) already spends 48 of them. Real keys:
    // the pool key carries a lane path and the instance id is a UUID.
    const paths = buildCursorSdkPaths({
      projectRoot: path.join(os.homedir(), "Projects", "ADE", ".ade", "worktrees", "some-long-lane-name-41540d5a"),
      poolKey: "session-1e3fdc51-a1f9-4eda-9045-62646f3f4fb9:composer-grok-4.6:full-auto",
      instanceId: "a4f1c0de-7b52-4a1e-9c33-8d2b6e5f0a17",
    });

    expect(Buffer.byteLength(paths.socketPath, "utf8")).toBeLessThanOrEqual(MAX_CURSOR_SDK_SOCKET_PATH_BYTES);
    // The budget only means something if it is measured against the real
    // layout, so pin the shape the bytes are being spent on.
    expect(path.basename(paths.socketPath)).toBe("hook.sock");
    expect(paths.socketPath).toContain(`ade-cursor-sdk-${process.getuid?.() ?? ""}`);
  });

  it.skipIf(process.platform === "win32")("falls back to a short socket root when the tempdir is too deep to bind under", () => {
    const deepTempDir = path.join("/var/folders/ck/qnm27lyn4d3865_9s0xt26y80000gn/T", "x".repeat(60));
    const paths = buildCursorSdkPaths({
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      poolKey: "lane:/repo:session",
      instanceId: "worker-a",
      tempDir: deepTempDir,
    });

    expect(paths.socketPath.startsWith(deepTempDir)).toBe(false);
    expect(Buffer.byteLength(paths.socketPath, "utf8")).toBeLessThanOrEqual(MAX_CURSOR_SDK_SOCKET_PATH_BYTES);
    expect(path.basename(paths.socketPath)).toBe("hook.sock");
  });

  it.skipIf(process.platform === "win32")("binds a real listener on the derived hook socket path", async () => {
    // The regression #1177 shipped was invisible to path assertions: the path
    // was well-formed and only `listen()` rejected it.
    const paths = buildCursorSdkPaths({
      projectRoot: path.join(os.homedir(), "Projects", "ADE", ".ade", "worktrees", "some-long-lane-name-41540d5a"),
      poolKey: "session-1e3fdc51-a1f9-4eda-9045-62646f3f4fb9:composer-grok-4.6:full-auto",
      instanceId: "a4f1c0de-7b52-4a1e-9c33-8d2b6e5f0a17",
    });
    fs.mkdirSync(path.dirname(paths.socketPath), { recursive: true, mode: 0o700 });
    const server = net.createServer();

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(paths.socketPath, resolve);
      });
      expect(server.listening).toBe(true);
      // A bound socket is a real file the worker's peer can connect to, and it
      // has to sit in a directory no other local user can reach.
      expect(fs.statSync(paths.socketPath).isSocket()).toBe(true);
      expect(fs.statSync(path.dirname(paths.socketPath)).mode & 0o077).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(path.dirname(paths.socketPath), { recursive: true, force: true });
    }
  });

  it("keeps per-instance named pipes on Windows, with no path-length budget applied", () => {
    // Runs on every host: CI's macOS/Linux shards would otherwise never execute
    // the win32 branch, and a named pipe is a flat kernel namespace entry with
    // no `sun_path` limit — so the POSIX byte budget must NOT be imposed here.
    const shared = {
      projectRoot: path.join(os.homedir(), "Projects", "ADE"),
      poolKey: "session-1e3fdc51-a1f9-4eda-9045-62646f3f4fb9:composer-grok-4.6:full-auto",
      platform: "win32" as NodeJS.Platform,
    };
    const first = buildCursorSdkPaths({ ...shared, instanceId: "worker-a" });
    const second = buildCursorSdkPaths({ ...shared, instanceId: "worker-b" });

    expect(first.socketPath.startsWith("\\\\.\\pipe\\ade-cursor-sdk-")).toBe(true);
    expect(second.socketPath.startsWith("\\\\.\\pipe\\ade-cursor-sdk-")).toBe(true);
    // Distinct instances must not share a pipe, or a recycle hands the
    // replacement's policy gate to the dying worker.
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(first.socketPath).not.toContain("/");
  });

  it.skipIf(process.platform === "win32")("does not leak the instance socket directory when init fails", async () => {
    // Every failed init used to leave its directory behind, because the caller
    // skipped cleanup entirely whenever the durable state had to be kept. A
    // provider outage or a bad key would then litter the tmpdir indefinitely.
    const failingChild = new FailingInitChild();
    forkMock.mockReturnValueOnce(failingChild);
    const poolKey = `test-init-failure-cleanup:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      projectRoot: makeTempDir("ade-cursor-init-fail-"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    };
    // The per-user root is shared with every other worker on this machine, so
    // compare against a snapshot rather than asserting it is empty.
    const instanceRoot = path.dirname(path.dirname(
      buildCursorSdkPaths({ projectRoot: args.projectRoot, poolKey, instanceId: "probe" }).socketPath,
    ));
    const before = new Set(fs.existsSync(instanceRoot) ? fs.readdirSync(instanceRoot) : []);

    await expect(acquireCursorSdkConnection(args)).rejects.toThrow();

    const after = fs.existsSync(instanceRoot) ? fs.readdirSync(instanceRoot) : [];
    expect(after.filter((entry) => !before.has(entry))).toEqual([]);
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty worker instance id", () => {
    expect(() => buildCursorSdkPaths({
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      poolKey: "session-1:composer-2.5:full-auto",
      instanceId: "  ",
    })).toThrow(/instance id is required/);
  });

  it.skipIf(process.platform === "win32")("does not delete a sibling worker's hook socket directory during cleanup", () => {
    const cacheRoot = makeTempDir("ade-cursor-cleanup-socket-");
    const stateRoot = path.join(cacheRoot, "state");
    fs.mkdirSync(stateRoot, { recursive: true });
    const poolRoot = makeTempDir("ade-cursor-sdk-pool-");
    const firstInstance = path.join(poolRoot, "worker-a");
    const secondInstance = path.join(poolRoot, "worker-b");
    fs.mkdirSync(firstInstance, { recursive: true });
    fs.mkdirSync(secondInstance, { recursive: true });
    const firstSock = path.join(firstInstance, "hook.sock");
    const secondSock = path.join(secondInstance, "hook.sock");
    fs.writeFileSync(firstSock, "");
    fs.writeFileSync(secondSock, "");

    cleanupCursorSdkRuntimePaths({
      cacheRoot,
      stateRoot,
      socketPath: firstSock,
      cleanupStateRoot: true,
    });

    expect(fs.existsSync(firstInstance)).toBe(false);
    expect(fs.existsSync(secondSock)).toBe(true);
    expect(fs.existsSync(poolRoot)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("reclaims the instance socket directory even when the durable state is kept", () => {
    // `cleanupStateRoot` is false for every ordinary chat pool, because the
    // Cursor state has to survive a recycle. The socket directory does not: its
    // worker is gone and the replacement binds elsewhere, so leaving it behind
    // leaked one empty directory per worker for the life of the machine.
    const cacheRoot = makeTempDir("ade-cursor-keep-state-");
    const stateRoot = path.join(cacheRoot, "state");
    fs.mkdirSync(stateRoot, { recursive: true });
    const poolRoot = makeTempDir("ade-cursor-sdk-keep-");
    const instanceDir = path.join(poolRoot, "instance-a");
    fs.mkdirSync(instanceDir, { recursive: true });
    const socketPath = path.join(instanceDir, "hook.sock");
    fs.writeFileSync(socketPath, "");

    cleanupCursorSdkRuntimePaths({
      cacheRoot,
      stateRoot,
      socketPath,
      cleanupStateRoot: false,
    });

    expect(fs.existsSync(instanceDir)).toBe(false);
    expect(fs.existsSync(poolRoot)).toBe(true);
    expect(fs.existsSync(stateRoot)).toBe(true);
    expect(fs.existsSync(cacheRoot)).toBe(true);
  });

  it("builds a worker environment with real HOME parity, the channel identity, and no ADE brain ownership metadata", () => {
    const cliRoot = makeTempDir("ade-cli-current-");
    const cliBinDir = path.join(cliRoot, "bin");
    const cliEntry = path.join(cliRoot, "cli.cjs");
    fs.mkdirSync(cliBinDir, { recursive: true });
    const adeCommand = path.join(cliBinDir, process.platform === "win32" ? "ade.cmd" : "ade");
    fs.writeFileSync(adeCommand, "");
    fs.writeFileSync(cliEntry, "");
    const env = buildCursorSdkWorkerEnv({
      baseEnv: {
        HOME: "/synthetic",
        USERPROFILE: "/synthetic-profile",
        PATH: "/bin",
        ADE_CLI_ENTRY_PATH: cliEntry,
        ADE_CLI_BIN_DIR: cliBinDir,
        ADE_HOME: "/Users/admin/.ade-beta",
        ADE_PACKAGE_CHANNEL: "beta",
        ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_RPC_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_DESKTOP_BRIDGE_SOCKET_PATH: "/Users/admin/.ade-beta/sock/desktop-bridge.sock",
        ADE_RUNTIME_BUILD_HASH: "old-build",
        ADE_RUNTIME_PARENT_PID: "1234",
        ADE_RUNTIME_IDLE_EXIT_MS: "300000",
        ADE_CLI_JS: "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs",
        ADE_CLI_INSTALL_NAME: "ade-beta",
        ADE_DEFAULT_ROLE: "cto",
        ADE_DESKTOP_APP_NAME: "ADE Beta",
        ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION: "1",
        ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL: "1",
        ELECTRON_RUN_AS_NODE: "1",
        CURSOR_API_KEY: "cursor-secret",
        CURSOR_AUTH_TOKEN: "cursor-token",
      },
      userHomeDir: "/Users/admin",
      stateRoot: "/repo/.ade/cache/cursor-sdk/hash/state",
      socketPath: "/tmp/ade-cursor-sdk/socket.sock",
      workspacePath: "/repo/.ade/worktrees/lane",
      sessionId: "session-1",
    });

    expect(env.HOME).toBe("/Users/admin");
    expect(env.USERPROFILE).toBe("/Users/admin");
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.CURSOR_AUTH_TOKEN).toBeUndefined();
    expect(env.ADE_HOME).toBe("/Users/admin/.ade-beta");
    expect(env.ADE_PACKAGE_CHANNEL).toBe("beta");
    expect(env.ADE_RUNTIME_SOCKET_PATH).toBeUndefined();
    expect(env.ADE_RPC_SOCKET_PATH).toBeUndefined();
    expect(env.ADE_DESKTOP_BRIDGE_SOCKET_PATH).toBeUndefined();
    expect(env.ADE_RUNTIME_BUILD_HASH).toBeUndefined();
    expect(env.ADE_RUNTIME_PARENT_PID).toBeUndefined();
    expect(env.ADE_RUNTIME_IDLE_EXIT_MS).toBeUndefined();
    expect(env.ADE_CLI_JS).toBeUndefined();
    expect(env.ADE_CLI_INSTALL_NAME).toBeUndefined();
    expect(env.ADE_DEFAULT_ROLE).toBeUndefined();
    expect(env.ADE_DESKTOP_APP_NAME).toBeUndefined();
    expect(env.ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION).toBeUndefined();
    expect(env.ADE_ALLOW_LOCAL_RELEASE_SERVICE_INSTALL).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.ADE_CLI_ENTRY_PATH).toBeUndefined();
    expect(env.ADE_DISABLE_RUNTIME_SERVICE_INSTALL).toBe("1");
    expect(env.ADE_CLI_BIN_DIR).toBe(cliBinDir);
    expect(env.ADE_CLI_PATH).toBe(adeCommand);
    expect(env.PATH?.split(path.delimiter)[0]).toBe(cliBinDir);
    expect(env.ADE_CURSOR_SDK_SOCKET).toBe("/tmp/ade-cursor-sdk/socket.sock");
    expect(env.ADE_CURSOR_SDK_LANE_ROOT).toBe("/repo/.ade/worktrees/lane");
    expect(env.ADE_CURSOR_SDK_SESSION_ID).toBe("session-1");
    expect(env.ADE_CURSOR_SDK_STATE_ROOT).toBe("/repo/.ade/cache/cursor-sdk/hash/state");
  });

  it("rebuilds packaged NODE_PATH for forked workers launched outside the ADE CLI wrapper", () => {
    const resourcesRoot = makeTempDir("ade-packaged-resources-");
    const cliBinDir = path.join(resourcesRoot, "ade-cli", "bin");
    const appNodeModules = path.join(resourcesRoot, "app.asar.unpacked", "node_modules");
    fs.mkdirSync(cliBinDir, { recursive: true });
    fs.mkdirSync(appNodeModules, { recursive: true });
    const adeCommand = path.join(cliBinDir, process.platform === "win32" ? "ade.cmd" : "ade");
    fs.writeFileSync(adeCommand, "");

    const env = buildCursorSdkWorkerEnv({
      baseEnv: {
        PATH: "/usr/bin",
        NODE_PATH: "/custom/node_modules",
        ADE_CLI_BIN_DIR: cliBinDir,
        ADE_CLI_PATH: adeCommand,
      },
      userHomeDir: "/Users/admin",
      stateRoot: "/repo/.ade/cache/cursor-sdk/hash/state",
      socketPath: "/tmp/ade-cursor-sdk/socket.sock",
      workspacePath: "/repo/.ade/worktrees/lane",
      sessionId: "session-1",
    });

    expect(env.NODE_PATH?.split(path.delimiter)).toEqual([
      ...buildPackagedRuntimeNodeModulePaths({ resourcesPath: resourcesRoot }),
      "/custom/node_modules",
    ]);
  });

  it("normalizes stale ADE CLI metadata to the current command bin dir without exposing CLI internals", () => {
    const stableRoot = makeTempDir("ade-cli-stable-");
    const betaRoot = makeTempDir("ade-cli-beta-");
    const stableEntry = path.join(stableRoot, "cli.cjs");
    const betaBinDir = path.join(betaRoot, "bin");
    const betaCommand = path.join(betaBinDir, process.platform === "win32" ? "ade-beta.cmd" : "ade-beta");
    fs.mkdirSync(betaBinDir, { recursive: true });
    fs.writeFileSync(stableEntry, "");
    fs.writeFileSync(betaCommand, "");

    const env = buildCursorSdkWorkerEnv({
      baseEnv: {
        PATH: "/usr/bin",
        ADE_PACKAGE_CHANNEL: "beta",
        ADE_HOME: "/Users/admin/.ade-beta",
        ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_CLI_ENTRY_PATH: stableEntry,
        ADE_CLI_BIN_DIR: betaBinDir,
        ADE_CLI_PATH: betaCommand,
      },
      userHomeDir: "/Users/admin",
      stateRoot: "/repo/.ade/cache/cursor-sdk/hash/state",
      socketPath: "/tmp/ade-cursor-sdk/socket.sock",
      workspacePath: "/repo/.ade/worktrees/lane",
      sessionId: "session-1",
    });

    expect(env.ADE_CLI_ENTRY_PATH).toBeUndefined();
    expect(env.ADE_PACKAGE_CHANNEL).toBe("beta");
    expect(env.ADE_HOME).toBe("/Users/admin/.ade-beta");
    expect(env.ADE_RUNTIME_SOCKET_PATH).toBeUndefined();
    expect(env.ADE_CLI_BIN_DIR).toBe(betaBinDir);
    expect(env.ADE_CLI_PATH).toBe(betaCommand);
    expect(env.PATH?.split(path.delimiter)[0]).toBe(betaBinDir);
  });

  /**
   * A Cursor chat inside packaged ADE Alpha got an injected `ade` that sat in
   * the Alpha bundle but resolved the STABLE `~/.ade`, because the worker env
   * denylist stripped ADE_HOME along with the brain's socket. It could not
   * reach the Alpha brain, fell back to a headless in-process runtime, and
   * `ade actions run plugin.install` failed. The two are different things: the
   * socket is the brain's, the home is WHICH APP'S STATE this agent belongs to.
   */
  it("keeps the channel home while still dropping the brain's socket", () => {
    const channelRoot = makeTempDir("ade-cli-channel-");
    const channelBinDir = path.join(channelRoot, "bin");
    const channelCommand = path.join(channelBinDir, process.platform === "win32" ? "ade-beta.cmd" : "ade-beta");
    fs.mkdirSync(channelBinDir, { recursive: true });
    fs.writeFileSync(channelCommand, "");

    const env = buildCursorSdkWorkerEnv({
      baseEnv: {
        PATH: "/usr/bin",
        ADE_HOME: "/Users/admin/.ade-beta",
        ADE_PACKAGE_CHANNEL: "beta",
        ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
        ADE_CLI_BIN_DIR: channelBinDir,
        ADE_CLI_PATH: channelCommand,
      },
      userHomeDir: "/Users/admin",
      stateRoot: "/repo/.ade/cache/cursor-sdk/hash/state",
      socketPath: "/tmp/ade-cursor-sdk/socket.sock",
      workspacePath: "/repo/.ade/worktrees/lane",
      sessionId: "session-1",
    });

    expect(env.ADE_HOME).toBe("/Users/admin/.ade-beta");
    expect(env.ADE_PACKAGE_CHANNEL).toBe("beta");
    expect(env.ADE_RUNTIME_SOCKET_PATH).toBeUndefined();
    expect(env.ADE_CLI_PATH).toBe(channelCommand);
  });

  /**
   * Cursor took the bundled skills root and stopped there, so an installed
   * plugin's skills reached Claude and Codex and were silently missing on
   * Cursor. These pin both halves: the roots are present, and they are LAST so
   * a plugin can add a skill but never shadow one ADE ships.
   */
  it("appends installed plugins' skill roots after the bundled catalog", () => {
    const adeHome = makeTempDir("ade-home-");
    const pluginsRoot = path.join(adeHome, "plugins");
    const pluginRoot = path.join(pluginsRoot, "notes");
    const pluginSkills = path.join(pluginRoot, "skills");
    fs.mkdirSync(path.join(pluginSkills, "note"), { recursive: true });
    fs.writeFileSync(path.join(pluginSkills, "note", "SKILL.md"), "# note", "utf8");
    fs.writeFileSync(
      path.join(pluginRoot, "plugin.json"),
      JSON.stringify({ name: "notes", version: "1.0.0", displayName: "Notes", skills: ["skills"] }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginsRoot, "state.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          notes: {
            version: "1.0.0",
            enabled: true,
            source: { kind: "local", path: pluginRoot },
            installedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const ownRoot = makeTempDir("ade-own-skills-");
    const cliBinDir = path.join(ownRoot, "ade-cli", "bin");
    const bundledSkillsRoot = path.join(ownRoot, "agent-skills");
    fs.mkdirSync(cliBinDir, { recursive: true });
    fs.mkdirSync(bundledSkillsRoot, { recursive: true });
    fs.writeFileSync(path.join(cliBinDir, process.platform === "win32" ? "ade.cmd" : "ade"), "");

    const env = buildCursorSdkWorkerEnv({
      baseEnv: { PATH: "/usr/bin", ADE_HOME: adeHome, ADE_CLI_BIN_DIR: cliBinDir },
      userHomeDir: "/Users/admin",
      stateRoot: "/repo/.ade/cache/cursor-sdk/hash/state",
      socketPath: "/tmp/ade-cursor-sdk/socket.sock",
      workspacePath: "/repo/.ade/worktrees/lane",
      sessionId: "session-1",
    });

    expect(env.ADE_AGENT_SKILLS_DIRS?.split(path.delimiter)).toEqual([
      bundledSkillsRoot,
      pluginSkills,
    ]);
  });

  it("leaves the skills roots alone when no plugin is installed", () => {
    const adeHome = makeTempDir("ade-home-empty-");
    const ownRoot = makeTempDir("ade-own-skills-empty-");
    const cliBinDir = path.join(ownRoot, "ade-cli", "bin");
    const bundledSkillsRoot = path.join(ownRoot, "agent-skills");
    fs.mkdirSync(cliBinDir, { recursive: true });
    fs.mkdirSync(bundledSkillsRoot, { recursive: true });
    fs.writeFileSync(path.join(cliBinDir, process.platform === "win32" ? "ade.cmd" : "ade"), "");

    const env = buildCursorSdkWorkerEnv({
      baseEnv: { PATH: "/usr/bin", ADE_HOME: adeHome, ADE_CLI_BIN_DIR: cliBinDir },
      userHomeDir: "/Users/admin",
      stateRoot: "/repo/.ade/cache/cursor-sdk/hash/state",
      socketPath: "/tmp/ade-cursor-sdk/socket.sock",
      workspacePath: "/repo/.ade/worktrees/lane",
      sessionId: "session-1",
    });

    expect(env.ADE_AGENT_SKILLS_DIRS?.split(path.delimiter)).toEqual([bundledSkillsRoot]);
  });

  it("prefers HOME on POSIX and USERPROFILE on Windows when resolving the Cursor user home", () => {
    const resolved = resolveCursorSdkUserHome({
      HOME: "/posix-home",
      USERPROFILE: "C:\\Users\\admin",
    });
    expect(resolved).toBe(process.platform === "win32" ? "C:\\Users\\admin" : "/posix-home");
  });

  it("retains a ref for each concurrent waiter on a shared initialization", async () => {
    const child = new FakeSdkChild();
    forkMock.mockReturnValue(child);
    const poolKey = `test:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    };

    const [first, second] = await Promise.all([
      acquireCursorSdkConnection(args),
      acquireCursorSdkConnection(args),
    ]);

    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(second.pooled).toBe(first.pooled);
    expect(second.generation).toBe(first.generation);

    releaseCursorSdkConnection(poolKey, first.generation);
    expect(child.disposeCount).toBe(0);

    releaseCursorSdkConnection(poolKey, second.generation);
    expect(child.disposeCount).toBe(1);
  });

  it("evicts a poisoned worker even while another lease is still held", async () => {
    const child = new FakeSdkChild();
    forkMock.mockReturnValue(child);
    const poolKey = `test:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    };

    const [first, second] = await Promise.all([
      acquireCursorSdkConnection(args),
      acquireCursorSdkConnection(args),
    ]);
    expect(second.pooled).toBe(first.pooled);

    // A transport-poisoned worker is still process-alive, so refcounting alone
    // would keep it in rotation for the sibling lease.
    expect(poisonCursorSdkConnection(poolKey, first.generation)).toBe(true);
    expect(child.disposeCount).toBe(1);
    expect(poisonCursorSdkConnection(poolKey, first.generation)).toBe(false);

    const nextChild = new FakeSdkChild();
    forkMock.mockReturnValue(nextChild);
    const third = await acquireCursorSdkConnection(args);
    expect(third.pooled).not.toBe(first.pooled);
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(forkedSocketPath(1)).toBeTruthy();
    expect(forkedSocketPath(1)).not.toBe(forkedSocketPath(0));

    releaseCursorSdkConnection(poolKey, third.generation);
  });

  it("does not fork a replacement until the poisoned worker has exited", async () => {
    const firstChild = new DelayedExitChild();
    const nextChild = new FakeSdkChild();
    forkMock.mockReturnValueOnce(firstChild);
    const poolKey = `test-replace-wait:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    };

    const first = await acquireCursorSdkConnection(args);
    expect(poisonCursorSdkConnection(poolKey, first.generation)).toBe(true);
    expect(firstChild.disposeCount).toBe(1);

    forkMock.mockReturnValue(nextChild);
    let replaced = false;
    const pending = acquireCursorSdkConnection(args).then((result) => {
      replaced = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(replaced).toBe(false);

    firstChild.finishExit(0, null);
    const second = await pending;
    expect(replaced).toBe(true);
    expect(second.pooled).not.toBe(first.pooled);
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(forkedSocketPath(1)).not.toBe(forkedSocketPath(0));

    releaseCursorSdkConnection(poolKey, second.generation);
  });

  it("replaces a wedged worker that only dies at the end of the kill escalation", async () => {
    // The hour-mark recovery path. A wedged worker ignores the IPC dispose AND
    // the SIGTERM, so it exits at dispose-grace + SIGTERM->SIGKILL. A replace
    // wait budgeted for the dispose grace alone expired before that exit could
    // land and failed the very turn the recycle was recovering.
    const firstChild = new WedgedWorkerChild();
    const nextChild = new FakeSdkChild();
    forkMock.mockReturnValueOnce(firstChild);
    const poolKey = `test-replace-wedged:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    };

    const first = await acquireCursorSdkConnection(args);
    vi.useFakeTimers();
    let second: Awaited<ReturnType<typeof acquireCursorSdkConnection>>;
    try {
      expect(poisonCursorSdkConnection(poolKey, first.generation)).toBe(true);
      forkMock.mockReturnValue(nextChild);
      const pending = acquireCursorSdkConnection(args);
      // Walk the whole ladder the pool actually schedules, without ever
      // reaching the replace-wait deadline.
      await vi.advanceTimersByTimeAsync(CURSOR_SDK_REPLACE_WAIT_MS - 1);
      second = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(firstChild.killed).toBe(true);
    expect(second.pooled).not.toBe(first.pooled);
    expect(forkMock).toHaveBeenCalledTimes(2);

    releaseCursorSdkConnection(poolKey, second.generation);
  });

  it("fails acquire if the poisoned worker outlives the replace wait", async () => {
    const firstChild = new StuckExitChild();
    const nextChild = new FakeSdkChild();
    forkMock.mockReturnValueOnce(firstChild);
    const poolKey = `test-replace-timeout:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    };

    const first = await acquireCursorSdkConnection(args);
    vi.useFakeTimers();
    try {
      expect(poisonCursorSdkConnection(poolKey, first.generation)).toBe(true);
      forkMock.mockReturnValue(nextChild);
      const pending = expect(acquireCursorSdkConnection(args)).rejects.toThrow(
        /did not exit before replacement/,
      );
      await vi.advanceTimersByTimeAsync(CURSOR_SDK_REPLACE_WAIT_MS);
      await pending;
      expect(forkMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }

    firstChild.finishExit(0, null);
    const second = await acquireCursorSdkConnection(args);
    expect(second.pooled).not.toBe(first.pooled);
    expect(forkMock).toHaveBeenCalledTimes(2);

    releaseCursorSdkConnection(poolKey, second.generation);
  });

  it("does not treat a dispatched kill plus IPC error as the worker exiting", async () => {
    const firstChild = new DelayedExitChild();
    const nextChild = new FakeSdkChild();
    forkMock.mockReturnValueOnce(firstChild);
    const poolKey = `test-replace-epipe:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    };

    const first = await acquireCursorSdkConnection(args);
    expect(poisonCursorSdkConnection(poolKey, first.generation)).toBe(true);
    firstChild.killed = true;
    firstChild.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    forkMock.mockReturnValue(nextChild);
    let replaced = false;
    const pending = acquireCursorSdkConnection(args).then((result) => {
      replaced = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(replaced).toBe(false);

    firstChild.finishExit(null, "SIGTERM");
    const second = await pending;
    expect(replaced).toBe(true);
    expect(second.pooled).not.toBe(first.pooled);
    expect(forkMock).toHaveBeenCalledTimes(2);

    releaseCursorSdkConnection(poolKey, second.generation);
  });

  it("waits for exit when a live worker's IPC channel errors before dispose", async () => {
    const firstChild = new DelayedExitChild();
    const nextChild = new FakeSdkChild();
    forkMock.mockReturnValueOnce(firstChild);
    const poolKey = `test-live-epipe:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    };

    const first = await acquireCursorSdkConnection(args);
    firstChild.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

    forkMock.mockReturnValue(nextChild);
    let replaced = false;
    const pending = acquireCursorSdkConnection(args).then((result) => {
      replaced = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(replaced).toBe(false);
    expect(firstChild.disposeCount).toBe(1);

    firstChild.finishExit(null, "SIGTERM");
    const second = await pending;
    expect(replaced).toBe(true);
    expect(second.pooled).not.toBe(first.pooled);
    expect(forkMock).toHaveBeenCalledTimes(2);

    releaseCursorSdkConnection(poolKey, second.generation);
  });

  it("reuses a oneshot worker during idle instead of colliding on cleanup", async () => {
    const firstChild = new FakeSdkChild();
    const secondChild = new FakeSdkChild();
    forkMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const poolKey = `cloud-oneshot:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    };

    const first = await acquireCursorSdkConnection(args);
    releaseCursorSdkConnectionAfterIdle(poolKey, first.generation, 60_000);
    const second = await acquireCursorSdkConnection(args);
    expect(second.pooled).toBe(first.pooled);
    expect(second.generation).toBe(first.generation);
    expect(forkMock).toHaveBeenCalledTimes(1);

    releaseCursorSdkConnectionAfterIdle(poolKey, second.generation, 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = await acquireCursorSdkConnection(args);
    expect(third.pooled).not.toBe(first.pooled);
    expect(forkMock).toHaveBeenCalledTimes(2);
    releaseCursorSdkConnection(poolKey, third.generation);
  });


  it("runs a one-shot local prompt on a pooled worker and starts a fresh conversation", async () => {
    const child = new OneShotSdkChild();
    forkMock.mockReturnValue(child);
    const workspacePath = path.join(os.tmpdir(), `ade-oneshot-${Date.now()}-${Math.random()}`);

    const result = await runCursorSdkLocalPrompt(oneShotArgs(workspacePath));

    expect(result.text).toBe("named it");
    expect(result.agentId).toBe("agent-1");
    const init = sentMessagesOfType(child, "init")[0]?.payload;
    expect(init).toMatchObject({
      modelSdkId: "grok-4.6",
      apiKey: "cursor-test-key",
      sessionId: "oneshot:session_title",
      laneRoot: workspacePath,
      // Fixed, both of them: the warm worker is shared across features and
      // keeps the policy and the name it was created with.
      agentName: CURSOR_SDK_ONESHOT_AGENT_NAME,
      policy: CURSOR_SDK_ONESHOT_POLICY,
    });
    const send = sentMessagesOfType(child, "send")[0]?.payload;
    expect(send).toMatchObject({
      promptText: "Name this chat.",
      modelSdkId: "grok-4.6",
      resetConversation: true,
    });
  });

  it("keeps the one-shot worker warm across back-to-back prompts", async () => {
    const child = new OneShotSdkChild();
    forkMock.mockReturnValue(child);
    const workspacePath = path.join(os.tmpdir(), `ade-oneshot-warm-${Date.now()}-${Math.random()}`);

    await runCursorSdkLocalPrompt(oneShotArgs(workspacePath));
    await runCursorSdkLocalPrompt({ ...oneShotArgs(workspacePath), modelSdkId: "composer-2" });

    expect(forkMock).toHaveBeenCalledTimes(1);
    const sends = sentMessagesOfType(child, "send");
    expect(sends).toHaveLength(2);
    // The worker applies a per-send model, so a second candidate model does not
    // need a second worker.
    expect(sends[1]?.payload?.modelSdkId).toBe("composer-2");
    expect(sends[1]?.payload?.resetConversation).toBe(true);
  });

  it("serializes concurrent one-shot prompts on the same workspace", async () => {
    const child = new OverlapCountingChild();
    forkMock.mockReturnValue(child);
    const workspacePath = path.join(os.tmpdir(), `ade-oneshot-race-${Date.now()}-${Math.random()}`);

    await Promise.all([
      runCursorSdkLocalPrompt(oneShotArgs(workspacePath)),
      runCursorSdkLocalPrompt(oneShotArgs(workspacePath)),
      runCursorSdkLocalPrompt(oneShotArgs(workspacePath)),
    ]);

    expect(child.maxInFlight).toBe(1);
    expect(sentMessagesOfType(child, "send")).toHaveLength(3);
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it("maps an errored one-shot run onto a thrown error", async () => {
    forkMock.mockReturnValue(new OneShotSdkChild({ status: "error", result: "Cursor is out of credits." }));
    const workspacePath = path.join(os.tmpdir(), `ade-oneshot-error-${Date.now()}-${Math.random()}`);

    await expect(runCursorSdkLocalPrompt(oneShotArgs(workspacePath)))
      .rejects.toThrow("Cursor is out of credits.");
  });

  it("maps a cancelled one-shot run onto a thrown error", async () => {
    forkMock.mockReturnValue(new OneShotSdkChild({ status: "cancelled", result: "" }));
    const workspacePath = path.join(os.tmpdir(), `ade-oneshot-cancelled-${Date.now()}-${Math.random()}`);

    await expect(runCursorSdkLocalPrompt(oneShotArgs(workspacePath)))
      .rejects.toThrow("Cursor SDK task was cancelled.");
  });

  it("cancels and discards the worker when a one-shot prompt times out", async () => {
    const stalled = new StalledSendChild();
    const replacement = new OneShotSdkChild();
    forkMock.mockReturnValueOnce(stalled).mockReturnValueOnce(replacement);
    const workspacePath = path.join(os.tmpdir(), `ade-oneshot-timeout-${Date.now()}-${Math.random()}`);

    await expect(runCursorSdkLocalPrompt({ ...oneShotArgs(workspacePath), timeoutMs: 20 }))
      .rejects.toThrow("Cursor SDK task timed out after 20ms.");
    expect(stalled.cancelCount).toBe(1);

    // A worker that missed its deadline is still streaming: the next one-shot
    // must not inherit it.
    const result = await runCursorSdkLocalPrompt(oneShotArgs(workspacePath));
    expect(result.text).toBe("named it");
    expect(forkMock).toHaveBeenCalledTimes(2);
  });

  it("discards the worker when a one-shot send rejects", async () => {
    const broken = new RejectingSendChild();
    const replacement = new OneShotSdkChild();
    forkMock.mockReturnValueOnce(broken).mockReturnValueOnce(replacement);
    const workspacePath = path.join(os.tmpdir(), `ade-oneshot-reject-${Date.now()}-${Math.random()}`);

    await expect(runCursorSdkLocalPrompt(oneShotArgs(workspacePath)))
      .rejects.toThrow("Cursor SDK worker is not initialized.");
    expect(broken.disposeCount).toBe(1);

    // A worker whose send rejected reported a fault of its own, and its process
    // stays alive through all of them: the pool's liveness check would keep
    // handing the same broken worker out.
    const result = await runCursorSdkLocalPrompt(oneShotArgs(workspacePath));
    expect(result.text).toBe("named it");
    expect(forkMock).toHaveBeenCalledTimes(2);
  });

  it("reports a terminal one-shot error from the run's error detail", async () => {
    forkMock.mockReturnValue(new OneShotSdkChild({
      status: "error",
      result: "Here is the partial answer",
      error: { message: "Cursor stream failed: NGHTTP2_ENHANCE_YOUR_CALM" },
    }));
    const workspacePath = path.join(os.tmpdir(), `ade-oneshot-detail-${Date.now()}-${Math.random()}`);

    await expect(runCursorSdkLocalPrompt(oneShotArgs(workspacePath)))
      .rejects.toThrow("Cursor stream failed: NGHTTP2_ENHANCE_YOUR_CALM");
  });

  it("shares one warm worker across two spellings of the same workspace path", async () => {
    const child = new OneShotSdkChild();
    forkMock.mockReturnValue(child);
    const workspacePath = path.join(os.tmpdir(), `ADE-Oneshot-Case-${Date.now()}`);

    await runCursorSdkLocalPrompt(oneShotArgs(workspacePath));
    await runCursorSdkLocalPrompt(oneShotArgs(workspacePath.toLowerCase()));

    // Only where the filesystem itself folds case; Linux is case-sensitive and
    // two spellings really are two workspaces there.
    const expectedWorkers = process.platform === "linux" ? 2 : 1;
    expect(forkMock).toHaveBeenCalledTimes(expectedWorkers);
  });

  it("forks a fresh worker when the Cursor API key rotates", async () => {
    const first = new OneShotSdkChild();
    const second = new OneShotSdkChild();
    forkMock.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const workspacePath = path.join(os.tmpdir(), `ade-oneshot-key-${Date.now()}-${Math.random()}`);

    await runCursorSdkLocalPrompt(oneShotArgs(workspacePath));
    await runCursorSdkLocalPrompt({ ...oneShotArgs(workspacePath), apiKey: "cursor-rotated-key" });

    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(sentMessagesOfType(second, "init")[0]?.payload?.apiKey).toBe("cursor-rotated-key");
  });

  it("caps the warm one-shot workers and releases the least recently used idle one", async () => {
    const children = [new OneShotSdkChild(), new OneShotSdkChild(), new OneShotSdkChild()];
    forkMock.mockImplementation(() => children.shift() ?? new OneShotSdkChild());
    const [oldest, middle] = [children[0]!, children[1]!];
    const stamp = `${Date.now()}-${Math.random()}`;
    const workspaces = [0, 1, 2].map((index) => path.join(os.tmpdir(), `ade-oneshot-lru-${stamp}-${index}`));

    expect(CURSOR_SDK_LOCAL_ONESHOT_MAX_WORKERS).toBe(2);
    await runCursorSdkLocalPrompt(oneShotArgs(workspaces[0]!));
    await runCursorSdkLocalPrompt(oneShotArgs(workspaces[1]!));
    expect(oldest.disposeCount).toBe(0);

    // The third distinct workspace is over the cap, so the idle worker that ran
    // longest ago is released rather than kept warm alongside the other two.
    await runCursorSdkLocalPrompt(oneShotArgs(workspaces[2]!));
    expect(forkMock).toHaveBeenCalledTimes(3);
    expect(oldest.disposeCount).toBe(1);
    expect(middle.disposeCount).toBe(0);
  });

  it("preserves structured Cursor SDK worker error metadata on rejected requests", async () => {
    const child = new FailingSendChild();
    forkMock.mockReturnValue(child);
    const poolKey = `test-send-failure:${Date.now()}:${Math.random()}`;
    const acquired = await acquireCursorSdkConnection({
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    });

    await expect(acquired.pooled.sendPrompt({ promptText: "hi" })).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      requestId: "req-cursor-1",
      operation: "Agent.send",
      endpoint: "/agent/send",
      isRetryable: true,
      cursorSdk: {
        code: "resource_exhausted",
        requestId: "req-cursor-1",
      },
    });

    releaseCursorSdkConnection(poolKey, acquired.generation);
  });

  it("sends screenshot paths over worker IPC instead of inline bytes", async () => {
    const child = new FakeSdkChild();
    forkMock.mockReturnValue(child);
    const poolKey = `test-image-paths:${Date.now()}:${Math.random()}`;
    const acquired = await acquireCursorSdkConnection({
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    });

    await acquired.pooled.sendPrompt({
      promptText: "compare these screens",
      images: [
        { path: "/repo/.ade/attachments/a.png", mimeType: "image/png", rootPath: "/repo" },
        { path: "/repo/.ade/attachments/b.png", mimeType: "image/png", rootPath: "/repo" },
      ],
    });

    const sendReq = child.sent.find((message) => (
      message
      && typeof message === "object"
      && "type" in message
      && message.type === "send"
    )) as { payload?: { images?: Array<{ path?: string; data?: string }> } } | undefined;
    expect(sendReq?.payload?.images).toEqual([
      { path: "/repo/.ade/attachments/a.png", mimeType: "image/png", rootPath: "/repo" },
      { path: "/repo/.ade/attachments/b.png", mimeType: "image/png", rootPath: "/repo" },
    ]);
    expect(sendReq?.payload?.images?.some((image) => image.data)).toBeFalsy();

    releaseCursorSdkConnection(poolKey, acquired.generation);
  });

  it("does not reuse a worker whose IPC channel has closed", async () => {
    const firstChild = new FakeSdkChild();
    const secondChild = new FakeSdkChild();
    forkMock
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const poolKey = `test-disconnected:${Date.now()}:${Math.random()}`;
    const args = {
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    };

    const first = await acquireCursorSdkConnection(args);
    expect(isCursorSdkPooledAlive(first.pooled)).toBe(true);
    (firstChild as unknown as { connected: boolean }).connected = false;
    expect(isCursorSdkPooledAlive(first.pooled)).toBe(false);

    const second = await acquireCursorSdkConnection(args);
    expect(second.pooled).not.toBe(first.pooled);
    expect(second.generation).not.toBe(first.generation);
    expect(firstChild.killed).toBe(true);
    expect(forkMock).toHaveBeenCalledTimes(2);

    releaseCursorSdkConnection(poolKey, second.generation);
  });

  it("rejects initialization instead of throwing when the worker IPC channel closes", async () => {
    forkMock.mockReturnValue(new ExitingBeforeInitChild());
    const poolKey = `test-exit:${Date.now()}:${Math.random()}`;

    await expect(acquireCursorSdkConnection({
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    })).rejects.toThrow("Cursor SDK worker exited (1).");
  });

  it("includes recent worker stderr when a Cursor SDK worker exits", async () => {
    forkMock.mockReturnValue(new ExitingWithStderrBeforeInitChild());
    const poolKey = `test-exit-stderr:${Date.now()}:${Math.random()}`;

    await expect(acquireCursorSdkConnection({
      poolKey,
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      workspacePath: path.join(os.tmpdir(), "ade-workspace"),
      modelSdkId: "cursor-model",
      sessionId: "session-1",
      policy: { ...TEST_POLICY },
    })).rejects.toThrow(/NGHTTP2_ENHANCE_YOUR_CALM/);
  });
});
