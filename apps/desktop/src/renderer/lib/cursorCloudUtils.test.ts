import { describe, expect, it, vi } from "vitest";
import {
  cursorCloudAgentWebUrl,
  CURSOR_CLOUD_BRANCH_DIVERGED_MESSAGE,
  describeCursorCloudPushFailure,
  ensureExistingLaneOriginReadyForCursorCloud,
  pushAutoCreatedLaneOriginForCursorCloud,
  resolveCursorCloudPrCreateFields,
} from "./cursorCloudUtils";

describe("resolveCursorCloudPrCreateFields", () => {
  it("attaches to an existing PR and never also auto-creates", () => {
    expect(resolveCursorCloudPrCreateFields({
      existingPrUrl: "https://github.com/acme/project/pull/12",
      autoCreatePR: true,
    })).toEqual({
      autoCreatePR: false,
      prUrl: "https://github.com/acme/project/pull/12",
    });
  });

  it("passes through Open a PR when the branch has none", () => {
    expect(resolveCursorCloudPrCreateFields({ autoCreatePR: true })).toEqual({
      autoCreatePR: true,
    });
    expect(resolveCursorCloudPrCreateFields({ autoCreatePR: false })).toEqual({
      autoCreatePR: false,
    });
  });
});

describe("cursorCloudAgentWebUrl", () => {
  it("builds the public agent URL and ignores blanks", () => {
    expect(cursorCloudAgentWebUrl("bc-1")).toBe("https://cursor.com/agents?id=bc-1");
    expect(cursorCloudAgentWebUrl("  ")).toBeNull();
    expect(cursorCloudAgentWebUrl(null)).toBeNull();
  });
});

describe("pushAutoCreatedLaneOriginForCursorCloud", () => {
  it("always pushes a just-created lane branch", async () => {
    const push = vi.fn().mockResolvedValue({ operationId: "op-1" });
    await pushAutoCreatedLaneOriginForCursorCloud({
      laneId: "lane-new",
      branchHint: "ade/new",
      git: { push },
    });
    expect(push).toHaveBeenCalledWith({ laneId: "lane-new" });
  });

  it("rewrites a failed auto-create push into one sentence", async () => {
    const push = vi.fn().mockRejectedValue(new Error("! [rejected] fetch first"));
    await expect(pushAutoCreatedLaneOriginForCursorCloud({
      laneId: "lane-new",
      branchHint: "ade/new",
      git: { push },
    })).rejects.toThrow(describeCursorCloudPushFailure(new Error("! [rejected] fetch first"), "ade/new"));
  });
});

describe("ensureExistingLaneOriginReadyForCursorCloud", () => {
  it("skips the push when the existing lane is only behind origin", async () => {
    const push = vi.fn();
    const getSyncStatus = vi.fn().mockResolvedValue({
      hasUpstream: true,
      upstreamState: "tracking",
      upstreamRef: "origin/current",
      ahead: 0,
      behind: 3,
      diverged: false,
      recommendedAction: "pull",
    });
    await ensureExistingLaneOriginReadyForCursorCloud({
      laneId: "lane-1",
      git: { push, getSyncStatus },
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("blocks a diverged existing lane without pushing", async () => {
    const push = vi.fn();
    await expect(ensureExistingLaneOriginReadyForCursorCloud({
      laneId: "lane-1",
      git: {
        push,
        getSyncStatus: vi.fn().mockResolvedValue({
          hasUpstream: true,
          upstreamState: "tracking",
          upstreamRef: "origin/current",
          ahead: 2,
          behind: 3,
          diverged: true,
          recommendedAction: "rebase",
        }),
      },
    })).rejects.toThrow(CURSOR_CLOUD_BRANCH_DIVERGED_MESSAGE);
    expect(push).not.toHaveBeenCalled();
  });

  it("fails closed when local commits cannot be pushed even if origin already has the branch", async () => {
    const push = vi.fn().mockRejectedValue(new Error("remote: permission denied"));
    await expect(ensureExistingLaneOriginReadyForCursorCloud({
      laneId: "lane-1",
      git: {
        push,
        getSyncStatus: vi.fn().mockResolvedValue({
          hasUpstream: true,
          upstreamState: "tracking",
          upstreamRef: "origin/current",
          ahead: 2,
          behind: 0,
          diverged: false,
          recommendedAction: "push",
        }),
      },
    })).rejects.toThrow(/GitHub refused the push/);
    expect(push).toHaveBeenCalledWith({ laneId: "lane-1" });
  });
});
