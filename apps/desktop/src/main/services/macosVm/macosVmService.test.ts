import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMacosVmService } from "./macosVmService";
import { createCredentialsStore } from "./credentialsStore";
import { deleteMacosVmFromProjectState } from "./macosVmRecovery";
import { imageStateForFramebuffer } from "./rfbDirectClient";
import { installAdeRuntimeInVm } from "./runtimeBootstrap";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type { Logger } from "../logging/logger";
import type { MacosVmRecord } from "../../../shared/types";

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeTempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-macos-vm-test-"));
  const laneRoot = path.join(projectRoot, ".ade", "worktrees", "lane-one");
  fs.mkdirSync(laneRoot, { recursive: true });
  return {
    projectRoot,
    laneRoot,
    lane: {
      id: "lane-1",
      name: "Lane One",
      worktreePath: laneRoot,
    },
  };
}

function writeFixtureIpsw(projectRoot: string): string {
  const ipswPath = path.join(projectRoot, "fixture.ipsw");
  fs.writeFileSync(ipswPath, "ipsw");
  return ipswPath;
}

describe("createMacosVmService", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it("reports platform and provider status without requiring Lume to be installed", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "ls") return { exitCode: 1, signal: null, stdout: "", stderr: "missing" };
      return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const status = await service.getStatus({ laneId: "lane-1" });

    expect(status.supported).toBe(true);
    expect(status.activeProvider.kind).toBe("lume");
    expect(status.activeProvider.available).toBe(false);
    expect(status.laneVm).toBeNull();
  });

  it("summarizes a broken Lume shim as an install or repair action", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "--version") {
        return {
          exitCode: 126,
          signal: null,
          stdout: "",
          stderr: "/Users/admin/.local/bin/lume: line 2: /Users/admin/.local/share/lume/lume.app/Contents/MacOS/lume: No such file or directory",
        };
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const status = await service.getStatus({ laneId: "lane-1" });

    expect(status.activeProvider.available).toBe(false);
    expect(status.activeProvider.detail).toBe("Lume is not installed or its CLI shim is broken. Install Lume from Cua, then refresh this panel.");
  });

  it("rejects an unsigned Lume binary before reporting the provider available", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const unsignedLumePath = path.join(temp.projectRoot, "tools", "lume");
    fs.mkdirSync(path.dirname(unsignedLumePath), { recursive: true });
    fs.writeFileSync(unsignedLumePath, "#!/bin/sh\n");
    fs.chmodSync(unsignedLumePath, 0o755);
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === unsignedLumePath && args[0] === "--version") {
        return { exitCode: 0, signal: null, stdout: "lume 0.3.9", stderr: "" };
      }
      if (command === "/usr/bin/codesign") {
        return { exitCode: 1, signal: null, stdout: "", stderr: "code object is not signed at all" };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
      return { exitCode: 1, signal: null, stdout: "", stderr: "unexpected" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      validateProviderSignature: true,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "", ADE_LUME_PATH: unsignedLumePath },
    });

    const status = await service.getStatus({ laneId: "lane-1" });

    expect(status.activeProvider.available).toBe(false);
    expect(status.activeProvider.version).toBe("0.3.9");
    expect(status.activeProvider.detail).toContain(`ADE found Lume at ${unsignedLumePath}`);
    expect(status.activeProvider.detail).toContain("not the signed Cua app bundle");
    expect(runCommand).toHaveBeenCalledWith(
      "/usr/bin/codesign",
      ["-d", "--entitlements", ":-", unsignedLumePath],
      expect.objectContaining({ cwd: temp.projectRoot }),
    );
  });

  it("reports the selected signed Lume path in provider diagnostics", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const signedLumePath = path.join(temp.projectRoot, "signed", "lume.app", "Contents", "MacOS", "lume");
    fs.mkdirSync(path.dirname(signedLumePath), { recursive: true });
    fs.writeFileSync(signedLumePath, "#!/bin/sh\n");
    fs.chmodSync(signedLumePath, 0o755);
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command === signedLumePath && args[0] === "--version") {
        return { exitCode: 0, signal: null, stdout: "lume 0.3.9", stderr: "" };
      }
      if (command === "/usr/bin/codesign") {
        return {
          exitCode: 0,
          signal: null,
          stdout: [
            "<key>com.apple.security.virtualization</key>",
            "<key>com.apple.vm.networking</key>",
          ].join("\n"),
          stderr: "",
        };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
      return { exitCode: 1, signal: null, stdout: "", stderr: "unexpected" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      validateProviderSignature: true,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: path.join(temp.projectRoot, "other-bin"), ADE_LUME_PATH: signedLumePath },
    });

    const status = await service.getStatus({ laneId: "lane-1" });

    expect(status.activeProvider.available).toBe(true);
    expect(status.activeProvider.version).toBe("0.3.9");
    expect(status.activeProvider.detail).toContain(signedLumePath);
    expect(status.tools.find((tool) => tool.name === "lume")?.detail).toContain(signedLumePath);
  });

  it("keeps a long image pull in creating state while Lume has not registered the VM yet", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const now = "2026-05-16T20:00:00.000Z";
    const vmName = "ade-lane-one-lane-1";
    const storePath = path.join(temp.projectRoot, ".ade", "cache", "macos-vms", "records.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, `${JSON.stringify({
      version: 1,
      records: [{
        id: "macos-vm:lane-1",
        provider: "lume",
        name: vmName,
        laneId: "lane-1",
        laneName: "Lane One",
        laneRoot: temp.laneRoot,
        laneState: "attached",
        state: "creating",
        cpuCores: 4,
        memory: "8GB",
        diskSize: "80GB",
        display: "1920x1440",
        guestSharedPath: "/Volumes/My Shared Files",
        sharedDirectory: temp.laneRoot,
        createdAt: now,
        updatedAt: now,
        lastStartedAt: null,
        lastStoppedAt: null,
        ipAddress: null,
        sshCommand: null,
        vncUrl: null,
        lastError: null,
        metadata: {},
      }],
    }, null, 2)}\n`, "utf8");
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 0.3.9", stderr: "" };
      if (args[0] === "get") return { exitCode: 1, signal: null, stdout: "", stderr: "Virtual machine not found" };
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
      return { exitCode: 1, signal: null, stdout: "", stderr: "unexpected" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const status = await service.getStatus({ laneId: "lane-1" });

    expect(status.laneVm?.state).toBe("creating");
    expect(status.laneVm?.lastError).toBeNull();
  });

  it("mounts a sanitized mirror when the lane root contains ADE local state", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const ipswPath = writeFixtureIpsw(temp.projectRoot);
    const primaryLaneRoot = path.join(temp.projectRoot, "primary");
    fs.mkdirSync(path.join(primaryLaneRoot, ".ade", "secrets"), { recursive: true });
    let vmExists = false;
    let vmRunning = false;
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (command === "rsync") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0", stderr: "" };
      if (args[0] === "get") {
        if (!vmExists) return { exitCode: 1, signal: null, stdout: "", stderr: "missing" };
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ name: args[1], state: vmRunning ? "running" : "stopped" }),
          stderr: "",
        };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
      if (args[0] === "pull") {
        vmExists = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "create") {
        vmExists = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [{ id: "primary", name: "Primary", worktreePath: primaryLaneRoot }],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "", ADE_MACOS_VM_IPSW_URL: ipswPath },
    });

    const policy = await service.getSharePolicy({ laneId: "primary" });
    const started = await service.start({ laneId: "primary", createIfMissing: true });

    expect(policy.allowed).toBe(true);
    expect(policy.syncMode).toBe("sanitized-mirror");
    expect(policy.hostPath).toContain(path.join(".ade", "cache", "macos-vms", "shares", "primary", "worktree"));
    expect(policy.originalHostPath).toBe(primaryLaneRoot);
    expect(policy.excludedPaths).toContain("/.ade/secrets/***");
    expect(started.sharedDirectory).toBe(policy.hostPath);
    expect(started.metadata.shareMode).toBe("sanitized-mirror");
    expect(started.metadata.originalHostPath).toBe(primaryLaneRoot);
    expect(started.metadata.mirrorPath).toBe(policy.hostPath);
    expect(commands.filter(({ command }) => command === "rsync")).toHaveLength(1);
    expect(commands.find(({ command }) => command === "rsync")?.args).toEqual(expect.arrayContaining(["--exclude", "/.ade/secrets/***"]));
    expect(commands.some(({ command, args }) =>
      path.basename(command) === "lume"
        && args[0] === "run"
        && args[1] === started.name
        && args[2] === "--shared-dir"
        && args[3] === policy.hostPath
        && args.some((arg) => /^--vnc-password=.+/.test(arg)),
    )).toBe(true);
  });

  it("provisions and starts a lane VM through Lume with the lane mounted", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    let vmExists = false;
    let vmRunning = false;
    let vmName: string | null = null;
    const commands: string[][] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      commands.push(args);
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") {
        if (!vmExists) return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            name: args[1],
            state: vmRunning ? "running" : "stopped",
            ipAddress: vmRunning ? "192.168.64.2" : null,
            sshAvailable: vmRunning ? false : null,
            vncUrl: vmRunning ? "vnc://127.0.0.1:5901" : null,
          }),
          stderr: "",
        };
      }
      if (args[0] === "ls") {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify(vmExists && vmName ? [{ name: vmName, state: vmRunning ? "running" : "stopped" }] : []),
          stderr: "",
        };
      }
      if (args[0] === "pull") {
        vmExists = true;
        vmName = args[2] ?? null;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const provisioned = await service.provision({ laneId: "lane-1", mode: "pull-image" });
    const started = await service.start({ laneId: "lane-1" });

    expect(provisioned.name).toContain("lane-one");
    expect(started.state).toBe("running");
    expect(started.ipAddress).toBe("192.168.64.2");
    expect(started.sshCommand).toBeNull();
    expect(started.guestReadiness).toMatchObject({
      state: "setup_required",
      canControlGui: true,
      canRunCode: false,
      sshAvailable: false,
      setupAssistantLikely: true,
    });
    expect(commands).toContainEqual(["pull", "macos-tahoe-vanilla:latest", provisioned.name]);
    expect(commands).toContainEqual(["set", provisioned.name, "--display", "1920x1440"]);
    expect(commands.some((args) =>
      args[0] === "run"
        && args[1] === provisioned.name
        && args[2] === "--shared-dir"
        && args[3] === temp.laneRoot
        && args.some((arg) => /^--vnc-password=.+/.test(arg)),
    )).toBe(true);
  });

  it("starts by creating a missing VM from the default restore image path", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const ipswPath = writeFixtureIpsw(temp.projectRoot);
    let vmExists = false;
    let vmRunning = false;
    const commands: string[][] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      commands.push(args);
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") {
        if (!vmExists) return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            name: args[1],
            state: vmRunning ? "running" : "stopped",
          }),
          stderr: "",
        };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
      if (args[0] === "pull") {
        vmExists = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "create") {
        vmExists = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "", ADE_MACOS_VM_IPSW_URL: ipswPath },
    });

    const started = await service.start({ laneId: "lane-1", createIfMissing: true });

    expect(started.state).toBe("running");
    expect(commands.some((args) => args[0] === "pull")).toBe(false);
    expect(commands).toContainEqual(expect.arrayContaining(["create", started.name, "--ipsw", ipswPath]));
    expect(commands).toContainEqual(["set", started.name, "--display", "1920x1440"]);
    expect(commands.some((args) =>
      args[0] === "run"
        && args[1] === started.name
        && args[2] === "--shared-dir"
        && args[3] === temp.laneRoot
        && args.some((arg) => /^--vnc-password=.+/.test(arg)),
    )).toBe(true);
  });

  it("marks a running VM code-ready only after Lume reports SSH availability", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    let vmRunning = false;
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            name: args[1],
            state: vmRunning ? "running" : "stopped",
            ipAddress: vmRunning ? "192.168.64.22" : null,
            sshAvailable: vmRunning,
            vncUrl: vmRunning ? "vnc://127.0.0.1:5902" : null,
          }),
          stderr: "",
        };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: JSON.stringify([{ name: "ade-ade-lane-one-lane-1", state: vmRunning ? "running" : "stopped" }]), stderr: "" };
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const started = await service.start({ laneId: "lane-1" });

    expect(started.sshCommand).toBe("ssh lume@192.168.64.22");
    expect(started.guestReadiness).toMatchObject({
      state: "code_ready",
      canControlGui: true,
      canRunCode: true,
      sshAvailable: true,
      setupAssistantLikely: false,
    });
  });

  it("reports Lume provisioning as installing and blocks early start attempts", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    let vmExists = false;
    const commands: string[][] = [];
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      commands.push(args);
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") {
        if (!vmExists) return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            name: args[1],
            status: "provisioning",
            provisioningOperation: "ipsw_install",
          }),
          stderr: "",
        };
      }
      if (args[0] === "ls") {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify(vmExists ? [{
            name: "ade-ade-lane-one-lane-1",
            status: "provisioning",
            provisioningOperation: "ipsw_install",
          }] : []),
          stderr: "",
        };
      }
      if (args[0] === "pull") {
        vmExists = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const provisioned = await service.provision({ laneId: "lane-1", mode: "pull-image" });
    const status = await service.getStatus({ laneId: "lane-1" });

    expect(provisioned.state).toBe("installing");
    expect(status.laneVm?.state).toBe("installing");
    expect(status.laneVm?.metadata.lume).toMatchObject({ provisioningOperation: "ipsw_install" });
    await expect(service.start({ laneId: "lane-1" })).rejects.toThrow("still installing");
    expect(commands.some((args) => args[0] === "run")).toBe(false);
  });

  it("keeps an old installing record installing while Lume has not registered the VM yet", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const temp = makeTempProject();
      cleanupRoots.push(temp.projectRoot);
      let vmExists = false;
      const runCommand = vi.fn(async (_command: string, args: string[]) => {
        if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
        if (args[0] === "get") {
          if (!vmExists) return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({ name: args[1], status: "provisioning", provisioningOperation: "ipsw_install" }),
            stderr: "",
          };
        }
        if (args[0] === "ls") {
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify(vmExists ? [{ name: "ade-ade-lane-one-lane-1", status: "provisioning" }] : []),
            stderr: "",
          };
        }
        if (args[0] === "pull") {
          vmExists = true;
          return { exitCode: 0, signal: null, stdout: "", stderr: "" };
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      });
      const service = createMacosVmService({
        projectRoot: temp.projectRoot,
        logger,
        resolveLanes: async () => [temp.lane],
        runCommand,
        platform: "darwin",
        arch: "arm64",
        env: { PATH: "" },
      });

      await service.provision({ laneId: "lane-1", mode: "pull-image" });
      vmExists = false;
      vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));

      const status = await service.getStatus({ laneId: "lane-1" });
      expect(status.laneVm?.state).toBe("installing");
      expect(status.laneVm?.lastError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails clearly when an image pull exits without creating the VM", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
      if (args[0] === "pull") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    await expect(service.provision({
      laneId: "lane-1",
      mode: "pull-image",
      sourceImage: "macos-sequoia-vanilla:latest",
    })).rejects.toThrow("did not create a VM named");
  });

  it("uses the compatible cached restore image before creating a VM", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const ipswUrl = "https://updates.cdn-apple.com/2025SummerFCS/fullrestores/093-10809/CFD6DD38-DAF0-40DA-854F-31AAD1294C6F/UniversalMac_15.6.1_24G90_Restore.ipsw";
    let vmExists = false;
    let vmRunning = false;
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (command === "/usr/bin/curl") {
        const outputPath = args.at(args.indexOf("--output") + 1);
        if (outputPath) fs.writeFileSync(outputPath, Buffer.from("ipsw"));
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") {
        if (!vmExists) return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ name: args[1], state: vmRunning ? "running" : "stopped" }),
          stderr: "",
        };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
      if (args[0] === "create") {
        vmExists = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const started = await service.start({
      laneId: "lane-1",
      createIfMissing: true,
      mode: "create",
      display: "1440x900",
    });

    const curl = commands.find(
      ({ command, args }) => command === "/usr/bin/curl" && args.includes("--output"),
    );
    const create = commands.find(({ args }) => args[0] === "create");
    const cachedIpsw = path.join(temp.projectRoot, ".ade", "cache", "macos-vms", "ipsw", "UniversalMac_15.6.1_24G90_Restore.ipsw");
    expect(started.state).toBe("running");
    expect(curl?.args).toEqual([
      "--fail",
      "--location",
      "--continue-at",
      "-",
      "--silent",
      "--show-error",
      "--output",
      `${cachedIpsw}.part`,
      ipswUrl,
    ]);
    expect(create?.args).toEqual(expect.arrayContaining(["--ipsw", cachedIpsw]));
    expect(create?.args).not.toContain("--unattended");
    expect(fs.existsSync(cachedIpsw)).toBe(true);
  });

  it("keeps a partial IPSW download for the next retry when curl fails", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (command === "/usr/bin/curl") {
        const outputPath = args.at(args.indexOf("--output") + 1);
        if (outputPath) fs.writeFileSync(outputPath, Buffer.from("partial"));
        return { exitCode: 56, signal: null, stdout: "", stderr: "network reset" };
      }
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    await expect(service.provision({ laneId: "lane-1", mode: "create" })).rejects.toThrow("network reset");

    const cachedIpsw = path.join(temp.projectRoot, ".ade", "cache", "macos-vms", "ipsw", "UniversalMac_15.6.1_24G90_Restore.ipsw");
    expect(commands.some(({ command }) => command === "/usr/bin/curl")).toBe(true);
    expect(fs.readFileSync(`${cachedIpsw}.part`, "utf8")).toBe("partial");
  });

  it("wraps incompatible image pull failures with actionable context", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
      if (args[0] === "get") return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
      if (args[0] === "pull") {
        return {
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "Virtual machine not found: lane-vm",
        };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    await expect(service.provision({
      laneId: "lane-1",
      mode: "pull-image",
      sourceImage: "macos-sequoia-cua:latest",
    })).rejects.toThrow("The image may be incompatible with this Lume version");
  });

  it("blocks a second VM lane while the runtime-wide VM lease is held", async () => {
    const first = makeTempProject();
    const second = makeTempProject();
    const ipswPath = writeFixtureIpsw(first.projectRoot);
    second.lane.id = "lane-2";
    second.lane.name = "Lane Two";
    const adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-macos-vm-home-"));
    cleanupRoots.push(first.projectRoot, second.projectRoot, adeHome);
    const vmStates = new Map<string, "stopped" | "running">();
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "ls") {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify([...vmStates.entries()].map(([name, state]) => ({ name, state }))),
          stderr: "",
        };
      }
      if (args[0] === "get") {
        const state = vmStates.get(args[1] ?? "");
        if (!state) return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ name: args[1], state }),
          stderr: "",
        };
      }
      if (args[0] === "pull") {
        vmStates.set(args[2] ?? "unknown", "stopped");
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "create") {
        vmStates.set(args[1] ?? "unknown", "stopped");
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "run") {
        vmStates.set(args[1] ?? "unknown", "running");
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const firstService = createMacosVmService({
      projectRoot: first.projectRoot,
      logger,
      resolveLanes: async () => [first.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "", ADE_HOME: adeHome, ADE_MACOS_VM_IPSW_URL: ipswPath },
    });
    const secondService = createMacosVmService({
      projectRoot: second.projectRoot,
      logger,
      resolveLanes: async () => [second.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "", ADE_HOME: adeHome, ADE_MACOS_VM_IPSW_URL: ipswPath },
    });

    const started = await firstService.start({ laneId: "lane-1", createIfMissing: true });
    const firstStatus = await firstService.getStatus();
    const secondStatus = await secondService.getStatus();

    expect(firstStatus.globalLease).toMatchObject({ laneId: "lane-1", vmName: started.name });
    expect(secondStatus.globalLease).toMatchObject({ laneId: "lane-1", vmName: started.name });
    await expect(secondService.start({ laneId: "lane-2", createIfMissing: true }))
      .rejects.toThrow("Mac VM is already attached to Lane One");
  });

  it("surfaces and removes a stale VM record when its lane no longer exists", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const ipswPath = writeFixtureIpsw(temp.projectRoot);
    let lanes = [temp.lane];
    const vmStates = new Map<string, "stopped" | "running">();
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "ls") {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify([...vmStates.entries()].map(([name, state]) => ({ name, state }))),
          stderr: "",
        };
      }
      if (args[0] === "get") {
        const state = vmStates.get(args[1] ?? "");
        if (!state) return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({ name: args[1], state }),
          stderr: "",
        };
      }
      if (args[0] === "pull") {
        vmStates.set(args[2] ?? "unknown", "stopped");
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "create") {
        vmStates.set(args[1] ?? "unknown", "stopped");
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "run") {
        vmStates.set(args[1] ?? "unknown", "running");
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (args[0] === "delete") {
        vmStates.delete(args[1] ?? "");
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => lanes,
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "", ADE_MACOS_VM_IPSW_URL: ipswPath },
    });

    const started = await service.start({ laneId: "lane-1", createIfMissing: true });
    lanes = [];

    const staleStatus = await service.getStatus();
    expect(staleStatus.globalLease).toMatchObject({ laneId: "lane-1", vmName: started.name });
    expect(staleStatus.vms[0]).toMatchObject({
      laneId: "lane-1",
      laneName: "Lane One",
      laneState: "missing",
      name: started.name,
    });

    const deleted = await service.delete({ vmName: started.name, force: true });
    expect(deleted.deleted).toBe(true);
    expect(await service.getStatus()).toMatchObject({ vms: [], globalLease: null });
  });

  it("builds agent guidance around the mounted lane", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand: vi.fn(async (_command, args) => {
        if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0", stderr: "" };
        if (args[0] === "get") return { exitCode: 1, signal: null, stdout: "", stderr: "missing" };
        if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }),
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const guide = await service.getAgentGuide({ laneId: "lane-1" });

    expect(guide.vmName).toContain("lane-one");
    expect(guide.target.kind).toBe("macos_vm_target");
    expect(guide.target.windowTitleQuery).toContain("lane-one");
    expect(guide.text).toContain(temp.laneRoot);
    expect(guide.text).toContain("/Volumes/My Shared Files");
    expect(guide.text).toContain("run the agent/runtime inside a VM-backed lane");
  });

  it("starts headlessly with a managed VNC credential and drives the VM through direct VNC", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    let vmExists = true;
    let vmRunning = false;
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") {
        if (!vmExists) return { exitCode: 1, signal: null, stdout: "", stderr: "not found" };
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            name: args[1],
            state: vmRunning ? "running" : "stopped",
            vncUrl: vmRunning ? "vnc://127.0.0.1:5999" : null,
          }),
          stderr: "",
        };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: JSON.stringify([{ name: "lane-vm", state: "stopped" }]), stderr: "" };
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const directVncClient = {
      captureScreenshot: vi.fn(async () => ({
        width: 640,
        height: 480,
        pngData: Buffer.from("png"),
        imageState: "visible" as const,
      })),
      click: vi.fn(async (_connection: unknown, x: number, y: number) => ({
        width: 640,
        height: 480,
        x,
        y,
      })),
      typeText: vi.fn(async (_connection: unknown, text: string) => ({
        width: 640,
        height: 480,
        typedLength: text.length,
      })),
    };
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      directVncClient,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const started = await service.start({ laneId: "lane-1", openDisplay: false });
    const screenshot = await service.captureScreenshot({ laneId: "lane-1" });
    const selected = await service.selectPoint({ laneId: "lane-1", x: 25, y: 35 });
    const clicked = await service.click({ laneId: "lane-1", x: 25, y: 35 });
    const typed = await service.typeText({ laneId: "lane-1", text: "hello" });

    const run = commands.find(({ args }) => args[0] === "run");
    expect(started.state).toBe("running");
    expect(run?.args).toEqual([
      "run",
      started.name,
      "--shared-dir",
      temp.laneRoot,
      "--no-display",
      expect.stringMatching(/^--vnc-password=.{8}$/),
    ]);
    expect(run?.args).not.toContain("--vnc-password");
    expect(screenshot.captureMode).toBe("direct-vnc");
    expect(screenshot.imageState).toBe("visible");
    expect(screenshot.window.processName).toBe("direct-vnc");
    expect(screenshot.window.frame).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    expect(screenshot.dataUrl).toBe("data:image/png;base64,cG5n");
    expect(selected.source).toBe("direct-vnc");
    expect(clicked).toMatchObject({ ok: true, x: 25, y: 35, window: { processName: "direct-vnc" } });
    expect(typed).toMatchObject({ ok: true, window: { processName: "direct-vnc" } });
    expect(directVncClient.captureScreenshot).toHaveBeenCalled();
    expect(directVncClient.click).toHaveBeenCalledWith(
      { host: "127.0.0.1", port: 5999, password: expect.any(String) },
      25,
      35,
      10_000,
    );
    expect(commands.some(({ command }) => command === "osascript" || command === "screencapture")).toBe(false);
  });

  it("starts visibly with a managed VNC credential and refreshes the display size first", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    let vmRunning = false;
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            name: args[1],
            state: vmRunning ? "running" : "stopped",
            vncUrl: vmRunning ? "vnc://127.0.0.1:5999" : null,
          }),
          stderr: "",
        };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: JSON.stringify([{ name: "lane-vm", state: vmRunning ? "running" : "stopped" }]), stderr: "" };
      if (args[0] === "set") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (command === "/usr/bin/osascript" && args.join("\n").includes("AXClose")) {
        return { exitCode: 0, signal: null, stdout: "1", stderr: "" };
      }
      if (command === "/usr/bin/pkill") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const started = await service.start({ laneId: "lane-1", openDisplay: true, display: "2560x1440" });
    const setIndex = commands.findIndex(({ args }) => args[0] === "set");
    const runIndex = commands.findIndex(({ args }) => args[0] === "run");

    expect(started.state).toBe("running");
    expect(setIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThan(setIndex);
    expect(commands[setIndex]?.args).toEqual(["set", started.name, "--display", "2560x1440"]);
    expect(commands[runIndex]?.args).toEqual([
      "run",
      started.name,
      "--shared-dir",
      temp.laneRoot,
      expect.stringMatching(/^--vnc-password=.{8}$/),
    ]);
    expect(commands[runIndex]?.args).not.toContain("--vnc-password");
    expect(started.metadata.controlBackend).toBe("vnc-window-and-embedded");
    expect(started.metadata.vncCredentialStored).toBe(true);
    expect(commands.some(({ command, args }) =>
      command === "/usr/bin/osascript" && args.join("\n").includes("AXClose")
    )).toBe(true);
    expect(commands.some(({ command, args }) =>
      command === "/usr/bin/osascript" && args.join("\n").includes("tell application \"Screen Sharing\" to quit")
    )).toBe(true);
    expect(commands.some(({ command, args }) =>
      command === "/usr/bin/pkill" && args.join(" ") === "-x Screen Sharing"
    )).toBe(true);
    expect(commands.some(({ command, args }) =>
      command === "/usr/bin/osascript" && args.join("\n").includes("AXMinimized")
    )).toBe(true);
    expect(commands.some(({ command }) => command === "/usr/bin/open")).toBe(true);
  });

  it("surfaces early Lume run failures instead of waiting for the VM start timeout", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const lumePath = path.join(temp.projectRoot, "bin", "lume");
    fs.mkdirSync(path.dirname(lumePath), { recursive: true });
    fs.writeFileSync(lumePath, [
      "#!/bin/sh",
      "case \"$1\" in",
      "  --version) echo 'lume 0.3.9'; exit 0 ;;",
      "  get) printf '{\"name\":\"%s\",\"state\":\"stopped\"}\\n' \"$2\"; exit 0 ;;",
      "  ls) echo '[{\"name\":\"lane-vm\",\"state\":\"stopped\"}]'; exit 0 ;;",
      "  set) exit 0 ;;",
      "  run) echo \"Error: Missing value for '--vnc-password <vnc-password>'\" >&2; exit 64 ;;",
      "  *) echo \"unexpected $1\" >&2; exit 1 ;;",
      "esac",
      "",
    ].join("\n"), "utf8");
    fs.chmodSync(lumePath, 0o755);
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      validateProviderSignature: false,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "", ADE_LUME_PATH: lumePath },
    });

    let error: unknown;
    try {
      await service.start({ laneId: "lane-1" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Missing value for '--vnc-password");
    expect((error as Error).message).toContain("exit 64");
  });

  it("reuses an existing Screen Sharing connection for the VM VNC port", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    let vmRunning = false;
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (command === "/usr/sbin/lsof") {
        return {
          exitCode: 0,
          signal: null,
          stdout: [
            "p1234",
            "cScreen Sharing",
            "n127.0.0.1:5999->127.0.0.1:52000",
          ].join("\n"),
          stderr: "",
        };
      }
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            name: args[1],
            state: vmRunning ? "running" : "stopped",
            vncUrl: vmRunning ? "vnc://127.0.0.1:5999" : null,
          }),
          stderr: "",
        };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: JSON.stringify([{ name: "lane-vm", state: vmRunning ? "running" : "stopped" }]), stderr: "" };
      if (args[0] === "set") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const started = await service.start({ laneId: "lane-1", openDisplay: true });
    const alreadyRunning = await service.start({ laneId: "lane-1", openDisplay: true });

    expect(started.state).toBe("running");
    expect(alreadyRunning.state).toBe("running");
    expect(alreadyRunning.metadata.controlBackend).toBe("vnc-window-and-embedded");
    expect(alreadyRunning.metadata.externalVncClientRequested).toBe(true);
    expect(alreadyRunning.metadata.externalVncClientHidden).toBe(true);
    expect(commands.filter(({ command }) => command === "/usr/sbin/lsof")).toHaveLength(2);
    expect(commands.some(({ command, args }) =>
      command === "/usr/bin/osascript" && args.join("\n").includes("AXMinimized")
    )).toBe(true);
    expect(commands.some(({ command }) => command === "/usr/bin/open")).toBe(false);
  });

  it("replaces duplicate Screen Sharing helpers for the VM VNC port", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    let vmRunning = false;
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (command === "/usr/sbin/lsof") {
        return {
          exitCode: 0,
          signal: null,
          stdout: [
            "p1234",
            "cScreen Sharing",
            "n127.0.0.1:5999->127.0.0.1:52000",
            "p5678",
            "cScreen Sharing",
            "n127.0.0.1:5999->127.0.0.1:52001",
          ].join("\n"),
          stderr: "",
        };
      }
      if (command === "/usr/bin/osascript" && args.join("\n").includes("AXClose")) {
        return { exitCode: 0, signal: null, stdout: "2", stderr: "" };
      }
      if (command === "/usr/bin/pkill") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
      if (args[0] === "get") {
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            name: args[1],
            state: vmRunning ? "running" : "stopped",
            vncUrl: vmRunning ? "vnc://127.0.0.1:5999" : null,
          }),
          stderr: "",
        };
      }
      if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: JSON.stringify([{ name: "lane-vm", state: vmRunning ? "running" : "stopped" }]), stderr: "" };
      if (args[0] === "set") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      if (args[0] === "run") {
        vmRunning = true;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const started = await service.start({ laneId: "lane-1", openDisplay: true });

    expect(started.state).toBe("running");
    expect(commands.some(({ command, args }) =>
      command === "/usr/bin/osascript" && args.join("\n").includes("AXClose")
    )).toBe(true);
    expect(commands.some(({ command }) => command === "/usr/bin/pkill")).toBe(true);
    expect(commands.some(({ command }) => command === "/usr/bin/open")).toBe(true);
    expect(commands.some(({ command, args }) =>
      command === "/usr/bin/osascript" && args.join("\n").includes("AXMinimized")
    )).toBe(true);
  });

  it("focuses, screenshots, selects, clicks, and types into the VM window through macOS utilities", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (path.basename(command) === "lume") {
        if (args[0] === "get") return { exitCode: 1, signal: null, stdout: "", stderr: "missing" };
        if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
        return { exitCode: 0, signal: null, stdout: "lume 1.0", stderr: "" };
      }
      if (command === "osascript") {
        const script = args.join("\n");
        if (script.includes("click at") || script.includes("keystroke")) {
          return { exitCode: 0, signal: null, stdout: "", stderr: "" };
        }
        return {
          exitCode: 0,
          signal: null,
          stdout: "Lume\tade-ade-lane-one-lane-1\t10\t20\t800\t600",
          stderr: "",
        };
      }
      if (command === "screencapture") {
        const outputPath = args.at(-1);
        if (outputPath) fs.writeFileSync(outputPath, Buffer.from("png"));
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "unexpected" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const target = await service.focusWindow({ laneId: "lane-1" });
    const screenshot = await service.captureScreenshot({ laneId: "lane-1" });
    const selected = await service.selectPoint({ laneId: "lane-1", x: 30, y: 40 });
    const clicked = await service.click({ laneId: "lane-1", x: 30, y: 40 });
    const typed = await service.typeText({ laneId: "lane-1", text: "hello" });

    expect(target.processName).toBe("Lume");
    expect(screenshot.captureMode).toBe("window-region");
    expect(screenshot.path).toContain(path.join(".ade", "artifacts", "macos-vms", "lane-1"));
    expect(screenshot.dataUrl).toBe("data:image/png;base64,cG5n");
    expect(selected.source).toBe("coordinate-fallback");
    expect(selected.item.kind).toBe("macos_vm_target");
    expect(selected.item.screenshotDataUrl).toBe("data:image/png;base64,cG5n");
    expect(selected.item.metadata.selectedPoint).toEqual({ x: 30, y: 40, coordinateSpace: "window" });
    expect(selected.item.metadata.screenshotPath).toContain(path.join(".ade", "artifacts", "macos-vms", "lane-1"));
    expect(clicked).toMatchObject({ ok: true, x: 40, y: 60 });
    expect(typed.ok).toBe(true);
    expect(commands).toContainEqual({
      command: "screencapture",
      args: ["-x", "-R", "10,20,800,600", screenshot.path],
    });
    expect(commands.some(({ command, args }) => command === "osascript" && args.join("\n").includes("click at {40, 60}"))).toBe(true);
    expect(commands.some(({ command, args }) => command === "osascript" && args.join("\n").includes('keystroke "hello"'))).toBe(true);
  });

  it("falls back to a single visible Screen Sharing VNC window for Lume VMs", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (path.basename(command) === "lume") {
        if (args[0] === "get") {
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              name: args[1],
              state: "running",
              vncUrl: "vnc://127.0.0.1:5900",
            }),
            stderr: "",
          };
        }
        if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
        return { exitCode: 0, signal: null, stdout: "lume 1.0", stderr: "" };
      }
      if (command === "osascript") {
        return {
          exitCode: 0,
          signal: null,
          stdout: "Screen Sharing\tVirtualization\t100\t120\t1024\t768",
          stderr: "",
        };
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "unexpected" };
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: "" },
    });

    const target = await service.focusWindow({ laneId: "lane-1" });
    const focusScript = commands.find(({ command }) => command === "osascript")?.args.join("\n") ?? "";

    expect(target.processName).toBe("Screen Sharing");
    expect(target.windowTitle).toBe("Virtualization");
    expect(target.frame).toEqual({ x: 100, y: 120, width: 1024, height: 768 });
    expect(focusScript).toContain("set allowVncFallback to true");
    expect(focusScript).toContain("set restrictToVmViewer to true");
    expect(focusScript).toContain("set candidateNames to {\"Virtualization\", \"Lume\", \"Screen Sharing\"}");
    expect(focusScript).toContain("repeat with procNameItem in {\"Virtualization\", \"Lume\", \"Screen Sharing\"}");
    expect(focusScript).toContain("tell application process procName");
  });

  describe("singleton VM lifecycle", () => {
    function makeKeychainMock() {
      const memory = new Map<string, { username: string; password: string; savedAt: string }>();
      return {
        memory,
        store: {
          saveCredentials: vi.fn(async (vmName: string, username: string, password: string) => {
            const savedAt = "2026-05-18T00:00:00.000Z";
            memory.set(vmName, { username, password, savedAt });
            return { savedAt };
          }),
          loadCredentials: vi.fn(async (vmName: string) => memory.get(vmName) ?? null),
          clearCredentials: vi.fn(async (vmName: string) => memory.delete(vmName)),
        },
      };
    }

    function makeBaselineRecord(temp: ReturnType<typeof makeTempProject>, vmName: string) {
      const now = "2026-05-18T00:00:00.000Z";
      return {
        id: `macos-vm:${temp.lane.id}`,
        provider: "lume" as const,
        name: vmName,
        laneId: temp.lane.id,
        laneName: temp.lane.name,
        laneRoot: temp.laneRoot,
        laneState: "attached" as const,
        state: "running" as const,
        cpuCores: 4,
        memory: "8GB",
        diskSize: "80GB",
        display: "1920x1440",
        guestSharedPath: "/Volumes/My Shared Files",
        sharedDirectory: temp.laneRoot,
        createdAt: now,
        updatedAt: now,
        lastStartedAt: now,
        lastStoppedAt: null,
        ipAddress: "192.168.64.10",
        sshCommand: "ssh lume@192.168.64.10",
        vncUrl: "vnc://127.0.0.1:5901",
        lastError: null,
        metadata: {},
      };
    }

    function writeBaselineRecord(temp: ReturnType<typeof makeTempProject>, vmName: string, overrides: Record<string, unknown> = {}) {
      const storePath = path.join(temp.projectRoot, ".ade", "cache", "macos-vms", "records.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const record = { ...makeBaselineRecord(temp, vmName), ...overrides };
      fs.writeFileSync(
        storePath,
        `${JSON.stringify({ version: 1, records: [record] }, null, 2)}\n`,
        "utf8",
      );
      return record;
    }

    it("round-trips guest credentials through the injected keychain store and never returns the password", async () => {
      const temp = makeTempProject();
      cleanupRoots.push(temp.projectRoot);
      writeBaselineRecord(temp, "ade-test-vm");
      const keychain = makeKeychainMock();
      const runCommand = vi.fn(async (_command: string, args: string[]) => {
        if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
        if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
        if (args[0] === "get") return { exitCode: 1, signal: null, stdout: "", stderr: "missing" };
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      });
      const service = createMacosVmService({
        projectRoot: temp.projectRoot,
        logger,
        resolveLanes: async () => [temp.lane],
        runCommand,
        platform: "darwin",
        arch: "arm64",
        env: { PATH: "" },
        credentialsStore: keychain.store,
      });

      const empty = await service.getCredentials({ vmName: "ade-test-vm" });
      expect(empty).toEqual({ vmName: "ade-test-vm", username: null, hasPassword: false, savedAt: null });

      const saved = await service.setCredentials({ vmName: "ade-test-vm", username: "ade", password: "hunter2" });
      expect(saved).toEqual({ ok: true });
      expect(keychain.store.saveCredentials).toHaveBeenCalledWith("ade-test-vm", "ade", "hunter2");

      const summary = await service.getCredentials({ vmName: "ade-test-vm" });
      expect(summary).toMatchObject({ vmName: "ade-test-vm", username: "ade", hasPassword: true });
      // The password must never cross the IPC boundary.
      expect(Object.keys(summary)).not.toContain("password");
    });

    it("marks a lane's share entry as stale so the next restart cleans it up", async () => {
      const temp = makeTempProject();
      cleanupRoots.push(temp.projectRoot);
      writeBaselineRecord(temp, "ade-test-vm", {
        shareEntries: [
          {
            laneId: temp.lane.id,
            hostPath: temp.laneRoot,
            guestPath: "/Volumes/My Shared Files",
            state: "live",
            attachedAt: "2026-05-18T00:00:00.000Z",
          },
        ],
      });
      const runCommand = vi.fn(async (_command: string, args: string[]) => {
        if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
        if (args[0] === "ls") return { exitCode: 0, signal: null, stdout: "[]", stderr: "" };
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      });
      const service = createMacosVmService({
        projectRoot: temp.projectRoot,
        logger,
        resolveLanes: async () => [temp.lane],
        runCommand,
        platform: "darwin",
        arch: "arm64",
        env: { PATH: "" },
      });

      const marked = service.markShareStale({ laneId: temp.lane.id });
      expect(marked?.shareEntries).toEqual([
        expect.objectContaining({ laneId: temp.lane.id, state: "stale" }),
      ]);

      // Marking again is a no-op (returns null because nothing mutates).
      const second = service.markShareStale({ laneId: temp.lane.id });
      expect(second).toBeNull();
    });

    it("wipe destroys the lume VM, clears keychain credentials, and removes the IPSW cache", async () => {
      const temp = makeTempProject();
      cleanupRoots.push(temp.projectRoot);
      writeBaselineRecord(temp, "ade-test-vm", { state: "stopped", ipAddress: null, sshCommand: null, vncUrl: null });
      const ipswCacheDir = path.join(temp.projectRoot, ".ade", "cache", "macos-vms", "ipsw");
      fs.mkdirSync(ipswCacheDir, { recursive: true });
      fs.writeFileSync(path.join(ipswCacheDir, "UniversalMac.ipsw"), "ipsw-data");
      const keychain = makeKeychainMock();
      await keychain.store.saveCredentials("ade-test-vm", "ade", "hunter2");
      const commands: Array<{ command: string; args: string[] }> = [];
      const runCommand = vi.fn(async (command: string, args: string[]) => {
        commands.push({ command, args });
        if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
        if (args[0] === "ls") {
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify([{ name: "ade-test-vm", state: "stopped" }]),
            stderr: "",
          };
        }
        if (args[0] === "get") {
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({ name: "ade-test-vm", state: "stopped" }),
            stderr: "",
          };
        }
        if (args[0] === "delete") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      });
      const service = createMacosVmService({
        projectRoot: temp.projectRoot,
        logger,
        resolveLanes: async () => [temp.lane],
        runCommand,
        platform: "darwin",
        arch: "arm64",
        env: { PATH: "" },
        credentialsStore: keychain.store,
      });

      const result = await service.wipe({ vmName: "ade-test-vm", confirm: true });

      expect(result.wiped).toBe(true);
      expect(result.previousVm?.name).toBe("ade-test-vm");
      expect(commands.some(({ args }) => args[0] === "delete" && args[1] === "ade-test-vm")).toBe(true);
      expect(keychain.store.clearCredentials).toHaveBeenCalledWith("ade-test-vm");
      expect(fs.existsSync(ipswCacheDir)).toBe(false);
    });

    it("wipe refuses without explicit confirmation", async () => {
      const temp = makeTempProject();
      cleanupRoots.push(temp.projectRoot);
      writeBaselineRecord(temp, "ade-test-vm");
      const service = createMacosVmService({
        projectRoot: temp.projectRoot,
        logger,
        resolveLanes: async () => [temp.lane],
        runCommand: vi.fn(),
        platform: "darwin",
        arch: "arm64",
        env: { PATH: "" },
      });

      await expect(service.wipe({ vmName: "ade-test-vm", confirm: false } as never)).rejects.toThrow(
        /Wipe requires explicit confirmation/,
      );
    });

    it("restart stops a running VM and starts it again, returning the running record", async () => {
      const temp = makeTempProject();
      cleanupRoots.push(temp.projectRoot);
      writeBaselineRecord(temp, "ade-test-vm", { state: "running" });
      let vmState: "running" | "stopped" = "running";
      const commands: Array<{ command: string; args: string[] }> = [];
      const runCommand = vi.fn(async (command: string, args: string[]) => {
        commands.push({ command, args });
        if (args[0] === "--version") return { exitCode: 0, signal: null, stdout: "lume 1.0.0", stderr: "" };
        if (args[0] === "ls") {
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify([{ name: "ade-test-vm", state: vmState }]),
            stderr: "",
          };
        }
        if (args[0] === "get") {
          return {
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify({
              name: "ade-test-vm",
              state: vmState,
              ipAddress: vmState === "running" ? "192.168.64.10" : null,
              sshAvailable: vmState === "running" ? true : null,
              vncUrl: vmState === "running" ? "vnc://127.0.0.1:5901" : null,
            }),
            stderr: "",
          };
        }
        if (args[0] === "stop") {
          vmState = "stopped";
          return { exitCode: 0, signal: null, stdout: "", stderr: "" };
        }
        if (args[0] === "set") return { exitCode: 0, signal: null, stdout: "", stderr: "" };
        if (args[0] === "run") {
          vmState = "running";
          return { exitCode: 0, signal: null, stdout: "", stderr: "" };
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      });
      const service = createMacosVmService({
        projectRoot: temp.projectRoot,
        logger,
        resolveLanes: async () => [temp.lane],
        runCommand,
        platform: "darwin",
        arch: "arm64",
        env: { PATH: "" },
      });

      const restarted = await service.restart({ vmName: "ade-test-vm" });

      expect(restarted?.state).toBe("running");
      expect(commands.some(({ args }) => args[0] === "stop" && args[1] === "ade-test-vm")).toBe(true);
      expect(commands.some(({ args }) => args[0] === "run" && args[1] === "ade-test-vm")).toBe(true);
    });
  });
});

function blackFrame(width: number, height: number): Buffer {
  const frame = Buffer.alloc(width * height * 4);
  for (let offset = 3; offset < frame.length; offset += 4) {
    frame[offset] = 255;
  }
  return frame;
}

function setPixel(frame: Buffer, pixelIndex: number, red: number, green: number, blue: number): void {
  const offset = pixelIndex * 4;
  frame[offset] = red;
  frame[offset + 1] = green;
  frame[offset + 2] = blue;
  frame[offset + 3] = 255;
}

describe("imageStateForFramebuffer", () => {
  it("classifies a fully black framebuffer as blank", () => {
    expect(imageStateForFramebuffer(blackFrame(1024, 768))).toBe("blank");
  });

  it("classifies a nearly black framebuffer with tiny VNC noise as blank", () => {
    const frame = blackFrame(1024, 768);
    for (let index = 0; index < 32; index += 1) {
      setPixel(frame, index * 97, 255, 255, 255);
    }

    expect(imageStateForFramebuffer(frame)).toBe("blank");
  });

  it("classifies a framebuffer with meaningful visible content as visible", () => {
    const frame = blackFrame(1024, 768);
    for (let index = 0; index < 1200; index += 1) {
      setPixel(frame, index * 13, 245, 245, 245);
    }

    expect(imageStateForFramebuffer(frame)).toBe("visible");
  });
});

describe("createCredentialsStore", () => {
  it("invokes security add-generic-password with the per-VM service name and returns savedAt", async () => {
    const runCommand = vi.fn(async (_cmd: string, _args: string[]) => ({ exitCode: 0, stdout: "", stderr: "" }));
    const store = createCredentialsStore({ platform: "darwin", runCommand });

    const result = await store.saveCredentials("ade-test-vm", "ade", "hunter2");

    expect(typeof result.savedAt).toBe("string");
    expect(runCommand).toHaveBeenCalledTimes(1);
    const call = runCommand.mock.calls[0]!;
    expect(call[0]).toBe("/usr/bin/security");
    const args = call[1] as string[];
    expect(args[0]).toBe("add-generic-password");
    expect(args).toContain("ade-macos-vm-ade-test-vm");
    const payloadIndex = args.indexOf("-w") + 1;
    const payload = JSON.parse(args[payloadIndex]!) as { username: string; password: string };
    expect(payload.username).toBe("ade");
    expect(payload.password).toBe("hunter2");
  });

  it("rejects unsafe guest usernames before reaching the keychain", async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const store = createCredentialsStore({ platform: "darwin", runCommand });

    await expect(store.saveCredentials("ade-test-vm", "evil@host", "hunter2")).rejects.toThrow(
      /letters, digits/i,
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("returns null from loadCredentials when the keychain entry is missing", async () => {
    const runCommand = vi.fn(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
    }));
    const store = createCredentialsStore({ platform: "darwin", runCommand });

    const loaded = await store.loadCredentials("ade-test-vm");

    expect(loaded).toBeNull();
  });

  it("returns true on successful clear and false when the keychain entry is already gone", async () => {
    const successRun = vi.fn(async (_cmd: string, _args: string[]) => ({ exitCode: 0, stdout: "", stderr: "" }));
    const missingRun = vi.fn(async (_cmd: string, _args: string[]) => ({
      exitCode: 1,
      stdout: "",
      stderr: "security: The specified item could not be found in the keychain.",
    }));
    const success = createCredentialsStore({ platform: "darwin", runCommand: successRun });
    const missing = createCredentialsStore({ platform: "darwin", runCommand: missingRun });

    expect(await success.clearCredentials("ade-test-vm")).toBe(true);
    expect(await missing.clearCredentials("ade-test-vm")).toBe(false);
    expect(successRun.mock.calls[0]![1][0]).toBe("delete-generic-password");
  });

  it("refuses to operate on non-darwin platforms", async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const store = createCredentialsStore({ platform: "linux", runCommand });

    await expect(store.saveCredentials("ade-test-vm", "ade", "hunter2")).rejects.toThrow(/macOS/);
    await expect(store.loadCredentials("ade-test-vm")).rejects.toThrow(/macOS/);
    await expect(store.clearCredentials("ade-test-vm")).rejects.toThrow(/macOS/);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("installAdeRuntimeInVm", () => {
  it("walks the 5 bootstrap phases and routes ssh/scp through sshpass with password in env, not argv", async () => {
    const phases: string[] = [];
    const calls: Array<{ command: string; args: string[]; extraEnv?: NodeJS.ProcessEnv }> = [];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-runtime-bootstrap-test-"));
    const runner = vi.fn(async (command: string, args: string[], options: { extraEnv?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, extraEnv: options.extraEnv });
      if (args.includes("echo")) return { exitCode: 0, stdout: "ade-probe-ok\n", stderr: "" };
      if (args.some((a) => a === "bash")) return { exitCode: 0, stdout: "OK\n", stderr: "" };
      if (args.some((a) => a === "cat")) return { exitCode: 0, stdout: "2026-05-19T00:00:00Z\n", stderr: "" };
      // scp call
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await installAdeRuntimeInVm({
      ipAddress: "192.168.64.9",
      username: "ade",
      password: "hunter2",
      vmName: "ade-test-vm",
      onProgress: (phase) => phases.push(phase),
      runner,
      tempDir,
    });

    expect(result.ok).toBe(true);
    expect(result.markerPath).toBe("/Users/ade/.ade-runtime-installed");
    expect(phases).toEqual(["ssh-probe", "write-script", "scp-script", "run-script", "verify-marker"]);
    // Every spawn that uses the password should go via sshpass with SSHPASS in env, never argv.
    for (const call of calls) {
      const argString = call.args.join(" ");
      expect(argString).not.toContain("hunter2");
      if (call.extraEnv?.SSHPASS) {
        expect(call.extraEnv.SSHPASS).toBe("hunter2");
        expect(call.command).toMatch(/sshpass$/);
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects usernames that could hijack the user@host SSH target", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "ade-probe-ok\n", stderr: "" }));

    await expect(
      installAdeRuntimeInVm({
        ipAddress: "192.168.64.9",
        username: "evil@otherhost",
        password: "hunter2",
        vmName: "ade-test-vm",
        runner,
      }),
    ).rejects.toThrow(/safe for SSH/i);
    expect(runner).not.toHaveBeenCalled();
  });

  it("surfaces SSH probe failures with the underlying stderr instead of swallowing them", async () => {
    const runner = vi.fn(async () => ({
      exitCode: 255,
      stdout: "",
      stderr: "Permission denied (publickey,password).",
    }));

    await expect(
      installAdeRuntimeInVm({
        ipAddress: "192.168.64.9",
        username: "ade",
        password: "hunter2",
        vmName: "ade-test-vm",
        runner,
      }),
    ).rejects.toThrow(/Permission denied/);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

function makeStaleRecord(projectRoot: string): MacosVmRecord {
  return {
    id: "vm-1",
    provider: "lume",
    name: "ade-stale-vm",
    laneId: "lane-missing",
    laneName: "Deleted lane",
    laneRoot: path.join(projectRoot, ".ade", "worktrees", "deleted-lane"),
    laneState: "missing",
    state: "stopped",
    cpuCores: 4,
    memory: "8GB",
    diskSize: "80GB",
    display: "1920x1200",
    guestSharedPath: "/Volumes/My Shared Files",
    sharedDirectory: projectRoot,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    lastStartedAt: null,
    lastStoppedAt: null,
    ipAddress: null,
    sshCommand: null,
    vncUrl: null,
    lastError: null,
    metadata: {},
  };
}

describe("deleteMacosVmFromProjectState", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes stale VM records, credentials, and global lease without a lane service", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-macos-vm-recovery-test-"));
    const adeHome = path.join(projectRoot, "ade-home");
    cleanupRoots.push(projectRoot);
    const layout = resolveAdeLayout(projectRoot);
    const record = makeStaleRecord(projectRoot);
    const storePath = path.join(layout.cacheDir, "macos-vms", "records.json");
    const leasePath = path.join(adeHome, "cache", "macos-vms", "lease.json");
    const credentialPath = path.join(layout.secretsDir, "macos-vm-vnc.v1.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
    fs.writeFileSync(storePath, `${JSON.stringify({ version: 1, records: [record] })}\n`, "utf8");
    fs.writeFileSync(leasePath, `${JSON.stringify({
      version: 1,
      lease: {
        projectRoot,
        laneId: record.laneId,
        laneName: record.laneName,
        vmId: record.id,
        vmName: record.name,
        updatedAt: record.updatedAt,
      },
    })}\n`, "utf8");
    fs.writeFileSync(credentialPath, `${JSON.stringify({
      version: 1,
      credentials: {
        [`${record.laneId}:${record.name}`]: {
          laneId: record.laneId,
          vmName: record.name,
          password: "secret",
          updatedAt: record.updatedAt,
        },
      },
    })}\n`, "utf8");
    const lumePath = path.join(projectRoot, "bin", "lume");
    fs.mkdirSync(path.dirname(lumePath), { recursive: true });
    fs.writeFileSync(lumePath, "", "utf8");
    const runCommand = vi.fn(async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "" }));

    const result = await deleteMacosVmFromProjectState({
      projectRoot,
      args: { vmName: record.name, force: true },
      env: { ADE_HOME: adeHome, LUME_PATH: lumePath },
      runCommand,
    });

    expect(result).toMatchObject({ deleted: true, previous: { laneId: record.laneId, name: record.name } });
    expect(JSON.parse(fs.readFileSync(storePath, "utf8")).records).toEqual([]);
    expect(JSON.parse(fs.readFileSync(leasePath, "utf8")).lease).toBeNull();
    expect(JSON.parse(fs.readFileSync(credentialPath, "utf8")).credentials).toEqual({});
    expect(runCommand).toHaveBeenCalledWith(
      lumePath,
      ["delete", record.name, "--force"],
      expect.objectContaining({ cwd: projectRoot, timeoutMs: 60_000 }),
    );
  });
});
