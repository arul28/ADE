import { describe, expect, it } from "vitest";
import type { LaneEvent, LaneEventActor, LaneEventKind } from "../../../../shared/types/laneEvents";
import {
  CANVAS_PADDING_X,
  FOLD_THRESHOLD,
  GAP_THRESHOLD_MS,
  NODE_SPACING,
  buildHeatStrip,
  buildLaneStoryLayout,
  buildStorySummary,
  eventFilterCategory,
  filterStoryEvents,
  foldCommitRuns,
  formatGapLabel,
  formatGitReadout,
  makeTimeToX,
  storyProviderColor,
  sortStoryEvents,
  type StoryFilter,
} from "./laneStoryModel";

const T0 = Date.parse("2026-08-01T10:00:00.000Z");

function at(minutes: number): string {
  return new Date(T0 + minutes * 60_000).toISOString();
}

function event(
  id: string,
  kind: LaneEventKind,
  minutes: number,
  actor: Partial<LaneEventActor> = {},
  extra: Partial<LaneEvent> = {},
): LaneEvent {
  const payloadByKind: Record<string, unknown> = {
    commit: { sha: `sha-${id}`, shortSha: id, subject: `subject ${id}`, filesChanged: 2, insertions: 10, deletions: 1 },
    pr_opened: { prId: `pr-${id}`, githubPrNumber: 42, title: "A pull request" },
    pr_merged: { prId: `pr-${id}`, githubPrNumber: 42, title: "A pull request", mergedByLogin: "octocat" },
    pr_closed: { prId: `pr-${id}`, githubPrNumber: 42 },
    pr_checks: { prId: `pr-${id}`, githubPrNumber: 42, checksStatus: "failing" },
    pr_review: { prId: `pr-${id}`, githubPrNumber: 42, reviewStatus: "changes_requested" },
    lane_created: { source: "chat", branchRef: "feature", baseRef: "main" },
    lane_spawned: { laneId: "child", laneName: "Child", branchRef: "child" },
    branch_switched: { fromBranchRef: "a", toBranchRef: "b" },
    rebase: { onto: "main", outcome: "completed" },
    chat_started: { chatSessionId: "chat-1", title: "Chat" },
    chat_ended: { chatSessionId: "chat-1", title: "Chat" },
  };
  return {
    id,
    laneId: "lane-1",
    kind,
    ts: at(minutes),
    actor: { kind: "agent", provider: "claude", chatSessionId: "chat-1", ...actor } as LaneEventActor,
    ref: id,
    branchRef: "feature",
    payload: payloadByKind[kind] as never,
    derived: false,
    ...extra,
  } as LaneEvent;
}

function commits(count: number, startMinute: number, actor: Partial<LaneEventActor> = {}): LaneEvent[] {
  return Array.from({ length: count }, (_, index) => event(`c${startMinute}-${index}`, "commit", startMinute + index, actor));
}

describe("laneStoryModel — ordering and filters", () => {
  it("sorts by time and breaks ties by narrative order", () => {
    const sorted = sortStoryEvents([
      event("b", "commit", 5),
      event("a", "lane_created", 5),
      event("c", "commit", 1),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["c", "a", "b"]);
  });

  it("maps every kind to exactly one filter category", () => {
    expect(eventFilterCategory("commit")).toBe("commits");
    expect(eventFilterCategory("pr_checks")).toBe("ci");
    expect(eventFilterCategory("pr_review")).toBe("reviews");
    expect(eventFilterCategory("chat_started")).toBe("sessions");
    expect(eventFilterCategory("lane_spawned")).toBe("lanes");
  });

  it("filters events by active categories", () => {
    const active = new Set<StoryFilter>(["commits"]);
    const filtered = filterStoryEvents([event("a", "commit", 0), event("b", "pr_opened", 1)], active);
    expect(filtered.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("laneStoryModel — folding", () => {
  it("folds runs longer than the threshold into one group", () => {
    const groups = foldCommitRuns(commits(FOLD_THRESHOLD + 2, 0));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.events).toHaveLength(FOLD_THRESHOLD + 2);
  });

  it("leaves a run at the threshold unfolded", () => {
    const groups = foldCommitRuns(commits(FOLD_THRESHOLD, 0));
    expect(groups).toHaveLength(FOLD_THRESHOLD);
  });

  it("breaks a run when the acting agent changes", () => {
    const run = [
      ...commits(6, 0, { chatSessionId: "chat-a" }),
      ...commits(6, 10, { chatSessionId: "chat-b" }),
    ];
    const groups = foldCommitRuns(run, 4);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.events.length === 6)).toBe(true);
  });

  it("expands a fold the user opened", () => {
    const events = commits(FOLD_THRESHOLD + 2, 0);
    const folded = buildLaneStoryLayout({ events });
    expect(folded.nodes).toHaveLength(1);
    const unfolded = buildLaneStoryLayout({ events, unfoldedIds: new Set([folded.nodes[0]!.id]) });
    expect(unfolded.nodes).toHaveLength(FOLD_THRESHOLD + 2);
  });
});

describe("laneStoryModel — layout", () => {
  it("spaces nodes by event order, not by time", () => {
    const layout = buildLaneStoryLayout({ events: [event("a", "commit", 0), event("b", "commit", 1)] });
    expect(layout.nodes.map((node) => node.x)).toEqual([CANVAS_PADDING_X, CANVAS_PADDING_X + NODE_SPACING]);
  });

  it("staggers cards above and below the spine", () => {
    const layout = buildLaneStoryLayout({ events: commits(3, 0).map((e, i) => ({ ...e, id: `s${i}` })) });
    expect(layout.nodes.map((node) => node.side)).toEqual(["above", "below", "above"]);
  });

  it("adds a gap marker and extra spacing when Δt crosses the threshold", () => {
    const late = GAP_THRESHOLD_MS / 60_000 + 60;
    const layout = buildLaneStoryLayout({ events: [event("a", "commit", 0), event("b", "commit", late)] });
    expect(layout.gaps).toHaveLength(1);
    expect(layout.gaps[0]!.label).toMatch(/h|d/);
    expect(layout.nodes[1]!.x).toBeGreaterThan(CANVAS_PADDING_X + NODE_SPACING);
  });

  it("gives each branch its own row and forks the child off the parent", () => {
    const layout = buildLaneStoryLayout({
      events: [
        event("a", "commit", 0),
        event("b", "commit", 1, {}, { branchRef: "feature-2" }),
      ],
      branches: [
        { branchRef: "feature", firstTs: at(0), lastTs: at(0) },
        { branchRef: "feature-2", forkPointSha: "sha-a", firstTs: at(1), lastTs: at(1) },
      ],
    });
    expect(layout.rows).toHaveLength(2);
    expect(layout.rows[1]!.forkFromRowIndex).toBe(0);
    expect(layout.rows[1]!.forkX).toBe(layout.nodes[0]!.x);
    expect(layout.rows[1]!.y).toBeGreaterThan(layout.rows[0]!.y);
  });

  it("draws a causality arc from a review to the commit that answered it", () => {
    const layout = buildLaneStoryLayout({
      events: [event("r", "pr_review", 0), event("c", "commit", 1)],
    });
    expect(layout.arcs).toHaveLength(1);
    expect(layout.arcs[0]!.toX).toBeGreaterThan(layout.arcs[0]!.fromX);
  });

  it("places session swimlanes below the rows and can hide them", () => {
    const chats = [{
      chatSessionId: "chat-1",
      title: "Build it",
      provider: "claude",
      model: "Opus 5",
      startedAt: at(0),
      endedAt: at(2),
      status: "ended" as const,
      statusNote: null,
      lastActivityAt: at(2),
    }];
    const events = [event("a", "commit", 0), event("b", "commit", 2)];
    const withLanes = buildLaneStoryLayout({ events, chats });
    expect(withLanes.swimlanes).toHaveLength(1);
    expect(withLanes.swimlanes[0]!.y).toBeGreaterThan(withLanes.rows[0]!.y);
    expect(buildLaneStoryLayout({ events, chats, showSwimlanes: false }).swimlanes).toHaveLength(0);
  });

  it("interpolates a time onto the canvas between the nodes on either side", () => {
    const layout = buildLaneStoryLayout({ events: [event("a", "commit", 0), event("b", "commit", 10)] });
    const toX = makeTimeToX(layout.nodes, layout.width);
    expect(toX(at(5))).toBeCloseTo(CANVAS_PADDING_X + NODE_SPACING / 2, 0);
    expect(toX(at(-100))).toBe(CANVAS_PADDING_X);
  });

  it("returns an empty-but-valid layout for a lane with no story", () => {
    const layout = buildLaneStoryLayout({ events: [] });
    expect(layout.nodes).toHaveLength(0);
    expect(layout.rows).toHaveLength(1);
    expect(layout.width).toBeGreaterThan(0);
  });
});

describe("laneStoryModel — heat strip", () => {
  it("buckets proportionally to real time and flags merges and attention", () => {
    const heat = buildHeatStrip([
      event("a", "commit", 0),
      event("b", "pr_review", 1),
      event("m", "pr_merged", 100),
    ], 10);
    expect(heat.buckets).toHaveLength(10);
    expect(heat.buckets[0]!.count).toBe(2);
    expect(heat.buckets[0]!.needsAttention).toBe(true);
    expect(heat.buckets[9]!.hasMerge).toBe(true);
    expect(heat.buckets[0]!.density).toBe(1);
    expect(heat.durationLabel).toBeTruthy();
  });

  it("is empty for an empty story", () => {
    expect(buildHeatStrip([]).buckets).toHaveLength(0);
  });
});

describe("laneStoryModel — summary sentence", () => {
  it("reads origin, commits, PR outcome and the live tail", () => {
    const summary = buildStorySummary({
      events: [
        event("o", "lane_created", 0),
        ...commits(3, 1),
        event("m", "pr_merged", 10),
      ],
      chats: [{
        chatSessionId: "chat-1",
        title: null,
        provider: "claude",
        model: "Opus 5",
        startedAt: at(0),
        endedAt: null,
        status: "running",
        statusNote: null,
        lastActivityAt: at(10),
      }],
      baseRef: "main",
    });
    expect(summary).toContain("Spawned from a chat off main");
    expect(summary).toContain("3 commits from Claude");
    expect(summary).toContain("1 PR merged");
    expect(summary).toContain("Claude is working now");
  });

  it("falls back to a quiet sentence with no events", () => {
    expect(buildStorySummary({ events: [] })).toBe("No story yet.");
  });
});

describe("laneStoryModel — formatters", () => {
  it("formats gaps at human scale", () => {
    expect(formatGapLabel(30 * 60_000)).toBe("30m");
    expect(formatGapLabel(5 * 3600_000)).toBe("5h");
    expect(formatGapLabel(3 * 86400_000)).toBe("3d");
    expect(formatGapLabel(30 * 86400_000)).toBe("4w");
  });

  it("builds the git readout and marks a dirty tree", () => {
    const readout = formatGitReadout({ ahead: 2, behind: 1, remoteBehind: 0, dirty: true }, "main");
    expect(readout.base).toBe("main ↑2 ↓1");
    expect(readout.remote).toBe("remote ↑2 ↓0");
    expect(readout.clean).toBe(false);
    expect(formatGitReadout({ ahead: 0, behind: 0, remoteBehind: -1, dirty: false }, "main").remote).toBe("no upstream");
  });

  it("knows the provider brand colours", () => {
    expect(storyProviderColor("claude")).toBe("#D97757");
    expect(storyProviderColor("CURSOR")).toBe("#9CC7FF");
    expect(storyProviderColor("nope")).toBeNull();
  });
});
