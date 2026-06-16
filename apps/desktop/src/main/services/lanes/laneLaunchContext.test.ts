import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  statSync: vi.fn(),
  realpathSync: vi.fn(),
  resolvePathWithinRoot: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    statSync: mocks.statSync,
    realpathSync: mocks.realpathSync,
  },
  statSync: mocks.statSync,
  realpathSync: mocks.realpathSync,
}));

vi.mock("../shared/utils", () => ({
  resolvePathWithinRoot: mocks.resolvePathWithinRoot,
}));

import { resolveLaneLaunchContext } from "./laneLaunchContext";

function makeLaneService(worktreePath: string) {
  return {
    getLaneBaseAndBranch: vi.fn(() => ({
      baseRef: "main",
      branchRef: "feature/test",
      worktreePath,
      laneType: "standard" as const,
    })),
  } as unknown as Parameters<typeof resolveLaneLaunchContext>[0]["laneService"];
}

function setupDirectoryExists(realPath: string) {
  mocks.statSync.mockReturnValue({ isDirectory: () => true });
  mocks.realpathSync.mockReturnValue(realPath);
}

describe("resolveLaneLaunchContext", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns lane root as the launch cwd when no custom cwd is requested", () => {
    setupDirectoryExists("/real/lane/root");

    const result = resolveLaneLaunchContext({
      laneService: makeLaneService("/projects/my-lane"),
      laneId: "lane-1",
      purpose: "start agent",
    });

    expect(result).toEqual({
      laneWorktreePath: "/real/lane/root",
      cwd: "/real/lane/root",
      execStrategy: "local",
    });
  });

  it("resolves relative cwd within the lane root", () => {
    mocks.statSync.mockReturnValue({ isDirectory: () => true });
    mocks.realpathSync
      .mockReturnValueOnce("/real/lane/root")
      .mockReturnValueOnce("/real/lane/root/src");
    mocks.resolvePathWithinRoot.mockReturnValue("/real/lane/root/src");

    const result = resolveLaneLaunchContext({
      laneService: makeLaneService("/projects/my-lane"),
      laneId: "lane-1",
      requestedCwd: "src",
      purpose: "start agent",
    });

    expect(result).toEqual({
      laneWorktreePath: "/real/lane/root",
      cwd: "/real/lane/root/src",
      execStrategy: "local",
    });
    expect(mocks.resolvePathWithinRoot).toHaveBeenCalledWith(
      "/real/lane/root",
      "/real/lane/root/src",
    );
  });

  it("allows an external absolute cwd when the caller opts in", () => {
    mocks.statSync.mockReturnValue({ isDirectory: () => true });
    mocks.realpathSync
      .mockReturnValueOnce("/real/lane/root")
      .mockReturnValueOnce("/real/project/root");

    const result = resolveLaneLaunchContext({
      laneService: makeLaneService("/projects/my-lane"),
      laneId: "lane-1",
      requestedCwd: "/real/project/root",
      allowExternalCwd: true,
      purpose: "start agent",
    });

    expect(result).toEqual({
      laneWorktreePath: "/real/lane/root",
      cwd: "/real/project/root",
      execStrategy: "local",
    });
    expect(mocks.resolvePathWithinRoot).not.toHaveBeenCalled();
  });

  it("throws when the lane has no configured worktree", () => {
    expect(() =>
      resolveLaneLaunchContext({
        laneService: makeLaneService(""),
        laneId: "lane-orphan",
        purpose: "launch terminal",
      }),
    ).toThrow("Lane 'lane-orphan' has no worktree configured");
  });

  it("throws when the lane worktree is unavailable", () => {
    mocks.statSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(() =>
      resolveLaneLaunchContext({
        laneService: makeLaneService("/gone/lane"),
        laneId: "lane-gone",
        purpose: "deploy",
      }),
    ).toThrow("worktree is unavailable");
  });

  it("throws when requested cwd escapes the lane root", () => {
    setupDirectoryExists("/real/lane/root");
    mocks.resolvePathWithinRoot.mockImplementation(() => {
      throw new Error("Path escapes root");
    });

    expect(() =>
      resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane"),
        laneId: "lane-1",
        requestedCwd: "../../etc/passwd",
        purpose: "start agent",
      }),
    ).toThrow("escapes lane 'lane-1'");
  });
});
