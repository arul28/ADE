/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function resetStore() {
  useAppStore.setState({
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
});
