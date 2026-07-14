/* @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectPathInspection } from "../../../shared/types";
import { deriveLaneName, openWorktreeAsLane } from "./worktreeLaneFlow";

function inspection(overrides: Partial<ProjectPathInspection> = {}): ProjectPathInspection {
  return {
    inputPath: "/repo/wt",
    worktreeRoot: "/repo/wt",
    kind: "linked-worktree",
    branchRef: "feat-a",
    parent: {
      rootPath: "/repo",
      displayName: "repo",
      isKnownAdeProject: true,
      existingLane: null,
    },
    standaloneState: null,
    ...overrides,
  };
}

const attach = vi.fn();
const inspectPath = vi.fn();

beforeEach(() => {
  attach.mockReset();
  inspectPath.mockReset();
  (globalThis as unknown as { window: unknown }).window = {
    ade: { lanes: { attach }, project: { inspectPath } },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("deriveLaneName", () => {
  it("prefers the branch, falling back to the worktree basename", () => {
    expect(deriveLaneName(inspection({ branchRef: "feature/x" }))).toBe("feature/x");
    expect(deriveLaneName(inspection({ branchRef: null }))).toBe("wt");
  });
});

describe("openWorktreeAsLane", () => {
  it("attaches a branch-backed worktree and navigates to the new lane", async () => {
    attach.mockResolvedValueOnce({ id: "lane-1" });
    const switchProjectToPath = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();

    await openWorktreeAsLane(inspection(), { switchProjectToPath, navigate });

    expect(switchProjectToPath).toHaveBeenCalledWith("/repo", { skipWorktreeGate: true });
    expect(attach).toHaveBeenCalledWith({ name: "feat-a", attachedPath: "/repo/wt" });
    expect(navigate).toHaveBeenCalledWith("/lanes?laneId=lane-1&focus=single");
  });

  it("refuses a detached-HEAD worktree without switching projects or attaching", async () => {
    const switchProjectToPath = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();

    await expect(
      openWorktreeAsLane(inspection({ branchRef: null }), { switchProjectToPath, navigate }),
    ).rejects.toThrow(/detached HEAD/i);

    expect(switchProjectToPath).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("jumps straight to an existing lane without attaching", async () => {
    const switchProjectToPath = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();
    const withLane = inspection({
      branchRef: null,
      parent: {
        rootPath: "/repo",
        displayName: "repo",
        isKnownAdeProject: true,
        existingLane: { id: "lane-9", name: "wt", branchRef: "feat-a", color: null, laneType: "attached" },
      },
    });

    await openWorktreeAsLane(withLane, { switchProjectToPath, navigate });

    expect(attach).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/lanes?laneId=lane-9&focus=single");
  });
});
