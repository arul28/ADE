import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  __testSetIosSimulatorHelperFactory,
  __testSetIosSimulatorProcessHooks,
  clampStreamBitrateKbps,
  clampStreamFps,
  createIosSimulatorService,
  IOS_SIMULATOR_STREAM_BACKEND,
  IosSimulatorOwnedBySessionError,
  parseXcodePreviewWindows,
  shouldOpenSimulatorAppForLaunch,
} from "./iosSimulatorService";
import type { SimHelperClient } from "./simHelperClient";
import { createAppleStreamRelayForService } from "./appleStreamRelay";
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

// exitCode is load-bearing for any caller that reads `exitCode !== null` as
// "this child already died", so a stub must pass exitCode: null.
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
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      },
      {
        name: "iPhone 17",
        udid: "device-2",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
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

/**
 * A fake vendored helper.
 *
 * The real one is a Swift binary that talks to CoreSimulator and needs a booted
 * simulator, so every service test that touches input, the accessibility tree
 * or the live view stands this up instead and asserts on the NDJSON commands it
 * received — which is the actual contract between ADE and the helper.
 */
function fakeSimHelper(overrides: {
  onSend?: (command: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** The live helper's pid, read on every call so a test can "restart" it. */
  pid?: () => number | null;
} = {}): { client: SimHelperClient; sent: Array<Record<string, unknown>>; emit: (event: { type: string } & Record<string, unknown>) => void } {
  const sent: Array<Record<string, unknown>> = [];
  const listeners = new Set<(event: { type: string } & Record<string, unknown>) => void>();
  const client: SimHelperClient = {
    binaryPath: "/tmp/ade-sim-helper",
    send: async (command) => {
      sent.push(command);
      if (overrides.onSend) return overrides.onSend(command);
      if (command.type === "capture-start") {
        return {
          type: "capture-started",
          udid: command.udid,
          url: "http://127.0.0.1:45301/ios-simulator-video",
          token: "a".repeat(64),
          pointWidth: 393,
          pointHeight: 852,
          pixelWidth: 1179,
          pixelHeight: 2556,
          scale: 3,
        };
      }
      if (command.type === "screenshot") {
        return { path: command.path, width: 1179, height: 2556 };
      }
      return {};
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    isReady: () => true,
    pid: overrides.pid ?? (() => 4321),
    protocolVersion: () => 1,
    exists: () => true,
    dispose: () => { listeners.clear(); },
  };
  return {
    client,
    sent,
    emit: (event) => { for (const listener of [...listeners]) listener(event); },
  };
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
    // One engine now: the vendored Swift helper. The name survives so a status
    // read still says which engine produced the pixels; it just has one answer.
    expect(IOS_SIMULATOR_STREAM_BACKEND).toBe("helper-h264");
  });

  it("answers a usable frame rate for every input", () => {
    expect(clampStreamFps(undefined)).toBe(60);
    expect(clampStreamFps(null)).toBe(60);
    expect(clampStreamFps(30)).toBe(30);
    expect(clampStreamFps(30.4)).toBe(30);
    // Out of range clamps to the ends rather than reaching the encoder.
    expect(clampStreamFps(0)).toBe(1);
    expect(clampStreamFps(-5)).toBe(1);
    expect(clampStreamFps(1000)).toBe(60);
    // The reason this exists: every clamp keeps NaN, so `--fps NaN` used to
    // reach the encoder and the stream only failed when a viewer connected.
    expect(clampStreamFps(Number.NaN)).toBe(60);
    expect(clampStreamFps(Number.POSITIVE_INFINITY)).toBe(60);
    expect(clampStreamFps(Number.NEGATIVE_INFINITY)).toBe(60);
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

      // Sessions are keyed by lane, so a thief naming the owner's lane hits the
      // guard. Naming a DIFFERENT lane used to be described here as "no longer
      // a theft at all: that lane has no session" — that was wrong, and the
      // test below is the one that proves it. The lane bucket is empty; the
      // SIMULATOR is not.
      await expect(service.claim({ laneId: "lane-owner", chatSessionId: "chat-thief" }))
        .rejects.toMatchObject({ code: IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE });
      expect((await service.getStatus({ laneId: "lane-owner" })).activeSession).toMatchObject({
        laneId: "lane-owner",
        chatSessionId: "chat-owner",
      });

      // Naming no chat id is not a takeover: it re-attributes the lane and
      // leaves the owning chat exactly where it was, so an agent tagging a
      // running session with its lane still works.
      const relabelled = await service.claim({ laneId: "lane-other", chatSessionId: "chat-owner" });
      expect(relabelled.activeSession).toMatchObject({
        laneId: "lane-other",
        chatSessionId: "chat-owner",
      });

      // Stated intent gets through, the same way it does for `shutdown`.
      const taken = await service.claim({ laneId: "lane-other", chatSessionId: "chat-thief", ignoreOwnership: true });
      expect(taken.activeSession).toMatchObject({ chatSessionId: "chat-thief" });
    } finally {
      service.dispose();
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("regression: a launch naming ANOTHER lane cannot drive a device this chat owns", async () => {
    /*
     * Found by a test agent that was asked to try it.
     *
     * `shutdown` and `claim` refused it correctly. `launch` did not: the guard
     * reads `runtime.activeSession`, a runtime is per lane, so naming a lane
     * with no session found no owner and went on to drive the same physical
     * simulator — the running app's pid changed underneath its owner.
     *
     * Ownership belongs to the device. One Mac, one simulator, one holder.
     */
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
      const owned = await service.launch({
        bundleId: "com.example.app",
        build: false,
        laneId: "lane-owner",
        chatSessionId: "chat-owner",
      });
      const ownedUdid = (await service.getStatus({ laneId: "lane-owner" })).activeSession?.deviceUdid ?? null;
      expect(ownedUdid).toBeTruthy();
      void owned;

      await expect(service.launch({
        bundleId: "com.example.app",
        build: false,
        laneId: "lane-thief",
        chatSessionId: "chat-thief",
        deviceUdid: ownedUdid,
      })).rejects.toMatchObject({ code: IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE });

      // The owner still holds it, and nothing was half-taken.
      expect((await service.getStatus({ laneId: "lane-owner" })).activeSession).toMatchObject({
        chatSessionId: "chat-owner",
      });

      // Stated intent still gets through, as everywhere else.
      const forced = await service.launch({
        bundleId: "com.example.app",
        build: false,
        laneId: "lane-thief",
        chatSessionId: "chat-thief",
        deviceUdid: ownedUdid,
        force: true,
      });
      void forced;
      expect((await service.getStatus({ laneId: "lane-thief" })).activeSession).toMatchObject({
        chatSessionId: "chat-thief",
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

  it("reports the live view on getStatus, fresh and without the address", async () => {
    // One poll has to answer "what is going on". The throttle exists to spare
    // the `simctl` device list, so a cached status must still report a stream
    // that started after it was built — and must never carry the token.
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
    const helper = fakeSimHelper();
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const service = createIosSimulatorService({ projectRoot: os.tmpdir(), logger: noopLogger });

    try {
      const before = await service.getStatus();
      expect(before.stream?.running).toBe(false);

      const started = await service.startStream({ deviceUdid: "device-1" });
      // Immediately after, well inside the throttle window: the cached status
      // must not still say the stream is stopped.
      const after = await service.getStatus();
      expect(after.stream?.running).toBe(true);
      expect(after.stream?.backend).toBe("helper-h264");
      expect(after.stream?.deviceUdid).toBe("device-1");

      const serialized = JSON.stringify(after.stream);
      expect(serialized).not.toContain(started.transport?.token ?? "never");
      expect(serialized).not.toContain("token=");
      expect(after.stream).not.toHaveProperty("transport");
      expect(after.stream).not.toHaveProperty("streamUrl");
    } finally {
      service.dispose();
      restoreHelper();
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("hands the stream address out on start and redacts it from every status read", async () => {
    // `getStreamStatus` is on the action allowlist with no ownership guard, so
    // `ade actions run ios_simulator.getStreamStatus --json` prints whatever it
    // returns into a durable agent transcript. The shape is useful there; the
    // token is the stream's only authorization and must not be.
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run: runMock, commandExists: () => true });
    const helper = fakeSimHelper();
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const service = createIosSimulatorService({ projectRoot: os.tmpdir(), logger: noopLogger });

    try {
      const started = await service.startStream({ deviceUdid: "device-1", fps: 30, scaleFactor: 0.5 });
      expect(started.backend).toBe("helper-h264");
      // The helper is the one that captures, and it is told in its own units.
      expect(helper.sent.at(-1)).toMatchObject({ type: "capture-start", udid: "device-1", fps: 30, scale: 0.5 });
      // The call that creates the stream is the one caller that needs to read
      // it, so it gets the whole address.
      expect(started.transport?.token).toBe("a".repeat(64));
      expect(started.transport?.url).toBe("http://127.0.0.1:45301/ios-simulator-video");
      expect(started.transport?.port).toBe(45301);
      expect(started.transport?.width).toBe(1179);
      expect(started.streamUrl).toBe(started.transport?.url);

      const read = service.getStreamStatus();
      expect(read.backend).toBe("helper-h264");
      expect(read.transport?.token).toBeNull();
      expect(read.transport?.url).toBeNull();
      // A reader that only had `streamUrl` redacted would still be handed the
      // address, so both go.
      expect(read.streamUrl).toBeNull();
      expect(JSON.stringify(read)).not.toContain(started.transport?.token ?? "never");
      // The shape a reader actually wants survives.
      expect(read.transport?.port).toBe(started.transport?.port);
    } finally {
      service.dispose();
      restoreHelper();
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("forwards a caller's bitrate cap to the encoder, and clamps it", async () => {
    // The account's `apple.remoteBitrateKbpsCap` reaches the encoder only if the
    // service passes it through; it was dropped before, which left the setting
    // with no effect on the stream.
    expect(clampStreamBitrateKbps(2500)).toBe(2500);
    expect(clampStreamBitrateKbps(10)).toBe(100);
    expect(clampStreamBitrateKbps(50_000)).toBe(20_000);
    expect(clampStreamBitrateKbps(Number.NaN)).toBeNull();
    expect(clampStreamBitrateKbps(null)).toBeNull();

    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run: runMock, commandExists: () => true });
    const helper = fakeSimHelper();
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const service = createIosSimulatorService({ projectRoot: os.tmpdir(), logger: noopLogger });

    try {
      await service.startStream({ deviceUdid: "device-1", bitrateKbps: 2500 });
      expect(helper.sent.at(-1)).toMatchObject({
        type: "capture-start",
        udid: "device-1",
        bitrateKbps: 2500,
      });

      // No cap: the helper keeps its own default, so the field is absent.
      await service.stopStream({});
      await service.startStream({ deviceUdid: "device-1", bitrateKbps: null });
      const payload = helper.sent.at(-1) as Record<string, unknown>;
      expect(payload).toMatchObject({ type: "capture-start", udid: "device-1" });
      expect(payload).not.toHaveProperty("bitrateKbps");
    } finally {
      service.dispose();
      restoreHelper();
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("lets a second viewer join a running stream without moving it", async () => {
    // The owner's 2026-09-23 report: the phone joined the MacBook's own view,
    // the service restarted the capture for the phone's cap and fps, and the
    // MacBook's reader froze on the old address while taps still landed.
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run: runMock, commandExists: () => true });
    const helper = fakeSimHelper();
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const service = createIosSimulatorService({ projectRoot: os.tmpdir(), logger: noopLogger });

    try {
      // The Mac's own view: 30 fps, no cap.
      const local = await service.startStream({ deviceUdid: "device-1", fps: 30, bitrateKbps: null, localViewer: true });
      const sentBefore = helper.sent.length;

      // The phone, through the relay: default fps, a cap.
      const remote = await service.startStream({ deviceUdid: "device-1", bitrateKbps: 2500 });
      const sentForRemote = helper.sent.slice(sentBefore);
      expect(sentForRemote.map((command) => command.type)).toEqual(["capture-start"]);
      expect(sentForRemote[0]).toMatchObject({ udid: "device-1", bitrateKbps: 2500 });
      expect(remote.transport?.url).toBe(local.transport?.url);
      expect(remote.transport?.token).toBe(local.transport?.token);
      expect(remote.bitrateKbps).toBe(2500);

      // The same cap again, a different fps, or no cap: nothing to send.
      const sentAfterCap = helper.sent.length;
      await service.startStream({ deviceUdid: "device-1", bitrateKbps: 2500 });
      await service.startStream({ deviceUdid: "device-1", fps: 30, bitrateKbps: null, localViewer: true });
      expect(helper.sent.length).toBe(sentAfterCap);
      expect(service.getStreamStatus({}).bitrateKbps).toBe(2500);
    } finally {
      service.dispose();
      restoreHelper();
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("keeps one lane's stream out of another lane's", async () => {
    // Sessions and streams are per-lane now. A project-wide stream meant
    // `stream-stop` on one lane killed the other lane's picture.
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run: runMock, commandExists: () => true });
    const helper = fakeSimHelper();
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const service = createIosSimulatorService({
      projectRoot: os.tmpdir(),
      logger: noopLogger,
      resolveLaneWorktreePath: () => os.tmpdir(),
    });

    try {
      await service.startStream({ deviceUdid: "device-1", laneId: "lane-a" });
      // device-2 is Shutdown in this fixture, so lane-b's start is an explicit one.
      await service.startStream({ deviceUdid: "device-2", laneId: "lane-b", boot: true });

      expect(service.getStreamStatus({ laneId: "lane-a" }).running).toBe(true);
      expect(service.getStreamStatus({ laneId: "lane-b" }).deviceUdid).toBe("device-2");

      await service.stopStream({ laneId: "lane-a" });
      expect(service.getStreamStatus({ laneId: "lane-a" }).running).toBe(false);
      // The other lane is untouched — the whole point of keying by lane.
      expect(service.getStreamStatus({ laneId: "lane-b" }).running).toBe(true);
    } finally {
      service.dispose();
      restoreHelper();
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("refuses `frame` without a running stream and grabs one when there is", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-apple-frame-`);
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run: runMock, commandExists: () => true });
    const helper = fakeSimHelper();
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      // `frame` reads the live stream; `screenshot` round-trips simctl and
      // needs no stream. Saying so is the difference between "start one" and
      // "this is broken".
      await expect(service.frame({})).rejects.toThrow(/APPLE_STREAM_NOT_RUNNING/);

      await service.startStream({ deviceUdid: "device-1" });
      const grabbed = await service.frame({});
      expect(grabbed.width).toBe(1179);
      expect(grabbed.filePath.startsWith(path.join(projectRoot, ".ade", "cache", "ios-simulator", "frames"))).toBe(true);
      expect(helper.sent.at(-1)).toMatchObject({ type: "screenshot", udid: "device-1" });

      // Same containment rule as `screenshot`: an `--out` that escapes the
      // build root is refused rather than written.
      await expect(service.frame({ outPath: "../escape.png" })).rejects.toThrow(/OUT_PATH_OUTSIDE_ROOT/);
    } finally {
      service.dispose();
      restoreHelper();
      restoreHooks();
      fs.rmSync(projectRoot, { recursive: true, force: true });
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

/**
 * The 24 bytes of a PNG that `pngDimensions` reads.
 *
 * `rotate` decides `applied` from the framebuffer's pixel size, so a test that
 * wrote the run mock's usual "not-a-real-png" placeholder would exercise only
 * the unreadable-screen path.
 */
function makeTestPng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.write("\x89PNG\r\n\x1a\n", 0, "binary");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
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
    // Capabilities now come from the vendored helper binary, not `idb`, so
    // point the resolver at a real file: the assertion must not depend on a
    // gitignored build output (and has to hold where no Mac build exists).
    const helperBinary = path.join(projectRoot, "ade-sim-helper");
    fs.writeFileSync(helperBinary, "");
    const previousHelperPath = process.env.ADE_SIM_HELPER_PATH;
    process.env.ADE_SIM_HELPER_PATH = helperBinary;
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
      if (previousHelperPath === undefined) delete process.env.ADE_SIM_HELPER_PATH;
      else process.env.ADE_SIM_HELPER_PATH = previousHelperPath;
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

  it("files a screenshot as proof captured by ADE", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-screenshot-proof-`);
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const filed: Array<Record<string, unknown>> = [];
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      recordingDeps: {
        artifactFiler: {
          ingest(request) {
            filed.push(request as Record<string, unknown>);
            return { artifacts: [{ id: "artifact-1" }], links: [] };
          },
        },
      },
    });

    try {
      const shot = await service.screenshot({ projectRoot });
      expect(shot.proofArtifactId).toBe("artifact-1");
      expect(filed).toHaveLength(1);
      expect(filed[0]).toMatchObject({
        backend: { toolName: "apple_screenshot" },
        provenance: { source: "ade-capture" },
      });
    } finally {
      service.dispose();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("refuses an --out that reaches outside the build root through a symlink", async () => {
    // The lexical containment check cannot see this: every segment sits under
    // the root, and the write still lands wherever the link points.
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const parent = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-out-symlink-`);
    const projectRoot = path.join(parent, "repo");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(projectRoot, "escape"));
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      await expect(service.screenshot({ projectRoot, outPath: "escape/shot.png" }))
        .rejects.toThrow(new RegExp(IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT_CODE));
      expect(fs.existsSync(path.join(outside, "shot.png"))).toBe(false);

      // A build root that is itself reached through a symlink still works. This
      // is the normal case on macOS, where `/tmp` is a link to `/private/tmp`.
      const linkedRoot = path.join(parent, "linked-repo");
      fs.symlinkSync(projectRoot, linkedRoot);
      const linkedService = createIosSimulatorService({ projectRoot: linkedRoot, logger: noopLogger });
      try {
        const shot = await linkedService.screenshot({ projectRoot: linkedRoot, outPath: "proof/shot.png" });
        expect(fs.existsSync(shot.filePath)).toBe(true);
      } finally {
        linkedService.dispose();
      }
    } finally {
      service.dispose();
      fs.rmSync(parent, { recursive: true, force: true });
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

  it("sends a drag as begin/move/end so iOS does not read it as a flick", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-drag-duration-`);
    writeMinimalXcodeProject(projectRoot, "Prox");
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const helper = fakeSimHelper();
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });

    try {
      await service.launch({ projectRoot, build: true });
      // The helper has no duration argument: the gesture IS the move events.
      // A begin immediately followed by an end is a flick to UIKit's velocity
      // tracker, so scrolls and slider drags would silently do nothing.
      await service.drag({ startX: 10, startY: 200, endX: 10, endY: 40 });
      const touches = helper.sent.filter((command) => command.type === "touch");
      expect(touches.at(0)).toMatchObject({ phase: "begin", x: 10, y: 200 });
      expect(touches.at(-1)).toMatchObject({ phase: "end", x: 10, y: 40 });
      const moves = touches.filter((command) => command.phase === "move");
      expect(moves.length).toBeGreaterThan(0);
      // Every intermediate point lies on the segment between the ends.
      for (const move of moves) {
        expect(Number(move.y)).toBeLessThanOrEqual(200);
        expect(Number(move.y)).toBeGreaterThanOrEqual(40);
      }

      // A longer drag is more move events, not a longer single hop.
      helper.sent.length = 0;
      await service.drag({ startX: 10, startY: 200, endX: 10, endY: 40, durationMs: 500 });
      const longer = helper.sent.filter((command) => command.type === "touch" && command.phase === "move");
      expect(longer.length).toBeGreaterThan(moves.length);
    } finally {
      service.dispose();
      restoreHelper();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("taps through the helper in device points and records the input", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-tap-`);
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const helper = fakeSimHelper();
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const noted: Array<Record<string, unknown>> = [];
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      resolveLaneWorktreePath: () => projectRoot,
      recordingService: {
        noteInput: async (input) => { noted.push(input as unknown as Record<string, unknown>); },
        active: () => null,
        start: async () => { throw new Error("unused"); },
        stop: async () => null,
        stopDevice: async () => null,
        list: async () => [],
        remove: async () => {},
        pinActiveOrLatest: async () => null,
        onTurnEnded: async () => {},
        totalBytes: async () => 0,
        helperExited: () => [],
        dispose: () => {},
      },
    });

    try {
      await service.tap({ deviceUdid: "device-1", x: 100, y: 240, laneId: "lane-a" });
      // Device POINTS, the same unit idb's `ui tap` took, so no caller had to
      // change its coordinates when the engine did.
      expect(helper.sent).toEqual([
        expect.objectContaining({ type: "touch", udid: "device-1", phase: "begin", x: 100, y: 240 }),
        expect.objectContaining({ type: "touch", udid: "device-1", phase: "end", x: 100, y: 240 }),
      ]);

      await service.typeText({ deviceUdid: "device-1", text: "hello", laneId: "lane-a" });
      expect(helper.sent.at(-1)).toMatchObject({ type: "type", text: "hello" });

      // Auto-record: the first injected input announces itself so unit 2C can
      // start a recording without the service knowing anything about video.
      expect(noted.map((entry) => entry.kind)).toEqual(["tap", "type"]);
      expect(noted[0]).toMatchObject({ laneId: "lane-a", udid: "device-1", x: 100, y: 240 });
    } finally {
      service.dispose();
      restoreHelper();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("answers a tap in well under a second, and names who tapped", async () => {
    // Round 3, A1. The live test produced dozens of
    // `Remote ADE service timed out waiting for method ade/actions/call
    // (25000ms)` while the user tapped, so the floor this guards is not
    // "fast" — it is "the call returns at all, promptly, with a helper that
    // answers". The `source` is what keeps a human's tap from starting a
    // recording (A2).
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-tap-latency-`);
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const helper = fakeSimHelper();
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const noted: Array<Record<string, unknown>> = [];
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      resolveLaneWorktreePath: () => projectRoot,
      recordingService: {
        noteInput: async (input) => { noted.push(input as unknown as Record<string, unknown>); },
        active: () => null,
        start: async () => { throw new Error("unused"); },
        stop: async () => null,
        stopDevice: async () => null,
        list: async () => [],
        remove: async () => {},
        pinActiveOrLatest: async () => null,
        onTurnEnded: async () => {},
        totalBytes: async () => 0,
        helperExited: () => [],
        dispose: () => {},
      },
    });

    try {
      const startedAt = Date.now();
      for (let index = 0; index < 12; index += 1) {
        await service.tap({ deviceUdid: "device-1", x: 40 + index, y: 80, laneId: "lane-a", source: "user" });
      }
      // Twelve taps, serialised through the one control queue, still well
      // inside the budget of a single one of the old timeouts.
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(noted).toHaveLength(12);
      expect(noted.every((entry) => entry.source === "user")).toBe(true);

      // Nothing said `source`, so it is an agent: the auto-record contract's
      // default has to be the one that produces evidence.
      await service.tap({ deviceUdid: "device-1", x: 5, y: 5, laneId: "lane-a" });
      expect(noted.at(-1)).toMatchObject({ source: "agent" });
    } finally {
      service.dispose();
      restoreHelper();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("does not let one wedged control wedge every tap behind it", async () => {
    // The shape of the round-2 failure: the control queue is serial, and the
    // helper's own request timeout (30s) is LONGER than the desktop's action
    // timeout (25s) — so one command that never answered meant every later
    // tap sat behind it while its caller had already given up. The queue now
    // gives a control eight seconds and moves on.
    vi.useFakeTimers();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-tap-wedge-`);
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    let wedge = true;
    const helper = fakeSimHelper({
      onSend: async (command) => {
        if (command.type === "touch" && wedge) return new Promise<Record<string, unknown>>(() => {});
        return {};
      },
    });
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      resolveLaneWorktreePath: () => projectRoot,
    });

    try {
      const stuck = service.tap({ deviceUdid: "device-1", x: 1, y: 1, laneId: "lane-a" });
      const stuckResult = expect(stuck).rejects.toThrow(/did not accept tap/);
      await vi.advanceTimersByTimeAsync(8_001);
      await stuckResult;

      // The queue moved on: the next tap is answered normally.
      wedge = false;
      const next = service.tap({ deviceUdid: "device-1", x: 2, y: 2, laneId: "lane-a" });
      await vi.advanceTimersByTimeAsync(10);
      await expect(next).resolves.toEqual({ ok: true });
    } finally {
      service.dispose();
      restoreHelper();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("presses helper buttons without recording overlay input, and refuses shake", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-button-`);
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const helper = fakeSimHelper();
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const noted: Array<Record<string, unknown>> = [];
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      recordingService: {
        noteInput: async (input) => { noted.push(input as unknown as Record<string, unknown>); },
        active: () => null,
        start: async () => { throw new Error("unused"); },
        stop: async () => null,
        stopDevice: async () => null,
        list: async () => [],
        remove: async () => {},
        pinActiveOrLatest: async () => null,
        onTurnEnded: async () => {},
        totalBytes: async () => 0,
        helperExited: () => [],
        dispose: () => {},
      },
    });

    try {
      await service.pressButton({ name: "home", deviceUdid: "device-1", laneId: "lane-a" });
      expect(helper.sent).toEqual([
        expect.objectContaining({ type: "button", udid: "device-1", name: "home" }),
      ]);
      // Hardware buttons are not overlay input — auto-record must not start.
      expect(noted).toEqual([]);

      await expect(service.pressButton({ name: "shake", deviceUdid: "device-1" }))
        .rejects.toThrow(/APPLE_BUTTON_UNSUPPORTED/);
      expect(helper.sent).toHaveLength(1);

      await expect(service.pressButton({ name: "power" as "home", deviceUdid: "device-1" }))
        .rejects.toThrow(/APPLE_BUTTON_UNSUPPORTED/);

      // The app switcher is ONE helper command, whose double home press keeps
      // Simulator's short gap. Two `home` calls would relaunch SpringBoard twice.
      helper.sent.length = 0;
      await service.pressButton({ name: "app-switcher", deviceUdid: "device-1", laneId: "lane-a" });
      expect(helper.sent).toEqual([
        expect.objectContaining({ type: "button", udid: "device-1", name: "app_switcher" }),
      ]);
      expect(noted).toEqual([]);
    } finally {
      service.dispose();
      restoreHelper();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("reads the foreground app from the helper and maps SpringBoard or a missing app to null", async () => {
    // `getForegroundApp` is darwin-gated (`assertDarwin`), so the platform must
    // be mocked for this to hold on the Linux CI runner.
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-front-`);
    const { run } = simulatorRunMock();
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    let reply: () => Record<string, unknown> = () => ({ app: { bundleId: "com.acme.app", pid: 4242 } });
    const helper = fakeSimHelper({ onSend: () => reply() });
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const service = createIosSimulatorService({ projectRoot, logger: noopLogger });
    try {
      const front = await service.getForegroundApp({ deviceUdid: "device-1", laneId: "lane-a" });
      expect(front).toMatchObject({ bundleId: "com.acme.app", pid: 4242 });
      expect(helper.sent).toEqual([expect.objectContaining({ type: "ax-frontmost", udid: "device-1" })]);

      reply = () => ({ app: { bundleId: "com.apple.springboard" } });
      expect(await service.getForegroundApp({ deviceUdid: "device-1" })).toBeNull();

      reply = () => { throw new Error("No frontmost application returned for simulator"); };
      expect(await service.getForegroundApp({ deviceUdid: "device-1" })).toBeNull();

      reply = () => { throw new Error("helper exited"); };
      await expect(service.getForegroundApp({ deviceUdid: "device-1" })).rejects.toThrow(/helper exited/);
    } finally {
      service.dispose();
      restoreHelper();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  /**
   * `rotate` reports what the SCREEN did, never what was sent.
   *
   * The helper answers `applied: true` once its GSEvent reaches
   * `PurpleWorkspacePort` with `KERN_SUCCESS`, which says a mach message left
   * the host and nothing more. Measured on a machine with no `Simulator.app`
   * installed: the device orientation really does change, and whether the
   * screen follows is the foreground app's decision — SpringBoard and Settings
   * on an iPhone are portrait-only, so four landscape rotates all reported
   * success with the framebuffer still at 1179x2556. These cases pin each of
   * the five answers the service is allowed to give.
   */
  it("rotates only when the framebuffer is observed turning, and names the reason when it does not", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const projectRoot = fs.mkdtempSync(`${os.tmpdir()}/ade-ios-rotate-`);
    // The screen the fake device is showing, in framebuffer pixels. The test
    // moves this to say whether iOS took the rotation.
    let screen: { width: number; height: number } | "unreadable" = { width: 1179, height: 2556 };
    let helperApplied = true;
    const screenshots: string[] = [];
    const run = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: simulatorDevicesJson, stderr: "" };
      }
      if (command === "xcrun" && commandArgs[1] === "io" && commandArgs[3] === "screenshot") {
        const outPath = commandArgs[commandArgs.length - 1];
        screenshots.push(outPath);
        if (screen === "unreadable") {
          fs.writeFileSync(outPath, "not-a-real-png");
          return { stdout: "", stderr: "" };
        }
        fs.writeFileSync(outPath, makeTestPng(screen.width, screen.height));
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const helper = fakeSimHelper({
      onSend: (command) => {
        if (command.type !== "orientation") return {};
        // iOS accepts the device orientation whatever the app does, which is
        // exactly why the send cannot be the answer.
        if (helperApplied && command.value === 4) screen = { width: 2556, height: 1179 };
        return { applied: helperApplied };
      },
    });
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const noted: Array<Record<string, unknown>> = [];
    const service = createIosSimulatorService({
      projectRoot,
      logger: noopLogger,
      recordingService: {
        noteInput: async (input) => { noted.push(input as unknown as Record<string, unknown>); },
        active: () => null,
        start: async () => { throw new Error("unused"); },
        stop: async () => null,
        stopDevice: async () => null,
        list: async () => [],
        remove: async () => {},
        pinActiveOrLatest: async () => null,
        onTurnEnded: async () => {},
        totalBytes: async () => 0,
        helperExited: () => [],
        dispose: () => {},
      },
    });

    try {
      // landscape-left is helper value 4 (UIInterfaceOrientation), not 3.
      const rotated = await service.rotate({
        orientation: "landscape-left",
        deviceUdid: "device-1",
        laneId: "lane-a",
      });
      expect(helper.sent).toEqual([
        expect.objectContaining({ type: "orientation", udid: "device-1", value: 4 }),
      ]);
      expect(rotated).toMatchObject({
        applied: true,
        orientation: "landscape-left",
        verification: "rotated",
        reason: null,
        frameBefore: { width: 1179, height: 2556 },
        frameAfter: { width: 2556, height: 1179 },
      });
      expect(noted).toEqual([]);
      // The probe PNGs are temp files, not artifacts, and none may survive.
      expect(screenshots.every((file) => !fs.existsSync(file))).toBe(true);

      // Asking for the axis the screen is already on cannot be proved either
      // way, so it says so instead of claiming the exact side.
      const already = await service.rotate({
        orientation: "landscape-right",
        deviceUdid: "device-1",
      });
      expect(already).toMatchObject({
        applied: true,
        orientation: "landscape-right",
        verification: "already-on-axis",
        reason: null,
      });
      expect(already.detail).toMatch(/not confirmed/i);

      // The app on screen keeps its own orientation: the send succeeds, the
      // framebuffer never moves, and `applied` must be false.
      const refused = await service.rotate({
        orientation: "portrait",
        deviceUdid: "device-1",
      });
      expect(helper.sent.at(-1)).toMatchObject({ type: "orientation", value: 1 });
      expect(refused).toMatchObject({
        applied: false,
        orientation: "portrait",
        verification: "not-adopted",
        reason: "APPLE_ROTATE_NOT_ADOPTED",
        frameBefore: { width: 2556, height: 1179 },
        frameAfter: { width: 2556, height: 1179 },
      });
      expect(refused.detail).toMatch(/supports that orientation/i);

      // An unreadable screen is "do not know", which is not success.
      screen = "unreadable";
      const unmeasurable = await service.rotate({
        orientation: "portrait",
        deviceUdid: "device-1",
      });
      expect(unmeasurable).toMatchObject({
        applied: false,
        verification: "unmeasurable",
        reason: "APPLE_ROTATE_UNMEASURABLE",
        frameBefore: null,
        frameAfter: null,
      });

      // And a helper that could not deliver the event is its own answer.
      screen = { width: 1179, height: 2556 };
      helperApplied = false;
      const sendFailed = await service.rotate({
        orientation: "landscape-left",
        deviceUdid: "device-1",
      });
      expect(sendFailed).toMatchObject({
        applied: false,
        verification: "send-failed",
        reason: "APPLE_ROTATE_SEND_FAILED",
      });
    } finally {
      service.dispose();
      restoreHelper();
      fs.rmSync(projectRoot, { recursive: true, force: true });
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("fails every device-hub call on non-darwin with the macOS-only error", async () => {
    // Each of these shells out to `xcrun`. Ungated, a Windows or Linux caller
    // got `spawn xcrun ENOENT` from the action surface, which reads as a broken
    // install rather than an unsupported platform.
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const service = createIosSimulatorService({ projectRoot: os.tmpdir(), logger: noopLogger });

    try {
      await expect(service.openDevice()).rejects.toThrow(/only available on macOS/);
      await expect(service.closeDevice()).rejects.toThrow(/only available on macOS/);
      await expect(service.getDeviceSettings()).rejects.toThrow(/only available on macOS/);
      await expect(service.setAppearance({ appearance: "dark" })).rejects.toThrow(/only available on macOS/);
      await expect(service.startEventLog({ bundleId: "com.example.app" })).rejects.toThrow(/only available on macOS/);
      await expect(service.relaunchApp({ bundleId: "com.example.app" })).rejects.toThrow(/only available on macOS/);
      await expect(service.uninstallApp({ bundleId: "com.example.app" })).rejects.toThrow(/only available on macOS/);
      await expect(service.tapElement({ query: { label: "Continue" } })).rejects.toThrow(/only available on macOS/);
      await expect(service.captureProofBundle()).rejects.toThrow(/only available on macOS/);

      // The two reads that must keep working everywhere: a status read is how a
      // non-Mac desktop learns it cannot run a simulator, and the chat-close
      // cleanup runs on every platform.
      const status = await service.getStatus();
      expect(status.supported).toBe(false);
      expect(status.deviceSession ?? null).toBeNull();
      expect(await service.releaseIfOwnedBy("chat-a")).toEqual({ released: false, previousSession: null });
    } finally {
      service.dispose();
      platformSpy.mockRestore();
    }
  });

  it("fails screenshot, tap, and typeText on non-darwin with the macOS-only error", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const service = createIosSimulatorService({ projectRoot: os.tmpdir(), logger: noopLogger });

    try {
      await expect(service.screenshot()).rejects.toThrow(/only available on macOS/);
      await expect(service.tap({ x: 1, y: 2 })).rejects.toThrow(/only available on macOS/);
      await expect(service.pressButton({ name: "home" })).rejects.toThrow(/only available on macOS/);
      await expect(service.rotate({ orientation: "portrait" })).rejects.toThrow(/only available on macOS/);
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

describe("iosSimulatorService device tool targeting", () => {
  const twoBootedIphonesJson = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
        { name: "iPhone 17 Pro", udid: "device-1", state: "Booted", isAvailable: true },
        { name: "iPhone Air", udid: "device-2", state: "Booted", isAvailable: true },
      ],
    },
  });

  it("sends an implicit device tool to the open device session, not the first booted iPhone", async () => {
    // A chat that opens a device and never launches an app holds a device
    // session and no app session. Without the device session in the precedence
    // every appearance, location and log call fell through to "the first booted
    // iPhone", which is another simulator as soon as two are up.
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: twoBootedIphonesJson, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run: runMock, commandExists: () => true });
    const service = createIosSimulatorService({ projectRoot: os.tmpdir(), logger: noopLogger });

    try {
      await service.openDevice({ deviceUdid: "device-2", chatSessionId: "chat-a", openWindow: false });
      await service.setAppearance({ appearance: "dark" });

      const simctlUiCalls = runMock.mock.calls
        .map(([, commandArgs]) => commandArgs)
        .filter((commandArgs) => commandArgs[0] === "simctl" && commandArgs[1] === "ui");
      expect(simctlUiCalls.length).toBeGreaterThan(0);
      expect(simctlUiCalls.every((commandArgs) => commandArgs[2] === "device-2")).toBe(true);
      expect(simctlUiCalls).toContainEqual(["simctl", "ui", "device-2", "appearance", "dark"]);

      // The same precedence a status read reports, so the drawer and the tools
      // never name different simulators.
      expect((await service.getStatus()).activeDevice?.udid).toBe("device-2");
    } finally {
      service.dispose();
      restoreHooks();
      platformSpy.mockRestore();
    }
  });

  it("regression: places a lane-less caller by the worktree it stands in, not by whichever lane is busy", async () => {
    // A shell with no ADE_LANE_ID — every OpenCode agent, because a shared
    // `opencode serve` cannot carry a per-chat environment — sends its
    // workspace as projectRoot and no lane id. The service used that path for
    // the BUILD root and then resolved the lane by "the one lane running
    // something", so lane-b's screenshot was filed against lane-a. That is a
    // cross-lane leak of an agent's own proof.
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const runMock = vi.fn(async (command: string, commandArgs: string[]) => {
      if (command === "xcrun" && commandArgs.join(" ") === "simctl list devices available --json") {
        return { stdout: twoBootedIphonesJson, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run: runMock, commandExists: () => true });
    const laneRoots: Record<string, string> = {
      "lane-a": path.join(os.tmpdir(), "ade-lane-a"),
      "lane-b": path.join(os.tmpdir(), "ade-lane-b"),
    };
    const service = createIosSimulatorService({
      projectRoot: os.tmpdir(),
      logger: noopLogger,
      resolveLaneWorktreePath: (laneId) => laneRoots[laneId] ?? null,
      resolveLaneIdForPath: (absolutePath) =>
        Object.entries(laneRoots).find(([, root]) => absolutePath.startsWith(root))?.[0] ?? null,
    });

    try {
      // lane-a is the only lane with anything running.
      await service.openDevice({ laneId: "lane-a", deviceUdid: "device-2", chatSessionId: "chat-a", openWindow: false });

      // An anonymous call standing in lane-b's worktree is lane-b's.
      const status = await service.getStatus({ projectRoot: path.join(laneRoots["lane-b"]!, "apps", "ios") } as never);
      expect(status.laneId).toBe("lane-b");

      // And a caller standing nowhere in particular still reaches the one
      // occupied lane, which is the behaviour that guard was added for.
      expect((await service.getStatus()).laneId).toBe("lane-a");
    } finally {
      service.dispose();
      restoreHooks();
      platformSpy.mockRestore();
    }
  });
});

describe("iosSimulatorService boot contract", () => {
  /**
   * A `run` mock that keeps the installed list honest: a `simctl clone`
   * appends the clone as Shutdown, and `simctl boot` flips a device to Booted,
   * so `resolveDevice` after either sees what the real `simctl` would report.
   */
  function bootAwareRun(options: { bootError?: string | null; onShutdown?: (udid: string) => void; onBoot?: (udid: string) => void } = {}) {
    const devices = [
      { name: "iPhone 17 Pro", udid: "device-1", state: "Booted", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" },
      { name: "iPhone 17", udid: "device-2", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" },
    ];
    const calls: string[] = [];
    const run = vi.fn(async (command: string, commandArgs: string[]) => {
      const joined = `${command} ${commandArgs.join(" ")}`;
      calls.push(joined);
      if (joined === "xcrun simctl list devices available --json") {
        return { stdout: JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-3": devices } }), stderr: "" };
      }
      if (command === "xcrun" && commandArgs[0] === "simctl" && commandArgs[1] === "clone") {
        devices.push({ name: commandArgs[3] ?? "clone", udid: "device-clone", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" });
        return { stdout: "device-clone\n", stderr: "" };
      }
      if (command === "xcrun" && commandArgs[0] === "simctl" && commandArgs[1] === "shutdown") {
        options.onShutdown?.(commandArgs[2] ?? "");
        const target = devices.find((device) => device.udid === commandArgs[2]);
        if (target) target.state = "Shutdown";
      }
      if (command === "xcrun" && commandArgs[0] === "simctl" && commandArgs[1] === "boot") {
        if (options.bootError) throw new Error(options.bootError);
        const target = devices.find((device) => device.udid === commandArgs[2]);
        // What the real `simctl` answers for a device that is already up. A
        // caller holding a stale "Shutdown" read reaches this.
        if (target?.state === "Booted") throw new Error("Unable to boot device in current state: Booted");
        if (target) target.state = "Booted";
        options.onBoot?.(commandArgs[2] ?? "");
      }
      return { stdout: "", stderr: "" };
    });
    return { run, calls, devices };
  }

  function setup(options: {
    bootError?: string | null;
    captureError?: string | null;
    onShutdown?: (udid: string) => void;
    onBoot?: (udid: string) => void;
    helperPid?: () => number | null;
  } = {}) {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const { run, calls, devices } = bootAwareRun(options);
    const restoreHooks = __testSetIosSimulatorProcessHooks({ run, commandExists: () => true });
    const helper = fakeSimHelper({
      ...(options.captureError ? {
        onSend: (command: Record<string, unknown>) => {
          if (command.type === "capture-start") throw new Error(options.captureError ?? "capture failed");
          return {};
        },
      } : {}),
      ...(options.helperPid ? { pid: options.helperPid } : {}),
    });
    const restoreHelper = __testSetIosSimulatorHelperFactory(() => helper.client);
    const events: IosSimulatorEventPayload[] = [];
    const service = createIosSimulatorService({
      projectRoot: os.tmpdir(),
      logger: noopLogger,
      onEvent: (payload) => { events.push(payload); },
    });
    const phases = () => events.flatMap((event) => (event.type === "apple.device.state" ? [event.phase] : []));
    const dispose = () => {
      service.dispose();
      restoreHelper();
      restoreHooks();
      platformSpy.mockRestore();
    };
    return { service, calls, devices, helper, events, phases, dispose };
  }

  it("an explicit startStream (boot: true) boots a shut-down device and waits for bootstatus before opening the capture", async () => {
    const { service, calls, helper, dispose } = setup();
    try {
      const status = await service.startStream({ deviceUdid: "device-2", laneId: "lane-a", boot: true });
      expect(status.running).toBe(true);
      const bootAt = calls.indexOf("xcrun simctl boot device-2");
      const statusAt = calls.indexOf("xcrun simctl bootstatus device-2 -b");
      expect(bootAt).toBeGreaterThan(-1);
      expect(statusAt).toBeGreaterThan(bootAt);
      expect(helper.sent.some((command) => command.type === "capture-start" && command.udid === "device-2")).toBe(true);
    } finally {
      dispose();
    }
  });

  it("deviceDeleteInstalled refuses to delete without the owner's confirmation", async () => {
    // Not a formality. Deleting a simulator is not recoverable, the owner's
    // standing rule is that nothing deletes one without their approval, and
    // this verb is reachable by any agent because ADE keeps one action list
    // per domain. A caller that must write the claim out cannot arrive here by
    // drifting through a default.
    const { service, calls, dispose } = setup();
    try {
      await expect(
        service.deviceDeleteInstalled({ udid: "device-2" } as never),
      ).rejects.toThrow(/confirmedByUser/);
      expect(calls).not.toContain("xcrun simctl delete device-2");
    } finally {
      dispose();
    }
  });

  it("deviceDeleteInstalled deletes when the owner confirmed that device", async () => {
    const { service, calls, dispose } = setup();
    try {
      await service.deviceDeleteInstalled({ udid: "device-2", confirmedByUser: true, laneId: "lane-a" });
      expect(calls).toContain("xcrun simctl delete device-2");
    } finally {
      dispose();
    }
  });

  it("an explicit startStream skips simctl boot for a device that is already booted", async () => {
    const { service, calls, dispose } = setup();
    try {
      await service.startStream({ deviceUdid: "device-1", laneId: "lane-a", boot: true });
      expect(calls).not.toContain("xcrun simctl boot device-1");
      expect(calls).toContain("xcrun simctl bootstatus device-1 -b");
    } finally {
      dispose();
    }
  });

  it("an explicit startStream tolerates simctl saying the device is already booted", async () => {
    const { service, dispose } = setup({ bootError: "Unable to boot device in current state: Booted" });
    try {
      const status = await service.startStream({ deviceUdid: "device-2", laneId: "lane-a", boot: true });
      expect(status.running).toBe(true);
    } finally {
      dispose();
    }
  });

  it("regression: a viewer attaching to a device that is off gets APPLE_DEVICE_OFF and never boots it", async () => {
    // The owner's 2026-09-23 report: reopening the tools pane after ADE
    // restarted booted the simulator instead of showing "{name} is off."
    // Watching is not asking for power.
    const { service, calls, helper, dispose } = setup();
    try {
      await expect(service.startStream({ deviceUdid: "device-2", laneId: "lane-a", localViewer: true }))
        .rejects.toMatchObject({ code: "APPLE_DEVICE_OFF", message: expect.stringMatching(/^APPLE_DEVICE_OFF: iPhone 17 is off\./) });
      expect(calls).not.toContain("xcrun simctl boot device-2");
      expect(helper.sent.some((command) => command.type === "capture-start")).toBe(false);
      expect(service.getStreamStatus({ laneId: "lane-a" }).running).toBe(false);
    } finally {
      dispose();
    }
  });

  it("a viewer refused for an off device leaves the lane's other stream running", async () => {
    const { service, dispose } = setup();
    try {
      await service.startStream({ deviceUdid: "device-1", laneId: "lane-a" });
      await expect(service.startStream({ deviceUdid: "device-2", laneId: "lane-a" }))
        .rejects.toMatchObject({ code: "APPLE_DEVICE_OFF" });
      expect(service.getStreamStatus({ laneId: "lane-a" })).toMatchObject({ running: true, deviceUdid: "device-1" });
    } finally {
      dispose();
    }
  });

  it("regression: a stream left 'running' on a device that has since gone off is published stopped, not handed out", async () => {
    // A restart (or Xcode) powers the device off under a live status. The fast
    // path used to hand that capture's dead address to the next viewer.
    const { service, calls, events, devices, helper, dispose } = setup();
    try {
      await service.deviceStart({ laneId: "lane-a", udid: "device-2" });
      expect(service.getStreamStatus({ laneId: "lane-a" }).running).toBe(true);
      const captures = helper.sent.filter((command) => command.type === "capture-start").length;
      // Powered off outside ADE: simctl now says Shutdown, and no event said so.
      devices.find((device) => device.udid === "device-2")!.state = "Shutdown";
      await new Promise((resolve) => setTimeout(resolve, 600)); // past the device-list cache
      calls.length = 0;

      await expect(service.startStream({ laneId: "lane-a", localViewer: true }))
        .rejects.toMatchObject({ code: "APPLE_DEVICE_OFF" });

      expect(service.getStreamStatus({ laneId: "lane-a" }).running).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "stream-stopped" });
      expect(calls).not.toContain("xcrun simctl boot device-2");
      expect(helper.sent.filter((command) => command.type === "capture-start").length).toBe(captures);
    } finally {
      dispose();
    }
  });

  it("regression: a remote viewer on an off device (relay openSource) is refused and nothing boots", async () => {
    // The phone and the web tab reach the service through the relay. Before,
    // `startStream` booted the device for them, so opening the viewer on a
    // phone powered the Mac's simulator on.
    const { service, calls, dispose } = setup();
    try {
      await service.deviceAttach({ laneId: "lane-a", simulator: "device-2" });
      const connect = vi.fn();
      const relay = createAppleStreamRelayForService({
        service,
        remoteBitrateKbpsCap: () => 1500,
        connect: connect as never,
      });
      const ticket = relay.issue({ laneId: "lane-a" });
      const closed: Array<[number | undefined, string | undefined]> = [];
      const socket = {
        send: vi.fn(),
        close: (code?: number, reason?: string) => { closed.push([code, reason]); },
        on: vi.fn(),
      };
      await relay.attach(socket, { ticket: ticket.ticket, token: ticket.token });
      expect(closed).toEqual([[1011, "stream unavailable"]]);
      expect(connect).not.toHaveBeenCalled();
      expect(calls).not.toContain("xcrun simctl boot device-2");
      relay.dispose();
    } finally {
      dispose();
    }
  });

  it("regression: the Mac's last viewer leaving does not cut off a phone reading the same capture", async () => {
    // The owner's 2026-09-23 report: the floating player went away and its
    // lane-scoped stop ended the capture the phone was watching through the
    // relay. The phone kept going only because it reconnected.
    const { service, helper, dispose } = setup();
    try {
      await service.startStream({ deviceUdid: "device-1", laneId: "lane-a", localViewer: true });
      const upstreamClosed = vi.fn();
      const relay = createAppleStreamRelayForService({
        service,
        remoteBitrateKbpsCap: () => null,
        connect: (() => ({ onData: () => {}, onEnd: () => {}, close: upstreamClosed })) as never,
      });
      const ticket = relay.issue({ laneId: "lane-a" });
      const socketListeners = new Map<string, (...args: unknown[]) => void>();
      const socket = {
        send: vi.fn(),
        close: vi.fn(),
        on: (event: string, listener: (...args: unknown[]) => void) => { socketListeners.set(event, listener); },
      };
      expect(await relay.attach(socket as never, { ticket: ticket.ticket, token: ticket.token })).toBe(true);
      const captureStops = () => helper.sent.filter((command) => command.type === "capture-stop").length;

      // The desktop's last lease goes: the renderer's stop carries localViewer.
      await service.stopStream({ laneId: "lane-a", localViewer: true });
      expect(captureStops()).toBe(0);
      expect(service.getStreamStatus({ laneId: "lane-a" }).running).toBe(true);
      expect(service.hasLocalViewer("lane-a")).toBe(false);

      // The phone leaves too: now the relay, which took the stop over, stops it.
      socketListeners.get("close")?.();
      await vi.waitFor(() => expect(service.getStreamStatus({ laneId: "lane-a" }).running).toBe(false));
      expect(captureStops()).toBe(1);
      relay.dispose();

      // With no relay viewer at all, a local stop stops.
      await service.startStream({ deviceUdid: "device-1", laneId: "lane-a", localViewer: true });
      await service.stopStream({ laneId: "lane-a", localViewer: true });
      expect(captureStops()).toBe(2);
    } finally {
      dispose();
    }
  });

  it("a viewer arriving while the device is booting waits for it instead of refusing or booting again", async () => {
    const { service, calls, devices, dispose } = setup();
    try {
      devices.find((device) => device.udid === "device-2")!.state = "Booting";
      const status = await service.startStream({ deviceUdid: "device-2", laneId: "lane-a" });
      expect(status.running).toBe(true);
      expect(calls).not.toContain("xcrun simctl boot device-2");
      expect(calls).toContain("xcrun simctl bootstatus device-2 -b");
    } finally {
      dispose();
    }
  });

  it("deviceStart attaches, boots, streams, and narrates starting → booted → streaming", async () => {
    const { service, calls, phases, dispose, events } = setup();
    try {
      const status = await service.deviceStart({ laneId: "lane-a", udid: "device-2" });
      expect(status.running).toBe(true);
      expect(status.deviceUdid).toBe("device-2");
      expect(phases()).toEqual(["starting", "booted", "streaming"]);
      const first = events.find((event) => event.type === "apple.device.state");
      expect(first).toMatchObject({ type: "apple.device.state", laneId: "lane-a", udid: "device-2", phase: "starting" });
      expect(calls).toContain("xcrun simctl boot device-2");
      expect(calls).toContain("xcrun simctl bootstatus device-2 -b");
      const owned = await service.deviceList({ laneId: "lane-a", installed: false });
      expect(owned.lane).toMatchObject({ udid: "device-2", origin: "attached" });
    } finally {
      dispose();
    }
  });

  it("a takeover MOVES the device: the losing lane is released, not powered off", async () => {
    const { service, calls, events, dispose } = setup();
    try {
      // Lane A owns device-2 and is streaming it.
      await service.deviceStart({ laneId: "lane-a", udid: "device-2", chatSessionId: "chat-a" });
      expect(service.getStreamStatus({ laneId: "lane-a" }).running).toBe(true);

      // Lane B takes it over — the picker's "Take over…", behind its
      // confirmation, is exactly this call.
      const status = await service.deviceStart({ laneId: "lane-b", udid: "device-2", chatSessionId: "chat-b" });
      expect(status.deviceUdid).toBe("device-2");

      // Exactly one lane owns it. Before the move, both did — and either could
      // have powered it off or deleted it under the other.
      const mine = await service.deviceList({ laneId: "lane-b", installed: false });
      expect(mine.lane).toMatchObject({ udid: "device-2", laneId: "lane-b" });
      expect(mine.owners).toEqual([
        { udid: "device-2", laneId: "lane-b", laneName: null, origin: "attached", mine: true },
      ]);
      const theirs = await service.deviceList({ laneId: "lane-a", installed: false });
      expect(theirs.lane).toBeNull();

      // The losing lane's live view and session claim are gone.
      expect(service.getStreamStatus({ laneId: "lane-a" }).running).toBe(false);
      expect((await service.getStatus({ laneId: "lane-a" })).activeSession).toBeNull();
      expect(events).toContainEqual(expect.objectContaining({
        type: "apple.device.state",
        laneId: "lane-a",
        udid: "device-2",
        phase: "released",
      }));

      // The simulator itself keeps running: the lane taking it over is about to
      // stream the same device, and a takeover that hands over a powered-off
      // device is not a takeover.
      expect(calls).not.toContain("xcrun simctl shutdown device-2");
      expect(service.getStreamStatus({ laneId: "lane-b" }).running).toBe(true);
    } finally {
      dispose();
    }
  });

  it("regression: deviceStop ends the device's recording before it powers the device off", async () => {
    // A recording outlived its device's power cycle on 2026-09-22, and every
    // later `record-start` on the device was refused until the helper was killed.
    let sentAtShutdown: string[] = [];
    const { service, calls, helper, dispose } = setup({
      onShutdown: () => { sentAtShutdown = helper.sent.map((command) => `${String(command.type)} ${String(command.udid ?? "")}`); },
    });
    try {
      await service.deviceStart({ laneId: "lane-a", udid: "device-2" });
      await service.recordStart({ laneId: "lane-a" });

      await service.deviceStop({ laneId: "lane-a" });

      expect(calls).toContain("xcrun simctl shutdown device-2");
      expect(sentAtShutdown).toContain("record-stop device-2");
    } finally {
      dispose();
    }
  });

  it("regression: deviceStop resets the helper's session for the device before it powers it off", async () => {
    // 2026-09-23, live on a MacBook: a lane simulator was powered off and
    // booted again under a helper that stayed up, and every tap afterwards
    // answered ok in ~11 ms while the screen never changed. The helper's HID
    // client was bound to the old boot.
    let sentAtShutdown: string[] = [];
    const { service, calls, helper, dispose } = setup({
      onShutdown: () => { sentAtShutdown = helper.sent.map((command) => `${String(command.type)} ${String(command.udid ?? "")}`); },
    });
    try {
      await service.deviceStart({ laneId: "lane-a", udid: "device-2" });

      await service.deviceStop({ laneId: "lane-a" });

      expect(calls).toContain("xcrun simctl shutdown device-2");
      expect(sentAtShutdown).toContain("device-reset device-2");
    } finally {
      dispose();
    }
  });

  it("regression: booting a device that was off resets its helper session; an already-booted device keeps it", async () => {
    let sentAtBoot: string[] | null = null;
    const { service, helper, dispose } = setup({
      onBoot: (udid) => {
        if (udid === "device-2") sentAtBoot = helper.sent.map((command) => `${String(command.type)} ${String(command.udid ?? "")}`);
      },
    });
    const resetsFor = (udid: string) => helper.sent.filter((command) => command.type === "device-reset" && command.udid === udid).length;
    try {
      // The helper is up and driving device-2 — the state the live bug began in.
      await service.deviceStart({ laneId: "lane-a", udid: "device-2" });
      await service.deviceStop({ laneId: "lane-a" });
      const resetsAfterStop = resetsFor("device-2");

      // The power cycle: device-2 boots again.
      await service.deviceStart({ laneId: "lane-a" });

      // One more reset, sent AFTER the boot (not before it) and before the
      // new capture, so the capture and every later tap get a fresh session.
      expect(resetsFor("device-2")).toBe(resetsAfterStop + 1);
      expect(sentAtBoot).not.toBeNull();
      const lastReset = helper.sent.map((command) => `${String(command.type)} ${String(command.udid ?? "")}`).lastIndexOf("device-reset device-2");
      expect(lastReset).toBeGreaterThanOrEqual(sentAtBoot!.length);
      const lastCapture = helper.sent.map((command) => `${String(command.type)} ${String(command.udid ?? "")}`).lastIndexOf("capture-start device-2");
      expect(lastCapture).toBeGreaterThan(lastReset);

      // device-1 was never off: its session is left alone.
      await service.startStream({ laneId: "lane-b", deviceUdid: "device-1" });
      expect(resetsFor("device-1")).toBe(0);
    } finally {
      dispose();
    }
  });

  it("regression: a helper restart stops every lane's stream and the next startStream opens a fresh capture", async () => {
    // 2026-09-23, live: after the helper restarted, getStreamStatus still said
    // running with the dead pid and port, and startStream reused it, so every
    // viewer got a dead port until someone called stopStream.
    const { service, helper, events, dispose } = setup();
    const captureStarts = () => helper.sent.filter((command) => command.type === "capture-start").length;
    try {
      await service.startStream({ laneId: "lane-a", deviceUdid: "device-1", localViewer: true });
      expect(service.getStreamStatus({ laneId: "lane-a" })).toMatchObject({ running: true, helperPid: 4321 });
      expect(service.hasLocalViewer("lane-a")).toBe(true);
      expect(captureStarts()).toBe(1);

      helper.emit({ type: "helper-exited", pid: 4321, code: null, signal: "SIGKILL" });

      const after = service.getStreamStatus({ laneId: "lane-a" });
      expect(after.running).toBe(false);
      expect(after.helperPid).toBeNull();
      expect(service.hasLocalViewer("lane-a")).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        type: "stream-stopped",
        status: expect.objectContaining({ deviceUdid: "device-1", running: false }),
      }));

      const restarted = await service.startStream({ laneId: "lane-a", deviceUdid: "device-1" });
      expect(restarted.running).toBe(true);
      expect(captureStarts()).toBe(2);
    } finally {
      dispose();
    }
  });

  it("startStream will not reuse a running status stamped by a helper that is no longer the live one", async () => {
    // The second guard: even if no exit event reached the service, a status
    // whose helperPid is not the live helper's points at a dead port.
    let livePid = 4321;
    const { service, helper, dispose } = setup({ helperPid: () => livePid });
    const captureStarts = () => helper.sent.filter((command) => command.type === "capture-start").length;
    try {
      await service.startStream({ laneId: "lane-a", deviceUdid: "device-1" });
      // Same helper: the fast path is still taken.
      await service.startStream({ laneId: "lane-a", deviceUdid: "device-1" });
      expect(captureStarts()).toBe(1);

      livePid = 9876;
      const status = await service.startStream({ laneId: "lane-a", deviceUdid: "device-1" });

      expect(captureStarts()).toBe(2);
      expect(status.helperPid).toBe(9876);
    } finally {
      dispose();
    }
  });

  it("a takeover ends the losing lane's recording", async () => {
    const { service, helper, dispose } = setup();
    try {
      await service.deviceStart({ laneId: "lane-a", udid: "device-2", chatSessionId: "chat-a" });
      await service.recordStart({ laneId: "lane-a", chatSessionId: "chat-a" });

      await service.deviceStart({ laneId: "lane-b", udid: "device-2", chatSessionId: "chat-b" });

      expect(helper.sent).toContainEqual({ type: "record-stop", udid: "device-2" });
    } finally {
      dispose();
    }
  });

  it("deviceStart clones the source when asked to create", async () => {
    const { service, calls, phases, dispose } = setup();
    try {
      // `device-2`, the STOPPED one. This named `device-1` and passed only
      // because the mock does not enforce what simctl does: cloning a booted
      // device fails with error 405, "Unable to clone device in current state:
      // Booted" — verified against the real `simctl` (exit 149, nothing
      // created). So the old expectation could not happen on a Mac.
      const status = await service.deviceStart({ laneId: "lane-b", create: { sourceUdid: "device-2" } });
      expect(status.deviceUdid).toBe("device-clone");
      expect(calls.some((call) => call.startsWith("xcrun simctl clone device-2 "))).toBe(true);
      expect(calls).toContain("xcrun simctl boot device-clone");
      expect(phases()).toEqual(["starting", "booted", "streaming"]);
      const owned = await service.deviceList({ laneId: "lane-b", installed: false });
      expect(owned.lane).toMatchObject({ udid: "device-clone", origin: "clone" });
    } finally {
      dispose();
    }
  });

  it("deviceStart starts the device the lane already owns and ignores no udid silently", async () => {
    const { service, dispose } = setup();
    try {
      await service.deviceAttach({ laneId: "lane-c", simulator: "device-2" });
      const status = await service.deviceStart({ laneId: "lane-c" });
      expect(status.deviceUdid).toBe("device-2");
      await expect(service.deviceStart({ laneId: "lane-c", udid: "device-1" })).rejects.toThrow(/APPLE_DEVICE_EXISTS/);
    } finally {
      dispose();
    }
  });

  it("deviceStart refuses a lane with no device and nothing to attach", async () => {
    const { service, phases, dispose } = setup();
    try {
      await expect(service.deviceStart({ laneId: "lane-d" })).rejects.toThrow(/no Apple device yet/);
      expect(phases()).toEqual([]);
      await expect(service.deviceStart({})).rejects.toThrow(/belong to a lane/);
    } finally {
      dispose();
    }
  });

  it("deviceStart narrates a failure and rethrows it", async () => {
    const { service, phases, events, dispose } = setup({ captureError: "Device not booted (state: Shutdown)" });
    try {
      await expect(service.deviceStart({ laneId: "lane-e", udid: "device-2" })).rejects.toThrow(/Device not booted/);
      expect(phases()).toEqual(["starting", "booted", "failed"]);
      const failed = events.find((event) => event.type === "apple.device.state" && event.phase === "failed");
      expect(failed).toMatchObject({ detail: "Device not booted (state: Shutdown)" });
    } finally {
      dispose();
    }
  });
});
