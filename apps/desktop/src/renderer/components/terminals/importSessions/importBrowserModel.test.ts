import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../shared/types/chat";
import type { ExternalSessionSummary } from "./contract";
import {
  laneFilterKey,
  matchesSearch,
  OTHER_FOLDERS_ID,
  sessionPlace,
  spliceNewestPage,
} from "./importBrowserModel";
import { formatExternalSessionSize } from "../../../../shared/externalSessionAffordances";

function summary(overrides: Partial<ExternalSessionSummary> = {}): ExternalSessionSummary {
  return {
    provider: "claude",
    id: "s1",
    cwd: "/repo/.ade/worktrees/apple-sim-1a2b",
    title: "Title",
    preview: null,
    createdAt: null,
    updatedAt: null,
    messageCount: 1,
    alreadyImported: false,
    possiblyActive: false,
    cwdMatchesRequestedLane: null,
    capabilities: { resumeInPlace: true, resumeInDifferentCwd: false, fork: true, forkIntoDifferentCwd: false, importToChat: true },
    ...overrides,
  };
}

const HOME = {
  kind: "lane" as const,
  laneId: "lane-a",
  laneName: "Apple Sim",
  branchRef: "refs/heads/ade/apple-sim",
  color: "#abc",
  laneType: "worktree",
  atLaneRoot: true,
};

function env(timestamp: string, text: string): AgentChatEventEnvelope {
  return { sessionId: "x", timestamp, event: { type: "text", text } };
}

describe("importBrowserModel", () => {
  it("names the lane, never the worktree folder", () => {
    const lanes = new Map([["lane-a", { id: "lane-a", name: "Apple Sim (renamed)", color: "#def" }]]);
    expect(sessionPlace(summary({ home: HOME }), lanes)).toEqual({
      kind: "lane",
      laneId: "lane-a",
      name: "Apple Sim (renamed)",
      color: "#def",
      branch: "ade/apple-sim",
    });
    expect(sessionPlace(summary({ home: { ...HOME, kind: "removed-lane", laneId: null } }), lanes).name).toBe("Removed lane");
    expect(sessionPlace(summary({ cwd: "/repo/scripts", home: { ...HOME, kind: "outside", laneId: null } }), lanes).name).toBe("scripts");
  });

  it("buckets sessions outside live lanes under Other folders and leaves older hosts unbucketed", () => {
    expect(laneFilterKey(summary({ home: HOME }))).toBe("lane-a");
    expect(laneFilterKey(summary({ home: { ...HOME, kind: "outside", laneId: null } }))).toBe(OTHER_FOLDERS_ID);
    expect(laneFilterKey(summary())).toBeNull();
  });

  it("searches lane name and branch", () => {
    const row = summary({ home: HOME });
    const place = sessionPlace(row, new Map());
    expect(matchesSearch(row, place, "apple sim")).toBe(true);
    expect(matchesSearch(row, place, "ade/apple")).toBe(true);
    expect(matchesSearch(row, place, "nothing-like-this")).toBe(false);
  });

  it("keeps paged-back events when a newer page overlaps, and starts over when it does not", () => {
    const current = [env("t1", "a"), env("t2", "b"), env("t3", "c")];
    expect(spliceNewestPage(current, [env("t2", "b"), env("t3", "c"), env("t4", "d")])?.map((e) => e.timestamp))
      .toEqual(["t1", "t2", "t3", "t4"]);
    expect(spliceNewestPage(current, [env("t9", "z")])).toBeNull();
  });

  it("formats sizes compactly and hides unknown or zero sizes", () => {
    expect(formatExternalSessionSize(40 * 1024 * 1024)).toBe("40 MB");
    expect(formatExternalSessionSize(2.44 * 1024 * 1024)).toBe("2.4 MB");
    expect(formatExternalSessionSize(1536)).toBe("1.5 KB");
    expect(formatExternalSessionSize(512)).toBe("512 B");
    expect(formatExternalSessionSize(0)).toBe("");
    expect(formatExternalSessionSize(null)).toBe("");
    expect(formatExternalSessionSize(undefined)).toBe("");
  });
});
