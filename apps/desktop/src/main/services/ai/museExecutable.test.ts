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

  it.each([
    ["stays silent when the pinned build is present", resolution({ path: "/opt/ade/muse" }), null],
    ["names the unsupported host", resolution({ source: "unsupported" }), "ADE has no pinned Muse build for this platform."],
    ["points at the download when the fetch is pending", resolution({ pinnedVersion: "1.4.7-R6101.1", fetchPending: true }), "ADE's pinned Muse build (1.4.7-R6101.1) is not downloaded yet. Download it from Settings > Providers."],
    ["reports an unavailable build without a download offer", resolution({ pinnedVersion: "1.4.7-R6101.1" }), "ADE's pinned Muse build (1.4.7-R6101.1) is not available."],
  ])("%s", (_label, value, expected) => {
    expect(museBinaryBlocker(value)).toBe(expected);
  });
});
