import { describe, expect, it } from "vitest";
import {
  isMacPlatform,
  rendererPlatformAttribute,
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
});
