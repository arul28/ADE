import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireCursorSdkConnection,
  buildCursorSdkPaths,
  buildCursorSdkWorkerEnv,
  cleanupCursorSdkRuntimePaths,
  CURSOR_SDK_REPLACE_WAIT_MS,
  isCursorSdkPooledAlive,
  poisonCursorSdkConnection,
  releaseCursorSdkConnection,
  releaseCursorSdkConnectionAfterIdle,
  resolveCursorSdkUserHome,
} from "./cursorSdkPool";
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
