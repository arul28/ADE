import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrState } from "../../shared/types";
import {
  lanePrAggregateAttention,
  lanePrAttention,
  openLanePr,
  pickPrimaryPr,
  primaryPrStateRank,
  selectPrimaryLanePr,
} from "./lanePrBadge";
import { prStateTone, selectPrsForChatInLane } from "./prChatScope";

type TestPr = { id: string; state: PrState; updatedAt?: string | null; githubPrNumber: number };

function pr(id: string, state: PrState, updatedAt: string | null | undefined, githubPrNumber: number): TestPr {
  return { id, state, updatedAt, githubPrNumber };
}

describe("primaryPrStateRank", () => {
  it("ranks open < draft < terminal history", () => {
    expect(primaryPrStateRank("open")).toBeLessThan(primaryPrStateRank("draft"));
    expect(primaryPrStateRank("draft")).toBeLessThan(primaryPrStateRank("merged"));
    expect(primaryPrStateRank("merged")).toBe(primaryPrStateRank("closed"));
  });
});

describe("pickPrimaryPr", () => {
  const cases: Array<{ name: string; prs: TestPr[]; expected: string | null }> = [
    {
      name: "empty list -> null",
      prs: [],
      expected: null,
    },
    {
      // `github_pr_number` has no positive-value constraint, so a 0 can reach
      // the picker. The CLI picker refused such a row first while this one
      // ranked only by state and recency, so the lane badge and a CLI-minted
      // deeplink could name DIFFERENT PRs. The rule now lives in the shared
      // comparator, which is the only reason both agree.
      name: "a readable number beats a live state with no number",
      prs: [pr("no-number", "open", "2026-07-09T00:00:00Z", 0), pr("real", "merged", "2026-07-01T00:00:00Z", 7)],
      expected: "real",
    },
    {
      name: "among numbered rows the state rule still decides",
      prs: [pr("merged", "merged", "2026-07-09T00:00:00Z", 9), pr("open", "open", "2026-07-01T00:00:00Z", 3)],
      expected: "open",
    },
    {
      name: "a numberless row is still answered when it is all there is",
      prs: [pr("only", "open", "2026-07-01T00:00:00Z", 0)],
      expected: "only",
    },
    {
      name: "open beats draft",
      prs: [pr("draft", "draft", "2026-07-06T00:00:00Z", 5), pr("open", "open", "2026-07-01T00:00:00Z", 1)],
      expected: "open",
    },
    {
      name: "draft beats merged and closed",
      prs: [
        pr("closed", "closed", "2026-07-06T00:00:00Z", 9),
        pr("merged", "merged", "2026-07-05T00:00:00Z", 8),
        pr("draft", "draft", "2026-07-01T00:00:00Z", 2),
      ],
      expected: "draft",
    },
    {
      name: "newest open wins among opens",
      prs: [
        pr("old", "open", "2026-07-01T00:00:00Z", 3),
        pr("new", "open", "2026-07-06T00:00:00Z", 1),
      ],
      expected: "new",
    },
    {
      name: "highest number breaks a same-timestamp tie",
      prs: [
        pr("lo", "open", "2026-07-06T00:00:00Z", 4),
        pr("hi", "open", "2026-07-06T00:00:00Z", 7),
      ],
      expected: "hi",
    },
    {
      name: "falls back to a terminal PR when nothing is open/draft",
      prs: [
        pr("closed", "closed", "2026-07-01T00:00:00Z", 1),
        pr("merged", "merged", "2026-07-02T00:00:00Z", 2),
      ],
      expected: "merged",
    },
    {
      name: "newer closed activity beats older merged history",
      prs: [
        pr("old-merged", "merged", "2026-07-01T00:00:00Z", 20),
        pr("new-closed", "closed", "2026-07-04T00:00:00Z", 1),
      ],
      expected: "new-closed",
    },
    {
      name: "valid activity beats a missing timestamp",
      prs: [
        pr("missing", "open", null, 99),
        pr("known", "open", "2026-07-03T00:00:00Z", 1),
      ],
      expected: "known",
    },
  ];

  for (const { name, prs, expected } of cases) {
    it(name, () => {
      expect(pickPrimaryPr(prs)?.id ?? null).toBe(expected);
    });
  }
});

describe("selectPrimaryLanePr", () => {
  const lane = {
    id: "lane-1",
    laneType: "worktree" as const,
    branchRef: "refs/heads/current",
    baseRef: "refs/heads/main",
  };

  const base = {
    projectId: "project-1",
    laneId: "lane-1",
    repoOwner: "ade",
    repoName: "desktop",
    githubUrl: "https://github.com/ade/desktop/pull/1",
    githubNodeId: null,
    baseBranch: "main",
    additions: 0,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
  };

  it("keeps the newest open PR on the collapsed lane badge", () => {
    const healthyCurrent = {
      ...base,
      id: "current",
      githubPrNumber: 10,
      title: "Current",
      state: "open" as const,
      headBranch: "current",
      checksStatus: "passing" as const,
      reviewStatus: "approved" as const,
      updatedAt: "2026-07-02T00:00:00.000Z",
    };
    const failingPrevious = {
      ...base,
      id: "previous",
      githubPrNumber: 9,
      title: "Previous failure",
      state: "open" as const,
      headBranch: "old-branch",
      checksStatus: "failing" as const,
      reviewStatus: "approved" as const,
      updatedAt: "2026-07-03T00:00:00.000Z",
    };

    expect(selectPrimaryLanePr(lane, [healthyCurrent, failingPrevious])?.id).toBe("current");
  });

  it("uses the latest activity when multiple terminal PRs remain", () => {
    const olderMerged = {
      ...base,
      id: "older-merged",
      githubPrNumber: 8,
      title: "Older merged",
      state: "merged" as const,
      headBranch: "older",
      checksStatus: "passing" as const,
      reviewStatus: "approved" as const,
      updatedAt: "2026-07-02T00:00:00.000Z",
    };
    const newerMerged = {
      ...base,
      id: "newer-merged",
      githubPrNumber: 7,
      title: "Newer merged",
      state: "merged" as const,
      headBranch: "current",
      checksStatus: "passing" as const,
      reviewStatus: "approved" as const,
      updatedAt: "2026-07-04T00:00:00.000Z",
    };

    expect(selectPrimaryLanePr(lane, [olderMerged, newerMerged])?.id).toBe("newer-merged");
  });

  it("does not show a previous-branch PR after the primary lane returns to base", () => {
    const primary = {
      ...lane,
      laneType: "primary" as const,
      branchRef: "main",
      baseRef: "main",
    };
    const mergedPrevious = {
      ...base,
      id: "merged-previous",
      githubPrNumber: 12,
      title: "Merged previous",
      state: "merged" as const,
      headBranch: "current",
      checksStatus: "passing" as const,
      reviewStatus: "approved" as const,
    };

    expect(selectPrimaryLanePr(primary, [mergedPrevious])).toBeNull();
  });
});

describe("lane PR attention", () => {
  it("keeps terminal failures visible in the aggregate state", () => {
    const mergedFailure = {
      state: "merged" as const,
      checksStatus: "failing" as const,
      reviewStatus: "approved" as const,
    };

    expect(lanePrAttention(mergedFailure)).toBe("danger");
    expect(lanePrAggregateAttention([
      { state: "open" as const, checksStatus: "passing" as const },
      mergedFailure,
    ])).toBe("danger");
  });
});

describe("openLanePr", () => {
  const foreignPr = {
    id: "pr-on-other-machine",
    repoOwner: "arul28",
    repoName: "ADE",
    githubPrNumber: 91,
    githubUrl: "https://github.com/arul28/ADE/pull/91",
  } as unknown as Parameters<typeof openLanePr>[0];

  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = {
      ade: { app: { openExternal: vi.fn(async () => {}) } },
      open: vi.fn(),
    };
  });

  it("deep-links a local PR into the PRs tab", () => {
    const navigate = vi.fn();
    openLanePr(foreignPr, { foreign: false, navigate });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      "/prs?tab=normal&prId=pr-on-other-machine&pr=91&repoOwner=arul28&repoName=ADE",
    );
    expect(window.ade.app.openExternal).not.toHaveBeenCalled();
  });

  it("honours a caller's richer local route over the default deep link", () => {
    const navigate = vi.fn();
    openLanePr(foreignPr, { foreign: false, navigate, localPath: "/prs?tab=normal&laneId=lane-1" });

    expect(navigate).toHaveBeenCalledWith("/prs?tab=normal&laneId=lane-1");
  });

  // The regression: a PR id only resolves on the machine that owns it, so
  // deep-linking a foreign PR landed on an empty PRs tab. GitHub is the one
  // destination that means the same thing from either machine.
  it("sends a foreign PR to GitHub instead of the machine-scoped PRs tab", () => {
    const navigate = vi.fn();
    openLanePr(foreignPr, { foreign: true, navigate });

    expect(navigate).not.toHaveBeenCalled();
    expect(window.ade.app.openExternal)
      .toHaveBeenCalledWith("https://github.com/arul28/ADE/pull/91");
  });

  it("falls back to window.open when the external open is refused", async () => {
    const navigate = vi.fn();
    (window.ade.app.openExternal as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("blocked scheme"));

    openLanePr(foreignPr, { foreign: true, navigate });
    // The fallback runs in the rejected promise's catch; flush the microtask
    // queue rather than guessing a tick count.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(navigate).not.toHaveBeenCalled();
    expect(window.open).toHaveBeenCalledWith(
      "https://github.com/arul28/ADE/pull/91",
      "_blank",
      "noopener,noreferrer",
    );
  });
});

describe("prStateTone", () => {
  // Three copies of this mapping existed and two of them rendered a DRAFT pull
  // request GREEN — so one PR read amber in the pane header and green in the
  // pane's own selector and in the command menu.
  it("gives a draft its own amber tone, never the open green", () => {
    expect(prStateTone("draft").dot).not.toBe(prStateTone("open").dot);
    expect(prStateTone("draft").label).toBe("Draft");
  });

  it("distinguishes every state it is given", () => {
    const dots = (["open", "draft", "merged", "closed"] as PrState[]).map((state) => prStateTone(state).dot);
    expect(new Set(dots).size).toBe(4);
  });

  it("falls back rather than throwing on an unknown state", () => {
    const tone = prStateTone("something-new" as PrState);
    expect(tone.dot).toBeTruthy();
    expect(tone.label).toBe("something-new");
  });
});

describe("selectPrsForChatInLane", () => {
  const row = (id: string, laneId: string, sessions?: string[], detached?: boolean) => ({
    id, laneId, detached, chatSessionIds: sessions,
  } as unknown as Parameters<typeof selectPrsForChatInLane>[0][number]);

  it("takes lane-owned rows and rows this chat linked from another lane", () => {
    const ids = selectPrsForChatInLane(
      [row("own", "lane-1"), row("linked", "lane-2", ["sess-a"]), row("other", "lane-2", ["sess-b"])],
      "lane-1",
      "sess-a",
    ).map((pr) => pr.id);

    expect(ids).toContain("own");
    expect(ids).toContain("linked");
    expect(ids).not.toContain("other");
  });

  it("drops detached rows whichever arm they arrive on", () => {
    const ids = selectPrsForChatInLane(
      [row("own", "lane-1", undefined, true), row("linked", "lane-2", ["sess-a"], true)],
      "lane-1",
      "sess-a",
    ).map((pr) => pr.id);

    expect(ids).toEqual([]);
  });
});
