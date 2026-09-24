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
  disposeAllCursorSdkConnections,
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
  fullAuto: false,
  hardGuards: true,
  autoReview: true,
} as const;
const tempDirs: string[] = [];

vi.mock("node:child_process", () => ({
  fork: (...args: unknown[]) => forkMock(...args),
}));

/** A worker response body; `null` means the worker never answers that request type. */
type WorkerReply = Record<string, unknown> | null;

/**
 * A forked worker that answers each request type with a fixed response:
 * `init` and `send` succeed unless `replies` overrides them, and `dispose`
 * exits the process.
 */
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

  constructor(private readonly replies: Record<string, WorkerReply> = {}) {
    super();
  }

  send(message: { type?: string; requestId?: string; payload?: unknown }): boolean {
    this.sent.push(message);
    const reply = {
      init: { ok: true, result: { agentId: "agent-1" } },
      send: { ok: true, result: {} },
      ...this.replies,
    }[message.type ?? ""];
    const requestId = message.requestId;
    if (reply && requestId) {
      queueMicrotask(() => this.emit("message", { type: "response", requestId, ...reply }));
    }
    if (message.type === "dispose") {
      this.disposeCount += 1;
      this.onDispose();
    }
    return true;
  }

  protected onDispose(): void {
    queueMicrotask(() => this.finishExit(0, null));
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

class GatedInitSdkChild extends FakeSdkChild {
  private markInitSent!: () => void;
  readonly initSent = new Promise<void>((resolve) => {
    this.markInitSent = resolve;
  });
  initRequest: { requestId: string; payload?: unknown } | null = null;

  override send(message: { type?: string; requestId?: string; payload?: unknown }): boolean {
    if (message.type === "init" && message.requestId) {
      this.sent.push(message);
      this.initRequest = { requestId: message.requestId, payload: message.payload };
      this.markInitSent();
      return true;
    }
    return super.send(message);
  }

  completeInit(): void {
    if (!this.initRequest) throw new Error("Cursor init was not sent.");
    this.emit("message", {
      type: "response",
      requestId: this.initRequest.requestId,
      ok: true,
      result: { agentId: "agent-1" },
    });
  }
}

/** Ignores the IPC `dispose`; it exits only when the test (or a kill) says so. */
class DelayedExitChild extends FakeSdkChild {
  protected override onDispose(): void {}
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

/** Exits on `init`, after writing `stderrText`; a later `dispose` throws like a closed channel. */
class ExitingBeforeInitChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  killed = false;
  connected = true;

  constructor(private readonly stderrText = "") {
    super();
  }

  send(message: { type?: string; requestId?: string }): boolean {
    if (message.type === "init") {
      queueMicrotask(() => {
        if (this.stderrText) this.stderr.emit("data", this.stderrText);
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

/** Answers `send` with a terminal run result, the way a one-shot run ends. */
function oneShotChild(runResult: unknown = { status: "finished", result: " named it " }): FakeSdkChild {
  return new FakeSdkChild({ send: { ok: true, result: runResult } });
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

/** Acquire args under a pool key no other test shares. */
function poolArgs(tag: string, extra: { activityRuntimeSocketPath?: string } = {}) {
  return {
    poolKey: `${tag}:${Date.now()}:${Math.random()}`,
    projectRoot: path.join(os.tmpdir(), "ade-project"),
    workspacePath: path.join(os.tmpdir(), "ade-workspace"),
    modelSdkId: "cursor-model",
    sessionId: "session-1",
    policy: { ...TEST_POLICY },
    ...extra,
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

  it("keeps durable SDK state stable while each pool key and worker instance gets its own hook socket", () => {
    const shared = { projectRoot: path.join(os.tmpdir(), "ade-project"), stateKey: "session-1:lane-1:state" };
    const first = buildCursorSdkPaths({ ...shared, poolKey: "session-1:composer-2.5:full-auto", instanceId: "worker-a" });
    const otherPool = buildCursorSdkPaths({ ...shared, poolKey: "session-1:claude-sonnet-5:edit", instanceId: "worker-a" });
    const otherInstance = buildCursorSdkPaths({ ...shared, poolKey: "session-1:composer-2.5:full-auto", instanceId: "worker-b" });

    for (const other of [otherPool, otherInstance]) {
      expect(other.stateRoot).toBe(first.stateRoot);
      expect(other.cacheRoot).toBe(first.cacheRoot);
      expect(other.socketPath).not.toBe(first.socketPath);
    }
    if (process.platform !== "win32") {
      expect(path.basename(otherInstance.socketPath)).toBe("hook.sock");
      expect(path.dirname(otherInstance.socketPath)).not.toBe(path.dirname(first.socketPath));
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
    const args = { ...poolArgs("test-init-failure-cleanup"), projectRoot: makeTempDir("ade-cursor-init-fail-") };
    const { poolKey } = args;
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

  const WORKER_ENV_ARGS = {
    userHomeDir: "/Users/admin",
    stateRoot: "/repo/.ade/cache/cursor-sdk/hash/state",
    socketPath: "/tmp/ade-cursor-sdk/socket.sock",
    workspacePath: "/repo/.ade/worktrees/lane",
    sessionId: "session-1",
  };

  it("builds a worker environment with real HOME parity and no ADE brain ownership metadata", () => {
    const cliRoot = makeTempDir("ade-cli-current-");
    const cliBinDir = path.join(cliRoot, "bin");
    const cliEntry = path.join(cliRoot, "cli.cjs");
    fs.mkdirSync(cliBinDir, { recursive: true });
    const adeCommand = path.join(cliBinDir, process.platform === "win32" ? "ade.cmd" : "ade");
    fs.writeFileSync(adeCommand, "");
    fs.writeFileSync(cliEntry, "");
    const stripped = {
      CURSOR_API_KEY: "cursor-secret",
      CURSOR_AUTH_TOKEN: "cursor-token",
      ADE_HOME: "/Users/admin/.ade-beta",
      ADE_PACKAGE_CHANNEL: "beta",
      ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
      ADE_RPC_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
      ADE_RPC_URL: "/Users/admin/.ade-beta/sock/ade.sock",
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
      ADE_CLI_ENTRY_PATH: cliEntry,
    };
    const env = buildCursorSdkWorkerEnv({
      ...WORKER_ENV_ARGS,
      baseEnv: {
        HOME: "/synthetic",
        USERPROFILE: "/synthetic-profile",
        PATH: "/bin",
        ADE_CLI_BIN_DIR: cliBinDir,
        ...stripped,
      },
    });

    for (const key of Object.keys(stripped)) {
      expect(env[key], key).toBeUndefined();
    }
    expect(env).toMatchObject({
      HOME: "/Users/admin",
      USERPROFILE: "/Users/admin",
      ADE_DISABLE_RUNTIME_SERVICE_INSTALL: "1",
      ADE_CLI_BIN_DIR: cliBinDir,
      ADE_CLI_PATH: adeCommand,
      ADE_CURSOR_SDK_SOCKET: "/tmp/ade-cursor-sdk/socket.sock",
      ADE_CURSOR_SDK_LANE_ROOT: "/repo/.ade/worktrees/lane",
      ADE_CURSOR_SDK_SESSION_ID: "session-1",
      ADE_CURSOR_SDK_STATE_ROOT: "/repo/.ade/cache/cursor-sdk/hash/state",
      // Only an agent this worker spawned may send a preCompact report.
      ADE_CURSOR_SDK_PRECOMPACT: "1",
    });
    expect(env.PATH?.split(path.delimiter)[0]).toBe(cliBinDir);
  });

  it("passes only the explicitly authorized ADE runtime socket for activity reports", () => {
    const env = buildCursorSdkWorkerEnv({
      ...WORKER_ENV_ARGS,
      baseEnv: {
        PATH: "/usr/bin",
        ADE_HOME: "/Users/admin/.ade-beta",
        ADE_PACKAGE_CHANNEL: "beta",
        ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade/sock/ade.sock",
        ADE_RPC_SOCKET_PATH: "/Users/admin/.ade/sock/ade.sock",
        ADE_RPC_URL: "/Users/admin/.ade/sock/ade.sock",
      },
      activityRuntimeSocketPath: "/Users/admin/.ade-beta/sock/ade.sock",
    });

    expect(env).toMatchObject({
      ADE_RPC_URL: "/Users/admin/.ade-beta/sock/ade.sock",
      ADE_RPC_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
      ADE_RUNTIME_SOCKET_PATH: "/Users/admin/.ade-beta/sock/ade.sock",
    });
    expect(env.ADE_HOME).toBeUndefined();
    expect(env.ADE_PACKAGE_CHANNEL).toBeUndefined();
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
      ...WORKER_ENV_ARGS,
      baseEnv: {
        PATH: "/usr/bin",
        NODE_PATH: "/custom/node_modules",
        ADE_CLI_BIN_DIR: cliBinDir,
        ADE_CLI_PATH: adeCommand,
      },
    });

    expect(env.NODE_PATH?.split(path.delimiter)).toEqual([
      ...buildPackagedRuntimeNodeModulePaths({ resourcesPath: resourcesRoot }),
      "/custom/node_modules",
    ]);
  });

  it("points the worker at the current ADE CLI command, not a stale CLI entry from another install", () => {
    const stableRoot = makeTempDir("ade-cli-stable-");
    const betaRoot = makeTempDir("ade-cli-beta-");
    const stableEntry = path.join(stableRoot, "cli.cjs");
    const betaBinDir = path.join(betaRoot, "bin");
    const betaCommand = path.join(betaBinDir, process.platform === "win32" ? "ade-beta.cmd" : "ade-beta");
    fs.mkdirSync(betaBinDir, { recursive: true });
    fs.writeFileSync(stableEntry, "");
    fs.writeFileSync(betaCommand, "");

    const env = buildCursorSdkWorkerEnv({
      ...WORKER_ENV_ARGS,
      baseEnv: {
        PATH: "/usr/bin",
        ADE_CLI_ENTRY_PATH: stableEntry,
        ADE_CLI_BIN_DIR: betaBinDir,
        ADE_CLI_PATH: betaCommand,
      },
    });

    expect(env.ADE_CLI_ENTRY_PATH).toBeUndefined();
    expect(env.ADE_CLI_BIN_DIR).toBe(betaBinDir);
    expect(env.ADE_CLI_PATH).toBe(betaCommand);
    expect(env.PATH?.split(path.delimiter)[0]).toBe(betaBinDir);
  });

  it("prefers HOME on POSIX and USERPROFILE on Windows when resolving the Cursor user home", () => {
    const resolved = resolveCursorSdkUserHome({
      HOME: "/posix-home",
      USERPROFILE: "C:\\Users\\admin",
    });
    expect(resolved).toBe(process.platform === "win32" ? "C:\\Users\\admin" : "/posix-home");
  });

  it("forks one owner-marked worker and retains a ref for each concurrent waiter on it", async () => {
    const child = new FakeSdkChild();
    forkMock.mockReturnValue(child);
    const args = poolArgs("test");
    const { poolKey } = args;

    const [first, second] = await Promise.all([
      acquireCursorSdkConnection(args),
      acquireCursorSdkConnection(args),
    ]);

    expect(forkMock).toHaveBeenCalledTimes(1);
    // The orphan sweep reads this marker to tell a live brain's worker from a leaked one.
    expect(forkMock.mock.calls[0]?.[1]).toEqual([`--ade-owner-pid=${process.pid}`]);
    expect(second.pooled).toBe(first.pooled);
    expect(second.generation).toBe(first.generation);

    releaseCursorSdkConnection(poolKey, first.generation);
    expect(child.disposeCount).toBe(0);

    releaseCursorSdkConnection(poolKey, second.generation);
    expect(child.disposeCount).toBe(1);
  });

  it("rejects a shared initialization with different skill roots without interrupting its owner", async () => {
    const firstChild = new GatedInitSdkChild();
    const secondChild = new FakeSdkChild();
    forkMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const args = poolArgs("test-skill-roots");
    const { poolKey } = args;

    const firstPending = acquireCursorSdkConnection({ ...args, agentSkillDirs: ["/skills/first"] });
    await firstChild.initSent;
    const secondPending = acquireCursorSdkConnection({ ...args, agentSkillDirs: ["/skills/second"] });
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(firstChild.initRequest?.payload).toMatchObject({ agentSkillDirs: ["/skills/first"] });

    firstChild.completeInit();
    const first = await firstPending;
    expect(first.pooled.process).toBe(firstChild);
    await expect(secondPending).rejects.toThrow("active with different launch capabilities");
    expect(firstChild.disposeCount).toBe(0);

    releaseCursorSdkConnection(poolKey, first.generation);
    const second = await acquireCursorSdkConnection({ ...args, agentSkillDirs: ["/skills/second"] });

    expect(second.pooled.process).toBe(secondChild);
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(secondChild.sent.find((message) => (message as { type?: string }).type === "init"))
      .toMatchObject({ payload: { agentSkillDirs: ["/skills/second"] } });
    expect(firstChild.disposeCount).toBe(1);
    releaseCursorSdkConnection(poolKey, second.generation);
  });

  it("starts a new worker with requested skill roots after the leased worker exits unexpectedly", async () => {
    const firstChild = new FakeSdkChild();
    const secondChild = new FakeSdkChild();
    forkMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const args = poolArgs("test-skill-roots-exit");
    const { poolKey } = args;

    const first = await acquireCursorSdkConnection({ ...args, agentSkillDirs: ["/skills/first"] });
    firstChild.finishExit(1, null);
    const second = await acquireCursorSdkConnection({ ...args, agentSkillDirs: ["/skills/second"] });

    expect(second.pooled.process).toBe(secondChild);
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(secondChild.sent.find((message) => (message as { type?: string }).type === "init"))
      .toMatchObject({ payload: { agentSkillDirs: ["/skills/second"] } });
    releaseCursorSdkConnection(poolKey, first.generation);
    releaseCursorSdkConnection(poolKey, second.generation);
  });

  it("replaces a live worker when its authorized ADE runtime socket changes", async () => {
    const firstChild = new FakeSdkChild();
    const secondChild = new FakeSdkChild();
    forkMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const args = poolArgs("test-activity-socket", { activityRuntimeSocketPath: "/runtime/alpha.sock" });
    const { poolKey } = args;

    const first = await acquireCursorSdkConnection(args);
    const secondPending = acquireCursorSdkConnection({
      ...args,
      activityRuntimeSocketPath: "/runtime/beta.sock",
    });
    await expect(secondPending).rejects.toThrow("active with different launch capabilities");
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(firstChild.disposeCount).toBe(0);

    releaseCursorSdkConnection(poolKey, first.generation);
    const second = await acquireCursorSdkConnection({
      ...args,
      activityRuntimeSocketPath: "/runtime/beta.sock",
    });

    expect(second.pooled).not.toBe(first.pooled);
    expect(forkMock).toHaveBeenCalledTimes(2);
    releaseCursorSdkConnection(poolKey, second.generation);
  });

  it.skipIf(process.platform === "linux")("reuses a live worker for equivalent case-insensitive runtime socket paths", async () => {
    const child = new FakeSdkChild();
    forkMock.mockReturnValue(child);
    const runtimeSocketPath = process.platform === "win32" ? "C:\\runtime\\alpha.sock" : "/runtime/alpha.sock";
    const equivalentRuntimeSocketPath = process.platform === "win32" ? "c:/RUNTIME/ALPHA.SOCK" : "/RUNTIME/ALPHA.SOCK";
    const args = poolArgs("test-equivalent-activity-socket", { activityRuntimeSocketPath: runtimeSocketPath });
    const { poolKey } = args;

    const first = await acquireCursorSdkConnection(args);
    const equivalent = await acquireCursorSdkConnection({
      ...args,
      activityRuntimeSocketPath: equivalentRuntimeSocketPath,
    });

    expect(equivalent.pooled).toBe(first.pooled);
    expect(equivalent.generation).toBe(first.generation);
    expect(forkMock).toHaveBeenCalledTimes(1);
    releaseCursorSdkConnection(poolKey, first.generation);
    releaseCursorSdkConnection(poolKey, equivalent.generation);
  });

  it("evicts a poisoned worker even while another lease is still held", async () => {
    const child = new FakeSdkChild();
    forkMock.mockReturnValue(child);
    const args = poolArgs("test");
    const { poolKey } = args;

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

  const epipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  it.each([
    {
      name: "a poisoned worker",
      disrupt: (child: DelayedExitChild, poolKey: string, generation: number) => {
        expect(poisonCursorSdkConnection(poolKey, generation)).toBe(true);
      },
    },
    {
      // A dispatched kill plus an IPC error is not an exit.
      name: "a poisoned worker whose kill was dispatched and whose IPC then errored",
      disrupt: (child: DelayedExitChild, poolKey: string, generation: number) => {
        expect(poisonCursorSdkConnection(poolKey, generation)).toBe(true);
        child.killed = true;
        child.emit("error", epipe());
      },
    },
    {
      name: "a live worker whose IPC channel errored before dispose",
      disrupt: (child: DelayedExitChild) => {
        child.emit("error", epipe());
      },
    },
  ])("does not fork a replacement for $name until it has exited", async ({ disrupt }) => {
    const firstChild = new DelayedExitChild();
    forkMock.mockReturnValueOnce(firstChild);
    const args = poolArgs("test-replace-wait");
    const { poolKey } = args;

    const first = await acquireCursorSdkConnection(args);
    disrupt(firstChild, poolKey, first.generation);

    forkMock.mockReturnValue(new FakeSdkChild());
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
    const args = poolArgs("test-replace-wedged");
    const { poolKey } = args;

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
    const args = poolArgs("test-replace-timeout");
    const { poolKey } = args;

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

  it("reuses a oneshot worker during idle instead of colliding on cleanup", async () => {
    const firstChild = new FakeSdkChild();
    const secondChild = new FakeSdkChild();
    forkMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const args = poolArgs("cloud-oneshot");
    const { poolKey } = args;

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


  it("runs back-to-back one-shot prompts on one warm pooled worker, each in a fresh conversation", async () => {
    const child = new OneShotSdkChild();
    forkMock.mockReturnValue(child);
    const workspacePath = path.join(os.tmpdir(), `ade-oneshot-${Date.now()}-${Math.random()}`);

    const result = await runCursorSdkLocalPrompt(oneShotArgs(workspacePath));
    await runCursorSdkLocalPrompt({ ...oneShotArgs(workspacePath), modelSdkId: "composer-2" });

    expect(result.text).toBe("named it");
    expect(result.agentId).toBe("agent-1");
    expect(forkMock).toHaveBeenCalledTimes(1);
    const init = sentMessagesOfType(child, "init")[0]?.payload;
    expect(init).toMatchObject({
      modelSdkId: "grok-4.6",
      apiKey: "cursor-test-key",
      sessionId: "oneshot:session_title",
      projectRoot: path.join(os.tmpdir(), "ade-project"),
      laneRoot: workspacePath,
      // Fixed, both of them: the warm worker is shared across features and
      // keeps the policy and the name it was created with.
      agentName: CURSOR_SDK_ONESHOT_AGENT_NAME,
      policy: CURSOR_SDK_ONESHOT_POLICY,
    });
    // The worker applies a per-send model, so a second candidate model does not
    // need a second worker.
    expect(sentMessagesOfType(child, "send").map((send) => send.payload)).toMatchObject([
      { promptText: "Name this chat.", modelSdkId: "grok-4.6", resetConversation: true },
      { modelSdkId: "composer-2", resetConversation: true },
    ]);
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

  it.each([
    ["an errored run", { status: "error", result: "Cursor is out of credits." }, "Cursor is out of credits."],
    ["a cancelled run", { status: "cancelled", result: "" }, "Cursor SDK task was cancelled."],
    // The run's error detail wins over its partial result text.
    [
      "an errored run with error detail",
      { status: "error", result: "Here is the partial answer", error: { message: "Cursor stream failed: NGHTTP2_ENHANCE_YOUR_CALM" } },
      "Cursor stream failed: NGHTTP2_ENHANCE_YOUR_CALM",
    ],
  ])("maps %s onto a thrown one-shot error", async (_name, runResult, message) => {
    forkMock.mockReturnValue(new OneShotSdkChild(runResult));
    const workspacePath = path.join(os.tmpdir(), `ade-oneshot-error-${Date.now()}-${Math.random()}`);

    await expect(runCursorSdkLocalPrompt(oneShotArgs(workspacePath))).rejects.toThrow(message);
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
    const args = poolArgs("test-send-failure");
    const { poolKey } = args;
    const acquired = await acquireCursorSdkConnection(args);

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

  it("carries a steer request and its outcome over worker IPC", async () => {
    /** Answers `steer` with the outcome the SDK's `Run.steer()` reports. */
    class SteeringChild extends FakeSdkChild {
      steerTexts: string[] = [];

      override send(message: { type?: string; requestId?: string; payload?: unknown }): boolean {
        if (message.type === "steer" && message.requestId) {
          this.sent.push(message);
          this.steerTexts.push((message.payload as { text: string }).text);
          const requestId = message.requestId;
          queueMicrotask(() => {
            this.emit("message", {
              type: "response",
              requestId,
              ok: true,
              result: { outcome: "complete_delivered" },
            });
          });
          return true;
        }
        return super.send(message);
      }
    }

    const child = new SteeringChild();
    forkMock.mockReturnValue(child);
    const args = poolArgs("test-steer");
    const { poolKey } = args;
    const acquired = await acquireCursorSdkConnection(args);

    await expect(acquired.pooled.steer("redirect this turn")).resolves.toEqual({
      outcome: "complete_delivered",
    });
    // The text travels in the payload, not the request type, so the worker can
    // hand it to `Run.steer()` unchanged.
    expect(child.steerTexts).toEqual(["redirect this turn"]);

    releaseCursorSdkConnection(poolKey, acquired.generation);
  });

  it("does not reuse a worker whose IPC channel has closed", async () => {
    const firstChild = new FakeSdkChild();
    const secondChild = new FakeSdkChild();
    forkMock
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const args = poolArgs("test-disconnected");
    const { poolKey } = args;

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

  it.each([
    ["with no output", "", "Cursor SDK worker exited (1)."],
    [
      "including its recent stderr",
      [
        "ConnectError: [internal] Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM",
        "  rawMessage: 'Stream closed with error code NGHTTP2_ENHANCE_YOUR_CALM'",
        "Node.js v26.0.0",
      ].join("\n"),
      /NGHTTP2_ENHANCE_YOUR_CALM/,
    ],
  ])("rejects initialization instead of throwing when the worker exits before init, %s", async (_name, stderrText, message) => {
    forkMock.mockReturnValue(new ExitingBeforeInitChild(stderrText));

    await expect(acquireCursorSdkConnection(poolArgs("test-exit"))).rejects.toThrow(message);
  });
});

describe("Cursor SDK worker orphan guard", () => {
  it("releases the shared one-shot workers, which no session owns", async () => {
    const child = new OneShotSdkChild();
    const replacement = new OneShotSdkChild();
    forkMock.mockReturnValueOnce(child).mockReturnValueOnce(replacement);
    const workspacePath = path.join(os.tmpdir(), `ade-oneshot-dispose-all-${Date.now()}-${Math.random()}`);
    // The prompt returns and leaves the worker warm for the idle window.
    await runCursorSdkLocalPrompt(oneShotArgs(workspacePath));
    expect(child.disposeCount).toBe(0);

    await disposeAllCursorSdkConnections();

    expect(child.disposeCount).toBe(1);
    expect(child.exitCode).toBe(0);
    // The warm entry is gone, so the next one-shot forks a fresh worker.
    await runCursorSdkLocalPrompt(oneShotArgs(workspacePath));
    expect(forkMock).toHaveBeenCalledTimes(2);
    await disposeAllCursorSdkConnections();
  });
});
