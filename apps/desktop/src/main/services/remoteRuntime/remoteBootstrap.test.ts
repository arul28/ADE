import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  selectRemoteRuntimeVersion,
  shouldUploadBundledRuntime,
  validateRemoteRuntimeInitializeResult,
} from "./remoteBootstrap";

const connectSshMock = vi.hoisted(() => vi.fn());
const execSshMock = vi.hoisted(() => vi.fn());
const openSshRuntimeTransportMock = vi.hoisted(() => vi.fn());
const initializeMock = vi.hoisted(() => vi.fn());
const callMock = vi.hoisted(() => vi.fn());
const runtimeRpcClientMock = vi.hoisted(() => vi.fn());

vi.mock("./sshTransport", () => ({
  connectSsh: connectSshMock,
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

  it("uploads when the executable version matches but the binary hash changed", () => {
    expect(shouldUploadBundledRuntime({
      localBinaryAvailable: true,
      executableVersion: "1.0.0",
      appVersion: "1.0.0",
      localBinarySha256: "new",
      remoteBinarySha256: "old",
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
    })).toBe('ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" ');
  });

  it("adds the uploaded native dependency bundle to NODE_PATH", () => {
    expect(buildRemoteRuntimeEnvironmentPrefix({
      archLabel: "darwin-arm64",
      nativeDepsReady: true,
    })).toContain('NODE_PATH="$HOME/.ade/runtime/darwin-arm64/node_modules${NODE_PATH:+:$NODE_PATH}"');
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

  it("rejects a multi-project runtime that cannot handle machine-level project operations", () => {
    expect(() => validateRemoteRuntimeInitializeResult({
      expectedVersion: "1.0.0",
      result: {
        runtimeInfo: { version: "1.0.0", multiProject: true },
        capabilities: { projects: true },
      },
    })).toThrow(/missing project capability/i);
  });

  it("rejects a bundled runtime with the wrong reported version", () => {
    expect(() => validateRemoteRuntimeInitializeResult({
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
    })).toThrow(/version mismatch/i);
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

function ok(stdout = "") {
  return { stdout, stderr: "", code: 0 };
}

function createTempResources(archLabel = "linux-x64"): { resourcesPath: string; binaryPath: string; binarySha256: string; cleanup: () => void } {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-runtime-"));
  const runtimeDir = path.join(resourcesPath, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const binaryPath = path.join(runtimeDir, `ade-${archLabel}`);
  fs.writeFileSync(binaryPath, "#!/bin/sh\n");
  const binarySha256 = crypto.createHash("sha256").update(fs.readFileSync(binaryPath)).digest("hex");
  return {
    resourcesPath,
    binaryPath,
    binarySha256,
    cleanup: () => fs.rmSync(resourcesPath, { recursive: true, force: true }),
  };
}

function createFakeSsh() {
  const sftpEnd = vi.fn();
  const fastPut = vi.fn((_localPath: string, _remotePath: string, _options: object, callback: (error?: Error | null) => void) => {
    callback(null);
  });
  const sftp = vi.fn((callback: (error: Error | null, sftp: { fastPut: typeof fastPut; end: typeof sftpEnd }) => void) => {
    callback(null, { fastPut, end: sftpEnd });
  });
  const end = vi.fn();
  const ssh = { sftp, end } as unknown as Client;
  return { ssh, sftp, fastPut, sftpEnd, end };
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
    if (originalPackageChannel === undefined) delete process.env.ADE_PACKAGE_CHANNEL;
    else process.env.ADE_PACKAGE_CHANNEL = originalPackageChannel;
    connectSshMock.mockReset();
    execSshMock.mockReset();
    openSshRuntimeTransportMock.mockReset();
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
    connectSshMock.mockResolvedValue(fakeSsh.ssh);
    const commands: string[] = [];
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      commands.push(command);
      if (command === "uname -sm") return ok("Linux x86_64\n");
      if (command === "cat $HOME/.ade/bin/ade.version 2>/dev/null || true") return ok("");
      if (command === "cat $HOME/.ade/bin/ade.sha256 2>/dev/null || true") return ok("");
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("");
      if (command === "mkdir -p $HOME/.ade/bin") return ok("");
      if (command.includes("printf '%s\\n' '2.0.0' > $HOME/.ade/bin/ade.version")) return ok("");
      if (command.includes("$HOME/.ade/bin/ade --version")) return ok("ade 2.0.0\n");
      if (command.includes("$HOME/.ade/bin/ade runtime stop --text")) return ok("");
      throw new Error(`Unexpected SSH command: ${command}`);
    });

    const connected = await bootstrapRemoteRuntime({
      target: uploadTarget,
      registry,
      resourcesPath: resources.resourcesPath,
      appVersion: APP_VERSION,
    });

    expect(connectSshMock).toHaveBeenCalledWith(uploadTarget);
    expect(fakeSsh.fastPut).toHaveBeenCalledWith(resources.binaryPath, ".ade/bin/ade", {}, expect.any(Function));
    expect(commands).toEqual([
      "uname -sm",
      "cat $HOME/.ade/bin/ade.version 2>/dev/null || true",
      "cat $HOME/.ade/bin/ade.sha256 2>/dev/null || true",
      "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true",
      "mkdir -p $HOME/.ade/bin",
      `chmod 700 $HOME/.ade/bin && chmod +x $HOME/.ade/bin/ade && printf '%s\\n' '2.0.0' > $HOME/.ade/bin/ade.version && printf '%s\\n' '${resources.binarySha256}' > $HOME/.ade/bin/ade.sha256 && chmod 600 $HOME/.ade/bin/ade.version && chmod 600 $HOME/.ade/bin/ade.sha256`,
      'ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" $HOME/.ade/bin/ade --version',
      'ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" $HOME/.ade/bin/ade runtime stop --text >/dev/null 2>&1 || true',
    ]);
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
    });
    expect(connected.result).toMatchObject({
      arch: "linux-x64",
      version: APP_VERSION,
      projects: [{ projectId: "project-1", rootPath: "/srv/ade" }],
    });
    expect(fakeSsh.end).not.toHaveBeenCalled();
  });

  it("fails closed when an uploaded runtime reports the wrong version", async () => {
    const resources = createTempResources();
    cleanupResources = resources.cleanup;
    const fakeSsh = createFakeSsh();
    const registry = createRegistry();
    connectSshMock.mockResolvedValue(fakeSsh.ssh);
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      if (command === "uname -sm") return ok("Linux x86_64\n");
      if (command === "cat $HOME/.ade/bin/ade.version 2>/dev/null || true") return ok("");
      if (command === "cat $HOME/.ade/bin/ade.sha256 2>/dev/null || true") return ok("");
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("");
      if (command === "mkdir -p $HOME/.ade/bin") return ok("");
      if (command.includes("printf '%s\\n' '2.0.0' > $HOME/.ade/bin/ade.version")) return ok("");
      if (command.includes("$HOME/.ade/bin/ade --version")) return ok("ade 1.9.0\n");
      throw new Error(`Unexpected SSH command: ${command}`);
    });

    await expect(bootstrapRemoteRuntime({
      target: uploadTarget,
      registry,
      resourcesPath: resources.resourcesPath,
      appVersion: APP_VERSION,
    })).rejects.toThrow(/uploaded ade service version mismatch/i);

    expect(fakeSsh.fastPut).toHaveBeenCalledWith(resources.binaryPath, ".ade/bin/ade", {}, expect.any(Function));
    expect(openSshRuntimeTransportMock).not.toHaveBeenCalled();
    expect(initializeMock).not.toHaveBeenCalled();
    expect(registry.update).not.toHaveBeenCalled();
    expect(fakeSsh.end).toHaveBeenCalledTimes(1);
  });

  it("uses the matching isolated remote home for Alpha channel bootstrap", async () => {
    process.env.ADE_PACKAGE_CHANNEL = "alpha";
    const resources = createTempResources("darwin-arm64");
    cleanupResources = resources.cleanup;
    const fakeSsh = createFakeSsh();
    const registry = createRegistry();
    connectSshMock.mockResolvedValue(fakeSsh.ssh);
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      if (command === "uname -sm") return ok("Darwin arm64\n");
      if (command === "cat $HOME/.ade-alpha/bin/ade.version 2>/dev/null || true") return ok("");
      if (command === "cat $HOME/.ade-alpha/bin/ade.sha256 2>/dev/null || true") return ok("");
      if (command === "test -x $HOME/.ade-alpha/bin/ade && $HOME/.ade-alpha/bin/ade --version || true") return ok("");
      if (command === "mkdir -p $HOME/.ade-alpha/bin") return ok("");
      if (command === "mkdir -p $HOME/.ade-alpha/runtime") return ok("");
      if (command.includes("printf '%s\\n' '2.0.0' > $HOME/.ade-alpha/bin/ade.version")) return ok("");
      if (command.includes("test -d $HOME/.ade-alpha/runtime/darwin-arm64/node_modules")) return ok("ok\n");
      if (command.includes("tar -xzf $HOME/.ade-alpha/runtime/ade-darwin-arm64.native.tar.gz")) return ok("");
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

    expect(fakeSsh.fastPut).toHaveBeenCalledWith(resources.binaryPath, ".ade-alpha/bin/ade", {}, expect.any(Function));
    expect(execSshMock).toHaveBeenCalledWith(fakeSsh.ssh, "codesign --force --sign - $HOME/.ade-alpha/bin/ade");
    expect(openSshRuntimeTransportMock).toHaveBeenCalledWith(
      fakeSsh.ssh,
      'ADE_HOME="$HOME/.ade-alpha" PATH="$HOME/.ade-alpha/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" ADE_PACKAGE_CHANNEL="alpha" ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1 NODE_PATH="$HOME/.ade-alpha/runtime/darwin-arm64/node_modules${NODE_PATH:+:$NODE_PATH}" $HOME/.ade-alpha/bin/ade rpc --stdio',
    );
  });

  it("restarts and retries a same-version runtime daemon that is missing machine project capabilities", async () => {
    const resources = createTempResources();
    cleanupResources = resources.cleanup;
    const fakeSsh = createFakeSsh();
    const registry = createRegistry();
    connectSshMock.mockResolvedValue(fakeSsh.ssh);
    const commands: string[] = [];
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      commands.push(command);
      if (command === "uname -sm") return ok("Linux x86_64\n");
      if (command === "cat $HOME/.ade/bin/ade.version 2>/dev/null || true") return ok("2.0.0\n");
      if (command === "cat $HOME/.ade/bin/ade.sha256 2>/dev/null || true") return ok(`${resources.binarySha256}\n`);
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("ade 2.0.0\n");
      if (command.includes("$HOME/.ade/bin/ade runtime stop --text")) return ok("");
      throw new Error(`Unexpected SSH command: ${command}`);
    });
    initializeMock
      .mockResolvedValueOnce({
        runtimeInfo: { version: APP_VERSION, multiProject: true },
        capabilities: { projects: true },
      })
      .mockResolvedValueOnce({
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

    await expect(bootstrapRemoteRuntime({
      target: uploadTarget,
      registry,
      resourcesPath: resources.resourcesPath,
      appVersion: APP_VERSION,
    })).resolves.toMatchObject({
      result: {
        arch: "linux-x64",
        version: APP_VERSION,
      },
    });

    expect(fakeSsh.fastPut).not.toHaveBeenCalled();
    expect(openSshRuntimeTransportMock).toHaveBeenCalledTimes(2);
    expect(commands).toContain(
      'ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_DEFAULT_ROLE="cto" $HOME/.ade/bin/ade runtime stop --text >/dev/null 2>&1 || true',
    );
  });
});
