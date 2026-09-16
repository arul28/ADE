/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrSummary } from "../../../shared/types/prs";

const listPrsCoalesced = vi.fn<[], Promise<PrSummary[]>>();
vi.mock("../../lib/prReadCache", () => ({
  listPrsCoalesced: (...args: unknown[]) => listPrsCoalesced(...(args as [])),
  getGitHubSnapshotCoalesced: vi.fn(),
  refreshPrsCoalesced: vi.fn(),
}));

const { loadChipCardData } = await import("./ChipHoverCard");

function makePr(overrides: Partial<PrSummary> & { id: string }): PrSummary {
  return {
    laneId: "lane-1",
    projectId: "proj-1",
    repoOwner: "ade",
    repoName: "ade",
    githubPrNumber: 42,
    githubUrl: "https://github.com/ade/ade/pull/42",
    githubNodeId: null,
    title: "Ade forty-two",
    state: "open",
    baseBranch: "main",
    headBranch: "ade/x",
    checksStatus: "passing",
    reviewStatus: "none",
    additions: 0,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as PrSummary;
}

const SOURCES = { lanes: [], sessions: [], pin: null, rootPath: "/repo" } as never;

describe("loadChipCardData for a PR target", () => {
  beforeEach(() => {
    listPrsCoalesced.mockReset();
  });

  it("refuses a number-only target when two repositories both have that number", async () => {
    listPrsCoalesced.mockResolvedValue([
      makePr({ id: "pr-a", repoOwner: "ade", repoName: "ade", title: "Ade forty-two" }),
      makePr({ id: "pr-b", repoOwner: "other", repoName: "tools", title: "Other forty-two", state: "merged" }),
    ]);

    const data = await loadChipCardData(SOURCES, { kind: "pr", number: 42, owner: null, repo: null }, null);

    expect(data).toBeNull();
  });

  it("resolves a number-only target when only one repository has that number", async () => {
    listPrsCoalesced.mockResolvedValue([
      makePr({ id: "pr-a", title: "Ade forty-two" }),
      makePr({ id: "pr-c", githubPrNumber: 7, title: "Unrelated" }),
    ]);

    const data = await loadChipCardData(SOURCES, { kind: "pr", number: 42, owner: null, repo: null }, null);

    expect(data).toMatchObject({ kind: "pr", number: 42, title: "Ade forty-two", repo: "ade/ade" });
  });

  it("resolves a number-only target when one PR is linked to several lanes", async () => {
    // `pull_requests` is keyed by row id and carries a lane column, so the same
    // PR appears once per lane. That is not ambiguity — only distinct
    // repositories are.
    listPrsCoalesced.mockResolvedValue([
      makePr({ id: "pr-a", laneId: "lane-1" }),
      makePr({ id: "pr-a-dup", laneId: "lane-2" }),
    ]);

    const data = await loadChipCardData(SOURCES, { kind: "pr", number: 42, owner: null, repo: null }, null);

    expect(data).toMatchObject({ kind: "pr", number: 42, repo: "ade/ade" });
  });

  it("uses repository coordinates when the chip carries them", async () => {
    listPrsCoalesced.mockResolvedValue([
      makePr({ id: "pr-a", repoOwner: "ade", repoName: "ade", title: "Ade forty-two" }),
      makePr({ id: "pr-b", repoOwner: "other", repoName: "tools", title: "Other forty-two", state: "merged" }),
    ]);

    const data = await loadChipCardData(
      SOURCES,
      { kind: "pr", number: 42, owner: "Other", repo: "Tools" },
      null,
    );

    expect(data).toMatchObject({ kind: "pr", title: "Other forty-two", state: "merged", repo: "other/tools" });
  });
});
