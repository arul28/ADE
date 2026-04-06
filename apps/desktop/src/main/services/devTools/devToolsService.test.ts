import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logging/logger";
import type * as SharedUtilsModule from "../shared/utils";

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
  const actual = await vi.importActual<typeof SharedUtilsModule>("../shared/utils");
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

  it("detects git from known install locations and reads version via the resolved path", async () => {
    resolveExecutableFromKnownLocationsMock.mockImplementation((command: string) => {
      if (command === "git") return { path: "/usr/bin/git", source: "path" };
      return null;
    });
    spawnAsyncMock.mockImplementation(async () => ({
      status: 0,
      stdout: "git version 2.50.1\n",
      stderr: "",
    }));

    const service = createDevToolsService({ logger: createLogger() });
    const result = await service.detect(true);
    const git = result.tools.find((tool) => tool.id === "git");

    expect(git).toMatchObject({
      installed: true,
      detectedPath: "/usr/bin/git",
      detectedVersion: "git version 2.50.1",
    });
    expect(spawnAsyncMock).toHaveBeenCalledWith("/usr/bin/git", ["--version"]);
  });

  it("only checks for git (no gh)", async () => {
    resolveExecutableFromKnownLocationsMock.mockReturnValue(null);
    whichCommandMock.mockResolvedValue(null);

    const service = createDevToolsService({ logger: createLogger() });
    const result = await service.detect(true);

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].id).toBe("git");
  });
});
