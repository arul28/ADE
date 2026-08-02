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

/** Listeners registered through the mocked `prs.onEvent`, so tests can emit. */
const prEventListeners = new Set<(event: any) => void>();

function emitPrEvent(event: any) {
  for (const listener of [...prEventListeners]) listener(event);
}

function installAdeMocks() {
  prEventListeners.clear();
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
      onEvent: vi.fn().mockImplementation((listener: (event: any) => void) => {
        prEventListeners.add(listener);
        return () => prEventListeners.delete(listener);
      }),
      refresh: vi.fn().mockResolvedValue([]),
      syncLanePr: vi.fn().mockResolvedValue(null),
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
  runtimePin?: any;
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

    await waitFor(() => expect(window.ade.prs.getForLane).toHaveBeenCalledWith("lane-1", null));

    expect(window.ade.diff.getChanges).not.toHaveBeenCalled();
  });

  // The bug: every PR read routed to the machine the project TAB is bound to, so
  // a chat whose lane lives on another machine found no PR and showed the bare
  // "PR" create button for a session that already had one.
  it("routes PR reads to the lane's own machine when the chat is pinned", async () => {
    const runtimePin = {
      kind: "remote",
      key: "remote:target-b:project-b",
      targetId: "target-b",
      projectId: "project-b",
      runtimeName: "Machine B",
      displayName: "Repo B",
      rootPath: "/repo-b",
    };
    vi.mocked(window.ade.prs.getForLane).mockResolvedValue({
      id: "pr-foreign",
      laneId: "lane-1",
      githubPrNumber: 91,
      githubUrl: "https://github.com/acme/repo/pull/91",
      state: "open",
      checksStatus: "passing",
      reviewStatus: "approved",
    } as any);

    renderToolbar({ runtimePin });

    await waitFor(() => expect(window.ade.prs.getForLane)
      .toHaveBeenCalledWith("lane-1", runtimePin));
    // The event feed has to come from the same machine, or the pill goes stale.
    expect(window.ade.prs.onEvent).toHaveBeenCalledWith(expect.any(Function), runtimePin);
    // The pill renders the foreign machine's PR — before the fix this surface
    // showed the bare "PR" create button for a session that already had one.
    // (Where the click goes is `openLanePr`'s contract, pinned directly in
    // lib/lanePrBadge.test.ts.)
    expect(await screen.findByRole("button", { name: /#91/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "PR" })).toBeNull();
    // The dirty-file read is NOT pin-aware, so for a foreign lane it would only
    // ask the bound machine about a lane it does not have.
    expect(window.ade.diff.getChanges).not.toHaveBeenCalled();
  });

  // CodeRabbit on #1012: creating a PR is impossible for a lane on another
  // machine, and a surface with no PR pane has nothing to open instead — so the
  // create button must not accept a click it will silently drop.
  it("does not offer a dead PR-create click for a pinned lane with no pane", async () => {
    const runtimePin = {
      kind: "remote",
      key: "remote:target-b:project-b",
      targetId: "target-b",
      projectId: "project-b",
      runtimeName: "Machine B",
      displayName: "Repo B",
      rootPath: "/repo-b",
    };

    renderToolbar({ runtimePin });

    const button = await screen.findByRole("button", { name: "PR" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    expect(button.getAttribute("title")).toContain("Machine B");
    fireEvent.click(button);
    expect(screen.getByTestId("location").textContent).toBe("/work");
  });

  it("keeps the PR-create click live on the machine that owns the lane", async () => {
    renderToolbar();

    const button = await screen.findByRole("button", { name: "PR" });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(screen.getByTestId("location").textContent).toBe(
      "/prs?tab=normal&create=1&sourceLaneId=lane-1&target=primary",
    );
  });

  // On the pinned path `prs.onEvent` is a polling pump that re-anchors to the
  // live head on every subscribe, so a subscription keyed on the PR row dropped
  // whatever the runtime buffered in the teardown gap.
  it("keeps its PR event subscription across PR row changes", async () => {
    renderToolbar();
    await waitFor(() => expect(window.ade.prs.getForLane).toHaveBeenCalled());
    const subscriptionsAfterMount = vi.mocked(window.ade.prs.onEvent).mock.calls.length;

    vi.mocked(window.ade.prs.getForLane).mockResolvedValue({
      id: "pr-1",
      laneId: "lane-1",
      githubPrNumber: 7,
      githubUrl: "https://github.com/acme/repo/pull/7",
      state: "open",
      checksStatus: "passing",
      reviewStatus: "approved",
    } as any);
    await act(async () => {
      emitPrEvent({ type: "prs-updated", prs: [{ id: "pr-1", laneId: "lane-1" }] });
    });

    expect(await screen.findByRole("button", { name: /#7/ })).toBeTruthy();
    expect(vi.mocked(window.ade.prs.onEvent).mock.calls.length).toBe(subscriptionsAfterMount);
  });

  it("shows native GitHub stack position in the chat PR badge", async () => {
    vi.mocked(window.ade.prs.getForLane).mockResolvedValue({
      id: "pr-stack",
      laneId: "lane-1",
      title: "Stacked PR",
      state: "open",
      checksStatus: "passing",
      githubPrNumber: 965,
      githubUrl: "https://github.com/acme/ade/pull/965",
      additions: 10,
      deletions: 2,
      updatedAt: "2026-07-30T12:00:00.000Z",
      stack: {
        id: "stack-966",
        number: 966,
        size: 4,
        position: 2,
        baseBranch: "main",
      },
    } as any);

    renderToolbar();

    expect(await screen.findByLabelText("GitHub Stack 2 of 4")).toBeTruthy();
    expect(screen.getByRole("button", { name: /PR #965/ }).title).toContain("Stacked PR");
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
    expect(window.ade.prs.getForLane).toHaveBeenCalledWith("lane-1", null);
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
      expect(window.ade.prs.refresh).toHaveBeenCalledWith({ prIds: ["pr-1"] }, null);
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

  it("no longer renders a PR sync control in the chat header", async () => {
    vi.mocked(window.ade.prs.getForLane).mockResolvedValue({
      id: "pr-1",
      laneId: "lane-1",
      title: "Linked PR",
      state: "open",
      checksStatus: "unknown",
      githubPrNumber: 7,
      githubUrl: "https://github.com/acme/ade/pull/7",
      additions: 0,
      deletions: 0,
      updatedAt: null,
    } as any);

    renderToolbar();

    // The ⟳ affordance moved into ChatPrPane's title bar.
    expect(await screen.findByRole("button", { name: /PR #/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sync PR status/i })).toBeNull();
    expect(screen.queryByLabelText(/Sync PR status/i)).toBeNull();
    expect((window.ade.prs as any).syncLanePr).not.toHaveBeenCalled();
  });

  it("still heals the header PR pill when a backend reconcile finishes", async () => {
    vi.mocked(window.ade.prs.getForLane).mockResolvedValue({
      id: "pr-1",
      laneId: "lane-1",
      title: "Linked PR",
      state: "open",
      checksStatus: "unknown",
      githubPrNumber: 7,
      githubUrl: "https://github.com/acme/ade/pull/7",
      additions: 0,
      deletions: 0,
      updatedAt: null,
    } as any);

    renderToolbar();

    await screen.findByRole("button", { name: /PR #/ });
    const readsBefore = vi.mocked(window.ade.prs.getForLane).mock.calls.length;

    // A `running` reconcile must not trigger a re-read on its own…
    act(() => {
      emitPrEvent({ type: "pr-reconcile", state: "running", polledAt: "2026-07-27T00:00:00.000Z" });
    });
    expect(vi.mocked(window.ade.prs.getForLane).mock.calls.length).toBe(readsBefore);

    // …but finishing one heals the pill.
    act(() => {
      emitPrEvent({ type: "pr-reconcile", state: "idle", polledAt: "2026-07-27T00:00:01.000Z" });
    });

    await waitFor(() => {
      expect(vi.mocked(window.ade.prs.getForLane).mock.calls.length).toBeGreaterThan(readsBefore);
    });
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
      expect(window.ade.prs.refresh).toHaveBeenCalledWith({ prIds: ["pr-lane-1"] }, null);
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
