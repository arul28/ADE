/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { useAppStore } from "../../state/appStore";
import { ChatGitToolbar } from "./ChatGitToolbar";

const originalAde = globalThis.window.ade;

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
      getChecks: vi.fn().mockResolvedValue([]),
      openInGitHub: vi.fn().mockResolvedValue(undefined),
    },
    app: {
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
    projectConfig: {
      get: vi.fn().mockResolvedValue({
        effective: {
          processes: [],
          processGroups: [],
        },
      }),
      confirmTrust: vi.fn().mockResolvedValue(undefined),
    },
    processes: {
      startAll: vi.fn().mockResolvedValue(undefined),
      stopAll: vi.fn().mockResolvedValue(undefined),
      startGroup: vi.fn().mockResolvedValue(undefined),
      stopGroup: vi.fn().mockResolvedValue(undefined),
      restartGroup: vi.fn().mockResolvedValue(undefined),
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

function renderToolbar() {
  return render(
    <MemoryRouter initialEntries={["/work"]}>
      <Routes>
        <Route path="*" element={(
          <>
            <ChatGitToolbar laneId="lane-1" />
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
});
