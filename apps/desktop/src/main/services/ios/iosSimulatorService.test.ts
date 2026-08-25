import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  __testSetIosSimulatorCompanionRegistryPath,
  __testSetIosSimulatorProcessHooks,
  createIosSimulatorService,
  IDB_COMPANION_REGISTRY_PATH,
  IosSimulatorOwnedBySessionError,
  parseXcodePreviewWindows,
  resolveIosSimulatorStreamBackend,
  shouldOpenSimulatorAppForLaunch,
} from "./iosSimulatorService";
import {
  IOS_SIMULATOR_LANE_NOT_RESOLVED_CODE,
  IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE,
  IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE,
} from "../../../shared/types/iosSimulator";
import type { IosSimulatorEventPayload } from "../../../shared/types";
import type { Logger } from "../logging/logger";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// exitCode is load-bearing: ensureCompanion reads `exitCode !== null` as "the
// companion already died", so a companion stub must pass exitCode: null.
function mockChildProcess(options: { exitCode?: number | null } = {}): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.stdin = new EventEmitter() as ChildProcess["stdin"];
  Object.defineProperty(child, "exitCode", { configurable: true, value: "exitCode" in options ? options.exitCode : 0 });
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
      // Every lane here resolves to the same root: this test is about claiming,
      // not about build roots, but a named lane must always resolve to
      // something or the launch is rejected outright.
      resolveLaneWorktreePath: () => os.tmpdir(),
      onEvent: (payload) => events.push(payload),
    });

    try {
      await service.launch({
        bundleId: "com.example.app",
        build: false,
        laneId: "lane-old",
        chatSessionId: "chat-1",
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

  // Claim rewrites `activeSession.chatSessionId`, so before this guard it was
  // the cheapest eviction path there is: a foreign chat ran
  // `ade ios-sim claim --lane <anything>` (the CLI defaults the chat id to its
  // own $ADE_CHAT_SESSION_ID), became the owner, and a plain `shutdown` was then
  // accepted — no --force, no impersonation, past every other ownership check.
  it("refuses a claim from another chat unless the caller says it means to take over", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
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
      resolveLaneWorktreePath: () => os.tmpdir(),
      onEvent: () => {},
    });

    try {
      await service.launch({
        bundleId: "com.example.app",
        build: false,
        laneId: "lane-owner",
        chatSessionId: "chat-owner",
      });

      await expect(service.claim({ laneId: "lane-thief", chatSessionId: "chat-thief" }))
        .rejects.toMatchObject({ code: IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE });
      expect((await service.getStatus()).activeSession).toMatchObject({
        laneId: "lane-owner",
        chatSessionId: "chat-owner",
      });

      // Naming no chat id is not a takeover: it re-attributes the lane and
      // leaves the owning chat exactly where it was, so an agent tagging a
      // running session with its lane still works.
      const relabelled = await service.claim({ laneId: "lane-other" });
      expect(relabelled.activeSession).toMatchObject({
        laneId: "lane-other",
        chatSessionId: "chat-owner",
      });

      // Stated intent gets through, the same way it does for `shutdown`.
      const taken = await service.claim({ chatSessionId: "chat-thief", ignoreOwnership: true });
      expect(taken.activeSession).toMatchObject({ chatSessionId: "chat-thief" });
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

  it("refuses a shutdown from anyone but the owning chat unless forced", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-shutdown-owner-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });
    const launchAsChatA = () => service.launch({
      projectRoot,
      build: true,
      chatSessionId: "chat-A",
      laneId: "lane-A",
      force: true,
    });

    try {
      await launchAsChatA();

      // Chat B running its own skill step (`ade ios-sim shutdown`) must not be
      // able to kill chat A's session mid-verification.
      const deniedOther = await service.shutdown({ chatSessionId: "chat-B" })
        .then(() => null, (error: unknown) => error as Error);
      expect(deniedOther).toBeInstanceOf(IosSimulatorOwnedBySessionError);
      expect(deniedOther?.message).toContain(IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE);
      expect(deniedOther?.message).toContain("chat-A");
      expect(deniedOther?.message).toContain("lane-A");
      // Refused before any teardown: the owner's session is untouched.
      expect((await service.getStatus()).activeSession).toMatchObject({ chatSessionId: "chat-A" });

      // An anonymous caller names no chat, so it cannot be the owner either.
      // Same rule `launch` applies, so the two commands agree.
      const deniedAnon = await service.shutdown()
        .then(() => null, (error: unknown) => error as Error);
      expect(deniedAnon).toBeInstanceOf(IosSimulatorOwnedBySessionError);
      expect((await service.getStatus()).activeSession).toMatchObject({ chatSessionId: "chat-A" });

      // The owner stops its own session without ceremony.
      expect(await service.shutdown({ chatSessionId: "chat-A" })).toMatchObject({ released: true });
      expect((await service.getStatus()).activeSession).toBeNull();

      // --force stays the documented escape hatch, for a named other chat...
      await launchAsChatA();
      expect(await service.shutdown({ chatSessionId: "chat-B", force: true })).toMatchObject({ released: true });
      expect((await service.getStatus()).activeSession).toBeNull();

      // ...and for an anonymous caller.
      await launchAsChatA();
      expect(await service.shutdown({ force: true })).toMatchObject({ released: true });
      expect((await service.getStatus()).activeSession).toBeNull();

      // `ignoreOwnership` is the lane-scoped drawer's intent: stop whatever this
      // lane is running, said in its own name. It steps around the guard without
      // asking for anything else `force` does, so a caller that only needs the
      // bypass no longer has to impersonate the owner to get it.
      await launchAsChatA();
      expect(await service.shutdown({ chatSessionId: "chat-B", ignoreOwnership: true }))
        .toMatchObject({ released: true, previousSession: { chatSessionId: "chat-A" } });
      expect((await service.getStatus()).activeSession).toBeNull();
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
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

  it("reports the managed DerivedData path active only while xcodebuild owns it", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-build-activity-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    let markBuildStarted!: () => void;
    const buildStarted = new Promise<void>((resolve) => { markBuildStarted = resolve; });
    let releaseBuild!: () => void;
    const buildRelease = new Promise<void>((resolve) => { releaseBuild = resolve; });
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "ps") return { stdout: "", stderr: "" };
      if (command === "/usr/bin/xcode-select") return { stdout: "", stderr: "" };
      if (command === "xcodebuild" && commandArgs[0] === "-version") {
        return { stdout: "Xcode 26.3\nBuild version 17C52\n", stderr: "" };
      }
      if (command === "xcodebuild") {
        markBuildStarted();
        await buildRelease;
        throw new Error("test build stopped");
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
    const derivedDataPath = path.join(projectRoot, ".ade", "cache", "ios-simulator", "DerivedData");

    try {
      const launchPromise = service.launch({ projectRoot, build: true });
      await buildStarted;
      expect(service.isBuildPathActive(derivedDataPath)).toBe(true);
      expect(service.isBuildPathActive(path.join(projectRoot, ".ade", "cache", "other"))).toBe(false);

      releaseBuild();
      await expect(launchPromise).rejects.toThrow(/test build stopped/);
      expect(service.isBuildPathActive(derivedDataPath)).toBe(false);
    } finally {
      releaseBuild();
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

  it("returns an actionable no-context result for current preview rendering", async () => {
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-preview-current-no-context-`);
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
    });

    try {
      const result = await service.renderCurrentPreview();

      expect(result).toMatchObject({
        ok: false,
        target: null,
        render: null,
        match: {
          status: "no-context",
          confidence: "none",
        },
      });
      expect(result.error).toMatch(/select --x <x> --y <y>/);
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

function encodeTargetId(parts: string[]): string {
  return Buffer.from(parts.join("|")).toString("base64url");
}

function simulatorRunMock(options: {
  projectName?: string;
  bundleId?: string;
  installedApps?: string;
  onBuild?: (commandArgs: string[], runOptions?: { cwd?: string }) => Promise<void> | void;
} = {}) {
  const projectName = options.projectName ?? "Prox";
  const bundleId = options.bundleId ?? "com.prox.app";
  const builds: Array<{ args: string[]; cwd: string | undefined }> = [];
  const run = vi.fn(async (command: string, commandArgs: string[], runOptions?: { cwd?: string }) => {
    if (command === "ps") return { stdout: "", stderr: "" };
    if (command === "sh") return { stdout: "", stderr: "" };
    if (command === "xcodebuild" && commandArgs[0] === "-version") {
      return { stdout: "Xcode 26.3\nBuild version 17C52\n", stderr: "" };
    }
    if (command === "xcodebuild") {
      builds.push({ args: commandArgs, cwd: runOptions?.cwd });
      await options.onBuild?.(commandArgs, runOptions);
      const derivedDataPath = commandArgs[commandArgs.indexOf("-derivedDataPath") + 1];
      const appPath = path.join(derivedDataPath, "Build", "Products", "Debug-iphonesimulator", `${projectName}.app`);
      fs.mkdirSync(appPath, { recursive: true });
      fs.writeFileSync(path.join(appPath, "Info.plist"), "<plist />");
      return { stdout: "", stderr: "" };
    }
    if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
      return { stdout: simulatorDevicesJson, stderr: "" };
    }
    if (command === "xcrun" && commandArgs[1] === "listapps") {
      return { stdout: options.installedApps ?? "", stderr: "" };
    }
    if (command === "xcrun" && commandArgs[1] === "io") {
      const outPath = commandArgs[commandArgs.length - 1];
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, "not-a-real-png");
      return { stdout: "", stderr: "" };
    }
    if (command === "/usr/libexec/PlistBuddy" && commandArgs[1]?.includes("CFBundleIdentifier")) {
      return { stdout: `${bundleId}\n`, stderr: "" };
    }
    if (command === "/usr/libexec/PlistBuddy" && commandArgs[1]?.includes("CFBundleDisplayName")) {
      return { stdout: `${projectName}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
  return { run, builds };
}

describe("iosSimulatorService lane-correct build root", () => {
  it("builds the lane worktree when the caller passes a laneId", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-lane-root-`);
    const laneWorktree = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneWorktree, { recursive: true });
    // Both roots hold the same project, so a passing assertion can only come
    // from picking the lane, not from the primary checkout lacking a project.
    writeMinimalXcodeProject(projectRoot, "Prox");
    writeMinimalXcodeProject(laneWorktree, "Prox");
    const { run, builds } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      resolveLaneWorktreePath: (laneId) => (laneId === "lane-1" ? laneWorktree : null),
    });

    try {
      const result = await service.launch({ laneId: "lane-1", build: true });

      expect(builds).toHaveLength(1);
      expect(builds[0]?.cwd).toBe(laneWorktree);
      const derivedDataPath = builds[0]?.args[builds[0].args.indexOf("-derivedDataPath") + 1];
      expect(derivedDataPath).toBe(path.join(laneWorktree, ".ade", "cache", "ios-simulator", "DerivedData"));
      expect(result.buildRoot).toBe(laneWorktree);
      expect(result.projectRoot).toBe(laneWorktree);
      expect(result.usedInstalledBinary).toBe(false);
      expect(result.capabilities).toEqual({ canTap: true, canType: true, canDrag: true, canInspect: true });
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("refuses to fall back to the primary checkout when a named lane does not resolve", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-lane-unresolved-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const { run, builds } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      resolveLaneWorktreePath: (laneId) => (laneId === "lane-known" ? projectRoot : null),
    });

    try {
      // Silently building `projectRoot` here is the whole bug: the agent asked
      // for lane-ghost's tree and would have been told its unrelated code built
      // and launched fine.
      const error = await service.launch({ laneId: "lane-ghost", build: true })
        .then(() => null, (rejection: unknown) => rejection as Error);
      expect(error?.message).toContain(IOS_SIMULATOR_LANE_NOT_RESOLVED_CODE);
      expect(error?.message).toContain("lane-ghost");
      expect(error?.message).toContain("--project-root");
      expect(builds).toHaveLength(0);

      // An explicit root is the documented escape hatch and outranks the lane,
      // so it still works even when the lane itself is unresolvable.
      const rescued = await service.launch({ laneId: "lane-ghost", projectRoot, build: true });
      expect(rescued.buildRoot).toBe(projectRoot);
      expect(builds[0]?.cwd).toBe(projectRoot);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("prefers an explicit projectRoot over the caller's laneId", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-lane-override-`);
    const laneWorktree = path.join(projectRoot, ".ade", "worktrees", "lane-1");
    fs.mkdirSync(laneWorktree, { recursive: true });
    writeMinimalXcodeProject(projectRoot, "Prox");
    writeMinimalXcodeProject(laneWorktree, "Prox");
    const { run, builds } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      resolveLaneWorktreePath: () => laneWorktree,
    });

    try {
      const result = await service.launch({ laneId: "lane-1", projectRoot, build: true });
      expect(builds[0]?.cwd).toBe(projectRoot);
      expect(result.buildRoot).toBe(projectRoot);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });
});

describe("iosSimulatorService target provenance", () => {
  it("rejects a built target id whose app bundle lives under a different root", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-target-root-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      await expect(service.launch({
        projectRoot,
        targetId: encodeTargetId(["built", path.join(os.tmpdir(), "somewhere-else", "Prox.app"), "com.prox.app"]),
      })).rejects.toThrow(/IOS_SIMULATOR_TARGET_ROOT_MISMATCH/);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("rejects a project target id that names no project under the build root", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-target-missing-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      await expect(service.launch({
        projectRoot,
        targetId: encodeTargetId(["project", "apps/Other/Other.xcodeproj", "Other"]),
      })).rejects.toThrow(/IOS_SIMULATOR_TARGET_ROOT_MISMATCH/);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("refuses a --bundle-id that matches nothing instead of building a different app", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-bundle-mismatch-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const { run, builds } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      // The unmatched bundle id used to fall through to the generic "first
      // project target" default: xcodebuild built Prox, simctl launched it, and
      // the caller "verified" an app it never named.
      const denied = await service.launch({ projectRoot, build: true, bundleId: "com.nobody.here" })
        .then(() => null, (error: unknown) => error as Error);
      expect(denied).toBeInstanceOf(Error);
      expect(denied?.message).toContain("com.nobody.here");
      expect(denied?.message).toContain(projectRoot);
      // The error has to name what IS buildable, or the caller cannot correct it.
      expect(denied?.message).toContain("Prox");
      // Nothing was compiled and nothing was installed or launched.
      expect(builds).toEqual([]);
      expect(run.mock.calls.some((call) => call[0] === "xcodebuild" && call[1]?.[0] !== "-version")).toBe(false);
      expect(run.mock.calls.some((call) => call[0] === "xcrun" && call[1]?.[1] === "launch")).toBe(false);
      expect((await service.getStatus()).activeSession).toBeNull();
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });
});

describe("iosSimulatorService stale binary honesty", () => {
  const installedApps = `"com.example.app" = {\n  CFBundleDisplayName = "Example";\n};\n`;

  it("refuses to silently launch a preinstalled app when nothing buildable was found", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-no-buildable-`);
    const { run } = simulatorRunMock({ installedApps });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      await expect(service.launch({ projectRoot })).rejects.toThrow(/IOS_SIMULATOR_NO_BUILDABLE_TARGET/);
      await expect(service.launch({ projectRoot })).rejects.toThrow(/Example/);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("flags an explicitly chosen preinstalled app as a build that predates the caller's changes", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-installed-explicit-`);
    const events: IosSimulatorEventPayload[] = [];
    const { run } = simulatorRunMock({ installedApps });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      onEvent: (payload) => events.push(payload),
    });

    try {
      const result = await service.launch({ projectRoot, bundleId: "com.example.app", build: false });
      expect(result.usedInstalledBinary).toBe(true);
      const buildStep = events
        .filter((event): event is Extract<IosSimulatorEventPayload, { type: "launch-progress" }> =>
          event.type === "launch-progress")
        .findLast((event) => event.progress.step === "build-app");
      expect(buildStep?.progress.status).toBe("skipped");
      expect(buildStep?.progress.detail).toContain("current code changes are not included");
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });
});

describe("iosSimulatorService launch concurrency and ownership", () => {
  it("rejects a second launch while one is still running", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-concurrent-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    let markBuildStarted!: () => void;
    const buildStarted = new Promise<void>((resolve) => { markBuildStarted = resolve; });
    let releaseBuild!: () => void;
    const buildRelease = new Promise<void>((resolve) => { releaseBuild = resolve; });
    const { run } = simulatorRunMock({
      onBuild: async () => {
        markBuildStarted();
        await buildRelease;
      },
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      const first = service.launch({ projectRoot, build: true });
      await buildStarted;
      await expect(service.launch({ projectRoot, build: true })).rejects.toThrow(/IOS_SIMULATOR_LAUNCH_IN_PROGRESS/);
      releaseBuild();
      await expect(first).resolves.toMatchObject({ bundleId: "com.prox.app" });
    } finally {
      releaseBuild();
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("clears the launch lock on a force shutdown so the escape hatch actually works", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-force-unlock-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    let markBuildStarted!: () => void;
    const buildStarted = new Promise<void>((resolve) => { markBuildStarted = resolve; });
    let releaseBuild!: () => void;
    const buildRelease = new Promise<void>((resolve) => { releaseBuild = resolve; });
    let firstBuild = true;
    const { run } = simulatorRunMock({
      onBuild: async () => {
        if (!firstBuild) return;
        firstBuild = false;
        markBuildStarted();
        await buildRelease;
      },
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      const wedged = service.launch({ projectRoot, build: true }).catch(() => null);
      await buildStarted;
      // `shutdown --force` is what every error message and doc points at for a
      // wedged launch. Before this it cleared the session but not the launch
      // lock, so the very next launch failed IOS_SIMULATOR_LAUNCH_IN_PROGRESS
      // with no way out short of restarting ADE.
      await service.shutdown({ force: true });
      await expect(service.launch({ projectRoot, build: true })).resolves.toMatchObject({
        bundleId: "com.prox.app",
      });
      releaseBuild();
      // The superseded launch must not publish its session over the new one.
      await wedged;
      expect((await service.getStatus()).activeSession).toMatchObject({ bundleId: "com.prox.app" });
    } finally {
      releaseBuild();
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  // `launch-progress` broadcasts project-wide. Unstamped, a second drawer
  // renders this launch's stepper over its own live view and — never seeing a
  // terminal step it recognises as its own — the overlay sticks there.
  it("stamps every launch-progress event with the owning chat and lane", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-progress-owner-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const events: IosSimulatorEventPayload[] = [];
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      resolveLaneWorktreePath: () => projectRoot,
      onEvent: (payload) => events.push(payload),
    });

    const progressEvents = () => events
      .filter((event): event is Extract<IosSimulatorEventPayload, { type: "launch-progress" }> =>
        event.type === "launch-progress")
      .map((event) => event.progress);

    try {
      await service.launch({
        projectRoot,
        build: true,
        chatSessionId: "chat-A",
        laneId: "lane-A",
      });
      const owned = progressEvents();
      expect(owned.length).toBeGreaterThan(0);
      for (const progress of owned) {
        expect(progress.chatSessionId).toBe("chat-A");
        expect(progress.laneId).toBe("lane-A");
      }

      // The failing step is emitted from the catch, before the finally drops
      // the owner — so a foreign drawer can discard that one too.
      events.length = 0;
      await expect(service.launch({
        projectRoot,
        build: true,
        chatSessionId: "chat-B",
        force: true,
        targetId: encodeTargetId(["project", "apps/Nope/Nope.xcodeproj", "Nope"]),
      })).rejects.toThrow();
      const failed = progressEvents().filter((progress) => progress.status === "failed");
      expect(failed.length).toBeGreaterThan(0);
      for (const progress of failed) expect(progress.chatSessionId).toBe("chat-B");

      // An anonymous launch stays unstamped, so a drawer that predates the
      // stamp keeps rendering it rather than silently dropping every step.
      events.length = 0;
      await service.launch({ projectRoot, build: true, force: true });
      const anonymous = progressEvents();
      expect(anonymous.length).toBeGreaterThan(0);
      for (const progress of anonymous) {
        expect(progress.chatSessionId).toBeNull();
        expect(progress.laneId).toBeNull();
      }
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("makes an anonymous caller pass force before taking a chat-owned simulator", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-anon-takeover-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      resolveLaneWorktreePath: () => projectRoot,
    });

    try {
      await service.launch({
        projectRoot,
        build: true,
        chatSessionId: "chat-A",
        laneId: "lane-A",
      });
      const denied = await service.launch({ projectRoot, build: true })
        .then(() => null, (error: unknown) => error as Error);
      expect(denied?.message).toContain(IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE);
      // The owner facts stay in the service message; the "run this next" half
      // belongs to the CLI's own hint, keyed off the code, because the drawer
      // and the iOS app read this same string and cannot run a shell command.
      expect(denied?.message).toContain("chat-A");
      expect(denied?.message).toContain("lane-A");
      expect(denied?.message).not.toContain("ade ios-sim");
      await expect(service.launch({ projectRoot, build: true, force: true })).resolves.toMatchObject({
        chatSessionId: null,
      });
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("transfers ownership on attach takeOver without a shutdown, and still guards plain attach", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-attach-takeover-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      await service.launch({ projectRoot, build: true, chatSessionId: "chat-A" });
      // A different chat cannot attach without takeOver.
      expect(() => service.attachToChatSession("chat-B", "chat-B"))
        .toThrow(new RegExp(IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE));
      // takeOver adopts the running session in place: same session, new owner.
      const transferred = service.attachToChatSession("chat-B", "chat-B", { takeOver: true });
      expect(transferred).toMatchObject({ chatSessionId: "chat-B" });
      expect((await service.getStatus()).activeSession).toMatchObject({ chatSessionId: "chat-B" });
      // takeOver never applies to detach: a third chat still cannot free it.
      expect(() => service.attachToChatSession(null, "chat-C", { takeOver: true }))
        .toThrow(new RegExp(IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE));
      // takeOver adopts ownership for the CALLER only. chat-C handing the
      // simulator to chat-D is a transfer between two chats that neither owns
      // it nor is asked for, so it falls back to the normal owner guard.
      expect(() => service.attachToChatSession("chat-D", "chat-C", { takeOver: true }))
        .toThrow(new RegExp(IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE));
      expect((await service.getStatus()).activeSession).toMatchObject({ chatSessionId: "chat-B" });
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("releases the session when the owning chat ends and ignores other chats", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-release-owner-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      await service.launch({ projectRoot, build: true, chatSessionId: "chat-A" });
      expect(await service.releaseIfOwnedBy("chat-B")).toMatchObject({ released: false });
      expect((await service.getStatus()).activeSession).not.toBeNull();
      expect(await service.releaseIfOwnedBy("chat-A")).toMatchObject({ released: true });
      expect((await service.getStatus()).activeSession).toBeNull();
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });
});

describe("iosSimulatorService idb companion registry", () => {
  // The real ledger at IDB_COMPANION_REGISTRY_PATH is shared with the
  // developer's running ADE app and brain daemon, so writing or deleting it
  // from a test erases the live processes' companion records. Every test here
  // redirects the service at its own scratch file instead.
  const useScratchRegistry = () => {
    const dir = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-companion-registry-`);
    const registryPath = path.join(dir, "companions.json");
    const restoreHook = __testSetIosSimulatorCompanionRegistryPath(registryPath);
    return {
      registryPath,
      restore: () => {
        restoreHook();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  it("keeps the production ledger path per-user under tmpdir", () => {
    expect(path.dirname(IDB_COMPANION_REGISTRY_PATH)).toBe(os.tmpdir());
    expect(path.basename(IDB_COMPANION_REGISTRY_PATH)).toMatch(/^ade-ios-simulator-idb-companions-.+\.json$/);
  });

  it("sweeps only companions whose owning ADE process is gone", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const { registryPath, restore: restoreRegistry } = useScratchRegistry();
    // A pid this test can be sure is dead: 2^22 is above every default
    // pid_max, so nothing can be occupying it.
    const deadOwnerPid = 4_194_304;
    fs.writeFileSync(registryPath, JSON.stringify({
      "901": { udid: "device-1", startedAt: new Date().toISOString(), ownerPid: process.pid },
      "902": { udid: "device-2", startedAt: new Date().toISOString(), ownerPid: deadOwnerPid },
      // Written by a build that predates ownerPid; treated as an orphan, which
      // is the old behaviour and the safe reading for a since-dead writer.
      "903": { udid: "device-3", startedAt: new Date().toISOString() },
    }), "utf8");

    const psCalls: string[][] = [];
    let markSwept!: () => void;
    const swept = new Promise<void>((resolve) => { markSwept = resolve; });
    const run = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "ps") {
        psCalls.push(commandArgs);
        markSwept();
      }
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot: os.tmpdir(), logger: noopLogger });

    try {
      await swept;
      // 901 belongs to this very process, which is very much alive: a second
      // ADE (or the brain daemon beside the app) sweeping it killed the taps
      // and typing of the process still driving that companion.
      const pidArg = psCalls[0]?.[psCalls[0].length - 1] ?? "";
      expect(pidArg.split(",").sort()).toEqual(["902", "903"]);
      expect(pidArg).not.toContain("901");
    } finally {
      service.dispose();
      restoreHooks();
      restoreRegistry();
      platformSpy.mockRestore();
    }
  });

  it("rewrites the registry atomically and owner-readable only", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const { registryPath, restore: restoreRegistry } = useScratchRegistry();
    fs.writeFileSync(registryPath, JSON.stringify({
      "904": { udid: "device-4", startedAt: new Date().toISOString(), ownerPid: 4_194_305 },
    }), "utf8");

    let markSwept!: () => void;
    const swept = new Promise<void>((resolve) => { markSwept = resolve; });
    const run = vi.fn(async (command: string) => {
      if (command === "ps") markSwept();
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot: os.tmpdir(), logger: noopLogger });

    try {
      await swept;
      // The sweep forgets what it reaped, which is the rewrite path.
      await vi.waitFor(() => {
        expect(JSON.parse(fs.readFileSync(registryPath, "utf8"))).toEqual({});
      });
      // tmpdir is world-writable and shared between accounts, so the file that
      // names pids ADE will SIGKILL must not be readable or writable by others.
      expect(fs.statSync(registryPath).mode & 0o777).toBe(0o600);
      // No temp file survives the rename.
      expect(fs.existsSync(`${registryPath}.${process.pid}.tmp`)).toBe(false);
    } finally {
      service.dispose();
      restoreHooks();
      restoreRegistry();
      platformSpy.mockRestore();
    }
  });
});

describe("iosSimulatorService screenshots and platform guards", () => {
  it("writes the screenshot to a readable file under the build root", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-screenshot-`);
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      const shot = await service.screenshot({ projectRoot });
      expect(shot.filePath.startsWith(path.join(projectRoot, ".ade", "cache", "ios-simulator", "screenshots"))).toBe(true);
      expect(fs.existsSync(shot.filePath)).toBe(true);
      expect(shot.dataUrl.startsWith("data:image/png;base64,")).toBe(true);

      const explicit = path.join(projectRoot, "custom", "shot.png");
      const custom = await service.screenshot({ projectRoot, outPath: explicit });
      expect(custom.filePath).toBe(explicit);
      expect(fs.existsSync(explicit)).toBe(true);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("keeps --out inside the build root", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const parent = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-out-containment-`);
    const projectRoot = path.join(parent, "repo");
    fs.mkdirSync(projectRoot, { recursive: true });
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      // `--out` arrives from agent tool calls and from the CLI, so a traversal
      // tail or a bare absolute path would let a screenshot overwrite anything
      // the ADE process can write.
      const escape = path.join(parent, "outside.png");
      await expect(service.screenshot({ projectRoot, outPath: "../outside.png" }))
        .rejects.toThrow(new RegExp(IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE));
      expect(fs.existsSync(escape)).toBe(false);
      await expect(service.screenshot({ projectRoot, outPath: escape }))
        .rejects.toThrow(new RegExp(IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE));
      expect(fs.existsSync(escape)).toBe(false);

      // An absolute path that genuinely is inside the root stays allowed.
      const inside = path.join(projectRoot, "proof", "shot.png");
      const captured = await service.screenshot({ projectRoot, outPath: inside });
      expect(captured.filePath).toBe(inside);
      expect(fs.existsSync(inside)).toBe(true);
    } finally {
      service.dispose();
      fs.rmSync(parent, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("lets an explicit caller lane outrank the active session's root", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-scope-precedence-`);
    const laneB = path.join(projectRoot, ".ade", "worktrees", "lane-B");
    fs.mkdirSync(laneB, { recursive: true });
    writeMinimalXcodeProject(projectRoot, "Prox");
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      resolveLaneWorktreePath: (laneId) => (laneId === "lane-B" ? laneB : null),
    });

    try {
      // The running session is pinned to root A (it carries a projectRoot).
      await service.launch({ projectRoot, build: true });
      expect((await service.getStatus()).activeSession).toMatchObject({ projectRoot });

      // Merging the session into the caller's scope let session.projectRoot win
      // over an explicitly named lane, so `--lane B` captured root A's tree.
      const shot = await service.screenshot({ laneId: "lane-B" });
      expect(shot.filePath.startsWith(laneB)).toBe(true);

      // With neither field supplied the session is still the fallback.
      const fallback = await service.screenshot({});
      expect(fallback.filePath.startsWith(projectRoot)).toBe(true);
      expect(fallback.filePath.startsWith(laneB)).toBe(false);
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("gives a drag a duration so idb does not issue a flick", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-drag-duration-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const { run } = simulatorRunMock();
    // idb input needs a companion listening on the grpc port, so stand a real
    // listener up on whatever port the service picked and hand back a stub
    // process. Without this the drag blocks in waitForTcpPort.
    const listeners: net.Server[] = [];
    const spawn = ((command: string, commandArgs: string[]) => {
      const portIndex = commandArgs.indexOf("--grpc-port");
      if (portIndex >= 0) {
        const server = net.createServer();
        // getFreePort closes the port before handing it back, so another
        // worker can take it first. Without a handler that bind error is an
        // uncaught exception that fails the whole file instead of this test.
        server.on("error", () => {});
        server.listen(Number(commandArgs[portIndex + 1]), "127.0.0.1");
        listeners.push(server);
      }
      // No pid: the registry is shared with the developer's running ADE, so the
      // test must not record one.
      return mockChildProcess({ exitCode: null });
    }) as unknown as typeof nodeSpawn;
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, spawn, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      await service.launch({ projectRoot, build: true });
      // Without --duration idb performs an instantaneous swipe, which iOS reads
      // as a flick: scrolls and slider drags silently do nothing.
      await service.drag({ startX: 10, startY: 200, endX: 10, endY: 40 });
      const swipeArgs = () => (run.mock.calls
        .map((call) => call[1] as string[])
        .filter((args) => args.includes("swipe"))
        .at(-1) ?? []);
      const defaulted = swipeArgs();
      expect(defaulted).toContain("--duration");
      expect(defaulted[defaulted.indexOf("--duration") + 1]).toBe("0.18");

      // An explicit duration still wins.
      await service.drag({ startX: 10, startY: 200, endX: 10, endY: 40, durationMs: 500 });
      const explicit = swipeArgs();
      expect(explicit[explicit.indexOf("--duration") + 1]).toBe("0.5");
    } finally {
      service.dispose();
      for (const server of listeners) server.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("fails screenshot, tap, and typeText on non-darwin with the macOS-only error", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const service = createIosSimulatorService({ projectRoot: os.tmpdir(), logger: noopLogger });

    try {
      await expect(service.screenshot()).rejects.toThrow(/only available on macOS/);
      await expect(service.tap({ x: 1, y: 2 })).rejects.toThrow(/only available on macOS/);
      await expect(service.typeText({ text: "hi" })).rejects.toThrow(/only available on macOS/);
      await expect(service.drag({ startX: 1, startY: 2, endX: 3, endY: 4 })).rejects.toThrow(/only available on macOS/);
      await expect(service.getScreenSnapshot()).rejects.toThrow(/only available on macOS/);
      await expect(service.inspectPoint({ x: 1, y: 2 })).rejects.toThrow(/only available on macOS/);
      await expect(service.selectPoint({ x: 1, y: 2 })).rejects.toThrow(/only available on macOS/);
      // startStream used to resolve a device first, so a Windows caller was told
      // "No available iOS Simulator devices were found" — a setup problem it
      // could never fix — instead of that the platform is unsupported.
      await expect(service.startStream()).rejects.toThrow(/only available on macOS/);
      // getInspectorSnapshot was the one IPC-reachable method with no guard at
      // all; off darwin it blamed the caller for not launching an app.
      await expect(service.getInspectorSnapshot()).rejects.toThrow(/only available on macOS/);
    } finally {
      service.dispose();
      platformSpy.mockRestore();
    }
  });
});
