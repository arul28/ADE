import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  __testResetIosurfaceCapabilityCache,
  __testSetIosSimulatorProcessHooks,
  createIosSimulatorService,
  detectIosurfaceIndigoCapability,
  IosSimulatorOwnedBySessionError,
  iosurfaceInputScreenFromSnapshot,
  iosurfaceInputPointPayload,
  normalizeIosSimulatorPointForIndigo,
  parseXcodePreviewWindows,
  resolveIosSimulatorStreamBackend,
  shouldOpenSimulatorAppForLaunch,
} from "./iosSimulatorService";
import { IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE } from "../../../shared/types/iosSimulator";
import type { IosSimulatorEventPayload } from "../../../shared/types";
import type { Logger } from "../logging/logger";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function mockChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.stdin = new EventEmitter() as ChildProcess["stdin"];
  Object.defineProperty(child, "exitCode", { configurable: true, value: 0 });
  Object.defineProperty(child, "signalCode", { configurable: true, value: null });
  child.kill = vi.fn(() => true) as unknown as ChildProcess["kill"];
  child.unref = vi.fn(() => child) as unknown as ChildProcess["unref"];
  return child;
}

const simulatorDevicesJson = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
      {
        name: "iPhone 17 Pro",
        udid: "device-1",
        state: "Booted",
        isAvailable: true,
      },
    ],
  },
});

afterEach(() => {
  __testResetIosurfaceCapabilityCache();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("iosSimulatorService IOSurface helper capability", () => {
  it("allows packaged helper sources and builds helpers outside the signed app bundle", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ios-helper-packaged-"));
    const tempHome = path.join(tempRoot, "home");
    const developerDir = path.join(tempRoot, "Xcode.app", "Contents", "Developer");
    const simulatorKitDir = path.join(
      developerDir,
      "Platforms",
      "iPhoneSimulator.platform",
      "Developer",
      "Library",
      "PrivateFrameworks",
      "SimulatorKit.framework",
    );
    const helperRoot = path.join(tempRoot, "ADE.app", "Contents", "Resources", "native", "ios-sim-helpers");
    const previousHelperRoot = process.env.ADE_IOS_SIM_HELPER_ROOT;
    const previousHelperBuildRoot = process.env.ADE_IOS_SIM_HELPER_BUILD_ROOT;
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    let capturedBuildRoot: string | undefined;

    fs.mkdirSync(simulatorKitDir, { recursive: true });
    fs.mkdirSync(helperRoot, { recursive: true });
    fs.writeFileSync(path.join(helperRoot, "build.sh"), "#!/usr/bin/env bash\n");
    fs.writeFileSync(path.join(helperRoot, "sim-capture.swift"), "print(\"capture\")\n");
    fs.writeFileSync(path.join(helperRoot, "sim-input.m"), "int main(void) { return 0; }\n");
    process.env.ADE_IOS_SIM_HELPER_ROOT = helperRoot;
    delete process.env.ADE_IOS_SIM_HELPER_BUILD_ROOT;

    const runMock = vi.fn(async (command: string, commandArgs: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (command === "/usr/bin/xcode-select") return { stdout: `${developerDir}\n`, stderr: "" };
      if (command === "xcodebuild") return { stdout: "Xcode 26.3\nBuild version 17C52\n", stderr: "" };
      if (command === "bash" && commandArgs[0] === path.join(helperRoot, "build.sh")) {
        capturedBuildRoot = options?.env?.ADE_IOS_SIM_HELPER_BUILD_ROOT;
        const buildDir = path.join(capturedBuildRoot ?? helperRoot, "xcode-26.3-test");
        return {
          stdout: JSON.stringify({
            xcodeVersion: "26.3",
            sourceHash: "test-hash",
            buildDir,
            capture: path.join(buildDir, "sim-capture"),
            input: path.join(buildDir, "sim-input"),
          }),
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${command} ${commandArgs.join(" ")}`);
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({
      run: runMock,
      commandExists: () => true,
    });

    try {
      const capability = await detectIosurfaceIndigoCapability();
      expect(capability.available).toBe(true);
      expect(capturedBuildRoot).toBe(path.join(tempHome, "Library", "Caches", "ADE", "ios-sim-helpers"));
      expect(capturedBuildRoot).not.toContain(".app");
    } finally {
      restoreHooks();
      platformSpy.mockRestore();
      homeSpy.mockRestore();
      if (previousHelperRoot == null) {
        delete process.env.ADE_IOS_SIM_HELPER_ROOT;
      } else {
        process.env.ADE_IOS_SIM_HELPER_ROOT = previousHelperRoot;
      }
      if (previousHelperBuildRoot == null) {
        delete process.env.ADE_IOS_SIM_HELPER_BUILD_ROOT;
      } else {
        process.env.ADE_IOS_SIM_HELPER_BUILD_ROOT = previousHelperBuildRoot;
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("iosSimulatorService cross-platform safety", () => {
  it("constructs without throwing on non-darwin platforms", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(() => {
      const service = createIosSimulatorService({
        projectRoot: os.tmpdir(),
        logger: noopLogger,
      });
      service.dispose();
    }).not.toThrow();
    platformSpy.mockRestore();
  });

  it("reports supported=false and structured tool statuses on non-darwin", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const service = createIosSimulatorService({
      projectRoot: os.tmpdir(),
      logger: noopLogger,
    });
    try {
      const status = await service.getStatus();
      expect(status.supported).toBe(false);
      expect(status.platform).toBe("linux");
      const xcrun = status.tools.find((tool) => tool.name === "xcrun");
      expect(xcrun?.available).toBe(false);
      expect(typeof xcrun?.detail).toBe("string");
      expect(typeof xcrun?.installHint).toBe("string");
      const simulatorWindow = status.tools.find((tool) => tool.name === "simulator_window");
      expect(simulatorWindow?.available).toBe(false);
      expect(status.activeSession).toBeNull();
    } finally {
      service.dispose();
      platformSpy.mockRestore();
    }
  });

  it("rejects launch on non-darwin with a useful error", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const service = createIosSimulatorService({
      projectRoot: os.tmpdir(),
      logger: noopLogger,
    });
    try {
      await expect(service.launch({ chatSessionId: "chat-1" })).rejects.toThrow(/macOS/);
    } finally {
      service.dispose();
      platformSpy.mockRestore();
    }
  });
});

describe("iosSimulatorService single-owner lock contract", () => {
  it("IosSimulatorOwnedBySessionError carries a stable code and currentChatSessionId", () => {
    const previousSession = {
      id: "session-1",
      deviceUdid: "udid-1",
      deviceName: "iPhone 16",
      bundleId: "com.example.app",
      appName: "Example",
      appBundlePath: null,
      targetId: null,
      projectRoot: "/tmp",
      chatSessionId: "chat-A",
      mode: "snapshot" as const,
      bridgeUrl: null,
      startedAt: new Date().toISOString(),
    };
    const error = new IosSimulatorOwnedBySessionError(previousSession);
    expect(error.code).toBe(IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE);
    expect(error.name).toBe("IosSimulatorOwnedBySessionError");
    expect(error.currentChatSessionId).toBe("chat-A");
    expect(error.message).toContain(IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE);
    expect(error.message).toContain("chat-A");
  });
});

describe("iosSimulatorService shutdown contract", () => {
  it("shutdown emits session-released with previousSession=null when nothing is active and reports released=false", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const events: Array<{ type: string }> = [];
    const service = createIosSimulatorService({
      projectRoot: os.tmpdir(),
      logger: noopLogger,
      onEvent: (payload) => {
        events.push(payload);
      },
    });
    try {
      const result = await service.shutdown();
      expect(result.released).toBe(false);
      expect(result.previousSession).toBeNull();
      expect(events.find((e) => e.type === "session-released")).toBeUndefined();
    } finally {
      service.dispose();
      platformSpy.mockRestore();
    }
  });
});

describe("iosSimulatorService Simulator.app launch visibility", () => {
  it("does not open Simulator.app by default during headless launch", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "ps") return { stdout: "", stderr: "" };
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      if (command === "xcrun" && commandArgs[1] === "listapps") return { stdout: "", stderr: "" };
      if (command === "xcrun" && commandArgs[1] === "install") return { stdout: "", stderr: "" };
      if (command === "xcrun" && commandArgs[1] === "launch") return { stdout: "com.example.app: 123\n", stderr: "" };
      if (command === "/usr/libexec/PlistBuddy" && commandArgs[1]?.includes("CFBundleIdentifier")) {
        return { stdout: "com.example.app\n", stderr: "" };
      }
      if (command === "/usr/libexec/PlistBuddy" && commandArgs[1]?.includes("CFBundleDisplayName")) {
        return { stdout: "Example\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const spawnMock = vi.fn<[string, string[], unknown?], ChildProcess>(() => mockChildProcess());
    const restoreHooks = __testSetIosSimulatorProcessHooks({
      run: runMock,
      spawn: spawnMock as unknown as typeof nodeSpawn,
      commandExists: () => true,
    });
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-launch-hidden-`);
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      await service.launch({
        projectRoot,
        appBundlePath: "/tmp/Example.app",
        bundleId: "com.example.app",
        build: false,
      });
      expect(spawnMock.mock.calls.some(([command]) => command === "open")).toBe(false);
      expect(spawnMock.mock.calls.some(([command]) => command === "osascript")).toBe(false);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("opens Simulator.app only when foreground launch is requested", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "ps") return { stdout: "", stderr: "" };
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      if (command === "xcrun" && commandArgs[1] === "listapps") return { stdout: "", stderr: "" };
      if (command === "xcrun" && commandArgs[1] === "install") return { stdout: "", stderr: "" };
      if (command === "xcrun" && commandArgs[1] === "launch") return { stdout: "com.example.app: 123\n", stderr: "" };
      if (command === "/usr/libexec/PlistBuddy" && commandArgs[1]?.includes("CFBundleIdentifier")) {
        return { stdout: "com.example.app\n", stderr: "" };
      }
      if (command === "/usr/libexec/PlistBuddy" && commandArgs[1]?.includes("CFBundleDisplayName")) {
        return { stdout: "Example\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const spawnMock = vi.fn<[string, string[], unknown?], ChildProcess>(() => mockChildProcess());
    const restoreHooks = __testSetIosSimulatorProcessHooks({
      run: runMock,
      spawn: spawnMock as unknown as typeof nodeSpawn,
      commandExists: () => true,
    });
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-launch-foreground-`);
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      await service.launch({
        projectRoot,
        appBundlePath: "/tmp/Example.app",
        bundleId: "com.example.app",
        build: false,
        keepSimulatorInBackground: false,
      });
      expect(spawnMock).toHaveBeenCalledWith("open", ["-a", "Simulator"], { detached: true, stdio: "ignore" });
      expect(spawnMock.mock.calls.some(([command]) => command === "osascript")).toBe(false);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("opens Simulator.app when explicit window capture streaming is requested", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const spawnMock = vi.fn<[string, string[], unknown?], ChildProcess>(() => mockChildProcess());
    const restoreHooks = __testSetIosSimulatorProcessHooks({
      run: runMock,
      spawn: spawnMock as unknown as typeof nodeSpawn,
      commandExists: () => true,
    });
    const service = createIosSimulatorService({ projectRoot: os.tmpdir(), logger: noopLogger });

    try {
      const status = await service.startStream({ deviceUdid: "device-1", backend: "simulator-window-capture" });
      expect(status.backend).toBe("simulator-window-capture");
      expect(spawnMock).toHaveBeenCalledWith("open", ["-a", "Simulator"], { detached: true, stdio: "ignore" });
    } finally {
      service.dispose();
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("falls back from a frame-less idb MJPEG stream to drawable simulator screenshots", async () => {
    vi.useFakeTimers();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const events: IosSimulatorEventPayload[] = [];
    const companionServers: net.Server[] = [];
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "ps") return { stdout: "", stderr: "" };
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      if (command === "xcrun" && commandArgs[1] === "io" && commandArgs[3] === "screenshot") {
        const outputPath = commandArgs.at(-1);
        if (outputPath) fs.writeFileSync(outputPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        return { stdout: "", stderr: "" };
      }
      if (command === "/usr/bin/xcode-select") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const spawnMock = vi.fn<[string, string[], unknown?], ChildProcess>((command, commandArgs) => {
      const child = mockChildProcess();
      Object.defineProperty(child, "exitCode", { configurable: true, value: null });
      Object.defineProperty(child, "signalCode", { configurable: true, value: null });
      if (command === "idb_companion") {
        const portArg = commandArgs[commandArgs.indexOf("--grpc-port") + 1];
        const port = Number(portArg);
        const server = net.createServer((socket) => socket.end());
        server.listen(port, "127.0.0.1");
        companionServers.push(server);
        child.kill = vi.fn(() => {
          server.close();
          return true;
        }) as unknown as ChildProcess["kill"];
      }
      return child;
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({
      run: runMock,
      spawn: spawnMock as unknown as typeof nodeSpawn,
      commandExists: (command) => command === "xcrun" || command === "idb" || command === "idb_companion",
    });
    const service = createIosSimulatorService({
      projectRoot: os.tmpdir(),
      logger: noopLogger,
      onEvent: (payload) => {
        events.push(payload);
      },
    });

    try {
      const initialStatus = await service.startStream({ deviceUdid: "device-1", backend: "idb-mjpeg", fps: 30 });
      expect(initialStatus.backend).toBe("idb-mjpeg");
      expect(initialStatus.streamUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ios-simulator\/stream\.mjpg$/);

      await vi.advanceTimersByTimeAsync(5_100);
      await vi.waitFor(() => {
        expect(events.some((event) => (
          event.type === "stream-error"
          && event.status.backend === "idb-mjpeg"
          && event.status.degradationReason?.includes("idb MJPEG produced no frames")
        ))).toBe(true);
        expect(events.some((event) => (
          event.type === "stream-started"
          && event.status.backend === "simctl-screenshot-poll"
          && typeof event.status.streamUrl === "string"
        ))).toBe(true);
      });
      await vi.waitFor(() => {
        expect(service.getStreamStatus().frameCount).toBeGreaterThan(0);
      });

      const finalStatus = service.getStreamStatus();
      expect(finalStatus.backend).toBe("simctl-screenshot-poll");
      expect(finalStatus.running).toBe(true);
      expect(finalStatus.streamUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ios-simulator\/stream\.mjpg$/);
      expect(finalStatus.frameCount).toBeGreaterThan(0);
    } finally {
      service.dispose();
      for (const server of companionServers) server.close();
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("documents launch and stream backend defaults with pure helpers", () => {
    expect(shouldOpenSimulatorAppForLaunch(undefined)).toBe(false);
    expect(shouldOpenSimulatorAppForLaunch(true)).toBe(false);
    expect(shouldOpenSimulatorAppForLaunch(false)).toBe(true);
    const bools = [false, true];
    for (const iosurfaceIndigo of bools) {
      for (const windowCaptureAllowed of bools) {
        for (const idb of bools) {
          for (const idbCompanion of bools) {
            for (const ffmpeg of bools) {
              const expected = iosurfaceIndigo
                ? "iosurface-indigo"
                : windowCaptureAllowed
                  ? "simulator-window-capture"
                  : idb && idbCompanion
                    ? "idb-mjpeg"
                    : "simctl-screenshot-poll";
              expect(resolveIosSimulatorStreamBackend("auto", {
                iosurfaceIndigo,
                windowCaptureAllowed,
                idb,
                idbCompanion,
                ffmpeg,
              })).toBe(expected);
            }
          }
        }
      }
    }
    const tools = { iosurfaceIndigo: true, windowCaptureAllowed: true, idb: true, idbCompanion: true, ffmpeg: true };
    expect(resolveIosSimulatorStreamBackend("simulator-window-capture", tools)).toBe("simulator-window-capture");
    expect(resolveIosSimulatorStreamBackend("idb-h264-ffmpeg-mjpeg", tools)).toBe("idb-h264-ffmpeg-mjpeg");
  });

  it("normalizes point coordinates for Indigo input using screen points", () => {
    expect(normalizeIosSimulatorPointForIndigo(
      { x: 430, y: 932 },
      { width: 430, height: 932 },
    )).toEqual({ x: 1, y: 1 });
    expect(normalizeIosSimulatorPointForIndigo(
      { x: 215, y: 466 },
      { width: 430, height: 932 },
    )).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizeIosSimulatorPointForIndigo(
      { x: 196, y: 400 },
      { width: 393, height: 852 },
    )).toEqual({
      x: 196 / 393,
      y: 400 / 852,
    });
  });

  it("uses full screenshot dimensions for IOSurface input even when inspector screen is content-height only", () => {
    const inputScreen = iosurfaceInputScreenFromSnapshot(
      { width: 402, height: 778, scale: 3 },
      { width: 1206, height: 2622 },
    );
    expect(inputScreen).toEqual({ width: 402, height: 874, scale: 3 });
    expect(normalizeIosSimulatorPointForIndigo({ x: 201, y: 830 }, inputScreen)).toEqual({
      x: 0.5,
      y: 830 / 874,
    });
  });

  it("builds point-space Indigo input payloads with screen dimensions", () => {
    expect(iosurfaceInputPointPayload(
      { x: 201, y: 830 },
      { width: 402, height: 874 },
    )).toEqual({
      x: 201,
      y: 830,
      width: 402,
      height: 874,
    });
  });
});

describe("iosSimulatorService Xcode preview parsing", () => {
  it("parses Xcode 26 MCP windowtab identifiers", () => {
    const projectRoot = "/Users/admin/Projects/ADE/.ade/worktrees/ios-sim-editor-b0e2801b";
    const windows = parseXcodePreviewWindows(
      "* tabIdentifier: windowtab1, workspacePath: /Users/admin/Projects/ADE/.ade/worktrees/ios-sim-editor-b0e2801b/apps/ios/ADE.xcodeproj\n",
      projectRoot,
    );

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      tabIdentifier: "windowtab1",
      workspacePath: `${projectRoot}/apps/ios/ADE.xcodeproj`,
    });
  });

  it("dedupes repeated tabIdentifiers across multi-line MCP output", () => {
    const projectRoot = "/Users/admin/Projects/ADE";
    const raw = [
      "* tabIdentifier: windowtab1, workspacePath: /Users/admin/Projects/ADE/apps/ios/ADE.xcodeproj",
      "  tabIdentifier: windowtab1, title: \"Stale\"",
      "* tabIdentifier: windowtab2, workspacePath: /Users/admin/Projects/ADE/apps/ios/ADE.xcodeproj",
    ].join("\n");
    const windows = parseXcodePreviewWindows(raw, projectRoot);
    expect(windows.map((w) => w.tabIdentifier)).toEqual(["windowtab1", "windowtab2"]);
  });

  it("synthesizes a fallback window when raw output mentions projectRoot but has no parseable identifiers", () => {
    const projectRoot = "/Users/admin/Projects/ADE";
    const raw = "Xcode is busy at /Users/admin/Projects/ADE/apps/ios/ADE.xcodeproj";
    const windows = parseXcodePreviewWindows(raw, projectRoot);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      tabIdentifier: "",
      workspacePath: projectRoot,
      raw,
    });
  });

  it("returns an empty array when raw output is whitespace", () => {
    expect(parseXcodePreviewWindows("   \n  ", "/tmp/project")).toEqual([]);
  });

  it("rejects preview rendering early when the Swift source file is missing", async () => {
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-preview-missing-`);
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
    });

    try {
      await expect(service.renderPreview({ sourceFilePath: "MissingScreen.swift" })).rejects.toThrow(/Swift source file was not found/);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
