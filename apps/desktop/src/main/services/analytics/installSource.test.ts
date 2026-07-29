import { describe, expect, it } from "vitest";
import { detectInstallSource } from "./installSource";

describe("detectInstallSource", () => {
  it("separates development, explicit distribution, Homebrew, and unknown installs", () => {
    expect(detectInstallSource({
      isPackaged: false,
      execPath: "/tmp/ADE",
    })).toBe("development");
    expect(detectInstallSource({
      isPackaged: true,
      execPath: "/private/tmp/ADE",
      configuredSource: "direct_download",
    })).toBe("direct_download");
    expect(detectInstallSource({
      isPackaged: true,
      execPath: "/Applications/ADE.app/Contents/MacOS/ADE",
      realpath: () => "/opt/homebrew/Caskroom/ade/1.2.3/ADE.app/Contents/MacOS/ADE",
    })).toBe("homebrew");
    expect(detectInstallSource({
      isPackaged: true,
      execPath: "/private/tmp/ADE.app/Contents/MacOS/ADE",
      homebrewPrefix: "/opt/homebrew",
      exists: (candidate) => candidate === "/opt/homebrew/Caskroom/ade",
    })).toBe("homebrew");
    expect(detectInstallSource({
      isPackaged: true,
      execPath: "/private/tmp/ADE.app/Contents/MacOS/ADE",
      exists: () => false,
    })).toBe("unknown");
  });
});
