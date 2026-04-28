import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Import the module under test AFTER mocks are set up
// ---------------------------------------------------------------------------

import { resolveLaneLaunchContext } from "./laneLaunchContext";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveLaneLaunchContext", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("happy path: no custom cwd", () => {
    it("returns lane root as both laneWorktreePath and cwd", () => {
      setupDirectoryExists("/real/lane/root");

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane"),
        laneId: "lane-1",
        purpose: "start agent",
      });

      expect(result).toEqual({
        laneWorktreePath: "/real/lane/root",
        cwd: "/real/lane/root",
      });
    });

    it("treats null requestedCwd the same as no cwd", () => {
      setupDirectoryExists("/real/lane/root");

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane"),
        laneId: "lane-1",
        requestedCwd: null,
        purpose: "start agent",
      });

      expect(result).toEqual({
        laneWorktreePath: "/real/lane/root",
        cwd: "/real/lane/root",
      });
    });

    it("treats empty-string requestedCwd the same as no cwd", () => {
      setupDirectoryExists("/real/lane/root");

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane"),
        laneId: "lane-1",
        requestedCwd: "  ",
        purpose: "start agent",
      });

      expect(result).toEqual({
        laneWorktreePath: "/real/lane/root",
        cwd: "/real/lane/root",
      });
    });
  });

  describe("happy path: valid relative cwd inside worktree", () => {
    it("resolves relative cwd within lane root", () => {
      mocks.statSync.mockReturnValue({ isDirectory: () => true });
      mocks.realpathSync
        .mockReturnValueOnce("/real/lane/root")       // first ensureDirectoryExists (lane root)
        .mockReturnValueOnce("/real/lane/root/src");   // second ensureDirectoryExists (cwd)
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
      });
      expect(mocks.resolvePathWithinRoot).toHaveBeenCalledOnce();
    });
  });

  describe("happy path: valid absolute cwd inside worktree", () => {
    it("resolves absolute cwd within lane root", () => {
      mocks.statSync.mockReturnValue({ isDirectory: () => true });
      mocks.realpathSync
        .mockReturnValueOnce("/real/lane/root")                // first ensureDirectoryExists (lane root)
        .mockReturnValueOnce("/real/lane/root/packages/core"); // second ensureDirectoryExists (cwd)
      mocks.resolvePathWithinRoot.mockReturnValue("/real/lane/root/packages/core");

      const result = resolveLaneLaunchContext({
        laneService: makeLaneService("/projects/my-lane"),
        laneId: "lane-1",
        requestedCwd: "/real/lane/root/packages/core",
        purpose: "start agent",
      });

      expect(result).toEqual({
        laneWorktreePath: "/real/lane/root",
        cwd: "/real/lane/root/packages/core",
      });
      expect(mocks.resolvePathWithinRoot).toHaveBeenCalledWith(
        "/real/lane/root",
        "/real/lane/root/packages/core",
      );
    });
  });

  describe("happy path: explicit absolute cwd outside worktree", () => {
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
      });
      expect(mocks.resolvePathWithinRoot).not.toHaveBeenCalled();
    });
  });

  describe("error: lane has no worktree configured", () => {
    it("throws when worktreePath is empty string", () => {
      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService(""),
          laneId: "lane-orphan",
          purpose: "launch terminal",
        }),
      ).toThrow("Lane 'lane-orphan' has no worktree configured");
    });

    it("throws when worktreePath is whitespace-only", () => {
      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("   "),
          laneId: "lane-ws",
          purpose: "launch terminal",
        }),
      ).toThrow("Lane 'lane-ws' has no worktree configured");
    });

    it("includes the purpose in the error message", () => {
      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService(""),
          laneId: "lane-1",
          purpose: "run tests",
        }),
      ).toThrow("ADE cannot run tests outside the selected lane");
    });
  });

  describe("error: lane worktree directory doesn't exist", () => {
    it("throws when statSync fails (directory missing)", () => {
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

    it("throws when path is not a directory", () => {
      mocks.statSync.mockReturnValue({ isDirectory: () => false });

      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/some/file.txt"),
          laneId: "lane-file",
          purpose: "build",
        }),
      ).toThrow("worktree is unavailable");
    });

    it("throws when realpathSync fails after stat succeeds", () => {
      mocks.statSync.mockReturnValue({ isDirectory: () => true });
      mocks.realpathSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/broken/symlink"),
          laneId: "lane-broken",
          purpose: "launch agent",
        }),
      ).toThrow("worktree is unavailable");
    });
  });

  describe("error: requested cwd escapes lane root (path traversal)", () => {
    it("throws with descriptive message when resolvePathWithinRoot detects traversal", () => {
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

    it("re-throws non-traversal errors from resolvePathWithinRoot", () => {
      setupDirectoryExists("/real/lane/root");
      mocks.resolvePathWithinRoot.mockImplementation(() => {
        throw new Error("Permission denied");
      });

      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/projects/my-lane"),
          laneId: "lane-1",
          requestedCwd: "src",
          purpose: "start agent",
        }),
      ).toThrow("Permission denied");
    });
  });

  describe("error: requested cwd doesn't exist inside worktree", () => {
    it("throws when cwd directory does not exist after path validation", () => {
      // First ensureDirectoryExists (for lane root) succeeds
      setupDirectoryExists("/real/lane/root");
      mocks.resolvePathWithinRoot.mockReturnValue("/real/lane/root/nonexistent");

      // Second ensureDirectoryExists (for resolved cwd) fails
      let callCount = 0;
      mocks.statSync.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          // First call: lane root check succeeds
          return { isDirectory: () => true };
        }
        // Second call: cwd check fails
        throw new Error("ENOENT");
      });

      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService("/projects/my-lane"),
          laneId: "lane-1",
          requestedCwd: "nonexistent",
          purpose: "start agent",
        }),
      ).toThrow("is not an existing directory inside lane");
    });
  });

  describe("edge cases", () => {
    it("trims laneId whitespace", () => {
      setupDirectoryExists("/real/lane/root");

      const laneService = makeLaneService("/projects/my-lane");
      resolveLaneLaunchContext({
        laneService,
        laneId: "  lane-1  ",
        purpose: "test",
      });

      // Verify getLaneBaseAndBranch was called with the trimmed laneId
      expect(laneService.getLaneBaseAndBranch).toHaveBeenCalledWith("lane-1");
    });

    it("uses 'launch work' as default purpose when purpose is empty", () => {
      expect(() =>
        resolveLaneLaunchContext({
          laneService: makeLaneService(""),
          laneId: "lane-1",
          purpose: "",
        }),
      ).toThrow("ADE cannot launch work outside the selected lane");
    });
  });
});
