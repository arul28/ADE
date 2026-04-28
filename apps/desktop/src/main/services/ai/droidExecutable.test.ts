import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  resolveExecutableFromKnownLocations: vi.fn(),
}));

vi.mock("./cliExecutableResolver", () => ({
  resolveExecutableFromKnownLocations: (...args: unknown[]) =>
    mockState.resolveExecutableFromKnownLocations(...args),
}));

import { resolveDroidExecutable } from "./droidExecutable";

describe("resolveDroidExecutable", () => {
  it("prefers DROID_EXECUTABLE env over auth detection and PATH lookup", () => {
    mockState.resolveExecutableFromKnownLocations.mockReset();

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
    expect(mockState.resolveExecutableFromKnownLocations).not.toHaveBeenCalled();
  });

  it("falls back to detected auth path before PATH lookup when no env override is set", () => {
    mockState.resolveExecutableFromKnownLocations.mockReset();

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
    expect(mockState.resolveExecutableFromKnownLocations).not.toHaveBeenCalled();
  });

  it("returns the bare 'droid' command as a fallback when no resolution succeeds", () => {
    mockState.resolveExecutableFromKnownLocations.mockReset();
    mockState.resolveExecutableFromKnownLocations.mockReturnValue(null);

    expect(resolveDroidExecutable({ env: { PATH: "/usr/bin:/bin" } })).toEqual({
      path: "droid",
      source: "fallback-command",
    });
    expect(mockState.resolveExecutableFromKnownLocations).toHaveBeenCalledWith(
      "droid",
      expect.objectContaining({ PATH: "/usr/bin:/bin" }),
    );
  });
});
