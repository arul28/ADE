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
import { RunPage } from "./RunPage";
import { useAppStore } from "../../state/appStore";
import type { ProjectPathInspection, RecentProjectSummary } from "../../../shared/types";

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
const attach = vi.fn();
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

beforeEach(() => {
  navigateSpy.mockReset();
  listRecent.mockReset();
  listRecent.mockResolvedValue([worktreeRecent]);
  forgetRecent.mockReset();
  forgetRecent.mockResolvedValue([]);
  inspectPath.mockReset();
  inspectPath.mockResolvedValue(inspection());
  attach.mockReset();
  switchProjectToPath.mockReset();
  switchProjectToPath.mockResolvedValue(undefined);

  (globalThis.window as any).ade = {
    project: { listRecent, resolveIcon, forgetRecent, inspectPath },
    lanes: {
      attach,
      onLifecycleEvent: vi.fn(() => vi.fn()),
      onProxyEvent: vi.fn(() => vi.fn()),
      onPortEvent: vi.fn(() => vi.fn()),
      onDiagnosticsEvent: vi.fn(() => vi.fn()),
    },
    processes: {
      onEvent: vi.fn(() => vi.fn()),
      listRuntime: vi.fn(async () => []),
      listDefinitions: vi.fn(async () => []),
    },
    projectConfig: {
      get: vi.fn(async () => ({
        effective: { processGroups: [] },
        shared: { processGroups: [], processes: [] },
        local: { processGroups: [], processes: [] },
      })),
    },
    pty: { onExit: vi.fn(() => vi.fn()) },
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
      <RunPage />
    </MemoryRouter>,
  );
}

describe("RunPage worktree recents", () => {
  it("renders a worktree chip and a merge action for a worktree recent", async () => {
    renderWelcome();

    expect(await screen.findByText("app-feature")).toBeTruthy();
    expect(screen.getByText("worktree of app")).toBeTruthy();
    expect(
      screen.getByLabelText("Merge into app as a lane…"),
    ).toBeTruthy();
  });

  it("merge confirm attaches the worktree, forgets the recent, and navigates", async () => {
    attach.mockResolvedValueOnce({ id: "lane-merged" });
    renderWelcome();

    await screen.findByText("app-feature");
    fireEvent.click(screen.getByLabelText("Merge into app as a lane…"));

    // Dialog fetches fresh inspection, then confirm.
    const confirm = await screen.findByText("Merge into app");
    await waitFor(() => expect(inspectPath).toHaveBeenCalledWith(WORKTREE_ROOT));
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(attach).toHaveBeenCalledWith({
        name: "feature/x",
        attachedPath: WORKTREE_ROOT,
      }),
    );
    await waitFor(() =>
      expect(forgetRecent).toHaveBeenCalledWith(WORKTREE_ROOT),
    );
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith(
        "/lanes?laneId=lane-merged&focus=single",
      ),
    );
  });
});
