// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ProjectWelcomePage } from "./ProjectWelcomePage";
import { useAppStore } from "../../state/appStore";
import type { ProjectPathInspection, RecentProjectSummary } from "../../../shared/types";
import {
  dismissToast,
  getToasts,
} from "../app/toast/toastStore";

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigateSpy };
});

// The project-browser CommandPalette is heavy and irrelevant here.
vi.mock("../app/CommandPalette", () => ({
  CommandPalette: () => null,
}));

const listRecent = vi.fn();
const resolveIcon = vi.fn(async () => ({
  dataUrl: null,
  sourcePath: null,
  mimeType: null,
}));
const forgetRecent = vi.fn(async () => [] as RecentProjectSummary[]);
const inspectPath = vi.fn();
const listLanes = vi.fn();
const switchProjectToPath = vi.fn(async () => {});

const WORKTREE_ROOT = "/repos/app-feature";

const worktreeRecent: RecentProjectSummary = {
  rootPath: WORKTREE_ROOT,
  displayName: "app-feature",
  lastOpenedAt: "2026-05-08T00:00:00.000Z",
  exists: true,
  worktreeOf: { rootPath: "/repos/app", displayName: "app" },
  laneCount: 0,
};

function inspection(
  overrides: Partial<ProjectPathInspection> = {},
): ProjectPathInspection {
  return {
    inputPath: WORKTREE_ROOT,
    worktreeRoot: WORKTREE_ROOT,
    kind: "linked-worktree",
    branchRef: "feature/x",
    parent: {
      rootPath: "/repos/app",
      displayName: "app",
      isKnownAdeProject: true,
      existingLane: null,
    },
    standaloneState: { chatCount: 2, laneCount: 1 },
    ...overrides,
  };
}

/** What `inspectPath` reports once the owning project is open: the worktree
 *  is registered as a lane, so `openWorktreeAsLane` has somewhere to navigate. */
function mergedInspection(): ProjectPathInspection {
  return inspection({
    parent: {
      rootPath: "/repos/app",
      displayName: "app",
      isKnownAdeProject: true,
      existingLane: {
        id: "lane-merged",
        name: "feature/x",
        branchRef: "feature/x",
        color: null,
        laneType: "worktree",
      },
    },
  });
}

beforeEach(() => {
  for (const toast of getToasts()) dismissToast(toast.id);
  navigateSpy.mockReset();
  listRecent.mockReset();
  listRecent.mockResolvedValue([worktreeRecent]);
  forgetRecent.mockReset();
  forgetRecent.mockResolvedValue([]);
  inspectPath.mockReset();
  inspectPath.mockResolvedValue(inspection());
  listLanes.mockReset();
  listLanes.mockResolvedValue([]);
  switchProjectToPath.mockReset();
  switchProjectToPath.mockResolvedValue(undefined);

  (globalThis.window as any).ade = {
    project: { listRecent, resolveIcon, forgetRecent, inspectPath },
    lanes: {
      list: listLanes,
      onLifecycleEvent: vi.fn(() => vi.fn()),
      onProxyEvent: vi.fn(() => vi.fn()),
      onPortEvent: vi.fn(() => vi.fn()),
      onDiagnosticsEvent: vi.fn(() => vi.fn()),
    },
    app: { openExternal: vi.fn(), writeClipboardText: vi.fn() },
    remoteRuntime: {
      getConnectionSnapshot: vi.fn(async () => ({
        connections: [],
        connectedCount: 0,
        updatedAt: Date.now(),
      })),
      onConnectionSnapshotChanged: vi.fn(() => vi.fn()),
    },
  };

  useAppStore.setState({
    showWelcome: true,
    project: null,
    lanes: [],
    switchProjectToPath: switchProjectToPath as any,
  } as any);
});

afterEach(() => cleanup());

function renderWelcome() {
  return render(
    <MemoryRouter>
      <ProjectWelcomePage />
    </MemoryRouter>,
  );
}

describe("ProjectWelcomePage worktree recents", () => {
  it("renders a worktree chip and a merge action for a worktree recent", async () => {
    renderWelcome();

    expect(await screen.findByText("app-feature")).toBeTruthy();
    expect(screen.getByText("worktree of app")).toBeTruthy();
    expect(
      screen.getByLabelText("Merge into app as a lane…"),
    ).toBeTruthy();
  });

  it("merge confirm forgets the recent and navigates to the auto-registered lane", async () => {
    inspectPath.mockResolvedValueOnce(inspection());
    inspectPath.mockResolvedValueOnce(mergedInspection());
    renderWelcome();

    await screen.findByText("app-feature");
    fireEvent.click(screen.getByLabelText("Merge into app as a lane…"));

    // Dialog fetches fresh inspection, then confirm.
    const confirm = await screen.findByText("Merge into app");
    await waitFor(() =>
      expect(inspectPath).toHaveBeenCalledWith(WORKTREE_ROOT, { fresh: true }),
    );
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(forgetRecent).toHaveBeenCalledWith(WORKTREE_ROOT),
    );
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith(
        "/lanes?laneId=lane-merged&focus=single",
      ),
    );
  });

  it("surfaces a post-switch merge failure through a persistent toast", async () => {
    inspectPath.mockResolvedValueOnce(inspection());
    inspectPath.mockRejectedValueOnce(new Error("merge broke"));
    renderWelcome();

    await screen.findByText("app-feature");
    fireEvent.click(screen.getByLabelText("Merge into app as a lane…"));
    const confirm = await screen.findByText("Merge into app");
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(getToasts().at(-1)).toMatchObject({
        title: "Merge failed",
        message: "merge broke",
        tone: "error",
        durationMs: 0,
      }),
    );
  });

  it("still lands on the lane when retiring the recents row fails after the merge", async () => {
    inspectPath.mockResolvedValueOnce(inspection());
    inspectPath.mockResolvedValueOnce(mergedInspection());
    forgetRecent.mockRejectedValueOnce(new Error("forget failed"));
    renderWelcome();

    await screen.findByText("app-feature");
    fireEvent.click(screen.getByLabelText("Merge into app as a lane…"));
    const confirm = await screen.findByText("Merge into app");
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith(
        "/lanes?laneId=lane-merged&focus=single",
      ),
    );
    expect(getToasts().some((toast) => toast.title === "Merge failed")).toBe(false);
  });
});

describe("ProjectWelcomePage multi-machine recents", () => {
  it("renders one card for the same Git repository on two machines", async () => {
    listRecent.mockResolvedValueOnce([
      {
        rootPath: "/Users/arul/ADE",
        displayName: "ADE",
        lastOpenedAt: "2026-07-28T12:00:00.000Z",
        exists: true,
        kind: "local",
        gitOriginUrl: "git@github.com:arul28/ADE.git",
      },
      {
        rootPath: "/Users/studio/ADE",
        displayName: "ADE",
        lastOpenedAt: "2026-07-28T11:00:00.000Z",
        exists: true,
        kind: "remote",
        gitOriginUrl: "https://github.com/arul28/ADE",
        remote: {
          targetId: "studio",
          projectId: "ade",
          runtimeName: "Mac Studio",
          hostname: "studio.local",
          gitOriginUrl: "https://github.com/arul28/ADE",
        },
      },
    ]);

    renderWelcome();

    await screen.findByText("Also on Mac Studio");
    expect(
      document.querySelectorAll('[data-tour="project.recentProject"]'),
    ).toHaveLength(1);
    expect(screen.getAllByText("ADE")).toHaveLength(1);
  });
});
