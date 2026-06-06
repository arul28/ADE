import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  __testSetIosSimulatorProcessHooks,
  createIosSimulatorService,
  IosSimulatorOwnedBySessionError,
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

function writeMinimalXcodeProject(
  projectRoot: string,
  projectName: string,
  options: { targetName?: string; productName?: string; schemeName?: string } = {},
): string {
  const targetName = options.targetName ?? projectName;
  const productName = options.productName ?? targetName;
  const targetId = "PROXTARGET00000000000001";
  const projectPath = path.join(projectRoot, `${projectName}.xcodeproj`);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, "project.pbxproj"), `
/* Begin PBXGroup section */
		PROXGROUP0000000000000001 /* Products */ = {
			isa = PBXGroup;
			name = Products;
		};
/* End PBXGroup section */
/* Begin PBXNativeTarget section */
		${targetId} /* ${targetName} */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = PROXCONFIG00000000000001 /* Build configuration list for PBXNativeTarget "${targetName}" */;
			buildPhases = ();
			buildRules = ();
			dependencies = ();
			name = ${targetName};
			productName = ${productName};
			productReference = PROXPRODUCT0000000000001 /* ${productName}.app */;
			productType = "com.apple.product-type.application";
		};
		PROXTESTS000000000000001 /* ${targetName}Tests */ = {
			isa = PBXNativeTarget;
			name = ${targetName}Tests;
			productName = ${targetName}Tests;
			productType = "com.apple.product-type.bundle.unit-test";
		};
/* End PBXNativeTarget section */
`);
  if (options.schemeName) {
    const schemeDir = path.join(projectPath, "xcshareddata", "xcschemes");
    fs.mkdirSync(schemeDir, { recursive: true });
    fs.writeFileSync(path.join(schemeDir, `${options.schemeName}.xcscheme`), `<?xml version="1.0" encoding="UTF-8"?>
<Scheme version="1.7">
  <BuildAction>
    <BuildActionEntries>
      <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">
        <BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${targetId}" BuildableName="${productName}.app" BlueprintName="${targetName}" ReferencedContainer="container:${projectName}.xcodeproj">
        </BuildableReference>
      </BuildActionEntry>
    </BuildActionEntries>
  </BuildAction>
</Scheme>
`);
  }
  return projectPath;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("iosSimulatorService Simulator.app live view defaults", () => {
  it("documents launch and stream backend defaults with pure helpers", () => {
    expect(shouldOpenSimulatorAppForLaunch(undefined)).toBe(true);
    expect(shouldOpenSimulatorAppForLaunch(true)).toBe(false);
    expect(shouldOpenSimulatorAppForLaunch(false)).toBe(true);
    expect(resolveIosSimulatorStreamBackend("auto")).toBe("simulator-window-capture");
    expect(resolveIosSimulatorStreamBackend("simulator-window-capture")).toBe("simulator-window-capture");
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

describe("iosSimulatorService launch target discovery", () => {
  it("discovers root-level Xcode projects and ignores Products groups when parsing app targets", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ios-root-project-"));
    writeMinimalXcodeProject(projectRoot, "Prox");
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
    });

    try {
      const targets = await service.listLaunchTargets({ projectRoot });
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        kind: "project",
        projectPath: "Prox.xcodeproj",
        scheme: "Prox",
        name: "Prox",
      });
      expect(targets.map((target) => target.scheme)).not.toContain("Products");
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("uses shared scheme names when the app target and scheme differ", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ios-root-scheme-"));
    writeMinimalXcodeProject(projectRoot, "Prox", {
      targetName: "AppTarget",
      productName: "Prox",
      schemeName: "Prox",
    });
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
    });

    try {
      const targets = await service.listLaunchTargets({ projectRoot });
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        projectPath: "Prox.xcodeproj",
        scheme: "Prox",
        name: "Prox",
      });
      expect(targets[0]?.detail).toContain("target AppTarget");
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
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
      laneId: "lane-1",
      chatSessionId: "chat-A",
      mode: "snapshot" as const,
      bridgeUrl: null,
      startedAt: new Date().toISOString(),
      claimedAt: null,
    };
    const error = new IosSimulatorOwnedBySessionError(previousSession);
    expect(error.code).toBe(IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE);
    expect(error.name).toBe("IosSimulatorOwnedBySessionError");
    expect(error.currentChatSessionId).toBe("chat-A");
    expect(error.message).toContain(IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE);
    expect(error.message).toContain("chat-A");
  });

  it("can claim an active simulator drawer session for a lane without relaunching it", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const events: IosSimulatorEventPayload[] = [];
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      if (command === "xcrun" && commandArgs[1] === "bootstatus") return { stdout: "", stderr: "" };
      if (command === "xcrun" && commandArgs[1] === "listapps") {
        return {
          stdout: `"com.example.app" = {\n  CFBundleDisplayName = "Example";\n};\n`,
          stderr: "",
        };
      }
      if (command === "xcrun" && commandArgs[1] === "launch") return { stdout: "com.example.app: 123\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({
      run: runMock,
      commandExists: () => true,
    });
    const service = createIosSimulatorService({
      projectRoot: os.tmpdir(),
      logger: noopLogger,
      onEvent: (payload) => events.push(payload),
    });

    try {
      await service.launch({
        bundleId: "com.example.app",
        build: false,
        laneId: "lane-old",
        chatSessionId: "chat-old",
      });

      const claimed = await service.claim({ laneId: "lane-1", chatSessionId: "chat-1" });

      expect(claimed.activeSession).toMatchObject({
        laneId: "lane-1",
        chatSessionId: "chat-1",
        bundleId: "com.example.app",
        claimedAt: expect.any(String),
      });
      expect(runMock.mock.calls.filter(([command, commandArgs]) => (
        command === "xcrun" && commandArgs[1] === "launch"
      ))).toHaveLength(1);
      expect(events.findLast((event) => event.type === "session-updated")).toMatchObject({
        session: {
          laneId: "lane-1",
          chatSessionId: "chat-1",
          claimedAt: expect.any(String),
        },
      });
    } finally {
      service.dispose();
      restoreHooks();
      platformSpy.mockRestore();
    }
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
  it("recovers a stale drawer target id when the project now has one valid app scheme", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-stale-target-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const buildArgs: string[][] = [];
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "ps") return { stdout: "", stderr: "" };
      if (command === "/usr/bin/xcode-select") return { stdout: "", stderr: "" };
      if (command === "xcodebuild" && commandArgs[0] === "-version") {
        return { stdout: "Xcode 26.3\nBuild version 17C52\n", stderr: "" };
      }
      if (command === "xcodebuild") {
        buildArgs.push(commandArgs);
        const derivedDataIndex = commandArgs.indexOf("-derivedDataPath");
        const derivedDataPath = commandArgs[derivedDataIndex + 1];
        const appPath = path.join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator", "Prox.app");
        fs.mkdirSync(appPath, { recursive: true });
        fs.writeFileSync(path.join(appPath, "Info.plist"), "<plist />");
        return { stdout: "", stderr: "" };
      }
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      if (command === "xcrun" && commandArgs[1] === "bootstatus") return { stdout: "", stderr: "" };
      if (command === "xcrun" && commandArgs[1] === "listapps") return { stdout: "", stderr: "" };
      if (command === "xcrun" && commandArgs[1] === "install") return { stdout: "", stderr: "" };
      if (command === "xcrun" && commandArgs[1] === "launch") return { stdout: "com.prox.app: 123\n", stderr: "" };
      if (command === "/usr/libexec/PlistBuddy" && commandArgs[1]?.includes("CFBundleIdentifier")) {
        return { stdout: "com.prox.app\n", stderr: "" };
      }
      if (command === "/usr/libexec/PlistBuddy" && commandArgs[1]?.includes("CFBundleDisplayName")) {
        return { stdout: "Prox\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({
      run: runMock,
      commandExists: () => true,
    });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      const staleTargetId = Buffer.from("project|apps/Prox/Prox.xcodeproj|Products").toString("base64url");
      const session = await service.launch({
        projectRoot,
        targetId: staleTargetId,
        build: true,
      });

      const build = buildArgs.find((args) => args.includes("-scheme"));
      expect(build?.[build.indexOf("-scheme") + 1]).toBe("Prox");
      expect(session.targetId).not.toBe(staleTargetId);
      expect(session.bundleId).toBe("com.prox.app");
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("turns xcodebuild failures into actionable drawer errors", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-build-failure-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "ps") return { stdout: "", stderr: "" };
      if (command === "/usr/bin/xcode-select") return { stdout: "", stderr: "" };
      if (command === "xcodebuild" && commandArgs[0] === "-version") {
        return { stdout: "Xcode 26.3\nBuild version 17C52\n", stderr: "" };
      }
      if (command === "xcodebuild") {
        const failure = new Error("Command failed: xcodebuild build") as Error & { stderr?: string };
        failure.stderr = [
          "2026-05-06 00:15:59.080 xcodebuild[10266:93709] Writing error result bundle to /tmp/ResultBundle.xcresult",
          "** BUILD FAILED **",
          "error: No such module 'MissingKit'",
        ].join("\n");
        throw failure;
      }
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      if (command === "xcrun" && commandArgs[1] === "bootstatus") return { stdout: "", stderr: "" };
      if (command === "xcrun" && commandArgs[1] === "listapps") return { stdout: "", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({
      run: runMock,
      commandExists: () => true,
    });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      await expect(service.launch({ projectRoot, build: true })).rejects.toThrow(/Could not build Prox/);
      await expect(service.launch({ projectRoot, build: true })).rejects.toThrow(/No such module 'MissingKit'/);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("opens Simulator.app by default during launch", async () => {
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
      const session = await service.launch({
        projectRoot,
        appBundlePath: "/tmp/Example.app",
        bundleId: "com.example.app",
        build: false,
      });
      expect(session.keepSimulatorInBackground).toBe(false);
      expect(spawnMock).toHaveBeenCalledWith("open", ["-a", "Simulator"], { detached: true, stdio: "ignore" });
      expect(spawnMock.mock.calls.some(([command]) => command === "osascript")).toBe(false);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("leaves Simulator.app in the background when explicitly requested", async () => {
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
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-launch-background-`);
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      const session = await service.launch({
        projectRoot,
        appBundlePath: "/tmp/Example.app",
        bundleId: "com.example.app",
        build: false,
        keepSimulatorInBackground: true,
      });
      expect(session.keepSimulatorInBackground).toBe(true);
      expect(spawnMock.mock.calls.some(([command]) => command === "open")).toBe(false);
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
      expect(spawnMock).toHaveBeenCalledWith("open", ["-g", "-a", "Simulator"], { detached: true, stdio: "ignore" });
    } finally {
      service.dispose();
      restoreHooks();
      platformSpy.mockRestore();
    }
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

  it("resolves an exact Preview Lab match for the selected Swift file", async () => {
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-preview-match-`);
    const iosDir = path.join(projectRoot, "apps", "ios", "ADE", "Views");
    fs.mkdirSync(iosDir, { recursive: true });
    fs.writeFileSync(path.join(iosDir, "ContentView.swift"), `
import SwiftUI

struct ContentView: View {
  var body: some View {
    Button("Continue") {}
  }
}

#Preview("Content loaded") {
  ContentView()
}
`, "utf8");
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
    });

    try {
      const match = await service.resolvePreviewMatch({
        sourceFile: "ContentView.swift",
        sourceLine: 5,
        elementLabel: "Continue",
      });

      expect(match).toMatchObject({
        status: "matched",
        confidence: "exact",
        selectedSourceFile: "apps/ios/ADE/Views/ContentView.swift",
      });
      expect(match.target).toMatchObject({
        title: "Content loaded",
        sourceFile: "apps/ios/ADE/Views/ContentView.swift",
        previewDefinitionIndexInFile: 0,
      });
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("prefers the preview closest to the selected source line in a multi-preview file", async () => {
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-preview-line-match-`);
    const iosDir = path.join(projectRoot, "apps", "ios", "ADE", "Views");
    fs.mkdirSync(iosDir, { recursive: true });
    const swift = `
import SwiftUI

struct ContentView: View {
  var body: some View {
    Text("Content")
  }
}

#Preview("Root") {
  ContentView()
}






#Preview("Model picker") {
  ContentView()
}
`;
    fs.writeFileSync(path.join(iosDir, "ContentView.swift"), swift, "utf8");
    const modelPickerLine = swift.slice(0, swift.indexOf("#Preview(\"Model picker\")")).split(/\r?\n/).length;
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
    });

    try {
      const match = await service.resolvePreviewMatch({
        sourceFile: "ContentView.swift",
        sourceLine: modelPickerLine,
        elementLabel: "Model picker",
      });

      expect(match).toMatchObject({
        status: "matched",
        confidence: "exact",
      });
      expect(match.target).toMatchObject({
        title: "Model picker",
        previewDefinitionIndexInFile: 1,
      });
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("suggests a sidecar when selected Swift source has no nearby preview", async () => {
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-preview-missing-target-`);
    const iosDir = path.join(projectRoot, "apps", "ios", "ADE", "Views");
    fs.mkdirSync(iosDir, { recursive: true });
    fs.writeFileSync(path.join(iosDir, "ContentView.swift"), `
import SwiftUI

struct ContentView: View {
  var body: some View {
    Button("Continue") {}
  }
}
`, "utf8");
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
    });

    try {
      const match = await service.resolvePreviewMatch({
        sourceFile: "ContentView.swift",
        sourceLine: 5,
        elementLabel: "Continue",
      });

      expect(match).toMatchObject({
        status: "missing-preview",
        confidence: "none",
        selectedSourceFile: "apps/ios/ADE/Views/ContentView.swift",
        suggestedTitle: "Continue Preview",
        suggestedSourceFile: "apps/ios/ADE/Views/ContentPreviews.swift",
        suggestedSourceFilePath: "apps/ios/ADE/Views/ContentPreviews.swift",
      });
      expect(match.target).toBeNull();
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
