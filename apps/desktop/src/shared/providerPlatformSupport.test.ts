import { describe, expect, it } from "vitest";

import {
  CURSOR_WINDOWS_ARM_BLOCKER,
  isCursorProviderSupported,
  providerUnavailableReason,
} from "./providerPlatformSupport";

// Platform/arch are passed as literals, so this file asserts the same thing on
// every runner — it is not a platform-gated test and needs no gate annotation.
describe("isCursorProviderSupported", () => {
  it("hides Cursor only on win32-arm64, where @cursor/sdk has no build", () => {
    expect(isCursorProviderSupported("win32", "arm64")).toBe(false);
  });

  it("leaves Windows x64 untouched", () => {
    expect(isCursorProviderSupported("win32", "x64")).toBe(true);
    expect(isCursorProviderSupported("win32", "ia32")).toBe(true);
  });

  it("leaves macOS untouched on both architectures", () => {
    expect(isCursorProviderSupported("darwin", "arm64")).toBe(true);
    expect(isCursorProviderSupported("darwin", "x64")).toBe(true);
  });

  it("leaves Linux untouched, including arm64", () => {
    expect(isCursorProviderSupported("linux", "arm64")).toBe(true);
    expect(isCursorProviderSupported("linux", "x64")).toBe(true);
  });

  it("names the reason so the gate can be revisited when Cursor ships a build", () => {
    expect(CURSOR_WINDOWS_ARM_BLOCKER).toMatch(/win32-arm64/);
    expect(CURSOR_WINDOWS_ARM_BLOCKER).toMatch(/@cursor\/sdk/);
  });
});

describe("providerUnavailableReason", () => {
  it("reports Cursor's own reason on win32-arm64", () => {
    expect(providerUnavailableReason("cursor", "win32", "arm64")).toBe(CURSOR_WINDOWS_ARM_BLOCKER);
  });

  it("reports no reason for a provider that is not gated", () => {
    // The reason travels with the gate. A caller that gated on a boolean and
    // then named CURSOR_WINDOWS_ARM_BLOCKER itself would hand Cursor's sentence
    // to the second provider ever gated.
    for (const provider of ["claude", "codex", "droid", "opencode", "pi"]) {
      expect(providerUnavailableReason(provider, "win32", "arm64")).toBeNull();
    }
    expect(providerUnavailableReason("cursor", "darwin", "arm64")).toBeNull();
  });
});
