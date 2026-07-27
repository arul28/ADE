/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { useAppStore } from "../../state/appStore";
import { clearPrReadInFlightForTest } from "../../lib/prReadCache";
import { ChatGitToolbar } from "./ChatGitToolbar";

const originalAde = globalThis.window.ade;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installAdeMocks() {
  globalThis.window.ade = {
    git: {
      listBranches: vi.fn().mockResolvedValue([]),
      push: vi.fn().mockResolvedValue(undefined),
      stageAll: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      generateCommitMessage: vi.fn().mockResolvedValue({ message: "Commit changes" }),
      getActionRuntime: vi.fn().mockResolvedValue(null),
      onActionRuntimeEvent: vi.fn().mockImplementation(() => () => undefined),
    },
    diff: {
      getChanges: vi.fn().mockResolvedValue({
        staged: [],
        unstaged: [],
      }),
    },
    prs: {
      getForLane: vi.fn().mockResolvedValue(null),
      onEvent: vi.fn().mockImplementation(() => () => undefined),
      refresh: vi.fn().mockResolvedValue([]),
      getChecks: vi.fn().mockResolvedValue([]),
      openInGitHub: vi.fn().mockResolvedValue(undefined),
    },
    app: {
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

function resetStore(options?: { remote?: boolean }) {
  const rootPath = options?.remote ? "/Users/admin/Projects/perf pass" : "/tmp/project";
  useAppStore.setState({
    project: { rootPath, displayName: options?.remote ? "perf pass" : "Project" } as any,
    projectBinding: options?.remote
      ? {
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        projectId: "project-1",
        runtimeName: "Mac Studio",
        displayName: "perf pass",
        rootPath,
      } as any
      : {
        kind: "local",
        key: `local:${rootPath}`,
        rootPath,
        displayName: "Project",
      } as any,
    lanes: [{
      id: "lane-1",
      name: "UI audit lane",
      color: "#22c55e",
      laneType: "worktree",
      branchRef: "refs/heads/ui-audit",
      worktreePath: "/tmp/project/.ade/worktrees/ui-audit",
    } as any],
    selectedLaneId: null,
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderToolbar(props: {
  onTogglePrPane?: () => void;
  prPaneOpen?: boolean;
} = {}) {
  return render(
    <MemoryRouter initialEntries={["/work"]}>
      <Routes>
        <Route path="*" element={(
          <>
            <ChatGitToolbar laneId="lane-1" {...props} />
            <LocationProbe />
          </>
        )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ChatGitToolbar", () => {
  beforeEach(() => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    clearPrReadInFlightForTest();
    installAdeMocks();
    resetStore();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("opens the PR creation handoff when the current lane has no linked PR", async () => {
    renderToolbar();

    fireEvent.click(await screen.findByRole("button", { name: "PR" }));

    expect(screen.getByTestId("location").textContent).toBe(
      "/prs?tab=normal&create=1&sourceLaneId=lane-1&target=primary",
    );
  });

  it("loads remote PR state on mount without fetching remote diff status", async () => {
    resetStore({ remote: true });

    renderToolbar();

    await waitFor(() => expect(window.ade.prs.getForLane).toHaveBeenCalledWith("lane-1"));

    expect(window.ade.diff.getChanges).not.toHaveBeenCalled();
  });

  it("resolves the linked PR on first remote PR click before routing", async () => {
    resetStore({ remote: true });
    vi.mocked(window.ade.prs.getForLane).mockResolvedValue({
      id: "pr-1",
      laneId: "lane-1",
      title: "Remote linked PR",
      state: "open",
      checksStatus: "unknown",
      githubUrl: "https://github.com/acme/perf-pass/pull/1",
      additions: 0,
      deletions: 0,
      updatedAt: null,
    } as any);

    renderToolbar();

    const badge = await screen.findByRole("button", { name: /PR #/ });
    fireEvent.click(badge);
    fireEvent.click(screen.getByRole("button", { name: /ADE/ }));

    await waitFor(() => {
      expect(screen.getByTestId("location").textContent).toBe("/prs?tab=normal&prId=pr-1");
    });
    expect(window.ade.prs.getForLane).toHaveBeenCalledWith("lane-1");
    expect(window.ade.diff.getChanges).not.toHaveBeenCalled();
  });

  it("opens a linked PR URL through the local app bridge", async () => {
    vi.mocked(window.ade.prs.getForLane).mockResolvedValue({
      id: "pr-1",
      laneId: "lane-1",
      title: "Linked PR",
      state: "open",
      checksStatus: "unknown",
      githubUrl: "https://github.com/acme/ade/pull/1",
      additions: 0,
      deletions: 0,
      updatedAt: null,
    } as any);

    renderToolbar();

    fireEvent.click(await screen.findByRole("button", { name: /PR #/ }));
    fireEvent.click(screen.getByRole("button", { name: /GitHub/ }));

    await waitFor(() => {
      expect(window.ade.app.openExternal).toHaveBeenCalledWith("https://github.com/acme/ade/pull/1");
    });
    expect(window.ade.prs.openInGitHub).not.toHaveBeenCalled();
  });

  it("target-refreshes the linked PR when the chat PR pane opens", async () => {
    vi.mocked(window.ade.prs.getForLane).mockResolvedValue({
      id: "pr-1",
      laneId: "lane-1",
      title: "Stale linked PR",
      state: "open",
      checksStatus: "pending",
      githubPrNumber: 333,
      githubUrl: "https://github.com/acme/ade/pull/333",
      additions: 2,
      deletions: 1,
      updatedAt: null,
    } as any);
    vi.mocked(window.ade.prs.refresh).mockResolvedValue([{
      id: "pr-1",
      laneId: "lane-1",
      title: "Merged linked PR",
      state: "merged",
      checksStatus: "pending",
      githubPrNumber: 333,
      githubUrl: "https://github.com/acme/ade/pull/333",
      additions: 2,
      deletions: 1,
      updatedAt: "2026-06-29T14:00:00.000Z",
    } as any]);

    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <ChatGitToolbar
          laneId="lane-1"
          prPaneOpen={open}
          onTogglePrPane={() => setOpen((value) => !value)}
        />
      );
    }

    render(
      <MemoryRouter initialEntries={["/work"]}>
        <Harness />
      </MemoryRouter>,
    );

    const badge = await screen.findByText("PR #333");
    expect(window.ade.prs.refresh).not.toHaveBeenCalled();

    fireEvent.click(badge.closest("button")!);

    await waitFor(() => {
      expect(window.ade.prs.refresh).toHaveBeenCalledWith({ prIds: ["pr-1"] });
    });
    expect(await screen.findByText("MERGED #333")).toBeTruthy();
  });

  it("renders a projection-only PR badge without targeting its synthetic id for row refresh", async () => {
    vi.mocked(window.ade.prs.getForLane).mockResolvedValue({
      id: "gh:acme/ade#404",
      unmapped: true,
      laneId: "lane-1",
      projectId: "project-1",
      repoOwner: "acme",
      repoName: "ade",
      title: "Externally opened PR",
      state: "merged",
      checksStatus: "none",
      reviewStatus: "none",
      githubPrNumber: 404,
      githubUrl: "https://github.com/acme/ade/pull/404",
      githubNodeId: "PR_node404",
      baseBranch: "main",
      headBranch: "ui-audit",
      additions: 0,
      deletions: 0,
      lastSyncedAt: "2026-07-16T12:00:00.000Z",
      createdAt: "2026-07-16T11:00:00.000Z",
      updatedAt: "2026-07-16T12:00:00.000Z",
    });

    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <ChatGitToolbar
          laneId="lane-1"
          prPaneOpen={open}
          onTogglePrPane={() => setOpen((value) => !value)}
        />
      );
    }

    render(
      <MemoryRouter initialEntries={["/work"]}>
        <Harness />
      </MemoryRouter>,
    );

    const badge = await screen.findByText("MERGED #404");
    fireEvent.click(badge.closest("button")!);

    await waitFor(() => {
      expect(window.ade.prs.getForLane).toHaveBeenCalledTimes(2);
    });
    expect(window.ade.prs.refresh).not.toHaveBeenCalled();
  });

  it("ignores stale toolbar live refresh results after switching lanes", async () => {
    const laneOnePr = {
      id: "pr-lane-1",
      laneId: "lane-1",
      title: "Lane one stale PR",
      state: "open",
      checksStatus: "pending",
      githubPrNumber: 111,
      githubUrl: "https://github.com/acme/ade/pull/111",
      additions: 2,
      deletions: 1,
      updatedAt: null,
    };
    const laneOneFreshPr = {
      ...laneOnePr,
      title: "Lane one refreshed PR",
      state: "merged",
      updatedAt: "2026-06-29T14:00:00.000Z",
    };
    const laneTwoPr = {
      id: "pr-lane-2",
      laneId: "lane-2",
      title: "Lane two PR",
      state: "open",
      checksStatus: "passing",
      githubPrNumber: 222,
      githubUrl: "https://github.com/acme/ade/pull/222",
      additions: 4,
      deletions: 0,
      updatedAt: null,
    };
    const laneOneLive = deferred<any[]>();

    vi.mocked(window.ade.prs.getForLane).mockImplementation(async (requestedLaneId: string) => (
      requestedLaneId === "lane-1" ? laneOnePr : laneTwoPr
    ) as any);
    vi.mocked(window.ade.prs.refresh).mockImplementation((args?: { prIds?: string[] }) => (
      args?.prIds?.[0] === "pr-lane-1" ? laneOneLive.promise : Promise.resolve([laneTwoPr])
    ) as any);

    function Harness() {
      const [laneId, setLaneId] = React.useState("lane-1");
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => {
            setOpen(false);
            setLaneId("lane-2");
          }}>
            Switch lane
          </button>
          <ChatGitToolbar
            laneId={laneId}
            prPaneOpen={open}
            onTogglePrPane={() => setOpen((value) => !value)}
          />
        </>
      );
    }

    render(
      <MemoryRouter initialEntries={["/work"]}>
        <Harness />
      </MemoryRouter>,
    );

    fireEvent.click((await screen.findByText("PR #111")).closest("button")!);

    await waitFor(() => {
      expect(window.ade.prs.refresh).toHaveBeenCalledWith({ prIds: ["pr-lane-1"] });
    });

    fireEvent.click(screen.getByRole("button", { name: "Switch lane" }));

    expect(await screen.findByText("PR #222")).toBeTruthy();

    await act(async () => {
      laneOneLive.resolve([laneOneFreshPr]);
      await laneOneLive.promise;
    });

    expect(screen.getByText("PR #222")).toBeTruthy();
    expect(screen.queryByText("MERGED #111")).toBeNull();
  });
});
