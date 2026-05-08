import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMacosVmService } from "./macosVmService";
import type { Logger } from "../logging/logger";

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
    bundleRoot: path.join(projectRoot, "vm-bundles"),
    laneRoot,
    lane: {
      id: "lane-1",
      name: "Lane One",
      worktreePath: laneRoot,
    },
  };
}

function helperBuildJson(projectRoot: string) {
  const helper = path.join(projectRoot, "native-helper");
  return JSON.stringify({
    helper,
    buildDir: projectRoot,
    sourceHash: "test",
    osVersion: "26.3",
  });
}

function commandResult(stdout = "") {
  return { exitCode: 0, signal: null, stdout, stderr: "" };
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function blackPng(width = 320, height = 240): Buffer {
  const header = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    header,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("createMacosVmService", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it("reports Apple Virtualization helper readiness", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true, osVersion: "26.3" }));
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    const status = await service.getStatus({ laneId: "lane-1" });

    expect(status.supported).toBe(true);
    expect(status.activeProvider.kind).toBe("apple-virtualization-helper");
    expect(status.activeProvider.available).toBe(true);
    expect(status.tools).toEqual([
      expect.objectContaining({ name: "apple-virtualization", available: true }),
    ]);
    expect(status.docs.appleVirtualization).toContain("developer.apple.com/documentation/virtualization");
  });

  it("provisions and starts a native lane VM through the helper", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true, osVersion: "26.3" }));
      if (args[0] === "provision") {
        const bundle = args[args.indexOf("--bundle") + 1]!;
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "ade-vm.json"), "{}");
        return commandResult(JSON.stringify({ type: "completed", restoreImage: { buildVersion: "25E253" } }));
      }
      if (args[0] === "run") return commandResult(JSON.stringify({ type: "started" }));
      if (command === "rsync") return commandResult();
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    const provisioned = await service.provision({ laneId: "lane-1", mode: "create", ipsw: "latest" });
    const started = await service.start({ laneId: "lane-1", openDisplay: false });

    expect(provisioned.provider).toBe("apple-virtualization-helper");
    expect(provisioned.state).toBe("stopped");
    expect(started.state).toBe("running");
    expect(commands.some(({ args }) => args[0] === "provision" && args.includes("--ipsw") && args.includes("latest"))).toBe(true);
    expect(commands.some(({ args }) => args[0] === "run" && args.includes("--headless"))).toBe(true);
  });

  it("creates one prepared base and clones it into a lane VM", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true, osVersion: "26.3" }));
      if (args[0] === "provision") {
        const bundle = args[args.indexOf("--bundle") + 1]!;
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "ade-vm.json"), JSON.stringify({
          cpuCount: 2,
          memorySize: 4 * 1024 * 1024 * 1024,
          diskSize: 64 * 1024 * 1024 * 1024,
          display: "1440x900",
        }));
        return commandResult(JSON.stringify({ type: "completed", restoreImage: { buildVersion: "25E253" } }));
      }
      if (command === "cp") {
        const source = args.at(-2)!;
        const destination = args.at(-1)!;
        fs.cpSync(source, destination, { recursive: true });
        return commandResult();
      }
      if (args[0] === "run") return commandResult(JSON.stringify({ type: "started" }));
      if (command === "rsync") return commandResult();
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    const base = await service.createBase({ name: "default", ipsw: "latest" });
    const readyBase = await service.markBaseReady({ name: "default" });
    const laneVm = await service.provision({ laneId: "lane-1", fromBase: true, baseName: "default" });
    const started = await service.start({ laneId: "lane-1", openDisplay: false });

    expect(base.state).toBe("setup_required");
    expect(readyBase.state).toBe("ready");
    expect(laneVm.state).toBe("stopped");
    expect(laneVm.metadata.source).toBe("prepared-base");
    expect(laneVm.metadata.guestSetupCompleted).toBe(true);
    expect(started.state).toBe("running");
    expect(commands.some(({ args }) => args[0] === "provision" && !args.includes("--shared-dir"))).toBe(true);
    expect(commands.some(({ command, args }) => command === "cp" && args.includes("-cR"))).toBe(true);
    expect(commands.some(({ args }) => args[0] === "run" && args.includes("--shared-dir") && args.includes("--headless"))).toBe(true);
  });

  it("resolves latest to the matching mesu IPSW before base provisioning", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const fixtureXml = fs.readFileSync(
      path.join(__dirname, "__fixtures__", "macos_ipsw_mesu_fixture.xml"),
      "utf8",
    );
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true, osVersion: "26.3" }));
      if (command === "sw_vers") return commandResult("25D125\n");
      if (command === "sysctl") return commandResult("Mac16,1\n");
      if (command === "softwareupdate") return commandResult("* Label: macOS Tahoe 26.4.1-25E253\n");
      if (args[0] === "provision") {
        const bundle = args[args.indexOf("--bundle") + 1]!;
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "ade-vm.json"), "{}");
        return commandResult(JSON.stringify({ type: "completed", restoreImage: { buildVersion: "25E253" } }));
      }
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
      fetchText: async () => fixtureXml,
      fetchContentLength: async () => 17_300_000_000,
    });

    const base = await service.createBase({ name: "default", ipsw: "latest" });

    expect(base.metadata.ipswResolution).toMatchObject({
      build: "25E253",
      productVersion: "26.4.1",
      sizeBytes: 17_300_000_000,
    });
    expect(commands.some(({ args }) =>
      args[0] === "provision" &&
      args.includes("--ipsw") &&
      args.includes("https://updates.cdn-apple.com/macOS-26.4.1-25E253.ipsw") &&
      args.includes("--restore-images-dir"),
    )).toBe(true);
  });

  it("uses a sanitized mirror when a lane root contains ADE local state", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    fs.mkdirSync(path.join(temp.laneRoot, ".ade", "secrets"), { recursive: true });
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true }));
      if (command === "rsync") return commandResult();
      return commandResult(JSON.stringify({ type: "ok" }));
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    const policy = await service.getSharePolicy({ laneId: "lane-1" });

    expect(policy.syncMode).toBe("sanitized-mirror");
    expect(policy.hostPath).not.toBe(temp.laneRoot);
    expect(policy.guestPath).toBe("/Volumes/My Shared Files");
    expect(policy.excludedPaths).toContain(".env");
    expect(policy.excludedPaths).toContain(".env.*");
    expect(policy.excludedPaths).toContain("/.ade/secrets/***");
  });

  it("focuses, screenshots, selects, clicks, and types into the native VM window", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true }));
      if (args[0] === "provision") {
        const bundle = args[args.indexOf("--bundle") + 1]!;
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "ade-vm.json"), "{}");
        return commandResult(JSON.stringify({ type: "completed" }));
      }
      if (args[0] === "run") return commandResult(JSON.stringify({ type: "started" }));
      if (args[0] === "window-info") {
        return commandResult(JSON.stringify({
          type: "window",
          processName: "macos-vm-helper",
          processId: 42,
          windowId: 24,
          windowTitle: "ade-ade-lane-one-lane-1",
          x: 10,
          y: 20,
          width: 640,
          height: 480,
        }));
      }
      if (args[0] === "capture-window") {
        fs.writeFileSync(args[args.indexOf("--output") + 1]!, Buffer.from("png"));
        return commandResult(JSON.stringify({
          type: "window",
          processName: "macos-vm-helper",
          processId: 42,
          windowId: 24,
          windowTitle: "ade-ade-lane-one-lane-1",
          x: 10,
          y: 20,
          width: 640,
          height: 480,
        }));
      }
      if (command === "osascript") return commandResult("macos-vm-helper\tade-ade-lane-one-lane-1\t10\t20\t640\t480");
      if (command === "screencapture") {
        fs.writeFileSync(args.at(-1)!, Buffer.from("png"));
        return commandResult();
      }
      if (command === "rsync") return commandResult();
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    await service.start({ laneId: "lane-1" });
    const screenshot = await service.captureScreenshot({ laneId: "lane-1" });
    const selected = await service.selectPoint({ laneId: "lane-1", x: 25, y: 35 });
    const clicked = await service.click({ laneId: "lane-1", x: 25, y: 35 });
    const typed = await service.typeText({ laneId: "lane-1", text: "hello" });

    expect(screenshot.captureMode).toBe("window-id");
    expect(screenshot.window.processName).toBe("macos-vm-helper");
    expect(selected.source).toBe("coordinate-fallback");
    expect(clicked).toMatchObject({ ok: true, x: 35, y: 55 });
    expect(typed).toMatchObject({ ok: true, window: { processName: "macos-vm-helper" } });
  });

  it("wakes and retries a screenshot when the VM display is asleep", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    let captureCount = 0;
    const osascripts: string[] = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true }));
      if (args[0] === "provision") {
        const bundle = args[args.indexOf("--bundle") + 1]!;
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "ade-vm.json"), "{}");
        return commandResult(JSON.stringify({ type: "completed" }));
      }
      if (args[0] === "run") return commandResult(JSON.stringify({ type: "started" }));
      if (args[0] === "window-info" || args[0] === "capture-window") {
        if (args[0] === "capture-window") {
          captureCount += 1;
          fs.writeFileSync(args[args.indexOf("--output") + 1]!, captureCount === 1 ? blackPng() : Buffer.from("png"));
        }
        return commandResult(JSON.stringify({
          type: "window",
          processName: "macos-vm-helper",
          processId: 42,
          windowId: 24,
          windowTitle: "ade-ade-lane-one-lane-1",
          x: 10,
          y: 20,
          width: 640,
          height: 480,
        }));
      }
      if (command === "osascript") {
        osascripts.push(args.join("\n"));
        return commandResult();
      }
      if (command === "rsync") return commandResult();
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    await service.start({ laneId: "lane-1" });
    const screenshot = await service.captureScreenshot({ laneId: "lane-1" });

    expect(screenshot.captureMode).toBe("window-id");
    expect(captureCount).toBe(2);
    expect(osascripts.some((script) => script.includes("key code 49"))).toBe(true);
  });

  it("focuses the prepared base helper window when it is running", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const helperCalls: Array<{ args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true, osVersion: "26.3" }));
      if (args[0] === "provision") {
        const bundle = args[args.indexOf("--bundle") + 1]!;
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "ade-vm.json"), "{}");
        return commandResult(JSON.stringify({ type: "completed", restoreImage: { buildVersion: "25E253" } }));
      }
      if (args[0] === "run") return commandResult(JSON.stringify({ type: "started" }));
      if (args[0] === "window-info") {
        helperCalls.push({ args });
        return commandResult(JSON.stringify({
          type: "window",
          processName: "macos-vm-helper",
          processId: process.pid,
          windowId: 11,
          windowTitle: "ADE macOS Base - default",
          x: 5,
          y: 10,
          width: 800,
          height: 600,
        }));
      }
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    await service.createBase({ name: "default", ipsw: "latest" });
    await service.startBase({ name: "default", openDisplay: false });
    const baseBundle = path.join(temp.bundleRoot, "bases", "default.bundle");
    fs.writeFileSync(
      path.join(baseBundle, "runtime-status.json"),
      JSON.stringify({ state: "running", pid: process.pid, updatedAt: new Date().toISOString() }),
    );

    const target = await service.focusBaseWindow({ name: "default" });

    expect(target.windowTitle).toBe("ADE macOS Base - default");
    expect(target.processName).toBe("macos-vm-helper");
    expect(helperCalls.some(({ args }) => args.includes("--owner") && args.includes("macos-vm-helper") && args.includes("--activate"))).toBe(true);
    expect(helperCalls.some(({ args }) => args[0] === "window-info" && args.some((value) => value.includes("ADE macOS Base - default")))).toBe(true);
  });

  it("rejects focusBaseWindow when the base is missing", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true }));
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    await expect(service.focusBaseWindow({ name: "missing" })).rejects.toThrow(/No prepared macOS base/);
  });

  it("saves a stopped lane VM as a new snapshot", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const commands: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args });
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true }));
      if (args[0] === "provision") {
        const bundle = args[args.indexOf("--bundle") + 1]!;
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "ade-vm.json"), JSON.stringify({ name: path.basename(bundle, ".bundle") }));
        return commandResult(JSON.stringify({ type: "completed" }));
      }
      if (command === "cp") {
        const source = args.at(-2)!;
        const destination = args.at(-1)!;
        fs.cpSync(source, destination, { recursive: true });
        return commandResult();
      }
      if (args[0] === "run") return commandResult(JSON.stringify({ type: "started" }));
      if (command === "rsync") return commandResult();
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    await service.provision({ laneId: "lane-1", mode: "create", ipsw: "latest" });

    const snapshot = await service.saveLaneVmAsSnapshot({
      laneId: "lane-1",
      name: "before-deploy",
      description: "Snapshot taken before deploying.",
    });

    expect(snapshot.state).toBe("ready");
    expect(snapshot.name).toBe("before-deploy");
    expect(snapshot.metadata.guestSetupCompleted).toBe(true);
    expect(snapshot.metadata.baseRole).toBe("saved-from-lane");
    expect(snapshot.metadata.savedFromLaneId).toBe("lane-1");
    expect(snapshot.metadata.description).toBe("Snapshot taken before deploying.");
    const baseBundlePath = path.join(temp.bundleRoot, "bases", "before-deploy.bundle");
    expect(fs.existsSync(path.join(baseBundlePath, "ade-vm.json"))).toBe(true);
    const status = await service.getStatus({ laneId: "lane-1" });
    expect(status.bases.some((entry) => entry.name === "before-deploy" && entry.state === "ready")).toBe(true);
    expect(commands.some(({ command, args }) => command === "cp" && args.includes("-cR"))).toBe(true);
  });

  it("rejects saveLaneVmAsSnapshot when the lane VM is not stopped", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true }));
      if (args[0] === "provision") {
        const bundle = args[args.indexOf("--bundle") + 1]!;
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "ade-vm.json"), "{}");
        return commandResult(JSON.stringify({ type: "completed" }));
      }
      if (args[0] === "run") return commandResult(JSON.stringify({ type: "started" }));
      if (command === "rsync") return commandResult();
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    await service.start({ laneId: "lane-1", openDisplay: false });

    await expect(
      service.saveLaneVmAsSnapshot({ laneId: "lane-1", name: "running-snap" }),
    ).rejects.toThrow(/Stop the lane macOS VM/);
  });

  it("renames a prepared base and updates its bundle path", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true }));
      if (args[0] === "provision") {
        const bundle = args[args.indexOf("--bundle") + 1]!;
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "ade-vm.json"), "{}");
        return commandResult(JSON.stringify({ type: "completed" }));
      }
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    await service.createBase({ name: "default", ipsw: "latest" });
    await service.markBaseReady({ name: "default" });

    const renamed = await service.renameBase({ from: "default", to: "macos-26-3" });

    expect(renamed.name).toBe("macos-26-3");
    expect(renamed.metadata.renamedFrom).toBe("default");
    const oldBundle = path.join(temp.bundleRoot, "bases", "default.bundle");
    const newBundle = path.join(temp.bundleRoot, "bases", "macos-26-3.bundle");
    expect(fs.existsSync(oldBundle)).toBe(false);
    expect(fs.existsSync(newBundle)).toBe(true);
    const status = await service.getStatus();
    expect(status.bases.some((entry) => entry.name === "macos-26-3")).toBe(true);
    expect(status.bases.some((entry) => entry.name === "default")).toBe(false);
  });

  it("rejects renameBase when the destination already exists", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true }));
      if (args[0] === "provision") {
        const bundle = args[args.indexOf("--bundle") + 1]!;
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "ade-vm.json"), "{}");
        return commandResult(JSON.stringify({ type: "completed" }));
      }
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    await service.createBase({ name: "default", ipsw: "latest" });
    await service.markBaseReady({ name: "default" });
    await service.createBase({ name: "fresh-26", ipsw: "latest" });
    await service.markBaseReady({ name: "fresh-26" });

    await expect(service.renameBase({ from: "default", to: "fresh-26" })).rejects.toThrow(/already exists/);
  });

  it("preserves bundled IPSW files in restore-images when deleting a base", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true }));
      if (args[0] === "provision") {
        const bundle = args[args.indexOf("--bundle") + 1]!;
        fs.mkdirSync(bundle, { recursive: true });
        fs.writeFileSync(path.join(bundle, "ade-vm.json"), "{}");
        return commandResult(JSON.stringify({ type: "completed" }));
      }
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    await service.createBase({ name: "default", ipsw: "latest" });
    const baseBundle = path.join(temp.bundleRoot, "bases", "default.bundle");
    fs.writeFileSync(path.join(baseBundle, "UniversalMac_26.4.1_25E253_Restore.ipsw"), "cached");

    await service.deleteBase({ name: "default", force: true });

    expect(fs.existsSync(path.join(baseBundle, "ade-vm.json"))).toBe(false);
    expect(fs.readFileSync(path.join(temp.bundleRoot, "restore-images", "UniversalMac_26.4.1_25E253_Restore.ipsw"), "utf8")).toBe("cached");
  });

  it("clears the shared IPSW cache explicitly", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true }));
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });
    const cacheDir = path.join(temp.bundleRoot, "restore-images");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "UniversalMac.ipsw"), "cached");

    const result = await service.clearIpswCache();

    expect(result).toMatchObject({ cleared: true, path: cacheDir });
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });

  it("builds agent guidance around Apple Virtualization and the mounted lane", async () => {
    const temp = makeTempProject();
    cleanupRoots.push(temp.projectRoot);
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      if (command.endsWith("build.sh")) return commandResult(helperBuildJson(temp.projectRoot));
      if (args[0] === "doctor") return commandResult(JSON.stringify({ type: "doctor", supported: true }));
      return commandResult();
    });
    const service = createMacosVmService({
      projectRoot: temp.projectRoot,
      logger,
      resolveLanes: async () => [temp.lane],
      runCommand,
      platform: "darwin",
      arch: "arm64",
      env: { ADE_MACOS_VM_BUNDLE_ROOT: temp.bundleRoot },
    });

    const guide = await service.getAgentGuide({ laneId: "lane-1" });

    expect(guide.text).toContain("Apple");
    expect(guide.text).toContain("/Volumes/My Shared Files");
    expect(guide.target.provider).toBe("apple-virtualization-helper");
    expect(guide.target.runCommand).toContain("ade --socket macos-vm start");
  });
});
