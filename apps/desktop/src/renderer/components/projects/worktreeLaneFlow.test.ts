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

const inspectPath = vi.fn();
const listLanes = vi.fn();

beforeEach(() => {
  inspectPath.mockReset();
  listLanes.mockReset();
  listLanes.mockResolvedValue([]);
  (globalThis as unknown as { window: unknown }).window = {
    ade: { project: { inspectPath }, lanes: { list: listLanes } },
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
  it("opens the owning project and navigates to the lane it auto-registered", async () => {
    inspectPath.mockResolvedValueOnce(
      inspection({
        parent: {
          rootPath: "/repo",
          displayName: "repo",
          isKnownAdeProject: true,
          existingLane: { id: "lane-1", name: "feat-a", branchRef: "feat-a", color: null, laneType: "worktree" },
        },
      }),
    );
    const switchProjectToPath = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();

    await openWorktreeAsLane(inspection(), { switchProjectToPath, navigate });

    expect(switchProjectToPath).toHaveBeenCalledWith("/repo", { skipWorktreeGate: true });
    // Adoption only happens inside the lanes.list reconcile, so the row does not
    // exist until this runs — and it must run against the newly bound runtime.
    expect(listLanes).toHaveBeenCalledWith({ includeStatus: false });
    expect(switchProjectToPath.mock.invocationCallOrder[0]!).toBeLessThan(
      listLanes.mock.invocationCallOrder[0]!,
    );
    // The pre-switch inspection is cached against the old project, so the lane
    // lookup has to bypass the cache, and it has to come after adoption.
    expect(inspectPath).toHaveBeenCalledWith("/repo/wt", { fresh: true });
    expect(listLanes.mock.invocationCallOrder[0]!).toBeLessThan(
      inspectPath.mock.invocationCallOrder[0]!,
    );
    expect(navigate).toHaveBeenCalledWith("/lanes?laneId=lane-1&focus=single");
  });

  it("names detached HEAD as the reason when no lane was registered", async () => {
    inspectPath.mockResolvedValueOnce(inspection({ branchRef: null }));
    const switchProjectToPath = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();

    await expect(
      openWorktreeAsLane(inspection({ branchRef: null }), { switchProjectToPath, navigate }),
    ).rejects.toThrow(/detached HEAD/i);

    expect(navigate).not.toHaveBeenCalled();
  });

  it("jumps straight to an already-known lane without re-inspecting", async () => {
    const switchProjectToPath = vi.fn().mockResolvedValue(undefined);
    const navigate = vi.fn();
    const withLane = inspection({
      branchRef: null,
      parent: {
        rootPath: "/repo",
        displayName: "repo",
        isKnownAdeProject: true,
        existingLane: { id: "lane-9", name: "wt", branchRef: "feat-a", color: null, laneType: "worktree" },
      },
    });

    await openWorktreeAsLane(withLane, { switchProjectToPath, navigate });

    expect(inspectPath).not.toHaveBeenCalled();
    expect(listLanes).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/lanes?laneId=lane-9&focus=single");
  });
});
