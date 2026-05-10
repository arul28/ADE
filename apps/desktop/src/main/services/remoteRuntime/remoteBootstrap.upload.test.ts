import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";
import type { RemoteTargetRegistry } from "./remoteTargetRegistry";
import { bootstrapRemoteRuntime } from "./remoteBootstrap";

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

const APP_VERSION = "2.0.0";

const target: RemoteRuntimeTarget = {
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

function createTempResources(): { resourcesPath: string; binaryPath: string; cleanup: () => void } {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-runtime-"));
  const runtimeDir = path.join(resourcesPath, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const binaryPath = path.join(runtimeDir, "ade-linux-x64");
  fs.writeFileSync(binaryPath, "#!/bin/sh\n");
  return {
    resourcesPath,
    binaryPath,
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
      ...target,
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
      capabilities: { projects: true },
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
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("");
      if (command === "mkdir -p $HOME/.ade/bin") return ok("");
      if (command.includes("printf '%s\\n' '2.0.0' > $HOME/.ade/bin/ade.version")) return ok("");
      if (command.includes("$HOME/.ade/bin/ade --version")) return ok("ade 2.0.0\n");
      throw new Error(`Unexpected SSH command: ${command}`);
    });

    const connected = await bootstrapRemoteRuntime({
      target,
      registry,
      resourcesPath: resources.resourcesPath,
      appVersion: APP_VERSION,
    });

    expect(connectSshMock).toHaveBeenCalledWith(target);
    expect(fakeSsh.fastPut).toHaveBeenCalledWith(resources.binaryPath, ".ade/bin/ade", {}, expect.any(Function));
    expect(commands).toEqual([
      "uname -sm",
      "cat $HOME/.ade/bin/ade.version 2>/dev/null || true",
      "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true",
      "mkdir -p $HOME/.ade/bin",
      "chmod 700 $HOME/.ade/bin && chmod +x $HOME/.ade/bin/ade && printf '%s\\n' '2.0.0' > $HOME/.ade/bin/ade.version && chmod 600 $HOME/.ade/bin/ade.version",
      'ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" $HOME/.ade/bin/ade --version',
    ]);
    expect(openSshRuntimeTransportMock).toHaveBeenCalledWith(
      fakeSsh.ssh,
      'ADE_HOME="$HOME/.ade" PATH="$HOME/.ade/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" $HOME/.ade/bin/ade rpc --stdio',
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
      if (command === "test -x $HOME/.ade/bin/ade && $HOME/.ade/bin/ade --version || true") return ok("");
      if (command === "mkdir -p $HOME/.ade/bin") return ok("");
      if (command.includes("printf '%s\\n' '2.0.0' > $HOME/.ade/bin/ade.version")) return ok("");
      if (command.includes("$HOME/.ade/bin/ade --version")) return ok("ade 1.9.0\n");
      throw new Error(`Unexpected SSH command: ${command}`);
    });

    await expect(bootstrapRemoteRuntime({
      target,
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
    const resources = createTempResources();
    cleanupResources = resources.cleanup;
    const fakeSsh = createFakeSsh();
    const registry = createRegistry();
    connectSshMock.mockResolvedValue(fakeSsh.ssh);
    execSshMock.mockImplementation(async (_client: Client, command: string) => {
      if (command === "uname -sm") return ok("Linux x86_64\n");
      if (command === "cat $HOME/.ade-alpha/bin/ade.version 2>/dev/null || true") return ok("");
      if (command === "test -x $HOME/.ade-alpha/bin/ade && $HOME/.ade-alpha/bin/ade --version || true") return ok("");
      if (command === "mkdir -p $HOME/.ade-alpha/bin") return ok("");
      if (command.includes("printf '%s\\n' '2.0.0' > $HOME/.ade-alpha/bin/ade.version")) return ok("");
      if (command.includes("$HOME/.ade-alpha/bin/ade --version")) return ok("ade 2.0.0\n");
      throw new Error(`Unexpected SSH command: ${command}`);
    });

    await bootstrapRemoteRuntime({
      target,
      registry,
      resourcesPath: resources.resourcesPath,
      appVersion: APP_VERSION,
    });

    expect(fakeSsh.fastPut).toHaveBeenCalledWith(resources.binaryPath, ".ade-alpha/bin/ade", {}, expect.any(Function));
    expect(openSshRuntimeTransportMock).toHaveBeenCalledWith(
      fakeSsh.ssh,
      'ADE_HOME="$HOME/.ade-alpha" PATH="$HOME/.ade-alpha/bin:$HOME/.local/bin:$HOME/.npm-global/bin${PATH:+:$PATH}" ADE_PACKAGE_CHANNEL="alpha" ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1 $HOME/.ade-alpha/bin/ade rpc --stdio',
    );
  });
});
