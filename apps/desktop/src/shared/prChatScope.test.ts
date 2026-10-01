import { describe, expect, it } from "vitest";
import { selectPrsForChat, selectPrsForChatInLane } from "./prChatScope";
import type { PrSummary } from "./types";

function pr(over: Partial<PrSummary> & { id: string }): PrSummary {
  return { laneId: "lane-1", ...over } as PrSummary;
}

describe("prChatScope", () => {
  it("keeps an unlinked lane PR out of the chat after an unlink tombstone", () => {
    const prs = [
      pr({ id: "linked", chatSessionIds: ["chat-1"] }),
      pr({ id: "unlinked", dismissedChatSessionIds: ["chat-1"] }),
      pr({ id: "claimed-elsewhere", chatSessionIds: ["chat-2"] }),
    ];

    expect(selectPrsForChatInLane(prs, "lane-1", "chat-1").map((p) => p.id)).toEqual(["linked"]);
  });

  it("shows a cross-lane PR only to the chat that explicitly linked it", () => {
    const prs = [pr({ id: "foreign", laneId: "lane-2", chatSessionIds: ["chat-1"] })];

    expect(selectPrsForChatInLane(prs, "lane-1", "chat-1").map((p) => p.id)).toEqual(["foreign"]);
    expect(selectPrsForChatInLane(prs, "lane-1", "chat-2").map((p) => p.id)).toEqual([]);
  });

  it("lets an edges-first chat fall back to unedged current-branch PRs only", () => {
    const prs = [
      pr({ id: "edged", chatSessionIds: ["chat-1"] }),
      pr({ id: "same-branch-unedged", headBranch: "feat/x" }),
      pr({ id: "other-branch-unedged", headBranch: "feat/y" }),
      pr({ id: "unlinked", headBranch: "feat/x", dismissedChatSessionIds: ["chat-none"] }),
    ];

    expect(selectPrsForChat(prs, "chat-1", { currentBranch: "feat/x" }).map((p) => p.id))
      .toEqual(["edged"]);
    expect(selectPrsForChat(prs, "chat-none", { currentBranch: "feat/x" }).map((p) => p.id))
      .toEqual(["same-branch-unedged"]);
  });
});
