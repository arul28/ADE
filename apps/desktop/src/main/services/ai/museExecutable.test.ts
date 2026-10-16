import { describe, expect, it } from "vitest";
import type { MuseExecutableResolution } from "../../../../../ade-cli/src/services/tools/muse";
import { museBinaryBlocker, museProviderOverride } from "./museExecutable";

const DEV = { ADE_DEV_RUNTIME_SOCKET_PATH: "/tmp/dev.sock" };

describe("museProviderOverride", () => {
  it.each([
    ["a packaged run ignores the override entirely", { ADE_MUSE_PROVIDER: "echo" }, null],
    ["a dev run honors the trimmed override", { ...DEV, ADE_MUSE_PROVIDER: "  echo  " }, "echo"],
    ["a dev run with no override keeps Muse's own default", DEV, null],
    ["a dev run with a blank override keeps Muse's own default", { ...DEV, ADE_MUSE_PROVIDER: "   " }, null],
  ])("%s", (_label, env, expected) => {
    expect(museProviderOverride(env)).toBe(expected);
  });
});

describe("museBinaryBlocker", () => {
  function resolution(overrides: Partial<MuseExecutableResolution>): MuseExecutableResolution {
    return { path: null, source: "tools-cache", pinnedVersion: null, fetchPending: false, ...overrides };
  }

  it("stays silent when the pinned build is present", () => {
    expect(museBinaryBlocker(resolution({ path: "/opt/ade/muse" }))).toBeNull();
  });

  it.each([
    ["an unsupported host", resolution({ source: "unsupported" }), false],
    ["a pending fetch", resolution({ pinnedVersion: "1.4.7-R6101.1", fetchPending: true }), true],
    ["an unavailable build", resolution({ pinnedVersion: "1.4.7-R6101.1" }), false],
  ])("blocks %s and offers a download only while one can start", (_label, value, offersDownload) => {
    const blocker = museBinaryBlocker(value);
    expect(blocker).toBeTruthy();
    if (value.pinnedVersion) expect(blocker).toContain(value.pinnedVersion);
    expect(/download it/i.test(blocker ?? "")).toBe(offersDownload);
  });
});
