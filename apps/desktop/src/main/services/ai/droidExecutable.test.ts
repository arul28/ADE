import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  resolveExecutableCandidatesFromKnownLocations: vi.fn(),
  platform: "linux" as NodeJS.Platform,
}));

vi.mock("./cliExecutableResolver", () => ({
  resolveExecutableCandidatesFromKnownLocations: (...args: unknown[]) =>
    mockState.resolveExecutableCandidatesFromKnownLocations(...args),
}));

vi.mock("../shared/processExecution", async () => {
  const actual = await vi.importActual<typeof import("../shared/processExecution")>(
    "../shared/processExecution",
  );
  return {
    ...actual,
    // `preferNativeExecutablePath` reads `process.platform` by default; pin it
    // so the win32 preference is exercised on every host.
    preferNativeExecutablePath: (candidates: readonly string[]) =>
      actual.preferNativeExecutablePath(candidates, mockState.platform),
  };
});

import { resolveDroidExecutable } from "./droidExecutable";

describe("resolveDroidExecutable", () => {
  it("prefers DROID_EXECUTABLE env over auth detection and PATH lookup", () => {
    mockState.resolveExecutableCandidatesFromKnownLocations.mockReset();
    mockState.resolveExecutableCandidatesFromKnownLocations.mockReturnValue([]);
    mockState.platform = "linux";

    expect(
      resolveDroidExecutable({
        auth: [
          {
            type: "cli-subscription",
            cli: "droid",
            path: "/Users/arul/.local/bin/droid",
            authenticated: true,
            verified: true,
          },
        ],
        env: {
          DROID_EXECUTABLE: "/opt/droid/bin/droid",
          PATH: "/usr/bin:/bin",
        },
      }),
    ).toEqual({ path: "/opt/droid/bin/droid", source: "path" });
    expect(mockState.resolveExecutableCandidatesFromKnownLocations).not.toHaveBeenCalled();
  });

  it("falls back to detected auth path before PATH lookup when no env override is set", () => {
    mockState.resolveExecutableCandidatesFromKnownLocations.mockReset();
    mockState.resolveExecutableCandidatesFromKnownLocations.mockReturnValue([]);
    mockState.platform = "linux";

    expect(
      resolveDroidExecutable({
        auth: [
          {
            type: "cli-subscription",
            cli: "droid",
            path: "/Users/arul/.local/bin/droid",
            authenticated: true,
            verified: true,
          },
        ],
        env: { PATH: "/usr/bin:/bin" },
      }),
    ).toEqual({ path: "/Users/arul/.local/bin/droid", source: "auth" });
    expect(mockState.resolveExecutableCandidatesFromKnownLocations).not.toHaveBeenCalled();
  });

  it("returns the bare 'droid' command as a fallback when no resolution succeeds", () => {
    mockState.resolveExecutableCandidatesFromKnownLocations.mockReset();
    mockState.resolveExecutableCandidatesFromKnownLocations.mockReturnValue([]);
    mockState.platform = "linux";

    expect(resolveDroidExecutable({ env: { PATH: "/usr/bin:/bin" } })).toEqual({
      path: "droid",
      source: "fallback-command",
    });
    expect(mockState.resolveExecutableCandidatesFromKnownLocations).toHaveBeenCalledWith(
      "droid",
      expect.objectContaining({ PATH: "/usr/bin:/bin" }),
    );
  });

  // The Droid chat SDK spawns this path with no shell, and Node has refused
  // bare `.cmd` spawns since CVE-2024-27980 (`EINVAL`, errno -4071).
  it("prefers a real droid.exe over an npm shim that PATH happens to hit first", () => {
    mockState.resolveExecutableCandidatesFromKnownLocations.mockReset();
    mockState.platform = "win32";
    mockState.resolveExecutableCandidatesFromKnownLocations.mockReturnValue([
      { path: "C:\\Users\\me\\AppData\\Roaming\\npm\\droid.cmd", source: "path" },
      { path: "C:\\Users\\me\\bin\\droid.exe", source: "known-dir" },
    ]);

    expect(resolveDroidExecutable({ env: {} })).toEqual({
      path: "C:\\Users\\me\\bin\\droid.exe",
      source: "common-dir",
    });
  });

  it("still resolves a shim-only Windows install", () => {
    mockState.resolveExecutableCandidatesFromKnownLocations.mockReset();
    mockState.platform = "win32";
    mockState.resolveExecutableCandidatesFromKnownLocations.mockReturnValue([
      { path: "C:\\Users\\me\\AppData\\Roaming\\npm\\droid.cmd", source: "path" },
    ]);

    expect(resolveDroidExecutable({ env: {} })).toEqual({
      path: "C:\\Users\\me\\AppData\\Roaming\\npm\\droid.cmd",
      source: "path",
    });
  });

  it("keeps POSIX candidate precedence", () => {
    mockState.resolveExecutableCandidatesFromKnownLocations.mockReset();
    mockState.platform = "darwin";
    mockState.resolveExecutableCandidatesFromKnownLocations.mockReturnValue([
      { path: "/opt/homebrew/bin/droid", source: "path" },
      { path: "/Users/me/.local/bin/droid", source: "known-dir" },
    ]);

    expect(resolveDroidExecutable({ env: {} })).toEqual({
      path: "/opt/homebrew/bin/droid",
      source: "path",
    });
  });
});
