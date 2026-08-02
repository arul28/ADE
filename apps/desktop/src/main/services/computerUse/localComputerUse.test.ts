import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createComputerUseArtifactPath, getLocalComputerUseCapabilities } from "./localComputerUse";

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
    "blocks native OS control on %s without disabling App Control or proof ingestion",
    (platform) => {
      const capabilities = getLocalComputerUseCapabilities(platform, () => {
        throw new Error("non-macOS capability checks must not probe macOS executables");
      });

      expect(capabilities).toMatchObject({
        platform,
        overallState: "blocked_by_capability",
        screenshot: { state: "blocked_by_capability", available: false, command: null },
        videoRecording: { state: "blocked_by_capability", available: false, command: null },
        appLaunch: { state: "blocked_by_capability", available: false, command: null },
        guiInteraction: { state: "blocked_by_capability", available: false, command: null },
      });
      expect(capabilities.screenshot.detail).toContain("App Control and proof-file ingestion remain available");
    },
  );

  it("preserves native macOS capability detection", () => {
    const capabilities = getLocalComputerUseCapabilities("darwin", () => true);

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
});
