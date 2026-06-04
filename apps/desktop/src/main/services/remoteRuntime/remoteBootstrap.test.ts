import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Client } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";
import {
  bootstrapRemoteRuntime,
  buildRemoteRuntimeEnvironmentPrefix,
  normalizeRemoteArch,
  normalizeRuntimeVersion,
  resolveRemoteRuntimeLayout,
  resolveRemoteRuntimeLayoutCandidates,
  selectRemoteRuntimeVersion,
  shouldUploadBundledRuntime,
  validateRemoteRuntimeInitializeResult,
} from "./remoteBootstrap";

const connectSshWithRouteMock = vi.hoisted(() => vi.fn());
const execSshMock = vi.hoisted(() => vi.fn());
const openSshRuntimeTransportMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const initializeMock = vi.hoisted(() => vi.fn());
const callMock = vi.hoisted(() => vi.fn());
const runtimeRpcClientMock = vi.hoisted(() => vi.fn());

const guardedUploadCommandPattern = (remoteFilePattern: string): RegExp =>
  new RegExp(
    String.raw`^umask 077; cat >> ${remoteFilePattern} & ade_upload_pid=\$!; .*sleep 75; .*exit "\$ade_upload_status"$`,
  );

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("./sshTransport", () => ({
  connectSshWithRoute: connectSshWithRouteMock,
  execSsh: execSshMock,
  openSshRuntimeTransport: openSshRuntimeTransportMock,
}));

vi.mock("./runtimeRpcClient", () => ({
  RuntimeRpcClient: runtimeRpcClientMock,
}));

describe("normalizeRemoteArch", () => {
  it("normalizes supported uname platform and architecture pairs", () => {
    expect(normalizeRemoteArch("Darwin arm64")).toEqual({
      platform: "darwin",
      arch: "arm64",
      label: "darwin-arm64",
    });
    expect(normalizeRemoteArch("Linux x86_64")).toEqual({
      platform: "linux",
      arch: "x64",
      label: "linux-x64",
    });
    expect(normalizeRemoteArch("Linux aarch64")).toEqual({
      platform: "linux",
      arch: "arm64",
      label: "linux-arm64",
    });
  });

  it("rejects unsupported remote ADE service targets instead of guessing", () => {
    expect(() => normalizeRemoteArch("FreeBSD riscv64")).toThrow(/unsupported remote ade service platform/i);
    expect(() => normalizeRemoteArch("Linux riscv64")).toThrow(/unsupported remote ade service platform/i);
  });
});

describe("normalizeRuntimeVersion", () => {
  it("normalizes plain and prefixed ADE version output", () => {
    expect(normalizeRuntimeVersion("1.0.0-beta.1\n")).toBe("1.0.0-beta.1");
    expect(normalizeRuntimeVersion("ade 1.0.0-beta.1\n")).toBe("1.0.0-beta.1");
  });

  it("returns null for empty version output", () => {
    expect(normalizeRuntimeVersion("\n")).toBeNull();
  });
});

describe("selectRemoteRuntimeVersion", () => {
  it("prefers executable output over the marker file", () => {
    expect(selectRemoteRuntimeVersion({
      markerVersion: "1.0.0",
      executableVersion: "1.0.1",
    })).toBe("1.0.1");
  });

  it("uses the marker when the executable cannot report a version", () => {
    expect(selectRemoteRuntimeVersion({
      markerVersion: "1.0.0",
      executableVersion: null,
    })).toBe("1.0.0");
  });

  it("uses the marker when the executable reports the placeholder version", () => {
    expect(selectRemoteRuntimeVersion({
      markerVersion: "1.0.0",
      executableVersion: "0.0.0",
    })).toBe("1.0.0");
  });
});

describe("shouldUploadBundledRuntime", () => {
  it("uploads when the marker matches but the remote executable is missing", () => {
    expect(shouldUploadBundledRuntime({
      localBinaryAvailable: true,
      executableVersion: null,
      appVersion: "1.0.0",
    })).toBe(true);
  });

  it("skips upload when the executable itself matches the desktop version", () => {
    expect(shouldUploadBundledRuntime({
      localBinaryAvailable: true,
      executableVersion: "1.0.0",
      appVersion: "1.0.0",
      localBinarySha256: "abc",
      remoteBinarySha256: "abc",
    })).toBe(false);
  });

  it("skips upload when a placeholder executable has a matching marker and binary identity", () => {
    expect(shouldUploadBundledRuntime({
      localBinaryAvailable: true,
      executableVersion: "0.0.0",
      markerVersion: "1.0.0",
      appVersion: "1.0.0",
      localBinarySha256: "abc",
      remoteBinarySha256: "abc",
      remoteBinaryMatchesLocal: true,
    })).toBe(false);
  });

  it("uploads when the executable version matches but the binary hash changed", () => {
    expect(shouldUploadBundledRuntime({
      localBinaryAvailable: true,
      executableVersion: "1.0.0",
      appVersion: "1.0.0",
      localBinarySha256: "new",
      remoteBinarySha256: "old",
    })).toBe(true);
  });

  it("uploads when marker files match but the actual remote binary does not", () => {
    expect(shouldUploadBundledRuntime({
      localBinaryAvailable: true,
      executableVersion: "1.0.0",
      appVersion: "1.0.0",
      localBinarySha256: "abc",
      remoteBinarySha256: "abc",
      remoteBinaryMatchesLocal: false,
    })).toBe(true);
  });

  it("does not upload when no bundled runtime exists for the remote architecture", () => {
    expect(shouldUploadBundledRuntime({
      localBinaryAvailable: false,
      executableVersion: null,
      appVersion: "1.0.0",
    })).toBe(false);
  });
});

describe("buildRemoteRuntimeEnvironmentPrefix", () => {
  it("adds ADE and user-install bins to the remote runtime PATH", () => {
    expect(buildRemoteRuntimeEnvironmentPrefix({
      archLabel: "linux-x64",
      nativeDepsReady: false,
      layout: resolveRemoteRuntimeLayout({} as NodeJS.ProcessEnv),
    })).toBe('ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" ');
  });

  it("adds the uploaded native dependency bundle to NODE_PATH", () => {
    expect(buildRemoteRuntimeEnvironmentPrefix({
      archLabel: "darwin-arm64",
      nativeDepsReady: true,
      layout: resolveRemoteRuntimeLayout({} as NodeJS.ProcessEnv),
    })).toContain('NODE_PATH="$HOME/.ade/runtime/darwin-arm64/node_modules${NODE_PATH:+:$NODE_PATH}"');
  });

  it("can suppress service installation for shared runtime fallback sessions", () => {
    expect(buildRemoteRuntimeEnvironmentPrefix({
      archLabel: "linux-x64",
      nativeDepsReady: false,
      layout: resolveRemoteRuntimeLayout({} as NodeJS.ProcessEnv),
      disableRuntimeServiceInstall: true,
    })).toBe('ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1 ');
  });

  it("uses isolated remote paths for Alpha and Beta channels", () => {
    const alphaLayout = resolveRemoteRuntimeLayout({ ADE_PACKAGE_CHANNEL: "alpha" } as NodeJS.ProcessEnv);
    const betaLayout = resolveRemoteRuntimeLayout({ ADE_PACKAGE_CHANNEL: "beta" } as NodeJS.ProcessEnv);

    expect(alphaLayout).toMatchObject({
      homeDirName: ".ade-alpha",
      binaryRelative: ".ade-alpha/bin/ade",
      versionExpr: "$HOME/.ade-alpha/bin/ade.version",
    });
    expect(buildRemoteRuntimeEnvironmentPrefix({
      archLabel: "darwin-arm64",
      nativeDepsReady: true,
      layout: alphaLayout,
    })).toBe('ADE_HOME="$HOME/.ade-alpha" PATH="$HOME/.ade-alpha/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" ADE_PACKAGE_CHANNEL="alpha" ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1 NODE_PATH="$HOME/.ade-alpha/runtime/darwin-arm64/node_modules${NODE_PATH:+:$NODE_PATH}" ');
    expect(betaLayout).toMatchObject({
      homeDirName: ".ade-beta",
      binaryRelative: ".ade-beta/bin/ade",
      versionExpr: "$HOME/.ade-beta/bin/ade.version",
    });
  });

  it("checks the selected channel first, then falls back to shared and other channel runtime homes", () => {
    expect(resolveRemoteRuntimeLayoutCandidates({ ADE_PACKAGE_CHANNEL: "beta" } as NodeJS.ProcessEnv).map((layout) => layout.homeDirName)).toEqual([
      ".ade-beta",
      ".ade",
      ".ade-alpha",
    ]);
    expect(resolveRemoteRuntimeLayoutCandidates({ ADE_PACKAGE_CHANNEL: "alpha" } as NodeJS.ProcessEnv).map((layout) => layout.homeDirName)).toEqual([
      ".ade-alpha",
      ".ade",
      ".ade-beta",
    ]);
  });
});

describe("validateRemoteRuntimeInitializeResult", () => {
  it("accepts a multi-project runtime with the expected version", () => {
    expect(() => validateRemoteRuntimeInitializeResult({
      expectedVersion: "1.0.0",
      result: {
        runtimeInfo: { version: "1.0.0", multiProject: true },
        capabilities: {
          projects: true,
          machineProjects: {
            browseDirectories: true,
            getDetail: true,
            getWorkSummary: true,
            getDefaultParentDir: true,
            create: true,
            clone: true,
            listMyGitHubRepos: true,
          },
        },
      },
    })).not.toThrow();
  });

  it("rejects a stale single-project runtime", () => {
    expect(() => validateRemoteRuntimeInitializeResult({
      expectedVersion: null,
      result: {
        runtimeInfo: { version: "0.9.0" },
        capabilities: { actions: { listChanged: true } },
      },
    })).toThrow(/multi-project/i);
  });

  it("accepts compatible older runtimes and records missing machine-level project capabilities", () => {
    const info = validateRemoteRuntimeInitializeResult({
      expectedVersion: "1.0.0",
      result: {
        runtimeInfo: { version: "0.9.0", multiProject: true },
        capabilities: { projects: true },
      },
    });
    expect(info.version).toBe("0.9.0");
    expect(info.capabilities.machineProjects.browseDirectories).toBe(false);
    expect(info.compatibilityWarnings.join("\n")).toMatch(/local ADE is 1\.0\.0/i);
    expect(info.compatibilityWarnings.join("\n")).toMatch(/missing project capabilities/i);
  });

  it("does not reject a bundled runtime solely for reporting a different compatible version", () => {
    expect(validateRemoteRuntimeInitializeResult({
      expectedVersion: "1.0.0",
      result: {
        runtimeInfo: { version: "0.9.0", multiProject: true },
        capabilities: {
          projects: true,
          machineProjects: {
            browseDirectories: true,
            getDetail: true,
            getWorkSummary: true,
            getDefaultParentDir: true,
            create: true,
            clone: true,
            listMyGitHubRepos: true,
          },
        },
      },
    }).compatibilityWarnings.join("\n")).toMatch(/reported 0\.9\.0/i);
  });
});

const APP_VERSION = "2.0.0";

const uploadTarget: RemoteRuntimeTarget = {
  id: "target-1",
  name: "Build host",
  hostname: "build-host.local",
  sshUser: "ade",
  port: 22,
  sshKeyPath: null,
  lastSeenArch: null,
  runtimeBinaryVersion: null,
  lastConnectedAt: null,
};

const uploadRoute = {
  hostname: uploadTarget.hostname,
  port: uploadTarget.port,
  source: "manual" as const,
  lastSucceededAt: null,
};

function ok(stdout = "") {
  return { stdout, stderr: "", code: 0 };
}

function createFakeSpawnProcess(options: { closeCode?: number; error?: Error; stderr?: string } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(() => true),
    end: vi.fn(),
    destroy: vi.fn(),
  });
  child.kill = vi.fn();
  setImmediate(() => {
    if (options.error) {
      child.emit("error", options.error);
      return;
    }
    if (options.stderr) child.stderr.emit("data", Buffer.from(options.stderr));
    child.emit("close", options.closeCode ?? 0, null);
  });
  return child;
}

function createTempResources(
  archLabel = "linux-x64",
  options: { nativeDeps?: boolean } = {},
): { resourcesPath: string; binaryPath: string; binarySha256: string; cleanup: () => void } {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-runtime-"));
  const runtimeDir = path.join(resourcesPath, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const binaryPath = path.join(runtimeDir, `ade-${archLabel}`);
  fs.writeFileSync(binaryPath, "#!/bin/sh\n");
  if (options.nativeDeps) {
    fs.writeFileSync(path.join(runtimeDir, `ade-${archLabel}.native.tar.gz`), "native deps fixture\n");
  }
  const binarySha256 = crypto.createHash("sha256").update(fs.readFileSync(binaryPath)).digest("hex");
  return {
    resourcesPath,
    binaryPath,
    binarySha256,
    cleanup: () => fs.rmSync(resourcesPath, { recursive: true, force: true }),
  };
}

function createFakeSsh(options: { execError?: Error; channelError?: Error; closeCode?: number; stderr?: string } = {}) {
  const exec = vi.fn((command: string, callback: (error: Error | null, channel: PassThrough & { stderr: PassThrough }) => void) => {
    const channel = new PassThrough() as PassThrough & { stderr: PassThrough };
    channel.stderr = new PassThrough();
    channel.resume();
    if (options.execError) {
      setImmediate(() => callback(options.execError!, channel));
      return;
    }
    channel.on("finish", () => {
      setImmediate(() => {
        if (options.channelError) {
          channel.emit("error", options.channelError);
          return;
        }
        if (options.stderr) channel.stderr.emit("data", Buffer.from(options.stderr));
        channel.emit("exit", options.closeCode ?? 0, null);
        channel.emit("close", options.closeCode ?? 0, null);
      });
    });
    callback(null, channel);
  });
  const end = vi.fn();
  const ssh = Object.assign(new EventEmitter(), { exec, end }) as unknown as Client;
  return { ssh, exec, end };
}

function createRegistry() {
  return {
    update: vi.fn((_id: string, patch: Partial<RemoteRuntimeTarget>) => ({
      ...uploadTarget,
      ...patch,
    })),
  } as unknown as RemoteTargetRegistry & { update: ReturnType<typeof vi.fn> };
}

describe("bootstrapRemoteRuntime upload flow", () => {
  let cleanupResources: (() => void) | null = null;
  const originalPackageChannel = process.env.ADE_PACKAGE_CHANNEL;

  beforeEach(() => {
    delete process.env.ADE_PACKAGE_CHANNEL;
    connectSshWithRouteMock.mockReset();
    execSshMock.mockReset();
    openSshRuntimeTransportMock.mockReset();
    spawnMock.mockReset();
    initializeMock.mockReset();
    callMock.mockReset();
    runtimeRpcClientMock.mockReset();
    cleanupResources = null;

    runtimeRpcClientMock.mockImplementation(() => ({
      initialize: initializeMock,
      call: callMock,
      close: vi.fn(),
    }));
    openSshRuntimeTransportMock.mockResolvedValue({
      onData: vi.fn(),
      onError: vi.fn(),
      onClose: vi.fn(),
      write: vi.fn(),
      close: vi.fn(),
    });
    spawnMock.mockImplementation(() => createFakeSpawnProcess());
    initializeMock.mockResolvedValue({
      runtimeInfo: { version: APP_VERSION, multiProject: true },
      capabilities: {
        projects: true,
        machineProjects: {
          browseDirectories: true,
          getDetail: true,
          getWorkSummary: true,
          getDefaultParentDir: true,
          create: true,
          clone: true,
          listMyGitHubRepos: true,
        },
      },
    });
    callMock.mockImplementation(async (method: string) => {
      if (method === "projects.list") {
        return [{
          projectId: "project-1",
          rootPath: "/srv/ade",
          displayName: "ADE",
          addedAt: 1,
          lastOpenedAt: 2,
          gitOriginUrl: "git@github.com:example/ade.git",
        }];
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    });
  });

  afterEach(() => {
    if (originalPackageChannel === undefined) delete process.env.ADE_PACKAGE_CHANNEL;
    else process.env.ADE_PACKAGE_CHANNEL = originalPackageChannel;
    cleanupResources?.();
  });

  it("uploads a missing bundled runtime, verifies its version, and opens stdio RPC from ~/.ade/bin", async () => {
    const resources = createTempResources();
    cleanupResources = resources.cleanup;
    const fakeSsh = createFakeSsh();
    const registry = createRegistry();
    const targetFromSshConfig: RemoteRuntimeTarget = {
      ...uploadTarget,
      sshUser: null,
      port: null,
    };
    const connectedRoute = {
      ...uploadRoute,
      port: null,
    };
    connectSshWithRouteMock.mockResolvedValue({
      client: fakeSsh.ssh,
      route: connectedRoute,
      config: {
        host: "resolved-build-host.local",
        port: 2200,
        username: "admin",
      },
    });
    const commands: string[] = [];
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      commands.push(command);
      if (command === "uname -sm") return ok("Linux x86_64\n");
      if (command === "cat $HOME/.ade/bin/ade.version 2>/dev/null || true") return ok("");
      if (command === "cat $HOME/.ade/bin/ade.sha256 2>/dev/null || true") return ok("");
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("");
      if (command === "mkdir -p $HOME/.ade/bin && chmod 700 $HOME/.ade/bin") return ok("");
      if (command.match(/^rm -f \$HOME\/\.ade\/bin\/ade\.upload-.* && umask 077 && : > \$HOME\/\.ade\/bin\/ade\.upload-.* && chmod 600 \$HOME\/\.ade\/bin\/ade\.upload-/)) return ok("");
      if (
        command.includes("wc -c < $HOME/.ade/bin/ade.upload-") &&
        !command.includes("shasum") &&
        !command.includes("mv -f")
      ) return ok(`${fs.statSync(resources.binaryPath).size}\n`);
      if (
        command.includes("wc -c < $HOME/.ade/bin/ade.upload-") &&
        command.includes("shasum -a 256 $HOME/.ade/bin/ade.upload-") &&
        command.includes("mv -f $HOME/.ade/bin/ade.upload-") &&
        command.includes("printf '%s\\n' '2.0.0' > $HOME/.ade/bin/ade.version")
      ) return ok("");
      if (command.includes("$HOME/.ade/bin/ade --version")) return ok("ade 2.0.0\n");
      if (command.includes("$HOME/.ade/bin/ade runtime stop --text")) return ok("");
      throw new Error(`Unexpected SSH command: ${command}`);
    });

    const connected = await bootstrapRemoteRuntime({
      target: targetFromSshConfig,
      registry,
      resourcesPath: resources.resourcesPath,
      appVersion: APP_VERSION,
    });

    expect(connectSshWithRouteMock).toHaveBeenCalledWith(targetFromSshConfig);
    expect(fakeSsh.exec).toHaveBeenCalledWith(
      expect.stringMatching(guardedUploadCommandPattern(String.raw`\$HOME/\.ade/bin/ade\.upload-.*\.tmp`)),
      expect.any(Function),
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(commands.slice(0, 4)).toEqual([
      "uname -sm",
      "cat $HOME/.ade/bin/ade.version 2>/dev/null || true",
      "cat $HOME/.ade/bin/ade.sha256 2>/dev/null || true",
      "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true",
    ]);
    expect(commands).toContain("mkdir -p $HOME/.ade/bin && chmod 700 $HOME/.ade/bin");
    expect(commands.some((command) =>
      command.includes("wc -c < $HOME/.ade/bin/ade.upload-") &&
      command.includes(`printf '%s\\n' '${resources.binarySha256}' > $HOME/.ade/bin/ade.sha256`) &&
      command.includes("mv -f $HOME/.ade/bin/ade.upload-"),
    )).toBe(true);
    expect(commands).toContain(
      'ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" $HOME/.ade/bin/ade --version',
    );
    expect(commands).toContain(
      'ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" $HOME/.ade/bin/ade runtime stop --text >/dev/null 2>&1 || true',
    );
    expect(openSshRuntimeTransportMock).toHaveBeenCalledWith(
      fakeSsh.ssh,
      'ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" $HOME/.ade/bin/ade rpc --stdio',
    );
    expect(initializeMock).toHaveBeenCalledWith("ade-desktop-remote", APP_VERSION);
    expect(callMock).toHaveBeenCalledWith("projects.list", {});
    expect(registry.update).toHaveBeenCalledWith("target-1", {
      lastSeenArch: "linux-x64",
      runtimeBinaryVersion: APP_VERSION,
      lastConnectedAt: expect.any(Number),
      routes: [
        {
          hostname: "build-host.local",
          port: null,
          source: "manual",
          lastSucceededAt: expect.any(Number),
        },
      ],
    });
    expect(connected.result).toMatchObject({
      arch: "linux-x64",
      version: APP_VERSION,
      projects: [{ projectId: "project-1", rootPath: "/srv/ade" }],
    });
    expect(fakeSsh.end).not.toHaveBeenCalled();
  });

  it("tries a same-version runtime before replacing it for a hash-only mismatch", async () => {
    const resources = createTempResources();
    cleanupResources = resources.cleanup;
    const fakeSsh = createFakeSsh();
    const registry = createRegistry();
    connectSshWithRouteMock.mockResolvedValue({
      client: fakeSsh.ssh,
      route: uploadRoute,
    });
    const commands: string[] = [];
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      commands.push(command);
      if (command === "uname -sm") return ok("Linux x86_64\n");
      if (command === "cat $HOME/.ade/bin/ade.version 2>/dev/null || true") return ok(`${APP_VERSION}\n`);
      if (command === "cat $HOME/.ade/bin/ade.sha256 2>/dev/null || true") return ok("previous-local-build-sha\n");
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("ade 0.0.0\n");
      if (
        command.includes("wc -c < $HOME/.ade/bin/ade") &&
        command.includes("shasum -a 256 $HOME/.ade/bin/ade") &&
        command.includes("echo ok")
      ) return ok("");
      throw new Error(`Unexpected SSH command: ${command}`);
    });

    const connected = await bootstrapRemoteRuntime({
      target: uploadTarget,
      registry,
      resourcesPath: resources.resourcesPath,
      appVersion: APP_VERSION,
    });

    expect(fakeSsh.exec).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(commands).not.toContain("mkdir -p $HOME/.ade/bin && chmod 700 $HOME/.ade/bin");
    expect(commands.some((command) => command.includes("$HOME/.ade/bin/ade.upload-"))).toBe(false);
    expect(openSshRuntimeTransportMock).toHaveBeenCalledWith(
      fakeSsh.ssh,
      'ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" $HOME/.ade/bin/ade rpc --stdio',
    );
    expect(connected.result).toMatchObject({
      arch: "linux-x64",
      version: APP_VERSION,
      projects: [{ projectId: "project-1", rootPath: "/srv/ade" }],
    });
  });

  it("fails closed when an uploaded runtime reports the wrong version", async () => {
    const resources = createTempResources();
    cleanupResources = resources.cleanup;
    const fakeSsh = createFakeSsh();
    const registry = createRegistry();
    connectSshWithRouteMock.mockResolvedValue({
      client: fakeSsh.ssh,
      route: uploadRoute,
    });
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      if (command === "uname -sm") return ok("Linux x86_64\n");
      if (command === "cat $HOME/.ade/bin/ade.version 2>/dev/null || true") return ok("");
      if (command === "cat $HOME/.ade/bin/ade.sha256 2>/dev/null || true") return ok("");
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("");
      if (command === "mkdir -p $HOME/.ade/bin && chmod 700 $HOME/.ade/bin") return ok("");
      if (command.match(/^rm -f \$HOME\/\.ade\/bin\/ade\.upload-.* && umask 077 && : > \$HOME\/\.ade\/bin\/ade\.upload-.* && chmod 600 \$HOME\/\.ade\/bin\/ade\.upload-/)) return ok("");
      if (
        command.includes("wc -c < $HOME/.ade/bin/ade.upload-") &&
        !command.includes("shasum") &&
        !command.includes("mv -f")
      ) return ok(`${fs.statSync(resources.binaryPath).size}\n`);
      if (
        command.includes("wc -c < $HOME/.ade/bin/ade.upload-") &&
        command.includes("mv -f $HOME/.ade/bin/ade.upload-") &&
        command.includes("printf '%s\\n' '2.0.0' > $HOME/.ade/bin/ade.version")
      ) return ok("");
      if (command.includes("$HOME/.ade/bin/ade --version")) return ok("ade 1.9.0\n");
      throw new Error(`Unexpected SSH command: ${command}`);
    });

    await expect(bootstrapRemoteRuntime({
      target: uploadTarget,
      registry,
      resourcesPath: resources.resourcesPath,
      appVersion: APP_VERSION,
    })).rejects.toThrow(/uploaded ade service version mismatch/i);

    expect(fakeSsh.exec).toHaveBeenCalledWith(
      expect.stringMatching(guardedUploadCommandPattern(String.raw`\$HOME/\.ade/bin/ade\.upload-.*\.tmp`)),
      expect.any(Function),
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(openSshRuntimeTransportMock).not.toHaveBeenCalled();
    expect(initializeMock).not.toHaveBeenCalled();
    expect(registry.update).not.toHaveBeenCalled();
    expect(fakeSsh.end).toHaveBeenCalledTimes(1);
  });

  it("falls back to OpenSSH only when the connected SSH upload fails before writing", async () => {
    const resources = createTempResources();
    cleanupResources = resources.cleanup;
    const fakeSsh = createFakeSsh({ execError: new Error("channel denied") });
    spawnMock.mockImplementation(() => createFakeSpawnProcess({ error: new Error("pipe broke") }));
    const registry = createRegistry();
    connectSshWithRouteMock.mockResolvedValue({
      client: fakeSsh.ssh,
      route: uploadRoute,
    });
    const commands: string[] = [];
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      commands.push(command);
      if (command === "uname -sm") return ok("Linux x86_64\n");
      if (command === "cat $HOME/.ade/bin/ade.version 2>/dev/null || true") return ok("");
      if (command === "cat $HOME/.ade/bin/ade.sha256 2>/dev/null || true") return ok("");
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("");
      if (command === "mkdir -p $HOME/.ade/bin && chmod 700 $HOME/.ade/bin") return ok("");
      if (command.match(/^rm -f \$HOME\/\.ade\/bin\/ade\.upload-.* && umask 077 && : > \$HOME\/\.ade\/bin\/ade\.upload-.* && chmod 600 \$HOME\/\.ade\/bin\/ade\.upload-/)) return ok("");
      if (
        command.includes("wc -c < $HOME/.ade/bin/ade.upload-") &&
        !command.includes("shasum") &&
        !command.includes("mv -f")
      ) return ok("0\n");
      if (command.startsWith("rm -f $HOME/.ade/bin/ade.upload-")) return ok("");
      throw new Error(`Unexpected SSH command: ${command}`);
    });

    await expect(bootstrapRemoteRuntime({
      target: uploadTarget,
      registry,
      resourcesPath: resources.resourcesPath,
      appVersion: APP_VERSION,
    })).rejects.toThrow(/existing SSH session: SSH upload channel failed.*channel denied.*OpenSSH fallback failed: SSH upload process failed.*pipe broke/i);

    expect(fakeSsh.exec).toHaveBeenCalledWith(
      expect.stringMatching(guardedUploadCommandPattern(String.raw`\$HOME/\.ade/bin/ade\.upload-.*\.tmp`)),
      expect.any(Function),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining([
        "-p",
        "22",
        "ade@build-host.local",
        expect.stringMatching(guardedUploadCommandPattern(String.raw`\$HOME/\.ade/bin/ade\.upload-.*\.tmp`)),
      ]),
      expect.objectContaining({ stdio: [expect.any(Number), "ignore", "pipe"] }),
    );
    expect(commands.some((command) => command.startsWith("rm -f $HOME/.ade/bin/ade.upload-"))).toBe(true);
    expect(openSshRuntimeTransportMock).not.toHaveBeenCalled();
    expect(initializeMock).not.toHaveBeenCalled();
    expect(registry.update).not.toHaveBeenCalled();
    expect(fakeSsh.end).toHaveBeenCalledTimes(1);
  });

  it("uses the matching isolated remote home for Alpha channel bootstrap", async () => {
    process.env.ADE_PACKAGE_CHANNEL = "alpha";
    const resources = createTempResources("darwin-arm64", { nativeDeps: true });
    cleanupResources = resources.cleanup;
    const fakeSsh = createFakeSsh();
    const registry = createRegistry();
    connectSshWithRouteMock.mockResolvedValue({
      client: fakeSsh.ssh,
      route: uploadRoute,
    });
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      if (command === "uname -sm") return ok("Darwin arm64\n");
      if (command === "cat $HOME/.ade-alpha/bin/ade.version 2>/dev/null || true") return ok("");
      if (command === "cat $HOME/.ade-alpha/bin/ade.sha256 2>/dev/null || true") return ok("");
      if (command === "test -x $HOME/.ade-alpha/bin/ade && $HOME/.ade-alpha/bin/ade --version || true") return ok("");
      if (command === "mkdir -p $HOME/.ade-alpha/bin && chmod 700 $HOME/.ade-alpha/bin") return ok("");
      if (command === "mkdir -p $HOME/.ade-alpha/runtime") return ok("");
      if (command.match(/^rm -f \$HOME\/\.ade-alpha\/bin\/ade\.upload-.* && umask 077 && : > \$HOME\/\.ade-alpha\/bin\/ade\.upload-.* && chmod 600 \$HOME\/\.ade-alpha\/bin\/ade\.upload-/)) return ok("");
      if (command.match(/^rm -f \$HOME\/\.ade-alpha\/runtime\/ade-darwin-arm64\.native\.tar\.gz\.upload-.* && umask 077 && : > \$HOME\/\.ade-alpha\/runtime\/ade-darwin-arm64\.native\.tar\.gz\.upload-.* && chmod 600 \$HOME\/\.ade-alpha\/runtime\/ade-darwin-arm64\.native\.tar\.gz\.upload-/)) return ok("");
      if (
        command.includes("wc -c < $HOME/.ade-alpha/bin/ade.upload-") &&
        !command.includes("shasum") &&
        !command.includes("mv -f")
      ) return ok(`${fs.statSync(resources.binaryPath).size}\n`);
      if (
        command.includes("wc -c < $HOME/.ade-alpha/runtime/ade-darwin-arm64.native.tar.gz.upload-") &&
        !command.includes("shasum") &&
        !command.includes("mv -f")
      ) return ok(`${fs.statSync(path.join(resources.resourcesPath, "runtime", "ade-darwin-arm64.native.tar.gz")).size}\n`);
      if (
        command.includes("wc -c < $HOME/.ade-alpha/bin/ade.upload-") &&
        command.includes("mv -f $HOME/.ade-alpha/bin/ade.upload-") &&
        command.includes("printf '%s\\n' '2.0.0' > $HOME/.ade-alpha/bin/ade.version")
      ) return ok("");
      if (command.includes("test -d $HOME/.ade-alpha/runtime/darwin-arm64/node_modules")) return ok("ok\n");
      if (
        command.includes("wc -c < $HOME/.ade-alpha/runtime/ade-darwin-arm64.native.tar.gz.upload-") &&
        command.includes("mv -f $HOME/.ade-alpha/runtime/ade-darwin-arm64.native.tar.gz.upload-") &&
        command.includes("tar -xzf $HOME/.ade-alpha/runtime/ade-darwin-arm64.native.tar.gz")
      ) return ok("");
      if (command === "codesign --force --sign - $HOME/.ade-alpha/bin/ade") return ok("");
      if (command.includes("$HOME/.ade-alpha/bin/ade --version")) return ok("ade 2.0.0\n");
      if (command.includes("$HOME/.ade-alpha/bin/ade runtime stop --text")) return ok("");
      throw new Error(`Unexpected SSH command: ${command}`);
    });

    await bootstrapRemoteRuntime({
      target: uploadTarget,
      registry,
      resourcesPath: resources.resourcesPath,
      appVersion: APP_VERSION,
    });

    expect(fakeSsh.exec).toHaveBeenCalledWith(
      expect.stringMatching(guardedUploadCommandPattern(String.raw`\$HOME/\.ade-alpha/bin/ade\.upload-.*\.tmp`)),
      expect.any(Function),
    );
    expect(fakeSsh.exec).toHaveBeenCalledWith(
      expect.stringMatching(guardedUploadCommandPattern(String.raw`\$HOME/\.ade-alpha/runtime/ade-darwin-arm64\.native\.tar\.gz\.upload-.*\.tmp`)),
      expect.any(Function),
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execSshMock).toHaveBeenCalledWith(fakeSsh.ssh, "codesign --force --sign - $HOME/.ade-alpha/bin/ade");
    expect(openSshRuntimeTransportMock).toHaveBeenCalledWith(
      fakeSsh.ssh,
      'ADE_HOME="$HOME/.ade-alpha" PATH="$HOME/.ade-alpha/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" ADE_PACKAGE_CHANNEL="alpha" ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1 NODE_PATH="$HOME/.ade-alpha/runtime/darwin-arm64/node_modules${NODE_PATH:+:$NODE_PATH}" $HOME/.ade-alpha/bin/ade rpc --stdio',
    );
  });

  it("falls back across channel homes when no bundled runtime is available in dev", async () => {
    process.env.ADE_PACKAGE_CHANNEL = "beta";
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-runtime-empty-"));
    cleanupResources = () => fs.rmSync(resourcesPath, { recursive: true, force: true });
    const fakeSsh = createFakeSsh();
    const registry = createRegistry();
    connectSshWithRouteMock.mockResolvedValue({
      client: fakeSsh.ssh,
      route: uploadRoute,
    });
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      if (command === "uname -sm") return ok("Linux x86_64\n");
      if (command === "cat $HOME/.ade-beta/bin/ade.version 2>/dev/null || true") return ok("");
      if (command === "cat $HOME/.ade-beta/bin/ade.sha256 2>/dev/null || true") return ok("");
      if (command === "test -x $HOME/.ade-beta/bin/ade && $HOME/.ade-beta/bin/ade --version || true") return ok("");
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("");
      if (command === "test -x $HOME/.ade-alpha/bin/ade && $HOME/.ade-alpha/bin/ade --version || true") return ok("ade 1.9.0-alpha.4\n");
      if (command === "cat $HOME/.ade-alpha/bin/ade.version 2>/dev/null || true") return ok("1.9.0-alpha.4\n");
      if (command === "cat $HOME/.ade-alpha/bin/ade.sha256 2>/dev/null || true") return ok("old-sha\n");
      throw new Error(`Unexpected SSH command: ${command}`);
    });
    initializeMock.mockResolvedValueOnce({
      runtimeInfo: { version: "1.9.0-alpha.4", packageChannel: "alpha", multiProject: true },
      capabilities: {
        projects: true,
        machineProjects: {
          browseDirectories: true,
          getDetail: true,
          getWorkSummary: true,
          getDefaultParentDir: true,
          create: true,
          clone: true,
          listMyGitHubRepos: true,
        },
      },
    });

    const connected = await bootstrapRemoteRuntime({
      target: uploadTarget,
      registry,
      resourcesPath,
      appVersion: APP_VERSION,
    });

    expect(fakeSsh.exec).not.toHaveBeenCalled();
    expect(openSshRuntimeTransportMock).toHaveBeenCalledWith(
      fakeSsh.ssh,
      'ADE_HOME="$HOME/.ade-alpha" PATH="$HOME/.ade-alpha/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" ADE_PACKAGE_CHANNEL="alpha" ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1 ade rpc --stdio',
    );
    expect(connected.result.version).toBe("1.9.0-alpha.4");
    expect(connected.result.compatibilityWarnings).toEqual([
      expect.stringContaining("Using remote runtime home .ade-alpha"),
    ]);
  });

  it("tries another channel home when the preferred runtime cannot initialize compatible RPC", async () => {
    process.env.ADE_PACKAGE_CHANNEL = "beta";
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-runtime-empty-"));
    cleanupResources = () => fs.rmSync(resourcesPath, { recursive: true, force: true });
    const fakeSsh = createFakeSsh();
    const registry = createRegistry();
    connectSshWithRouteMock.mockResolvedValue({
      client: fakeSsh.ssh,
      route: uploadRoute,
    });
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      if (command === "uname -sm") return ok("Linux x86_64\n");
      if (command === "cat $HOME/.ade-beta/bin/ade.version 2>/dev/null || true") return ok("1.8.0-beta.2\n");
      if (command === "cat $HOME/.ade-beta/bin/ade.sha256 2>/dev/null || true") return ok("old-beta-sha\n");
      if (command === "test -x $HOME/.ade-beta/bin/ade && $HOME/.ade-beta/bin/ade --version || true") return ok("ade 1.8.0-beta.2\n");
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("");
      if (command === "test -x $HOME/.ade-alpha/bin/ade && $HOME/.ade-alpha/bin/ade --version || true") return ok("ade 1.9.0-alpha.4\n");
      if (command === "test -d $HOME/.ade-alpha/runtime/linux-x64/node_modules && echo ok || true") return ok("ok\n");
      throw new Error(`Unexpected SSH command: ${command}`);
    });
    initializeMock
      .mockResolvedValueOnce({
        runtimeInfo: { version: "1.8.0-beta.2" },
        capabilities: { actions: { listChanged: true } },
      })
      .mockResolvedValueOnce({
        runtimeInfo: { version: "1.9.0-alpha.4", packageChannel: "alpha", multiProject: true },
        capabilities: {
          projects: true,
          machineProjects: {
            browseDirectories: true,
            getDetail: true,
            getWorkSummary: true,
            getDefaultParentDir: true,
            create: true,
            clone: true,
            listMyGitHubRepos: true,
          },
        },
      });

    const connected = await bootstrapRemoteRuntime({
      target: uploadTarget,
      registry,
      resourcesPath,
      appVersion: APP_VERSION,
    });

    expect(openSshRuntimeTransportMock).toHaveBeenNthCalledWith(
      1,
      fakeSsh.ssh,
      'ADE_HOME="$HOME/.ade-beta" PATH="$HOME/.ade-beta/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" ADE_PACKAGE_CHANNEL="beta" ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1 ade rpc --stdio',
    );
    expect(openSshRuntimeTransportMock).toHaveBeenNthCalledWith(
      2,
      fakeSsh.ssh,
      'ADE_HOME="$HOME/.ade-alpha" PATH="$HOME/.ade-alpha/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" ADE_PACKAGE_CHANNEL="alpha" ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1 NODE_PATH="$HOME/.ade-alpha/runtime/linux-x64/node_modules${NODE_PATH:+:$NODE_PATH}" ade rpc --stdio',
    );
    expect(connected.result).toMatchObject({
      version: "1.9.0-alpha.4",
      compatibilityWarnings: [
        expect.stringContaining(".ade-beta could not start a compatible ADE RPC service"),
      ],
    });
  });

  it("suppresses service installation when compatible RPC falls back to the shared runtime home", async () => {
    process.env.ADE_PACKAGE_CHANNEL = "beta";
    const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-runtime-empty-"));
    cleanupResources = () => fs.rmSync(resourcesPath, { recursive: true, force: true });
    const fakeSsh = createFakeSsh();
    const registry = createRegistry();
    connectSshWithRouteMock.mockResolvedValue({
      client: fakeSsh.ssh,
      route: uploadRoute,
    });
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      if (command === "uname -sm") return ok("Linux x86_64\n");
      if (command === "cat $HOME/.ade-beta/bin/ade.version 2>/dev/null || true") return ok("1.8.0-beta.2\n");
      if (command === "cat $HOME/.ade-beta/bin/ade.sha256 2>/dev/null || true") return ok("old-beta-sha\n");
      if (command === "test -x $HOME/.ade-beta/bin/ade && $HOME/.ade-beta/bin/ade --version || true") return ok("ade 1.8.0-beta.2\n");
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("ade 1.9.0\n");
      if (command === "test -d $HOME/.ade/runtime/linux-x64/node_modules && echo ok || true") return ok("ok\n");
      throw new Error(`Unexpected SSH command: ${command}`);
    });
    initializeMock
      .mockResolvedValueOnce({
        runtimeInfo: { version: "1.8.0-beta.2" },
        capabilities: { actions: { listChanged: true } },
      })
      .mockResolvedValueOnce({
        runtimeInfo: { version: "1.9.0", packageChannel: null, multiProject: true },
        capabilities: {
          projects: true,
          machineProjects: {
            browseDirectories: true,
            getDetail: true,
            getWorkSummary: true,
            getDefaultParentDir: true,
            create: true,
            clone: true,
            listMyGitHubRepos: true,
          },
        },
      });

    await bootstrapRemoteRuntime({
      target: uploadTarget,
      registry,
      resourcesPath,
      appVersion: APP_VERSION,
    });

    expect(openSshRuntimeTransportMock).toHaveBeenNthCalledWith(
      2,
      fakeSsh.ssh,
      'ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1 NODE_PATH="$HOME/.ade/runtime/linux-x64/node_modules${NODE_PATH:+:$NODE_PATH}" ade rpc --stdio',
    );
  });

  it("connects to a same-version runtime with missing optional project capabilities", async () => {
    const resources = createTempResources();
    cleanupResources = resources.cleanup;
    const fakeSsh = createFakeSsh();
    const registry = createRegistry();
    connectSshWithRouteMock.mockResolvedValue({
      client: fakeSsh.ssh,
      route: uploadRoute,
    });
    const commands: string[] = [];
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      commands.push(command);
      if (command === "uname -sm") return ok("Linux x86_64\n");
      if (command === "cat $HOME/.ade/bin/ade.version 2>/dev/null || true") return ok("2.0.0\n");
      if (command === "cat $HOME/.ade/bin/ade.sha256 2>/dev/null || true") return ok(`${resources.binarySha256}\n`);
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("ade 2.0.0\n");
      if (
        command.includes("wc -c < $HOME/.ade/bin/ade") &&
        command.includes("shasum -a 256 $HOME/.ade/bin/ade") &&
        command.includes("echo ok")
      ) return ok("ok\n");
      if (command.includes("$HOME/.ade/bin/ade runtime stop --text")) return ok("");
      throw new Error(`Unexpected SSH command: ${command}`);
    });
    initializeMock.mockResolvedValueOnce({
      runtimeInfo: { version: APP_VERSION, multiProject: true },
      capabilities: { projects: true },
    });

    await expect(bootstrapRemoteRuntime({
      target: uploadTarget,
      registry,
      resourcesPath: resources.resourcesPath,
      appVersion: APP_VERSION,
    })).resolves.toMatchObject({
      result: {
        arch: "linux-x64",
        version: APP_VERSION,
        capabilities: {
          projects: true,
          machineProjects: {
            browseDirectories: false,
          },
        },
        compatibilityWarnings: [
          expect.stringContaining("missing project capabilities"),
        ],
      },
    });

    expect(fakeSsh.exec).not.toHaveBeenCalled();
    expect(openSshRuntimeTransportMock).toHaveBeenCalledTimes(1);
    expect(commands).not.toContain(
      'ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" $HOME/.ade/bin/ade runtime stop --text >/dev/null 2>&1 || true',
    );
  });
});
