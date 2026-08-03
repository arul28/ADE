import { describe, expect, it } from "vitest";

import {
  CURSOR_SDK_UNSUPPORTED_PLATFORM_CODE,
  assertCursorSdkSupportedOnThisPlatform,
  isCursorSdkResolutionError,
  loadCursorSdk,
} from "./cursorSdkLoader";

// Platform/arch are passed explicitly, so these assertions hold on every runner
// and this file is not a platform-gated test.
describe("assertCursorSdkSupportedOnThisPlatform", () => {
  it("rejects win32-arm64 with a message naming the missing @cursor/sdk build", () => {
    let thrown: unknown;
    try {
      assertCursorSdkSupportedOnThisPlatform("win32", "arm64");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/win32-arm64/);
    expect((thrown as Error).message).toMatch(/@cursor\/sdk/);
    expect((thrown as { code?: string }).code).toBe(CURSOR_SDK_UNSUPPORTED_PLATFORM_CODE);
  });

  it("allows win32-x64, darwin and linux on every architecture", () => {
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
    ] as const) {
      expect(
        () => assertCursorSdkSupportedOnThisPlatform(platform, arch),
        `${platform}-${arch}`,
      ).not.toThrow();
    }
  });
});

describe("isCursorSdkResolutionError", () => {
  it("treats the unsupported-platform failure like an unusable SDK module", () => {
    // Callers such as cursorModelsDiscovery drop cached rows and refuse to fall
    // back to network discovery when this returns true — which is exactly right
    // on a platform where no chat could ever run.
    const error = Object.assign(new Error("unsupported"), {
      code: CURSOR_SDK_UNSUPPORTED_PLATFORM_CODE,
    });
    expect(isCursorSdkResolutionError(error)).toBe(true);
  });

  it("still recognizes genuine module-resolution failures", () => {
    expect(isCursorSdkResolutionError(
      Object.assign(new Error("nope"), { code: "ERR_MODULE_NOT_FOUND" }),
    )).toBe(true);
    expect(isCursorSdkResolutionError(new Error("Cannot find package '@cursor/sdk'"))).toBe(true);
    expect(isCursorSdkResolutionError(new Error("socket hang up"))).toBe(false);
  });
});

describe("loadCursorSdk", () => {
  it("fails with the explained blocker on win32-arm64 instead of an opaque import error", async () => {
    // The realistic case: settings restored from an x64 machine still name
    // Cursor, so something reaches the SDK even though no picker offers it.
    const prevPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const prevArch = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
    try {
      await expect(loadCursorSdk()).rejects.toThrow(/win32-arm64/);
    } finally {
      Object.defineProperty(process, "platform", prevPlatform);
      Object.defineProperty(process, "arch", prevArch);
    }
  });
});
