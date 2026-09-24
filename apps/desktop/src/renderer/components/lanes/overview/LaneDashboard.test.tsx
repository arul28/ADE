/* @vitest-environment jsdom */

import React from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";
import { clearPrReadInFlightForTest } from "../../../lib/prReadCache";
import { LaneDashboard, RECENT_ACTIVITY_COUNT, recentActivityWindow } from "./LaneDashboard";
import { clearLanePrDetailCacheForTest, clearTrailerProviderCacheForTest } from "./useLaneOverviewData";

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const lane: LaneSummary = {
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
  status: { dirty: true, ahead: 1, behind: 2, remoteBehind: 0, rebaseInProgress: false, changedFileCount: 3 },
  color: null,
  icon: null,
  tags: [],
  createdAt: iso(600),
};

const LANE_COMMIT = { sha: "a".repeat(40), shortSha: "aaaaaaa", parents: [], authorName: "Arul", authoredAt: iso(30), subject: "fix sync cursor", pushed: true };

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

type AdeOverrides = {
  chats?: unknown[];
  terminals?: unknown[];
  prs?: unknown[];
  checks?: unknown[];
  reviews?: unknown[];
  files?: unknown[];
  status?: unknown;
};

function installAde(overrides: AdeOverrides = {}) {
  const ade = {
    app: { revealPath: vi.fn(async () => {}), openExternal: vi.fn(async () => {}) },
    agentChat: {
      list: vi.fn(async () => overrides.chats ?? []),
      onEvent: vi.fn(() => () => {}),
    },
    sessions: {
      list: vi.fn(async () => overrides.terminals ?? []),
      onChanged: vi.fn(() => () => {}),
    },
    prs: {
      listAll: vi.fn(async () => overrides.prs ?? []),
      getGitHubSnapshot: vi.fn(async () => ({ repo: null, viewerLogin: null, repoPullRequests: [], externalPullRequests: [] })),
      onEvent: vi.fn(() => () => {}),
      getStatus: vi.fn(async () => overrides.status ?? null),
      getChecks: vi.fn(async () => overrides.checks ?? []),
      getReviews: vi.fn(async () => overrides.reviews ?? []),
      getFiles: vi.fn(async () => overrides.files ?? []),
    },
    git: {
      listRecentCommits: vi.fn(async () => [
        LANE_COMMIT,
        { sha: "b".repeat(40), shortSha: "bbbbbbb", parents: [], authorName: "Arul", authoredAt: iso(9000), subject: "base history", pushed: true },
      ]),
      getCommitMessage: vi.fn(async () => "fix sync cursor\n\nCo-Authored-By: Claude <noreply@anthropic.com>"),
      getSyncStatus: vi.fn(async () => ({ hasUpstream: true, upstreamState: "tracking", upstreamRef: "origin/ade/lane-one", ahead: 2, behind: 0, diverged: false, recommendedAction: "push" })),
    },
    history: {
      listOperations: vi.fn(async () => []),
    },
  };
  (window as any).ade = ade;
  return ade;
}

function chat(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "chat-1",
    laneId: "lane-1",
    provider: "codex",
    model: "gpt",
    title: "Lane delete fix",
    status: "active",
    startedAt: iso(120),
    endedAt: null,
    lastActivityAt: iso(1),
    ...overrides,
  };
}

function pr(overrides: Record<string, unknown> = {}) {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "p",
    repoOwner: "acme",
    repoName: "ade",
    githubPrNumber: 1292,
    githubUrl: "https://github.com/acme/ade/pull/1292",
    githubNodeId: null,
    title: "Redesign PR detail",
    state: "open",
    baseBranch: "main",
    headBranch: "ade/lane-one",
    checksStatus: "failing",
    reviewStatus: "changes_requested",
    additions: 12,
    deletions: 3,
    lastSyncedAt: null,
    createdAt: iso(300),
    updatedAt: iso(10),
    ...overrides,
  };
}

function check(name: string, status: string, conclusion: string | null) {
  return { name, status, conclusion, detailsUrl: null, startedAt: iso(20), completedAt: conclusion ? iso(18) : null };
}

function renderDashboard(props: Partial<React.ComponentProps<typeof LaneDashboard>> = {}) {
  const handlers = {
    onOpenRebase: vi.fn(),
    onDismissRebaseSuggestion: vi.fn(),
    onDismissAutoRebase: vi.fn(),
    onStartChat: vi.fn(),
    onSelectCommit: vi.fn(),
    onSelectLane: vi.fn(),
    onOpenPrTag: vi.fn(),
    onOpenLaneMenu: vi.fn(),
  };
  render(
    <MemoryRouter initialEntries={["/lanes"]}>
      <Routes>
        <Route
          path="*"
          element={(
            <>
              <LaneDashboard
                laneId="lane-1"
                colorIndex={0}
                colorIndexByLaneId={new Map()}
                prTagsByLaneId={new Map()}
                showRebaseSuggestions
                rebaseError={null}
                {...handlers}
                {...props}
              />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
  return handlers;
}

describe("LaneDashboard", () => {
  beforeEach(() => {
    clearTrailerProviderCacheForTest();
    clearLanePrDetailCacheForTest();
    clearPrReadInFlightForTest();
    useAppStore.setState({ lanes: [lane], laneSnapshots: [] } as any);
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
    useAppStore.setState({ lanes: [], laneSnapshots: [] } as any);
  });

  it("shows the lane's git state, its open PR in full, its chats, its files and its activity", async () => {
    const ade = installAde({
      chats: [chat()],
      prs: [
        pr(),
        pr({ id: "pr-0", githubPrNumber: 1200, title: "First pass", state: "merged", headBranch: "ade/lane-one-v1", createdAt: iso(5000), updatedAt: iso(4000), mergedAt: iso(4000) }),
      ],
      checks: [
        check("ci / unit", "completed", "failure"),
        check("ci / build", "in_progress", null),
        check("ci / lint", "completed", "success"),
        check("ci / typecheck", "completed", "success"),
      ],
      reviews: [{ reviewer: "arul28", reviewerAvatarUrl: null, state: "changes_requested", body: null, submittedAt: iso(40) }],
      status: { prId: "pr-1", state: "open", checksStatus: "failing", reviewStatus: "changes_requested", isMergeable: false, mergeConflicts: true, behindBaseBy: 0 },
      files: [{ filename: "src/app.ts", status: "modified", additions: 10, deletions: 2, patch: null, previousFilename: null }],
    });
    const handlers = renderDashboard();

    // Identity and status line: base counts, uncommitted changes, and what is waiting to push.
    expect(screen.getByRole("heading", { name: "Lane one" })).toBeTruthy();
    const status = screen.getByTestId("lane-status-line");
    expect(status.textContent).toContain("1 ahead");
    expect(status.textContent).toContain("2 behind main");
    expect(status.textContent).toContain("3 uncommitted changes");
    await waitFor(() => expect(status.textContent).toContain("2 to push"));

    // PR: failing and running checks get a row each, the passing two fold into one line.
    await waitFor(() => expect(screen.getAllByTestId("lane-pr-check")).toHaveLength(2));
    const checkRows = screen.getAllByTestId("lane-pr-check").map((row) => row.textContent);
    expect(checkRows[0]).toContain("ci / unit");
    expect(checkRows[1]).toContain("ci / build");
    expect(screen.getByTestId("lane-pr-checks-passed").textContent).toBe("2 other checks passed");
    expect(screen.getByTestId("lane-pr-review").textContent).toBe("Changes requested by arul28");
    expect(screen.getByTestId("lane-pr-merge").textContent).toBe("Conflicts with main");
    // Detail reads are for the open PR only.
    expect(ade.prs.getChecks).toHaveBeenCalledWith("pr-1");
    expect(ade.prs.getChecks).toHaveBeenCalledTimes(1);

    // The merged PR sits behind one disclosure.
    expect(screen.queryByTestId("lane-pr-earlier-row")).toBeNull();
    fireEvent.click(screen.getByTestId("lane-pr-earlier-toggle"));
    expect(screen.getByTestId("lane-pr-earlier-row").textContent).toContain("#1200");

    // Chats: the live chat with the Work tab's status word.
    await waitFor(() => expect(screen.getAllByTestId("lane-chat-row")).toHaveLength(1));
    expect(within(screen.getByTestId("lane-chat-row")).getByText("Working")).toBeTruthy();

    // With an open PR, the changes are the PR's files.
    expect(screen.getByTestId("lane-changes-section").textContent).toContain("Files changed");
    expect(screen.getByTestId("lane-change-file").textContent).toContain("app.ts");

    // Activity: the lane's commit (not base history), attributed by its trailer.
    await waitFor(() => expect(screen.getByText("Claude committed")).toBeTruthy());
    expect(screen.queryByText("base history")).toBeNull();
    fireEvent.click(screen.getByText("Claude committed"));
    expect(handlers.onSelectCommit).toHaveBeenCalledWith(expect.objectContaining({ sha: LANE_COMMIT.sha }));

    // The PR row opens the PRs route with that PR selected.
    fireEvent.click(screen.getByTestId("lane-pr-current"));
    expect(screen.getByTestId("location").textContent).toMatch(/^\/prs\?/);
  });

  it("opens a chat in the Work tab", async () => {
    installAde({ chats: [chat({ provider: "claude", status: "idle", awaitingInput: true })] });
    renderDashboard();
    const row = await screen.findByTestId("lane-chat-row");
    fireEvent.click(row);
    expect(screen.getByTestId("location").textContent).toBe("/work?sessionId=chat-1&laneId=lane-1");
  });

  it("folds a section from its title and keeps it folded for the project", async () => {
    useAppStore.setState({ project: { rootPath: "/repo" }, projectBinding: null, workViewByProject: {} } as any);
    installAde({ chats: [chat({ provider: "claude", status: "idle" })] });
    renderDashboard();
    await screen.findByTestId("lane-chat-row");
    const toggle = screen.getByTestId("lane-chats-section-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByTestId("lane-chat-row")).toBeNull();
    expect(screen.getByTestId("lane-chats-section").getAttribute("data-collapsed")).toBe("true");
    const views = useAppStore.getState().workViewByProject;
    expect(Object.values(views).map((view) => view.lanesCollapsedSectionIds)).toEqual([["chats"]]);
    fireEvent.click(toggle);
    expect(await screen.findByTestId("lane-chat-row")).toBeTruthy();
    useAppStore.setState({ project: null, workViewByProject: {} } as any);
  });

  it("leaves out empty sections and keeps the lane actions", async () => {
    useAppStore.setState({
      lanes: [{ ...lane, status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false } }],
    } as any);
    const ade = installAde();
    const handlers = renderDashboard();
    await waitFor(() => expect(screen.getByText("Lane created")).toBeTruthy());
    expect(screen.queryByTestId("lane-pr-section")).toBeNull();
    expect(screen.queryByTestId("lane-chats-section")).toBeNull();
    expect(screen.queryByTestId("lane-stack-section")).toBeNull();
    expect(screen.queryByTestId("lane-changes-section")).toBeNull();
    // Nothing to read when the lane is not ahead of its base.
    expect(ade.git.listRecentCommits).not.toHaveBeenCalled();
    expect(ade.prs.getChecks).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("lane-new-chat"));
    expect(handlers.onStartChat).toHaveBeenCalledWith("lane-1");
    fireEvent.click(screen.getByTestId("lane-reveal"));
    expect(ade.app.revealPath).toHaveBeenCalledWith("/tmp/lane-one");
    fireEvent.click(screen.getByTestId("lane-more"));
    expect(handlers.onOpenLaneMenu).toHaveBeenCalledWith("lane-1", expect.anything());
    fireEvent.click(screen.getByTestId("lane-open-files"));
    expect(screen.getByTestId("location").textContent).toBe("/files");
  });

  it("lists the commits ahead of the base when there is no open PR", async () => {
    installAde();
    const handlers = renderDashboard();
    const row = await screen.findByTestId("lane-change-commit");
    expect(screen.getByTestId("lane-changes-section").textContent).toContain("Commits ahead of main");
    expect(row.textContent).toContain("fix sync cursor");
    fireEvent.click(row);
    expect(handlers.onSelectCommit).toHaveBeenCalledWith(expect.objectContaining({ sha: LANE_COMMIT.sha }));
  });

  it("shows the stack around the lane and selects a lane from it", async () => {
    const parent: LaneSummary = { ...lane, id: "lane-0", name: "Parent lane", branchRef: "refs/heads/ade/parent" };
    const child: LaneSummary = { ...lane, id: "lane-2", name: "Child lane", branchRef: "refs/heads/ade/child", parentLaneId: "lane-1" };
    useAppStore.setState({ lanes: [parent, { ...lane, parentLaneId: "lane-0" }, child] } as any);
    installAde();
    const handlers = renderDashboard();
    const rows = screen.getAllByTestId("lane-stack-row");
    expect(rows.map((row) => row.textContent?.split("ade/")[0])).toEqual(["Parent lane", "Lane one", "Child lane"]);
    fireEvent.click(rows[2]!);
    expect(handlers.onSelectLane).toHaveBeenCalledWith("lane-2");
    // The meta line names the parent instead of the base branch.
    fireEvent.click(screen.getByTestId("lane-identity-parent"));
    expect(handlers.onSelectLane).toHaveBeenCalledWith("lane-0");
  });

  it("shows a rebase suggestion as one notice that can be dismissed", () => {
    useAppStore.setState({
      lanes: [lane],
      laneSnapshots: [{
        lane,
        rebaseSuggestion: {
          laneId: "lane-1",
          parentLaneId: null,
          parentHeadSha: "x",
          behindCount: 4,
          baseLabel: "main",
          lastSuggestedAt: iso(5),
          deferredUntil: null,
          dismissedAt: null,
          hasPr: false,
        },
        autoRebaseStatus: null,
      }],
    } as any);
    installAde();
    const handlers = renderDashboard();
    const notice = screen.getByTestId("lane-rebase-notice");
    expect(notice.textContent).toContain("4 commits behind main · rebase needed");
    fireEvent.click(screen.getByText("Rebase…"));
    expect(handlers.onOpenRebase).toHaveBeenCalledWith("lane-1");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(handlers.onDismissRebaseSuggestion).toHaveBeenCalledWith("lane-1");
    cleanup();

    // With suggestions turned off for the project, the notice stays away.
    renderDashboard({ showRebaseSuggestions: false });
    expect(screen.queryByTestId("lane-rebase-notice")).toBeNull();
  });

  it("shows the newest activity rows until asked for all of them", async () => {
    const chats = Array.from({ length: 14 }, (_, index) => chat({
      sessionId: `chat-${index}`,
      title: `Chat ${index}`,
      status: "ended",
      startedAt: iso(200 + index),
      endedAt: iso(190 + index),
      lastActivityAt: iso(190 + index),
    }));
    useAppStore.setState({
      lanes: [{ ...lane, status: { ...lane.status, ahead: 0 } }],
    } as any);
    installAde({ chats });
    renderDashboard();
    // 14 chats plus "Lane created".
    await waitFor(() => expect(screen.getAllByTestId("lane-history-row")).toHaveLength(RECENT_ACTIVITY_COUNT));
    const more = screen.getByTestId("lane-history-more");
    expect(more.textContent).toBe("Show all activity");
    fireEvent.click(more);
    expect(screen.getAllByTestId("lane-history-row")).toHaveLength(15);
    expect(screen.queryByTestId("lane-history-more")).toBeNull();
    // The chats list is capped too, with its own "Show all".
    expect(screen.getAllByTestId("lane-chat-row")).toHaveLength(8);
    fireEvent.click(screen.getByTestId("lane-chats-show-all"));
    expect(screen.getAllByTestId("lane-chat-row")).toHaveLength(14);
  });
});

describe("recentActivityWindow", () => {
  it("cuts to eight, expands to everything, and pages the primary lane's commits", () => {
    expect(recentActivityWindow({ total: 4, expanded: false, hasMoreCommits: false })).toEqual({ count: 4, moreLabel: null });
    expect(recentActivityWindow({ total: 40, expanded: false, hasMoreCommits: false })).toEqual({ count: 8, moreLabel: "Show all activity" });
    expect(recentActivityWindow({ total: 40, expanded: true, hasMoreCommits: false })).toEqual({ count: 40, moreLabel: null });
    expect(recentActivityWindow({ total: 120, expanded: true, hasMoreCommits: true })).toEqual({ count: 120, moreLabel: "Show older" });
  });
});
