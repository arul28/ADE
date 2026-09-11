import { describe, expect, it } from "vitest";
import {
  isMacPlatform,
  isMacRuntimeTarget,
  rendererPlatformAttribute,
  supportsIosSimulatorPlatform,
  supportsNativeNotchPlatform,
} from "./platform";

describe("renderer platform helpers", () => {
  it("recognizes macOS platform spellings", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("darwin")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
  });

  it("maps renderer platform values to stable CSS attributes", () => {
    expect(rendererPlatformAttribute("MacIntel")).toBe("darwin");
    expect(rendererPlatformAttribute("Win32")).toBe("win32");
    expect(rendererPlatformAttribute("Linux x86_64")).toBe("linux");
    expect(rendererPlatformAttribute("browser")).toBe("unknown");
  });

  it("only enables the native Notch surface on macOS", () => {
    expect(supportsNativeNotchPlatform("MacIntel")).toBe(true);
    expect(supportsNativeNotchPlatform("Win32")).toBe(false);
    expect(supportsNativeNotchPlatform("Linux x86_64")).toBe(false);
  });

  it("limits the iOS simulator capability to macOS", () => {
    expect(supportsIosSimulatorPlatform("MacIntel")).toBe(true);
    expect(supportsIosSimulatorPlatform("Win32")).toBe(false);
    expect(supportsIosSimulatorPlatform("Linux x86_64")).toBe(false);
  });
});

/**
 * Windows-copy parity. Strings like "Sign in on this Mac" and the ⌘ glyphs on
 * the browser toolbar used to be hardcoded, which read as nonsense on a Windows
 * install and in the hosted web client. The fix routes that copy through
 * `isMacRuntimeTarget`, whose whole reason to exist is that it reads the HOST's
 * `process.platform` from the preload bridge instead of the renderer's user
 * agent — the two disagree exactly where the bug showed up (a Chromium renderer
 * reporting "MacIntel" while the host is win32, and the browser-mock path).
 */
describe("isMacRuntimeTarget", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");

  function withBridge(platform: string | undefined): void {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { ade: { app: { runtimeTarget: platform ? { platform, arch: "x64" } : undefined } } },
    });
  }

  it("follows the host the bridge reports, not the renderer's user agent", () => {
    try {
      withBridge("win32");
      expect(isMacRuntimeTarget()).toBe(false);
      // Same renderer, same navigator.platform — only the host changed.
      withBridge("darwin");
      expect(isMacRuntimeTarget()).toBe(true);
      withBridge("linux");
      expect(isMacRuntimeTarget()).toBe(false);
      // No bridge at all (browser mock / hosted web) falls back to the UA
      // rather than throwing, so the copy still renders.
      withBridge(undefined);
      expect(isMacRuntimeTarget()).toBe(rendererPlatformAttribute() === "darwin");
    } finally {
      if (original) Object.defineProperty(globalThis, "window", original);
      else delete (globalThis as { window?: unknown }).window;
    }
  });
});
