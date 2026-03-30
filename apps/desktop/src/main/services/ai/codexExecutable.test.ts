import { describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  resolveExecutableFromKnownLocations: vi.fn(),
}));

vi.mock("./cliExecutableResolver", () => ({
  resolveExecutableFromKnownLocations: (...args: unknown[]) => mockState.resolveExecutableFromKnownLocations(...args),
}));

import { resolveCodexExecutable } from "./codexExecutable";

describe("resolveCodexExecutable", () => {
  it("uses the detected Codex auth path before falling back to PATH lookup", () => {
    mockState.resolveExecutableFromKnownLocations.mockReset();

    expect(
      resolveCodexExecutable({
        auth: [
          {
            type: "cli-subscription",
            cli: "codex",
            path: "/Users/arul/.npm-global/bin/codex",
            authenticated: true,
            verified: true,
          },
        ],
        env: {
          PATH: "/usr/bin:/bin",
        },
      }),
    ).toEqual({
      path: "/Users/arul/.npm-global/bin/codex",
      source: "auth",
    });
    expect(mockState.resolveExecutableFromKnownLocations).not.toHaveBeenCalled();
  });

  it("honors CODEX_EXECUTABLE before PATH lookup", () => {
    mockState.resolveExecutableFromKnownLocations.mockReset();

    expect(
      resolveCodexExecutable({
        env: {
          CODEX_EXECUTABLE: "/opt/codex/bin/codex",
          PATH: "/usr/bin:/bin",
        },
      }),
    ).toEqual({
      path: "/opt/codex/bin/codex",
      source: "path",
    });
    expect(mockState.resolveExecutableFromKnownLocations).not.toHaveBeenCalled();
  });
});
