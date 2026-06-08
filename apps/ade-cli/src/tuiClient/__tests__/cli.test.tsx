import { beforeEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.hoisted(() =>
  vi.fn(() => ({
    waitUntilExit: vi.fn(async () => undefined),
  })),
);

const detectProjectLaunchContextMock = vi.hoisted(() =>
  vi.fn(() => ({
    projectRoot: "/repo",
    workspaceRoot: "/repo",
    laneHint: null,
  })),
);

vi.mock("ink", () => ({
  render: renderMock,
}));

vi.mock("../app", () => ({
  AdeCodeApp: () => null,
}));

vi.mock("../project", () => ({
  detectProjectLaunchContext: detectProjectLaunchContextMock,
}));

import { parseArgs, runAdeCodeCli } from "../cli";

describe("ade code CLI entrypoint", () => {
  beforeEach(() => {
    renderMock.mockClear();
    detectProjectLaunchContextMock.mockClear();
  });

  it("rejects unknown flags and missing flag values", () => {
    expect(() => parseArgs(["--socket", "--print-state"])).toThrow(
      "--socket requires a value.",
    );
    expect(() => parseArgs(["--bogus"])).toThrow(
      "Unknown ade code option: --bogus",
    );
  });

  it("accepts packaged service-repair opt-in", () => {
    expect(parseArgs(["--prefer-service-repair"]).preferServiceRepair).toBe(true);
  });

  it("passes Ctrl+C handling through to ADE Code instead of Ink", async () => {
    await expect(runAdeCodeCli(["--embedded"])).resolves.toBe(0);

    expect(renderMock).toHaveBeenCalledWith(
      expect.anything(),
      { exitOnCtrlC: false },
    );
  });
});
