import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";

const {
  spawnAsyncMock,
  whichCommandMock,
  resolveExecutableFromKnownLocationsMock,
} = vi.hoisted(() => ({
  spawnAsyncMock: vi.fn(),
  whichCommandMock: vi.fn(),
  resolveExecutableFromKnownLocationsMock: vi.fn(),
}));

vi.mock("../shared/utils", async () => {
  const actual = await vi.importActual<typeof import("../shared/utils")>("../shared/utils");
  return {
    ...actual,
    spawnAsync: spawnAsyncMock,
    whichCommand: whichCommandMock,
  };
});

vi.mock("../ai/cliExecutableResolver", () => ({
  resolveExecutableFromKnownLocations: resolveExecutableFromKnownLocationsMock,
}));

import { createDevToolsService } from "./devToolsService";

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("devToolsService", () => {
  beforeEach(() => {
    spawnAsyncMock.mockReset();
    whichCommandMock.mockReset();
    resolveExecutableFromKnownLocationsMock.mockReset();
  });

  it("detects GitHub CLI from known install locations and reads version via the resolved path", async () => {
    resolveExecutableFromKnownLocationsMock.mockImplementation((command: string) => {
      if (command === "git") return { path: "/usr/bin/git", source: "path" };
      if (command === "gh") return { path: "/opt/homebrew/bin/gh", source: "known-dir" };
      return null;
    });
    spawnAsyncMock.mockImplementation(async (command: string) => ({
      status: 0,
      stdout: `${command} version 1.0.0\n`,
      stderr: "",
    }));

    const service = createDevToolsService({ logger: createLogger() });
    const result = await service.detect(true);
    const gh = result.tools.find((tool) => tool.id === "gh");

    expect(gh).toMatchObject({
      installed: true,
      detectedPath: "/opt/homebrew/bin/gh",
      detectedVersion: "/opt/homebrew/bin/gh version 1.0.0",
    });
    expect(spawnAsyncMock).toHaveBeenCalledWith("/opt/homebrew/bin/gh", ["--version"]);
    expect(whichCommandMock).not.toHaveBeenCalledWith("gh");
  });
});
