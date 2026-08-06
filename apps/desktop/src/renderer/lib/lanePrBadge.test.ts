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

type TestPr = { id: string; state: PrState; updatedAt: string; githubPrNumber: number };

function pr(id: string, state: PrState, updatedAt: string, githubPrNumber: number): TestPr {
  return { id, state, updatedAt, githubPrNumber };
}

describe("primaryPrStateRank", () => {
  it("ranks open < draft < merged < closed", () => {
    expect(primaryPrStateRank("open")).toBeLessThan(primaryPrStateRank("draft"));
    expect(primaryPrStateRank("draft")).toBeLessThan(primaryPrStateRank("merged"));
    expect(primaryPrStateRank("merged")).toBeLessThan(primaryPrStateRank("closed"));
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

  it("lets an actionable failing historical PR win over a healthy current PR", () => {
    const healthyCurrent = {
      ...base,
      id: "current",
      githubPrNumber: 10,
      title: "Current",
      state: "open" as const,
      headBranch: "current",
      checksStatus: "passing" as const,
      reviewStatus: "approved" as const,
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
    };

    expect(selectPrimaryLanePr(lane, [healthyCurrent, failingPrevious])?.id).toBe("previous");
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
