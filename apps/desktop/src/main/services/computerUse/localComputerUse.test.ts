import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setScreenCapturePermissionProbeForTests,
  createComputerUseArtifactPath,
  getLocalComputerUseCapabilities,
} from "./localComputerUse";

describe("createComputerUseArtifactPath", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-local-computer-use-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns unique paths for same-kind captures within a tight loop", () => {
    const paths = new Set<string>();
    for (let i = 0; i < 500; i++) {
      paths.add(createComputerUseArtifactPath(projectRoot, "untitled", "png"));
    }
    expect(paths.size).toBe(500);
  });
});

describe("getLocalComputerUseCapabilities", () => {
  it.each(["win32", "linux"] as const)(
    "blocks native OS control on %s without disabling Electron Control or proof ingestion",
    (platform) => {
      const capabilities = getLocalComputerUseCapabilities(
        platform,
        () => {
          throw new Error("non-macOS capability checks must not probe macOS executables");
        },
        () => {
          throw new Error("non-macOS capability checks must not probe Screen Recording permission");
        },
      );

      expect(capabilities).toMatchObject({
        platform,
        overallState: "blocked_by_capability",
        screenshot: { state: "blocked_by_capability", available: false, command: null },
        videoRecording: { state: "blocked_by_capability", available: false, command: null },
        appLaunch: { state: "blocked_by_capability", available: false, command: null },
        guiInteraction: { state: "blocked_by_capability", available: false, command: null },
      });
      expect(capabilities.screenshot.detail).toContain("Electron Control and proof-file ingestion remain available");
    },
  );

  it("preserves native macOS capability detection when Screen Recording is granted", () => {
    const capabilities = getLocalComputerUseCapabilities("darwin", () => true, () => true);

    expect(capabilities.platform).toBe("darwin");
    expect(capabilities.overallState).toBe("present");
    expect(capabilities.screenshot).toMatchObject({
      state: "present",
      available: true,
      command: "screencapture",
    });
    expect(capabilities.guiInteraction.available).toBe(true);
    expect(capabilities.proofRequirements.console_logs.available).toBe(true);
  });

  it("reports screenshot and video as missing when Screen Recording permission is denied", () => {
    const capabilities = getLocalComputerUseCapabilities("darwin", () => true, () => false);

    expect(capabilities.screenshot).toMatchObject({ state: "missing", available: false, command: "screencapture" });
    expect(capabilities.videoRecording).toMatchObject({ state: "missing", available: false, command: "screencapture" });
    expect(capabilities.overallState).not.toBe("present");
    for (const detail of [capabilities.screenshot.detail, capabilities.videoRecording.detail]) {
      expect(detail).toContain("Screen Recording");
      expect(detail).toContain("System Settings > Privacy & Security > Screen Recording");
    }
    // Capabilities that do not read the display stay untouched.
    expect(capabilities.appLaunch.available).toBe(true);
    expect(capabilities.guiInteraction.available).toBe(true);
    expect(capabilities.environmentInfo.available).toBe(true);
    expect(capabilities.proofRequirements.screenshot.available).toBe(false);
    expect(capabilities.proofRequirements.video_recording.available).toBe(false);
  });

  it("does not probe Screen Recording permission when the screencapture binary is absent", () => {
    const capabilities = getLocalComputerUseCapabilities("darwin", (command) => command !== "screencapture", () => {
      throw new Error("permission must not be probed without the screencapture binary");
    });

    expect(capabilities.screenshot).toMatchObject({ state: "missing", available: false });
    expect(capabilities.screenshot.detail).toContain("macOS screencapture is required");
    expect(capabilities.overallState).toBe("missing");
  });

  it("probes the Screen Recording permission once per process", () => {
    let probes = 0;
    __setScreenCapturePermissionProbeForTests(() => {
      probes += 1;
      return true;
    });
    try {
      for (let i = 0; i < 5; i++) {
        expect(getLocalComputerUseCapabilities("darwin", () => true).screenshot.available).toBe(true);
      }
      expect(probes).toBe(1);
    } finally {
      __setScreenCapturePermissionProbeForTests(null);
    }
  });
});
