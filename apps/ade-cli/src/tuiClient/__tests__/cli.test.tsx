import { beforeEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.hoisted(() =>
  vi.fn(() => ({
    waitUntilExit: vi.fn(async () => undefined),
  })),
);

const detectProjectLaunchContextMock = vi.hoisted(() =>
  vi.fn(() => ({
    launchCwd: "/repo",
    projectRoot: "/repo",
    workspaceRoot: "/repo",
    laneHint: null,
    sessionHint: null,
    remote: false,
    remoteLabel: null,
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

  it("accepts remote launch context flags", () => {
    expect(parseArgs([
      "--remote",
      "--project-root",
      "/remote/project",
      "--workspace-root",
      "/remote/project",
      "--lane",
      "lane-1",
      "--session",
      "session-1",
      "--remote-label",
      "Mac Studio",
      "--socket",
      "tcp://127.0.0.1:43333",
      "--require-socket",
    ])).toMatchObject({
      remote: true,
      projectRoot: "/remote/project",
      workspaceRoot: "/remote/project",
      laneHint: "lane-1",
      sessionHint: "session-1",
      remoteLabel: "Mac Studio",
      socketPath: "tcp://127.0.0.1:43333",
      requireSocket: true,
    });
  });

  it("passes Ctrl+C handling through to ADE Code instead of Ink", async () => {
    await expect(runAdeCodeCli(["--embedded"])).resolves.toBe(0);

    expect(renderMock).toHaveBeenCalledWith(
      expect.anything(),
      { exitOnCtrlC: false },
    );
  });
});
