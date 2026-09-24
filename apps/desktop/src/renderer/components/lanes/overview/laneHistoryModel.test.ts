import { describe, expect, it } from "vitest";
import type { GitCommitSummary, LaneSummary, OperationRecord } from "../../../../shared/types";
import {
  buildLaneHistory,
  dayLabel,
  filterLaneHistory,
  groupLaneHistoryByDay,
  laneRebaseNeed,
  normalizeProvider,
  parseCoAuthorProvider,
  providerActiveAt,
  selectLaneCommits,
  type LaneHistoryPr,
  type LaneHistorySession,
} from "./laneHistoryModel";

const NOW = Date.parse("2026-09-23T15:00:00");

function lane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Lane one",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "refs/heads/ade/lane-one",
    worktreePath: "/tmp/lane-one",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 2, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-09-20T09:00:00",
    ...overrides,
  };
}

function commit(sha: string, authoredAt: string, subject: string, authorName = "Arul Sharma"): GitCommitSummary {
  return { sha, shortSha: sha.slice(0, 7), parents: [], authorName, authoredAt, subject, pushed: true };
}

function pr(overrides: Partial<LaneHistoryPr> = {}): LaneHistoryPr {
  return {
    key: "acme/ade#1292",
    linkedPrId: "pr-1",
    number: 1292,
    repoOwner: "acme",
    repoName: "ade",
    title: "Redesign PR detail",
    state: "open",
    createdAt: "2026-09-22T10:00:00",
    updatedAt: "2026-09-23T11:00:00",
    mergedAt: null,
    mergedBy: null,
    author: "arul28",
    checksStatus: "passing",
    reviewStatus: "none",
    mergeConflicts: false,
    ...overrides,
  };
}

function session(overrides: Partial<LaneHistorySession> = {}): LaneHistorySession {
  return {
    sessionId: "chat-1",
    kind: "chat",
    provider: "claude",
    title: "Lane delete fix",
    startedAt: "2026-09-23T08:00:00",
    endedAt: null,
    lastActivityAt: "2026-09-23T12:00:00",
    ...overrides,
  };
}

describe("parseCoAuthorProvider", () => {
  it("reads the agent from a Co-Authored-By trailer", () => {
    expect(parseCoAuthorProvider("fix: x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>")).toBe("claude");
    expect(parseCoAuthorProvider("fix\n\nco-authored-by: Codex <codex@openai.com>")).toBe("codex");
    expect(parseCoAuthorProvider("fix\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>")).toBe("cursor");
  });

  it("skips human co-authors and returns null without a trailer", () => {
    expect(parseCoAuthorProvider("fix\n\nCo-Authored-By: Jane <jane@example.com>\nCo-Authored-By: Claude <noreply@anthropic.com>")).toBe("claude");
    expect(parseCoAuthorProvider("fix: mention claude in the subject only")).toBeNull();
    expect(parseCoAuthorProvider(null)).toBeNull();
  });
});

describe("normalizeProvider", () => {
  it("strips tool type suffixes and drops shells", () => {
    expect(normalizeProvider("claude-chat")).toBe("claude");
    expect(normalizeProvider("cursor-cli")).toBe("cursor");
    expect(normalizeProvider("codex-orchestrated")).toBe("codex");
    expect(normalizeProvider("shell")).toBeNull();
  });
});

describe("selectLaneCommits", () => {
  const commits = [
    commit("c3", "2026-09-23T10:00:00", "three"),
    commit("c2", "2026-09-22T10:00:00", "two"),
    commit("c1", "2026-09-01T10:00:00", "base commit"),
  ];

  it("keeps only the lane's own commits (the newest `ahead` rows)", () => {
    expect(selectLaneCommits(commits, lane()).map((c) => c.sha)).toEqual(["c3", "c2"]);
    expect(selectLaneCommits(commits, lane({ status: { ...lane().status, ahead: 0 } }))).toEqual([]);
  });

  it("keeps every commit on the primary lane", () => {
    expect(selectLaneCommits(commits, lane({ laneType: "primary" }))).toHaveLength(3);
  });
});

describe("providerActiveAt", () => {
  it("attributes to the single provider whose session covered the time", () => {
    const ts = Date.parse("2026-09-23T10:00:00");
    expect(providerActiveAt(ts, [session()], NOW)).toBe("claude");
  });

  it("refuses to guess when two providers were active or none was", () => {
    const ts = Date.parse("2026-09-23T10:00:00");
    expect(providerActiveAt(ts, [session(), session({ sessionId: "chat-2", provider: "codex" })], NOW)).toBeNull();
    expect(providerActiveAt(Date.parse("2026-09-23T14:00:00"), [session()], NOW)).toBeNull();
  });
});

describe("buildLaneHistory", () => {
  const baseArgs = {
    lane: lane(),
    commits: [
      commit("aaa1111", "2026-09-23T10:00:00", "fix sync cursor"),
      commit("bbb2222", "2026-09-22T09:00:00", "add lane overview"),
      commit("ccc3333", "2026-09-01T09:00:00", "base history"),
    ],
    prs: [pr()],
    sessions: [session()],
    now: NOW,
  };

  it("merges every source newest first and drops base commits", () => {
    const entries = buildLaneHistory(baseArgs);
    expect(entries.map((entry) => entry.id)).toEqual([
      "pr-state:acme/ade#1292",
      "commit:aaa1111",
      "session:chat-1",
      "pr-opened:acme/ade#1292",
      "commit:bbb2222",
      "lane-created:lane-1",
    ]);
  });

  it("uses the trailer first, then the running chat, then the author name", () => {
    const entries = buildLaneHistory({
      ...baseArgs,
      trailerProviderBySha: new Map([["bbb2222", "codex"]]),
    });
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    expect(byId.get("commit:bbb2222")?.text).toBe("Codex committed");
    expect(byId.get("commit:aaa1111")?.text).toBe("Claude committed");
    expect(byId.get("commit:aaa1111")?.emphasis).toBe("fix sync cursor");

    const noSessions = buildLaneHistory({ ...baseArgs, sessions: [] });
    const human = noSessions.find((entry) => entry.id === "commit:aaa1111");
    expect(human?.text).toBe("Arul Sharma committed");
    expect(human?.actor).toEqual({ kind: "human", name: "Arul Sharma" });
  });

  it("does not guess from chats on the primary lane", () => {
    const entries = buildLaneHistory({ ...baseArgs, lane: lane({ laneType: "primary" }) });
    expect(entries.find((entry) => entry.id === "commit:aaa1111")?.actor.kind).toBe("human");
  });

  it("writes PR lines for opened, merged, closed and the latest check state", () => {
    const merged = buildLaneHistory({
      ...baseArgs,
      commits: [],
      sessions: [],
      prs: [
        pr({ state: "merged", mergedAt: "2026-09-23T12:00:00", mergedBy: { login: "arul28", avatarUrl: null } }),
        pr({ key: "acme/ade#1300", number: 1300, state: "closed", createdAt: "2026-09-21T10:00:00", updatedAt: "2026-09-21T12:00:00" }),
        pr({ key: "acme/ade#1301", number: 1301, checksStatus: "failing", createdAt: "2026-09-20T10:00:00", updatedAt: "2026-09-20T11:00:00" }),
      ],
    });
    const texts = merged.map((entry) => entry.text);
    expect(texts).toContain("PR #1292 merged");
    expect(texts).toContain("PR #1300 closed");
    expect(texts).toContain("Checks failed on #1301");
  });

  it("keeps useful lane operations and drops noise", () => {
    const op = (id: string, kind: string, status: OperationRecord["status"] = "succeeded"): OperationRecord => ({
      id,
      laneId: "lane-1",
      laneName: "Lane one",
      kind,
      startedAt: "2026-09-23T13:00:00",
      endedAt: "2026-09-23T13:00:05",
      status,
      preHeadSha: null,
      postHeadSha: null,
      metadataJson: null,
    });
    const entries = buildLaneHistory({
      ...baseArgs,
      operations: [op("1", "git_push"), op("2", "git_fetch"), op("3", "git_pull", "failed"), op("4", "git_stage")],
    });
    const ops = entries.filter((entry) => entry.category === "git");
    expect(ops.map((entry) => entry.text).sort()).toEqual(["Pull failed", "Pushed to remote"]);
    expect(ops.find((entry) => entry.text === "Pull failed")?.tone).toBe("danger");
  });

  it("filters by commits, PRs and agents", () => {
    const entries = buildLaneHistory(baseArgs);
    expect(filterLaneHistory(entries, "commits").every((entry) => entry.category === "commit" || entry.category === "git")).toBe(true);
    expect(filterLaneHistory(entries, "prs").map((entry) => entry.category)).toEqual(["pr", "pr"]);
    // Agent-made commits count as agent activity too.
    expect(filterLaneHistory(entries, "agents").map((entry) => entry.id)).toEqual(["commit:aaa1111", "session:chat-1"]);
    expect(filterLaneHistory(entries, "all")).toBe(entries);
  });
});

describe("day grouping", () => {
  it("labels today, yesterday and older days", () => {
    expect(dayLabel(Date.parse("2026-09-23T09:00:00"), NOW)).toBe("Today");
    expect(dayLabel(Date.parse("2026-09-22T23:59:00"), NOW)).toBe("Yesterday");
    const older = dayLabel(Date.parse("2026-09-21T09:00:00"), NOW);
    expect(older).toMatch(/21/);
    expect(older).not.toMatch(/2026/);
    expect(dayLabel(Date.parse("2025-09-21T09:00:00"), NOW)).toMatch(/2025/);
  });

  it("groups sorted entries into consecutive days", () => {
    const entries = buildLaneHistory({
      lane: lane(),
      commits: [],
      prs: [],
      sessions: [
        session({ sessionId: "a", startedAt: "2026-09-23T10:00:00" }),
        session({ sessionId: "b", startedAt: "2026-09-23T08:00:00" }),
        session({ sessionId: "c", startedAt: "2026-09-22T08:00:00" }),
      ],
      now: NOW,
    });
    const days = groupLaneHistoryByDay(entries, NOW);
    expect(days.map((day) => [day.label, day.entries.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      [dayLabel(Date.parse("2026-09-20T09:00:00"), NOW), 1],
    ]);
  });
});

describe("laneRebaseNeed", () => {
  it("says when the lane needs a rebase", () => {
    const behind = lane({ status: { ...lane().status, behind: 3 } });
    expect(laneRebaseNeed({ lane: behind, rebaseSuggestion: null, autoRebaseStatus: null })?.label).toBe("3 commits behind main");
    expect(laneRebaseNeed({
      lane: behind,
      rebaseSuggestion: {
        laneId: "lane-1",
        parentLaneId: "p",
        parentHeadSha: "x",
        behindCount: 4,
        baseLabel: "Parent lane",
        lastSuggestedAt: "",
        deferredUntil: null,
        dismissedAt: null,
        hasPr: false,
      },
      autoRebaseStatus: null,
    })).toEqual({ label: "4 commits behind Parent lane · rebase needed", tone: "warning", source: "suggestion" });
    expect(laneRebaseNeed({ lane: lane({ status: { ...lane().status, rebaseInProgress: true } }), rebaseSuggestion: null, autoRebaseStatus: null })?.tone)
      .toBe("danger");
    expect(laneRebaseNeed({ lane: lane(), rebaseSuggestion: null, autoRebaseStatus: null })).toBeNull();
    expect(laneRebaseNeed({ lane: lane({ laneType: "primary", status: { ...lane().status, behind: 2 } }), rebaseSuggestion: null, autoRebaseStatus: null }))
      .toBeNull();
  });

});
