/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
import { PROJECT_BROWSER_CLOSE_EVENT } from "../../lib/projectBrowserEvents";
import {
  SESSION_TONE_DOT_CLASS,
  SESSION_TONE_TEXT_CLASS,
} from "../../../shared/sessionStatusPresentation";
import { useAppStore } from "../../state/appStore";
import { THIS_MACHINE_ID } from "../../../shared/machineIdentity";

/** Surfaces the router location so navigation assertions read the real URL. */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PROJECT_ROOT = "/Users/admin/Projects/ADE";

function seedStore(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    project: {
      rootPath: PROJECT_ROOT,
      displayName: "ADE",
      baseRef: "main",
    },
    lanes: [],
    selectedLaneId: null,
    selectLane: vi.fn(),
    switchProjectToPath: vi.fn(async () => {}),
    // Reset explicitly: `setState` merges, so a thread test's sessions would
    // otherwise leak into every later test's palette.
    sessionsCacheByProject: {},
    workViewByProject: {},
    crossMachineLanesByMachineId: {},
    ...overrides,
  } as any);
}

function makeLane(overrides: Record<string, unknown> = {}) {
  return {
    id: "lane-1",
    name: "redesign",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "t3code/redesign-new-chat-ui",
    worktreePath: "/tmp/wt/redesign",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: "active",
    color: null,
    icon: null,
    tags: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    laneId: "lane-1",
    laneName: "redesign",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "claude",
    title: "Redesign ADE Chat and Prompt UI",
    status: "running",
    runtimeState: "running",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    resumeCommand: null,
    ...overrides,
  };
}

const REMOTE_BINDING = {
  kind: "remote" as const,
  key: "remote:target-studio:project-remote-ade",
  targetId: "target-studio",
  runtimeName: "Mac Studio",
  projectId: "project-remote-ade",
  rootPath: "/remote/ADE",
  displayName: "ADE",
};

/**
 * One machine's slice of the cross-machine Work union
 * (`CrossMachineMachineLanes`). The palette reads these straight off the root
 * store — the same slices the Work sidebar renders — so seeding the store is
 * the whole setup; there is no foreign-session IPC to mock.
 */
function makeForeignMachine(overrides: Record<string, unknown> = {}) {
  return {
    machineId: "target-studio",
    machineName: "Mac Studio",
    targetId: "target-studio",
    projectId: "project-remote-ade",
    binding: REMOTE_BINDING,
    online: true,
    lanes: [
      makeLane({
        id: "lane-remote",
        name: "release",
        branchRef: "t3code/release-notes",
      }),
    ],
    sessions: [
      makeSession({
        id: "session-remote-1",
        title: "Ship the release notes",
        laneId: "lane-remote",
        laneName: "release",
      }),
    ],
    lastSyncedAtMs: Date.now(),
    error: null,
    ...overrides,
  };
}

/** Seed the palette with threads sourced from the Work tab's per-project cache. */
function seedThreads(
  sessions: Array<Record<string, unknown>>,
  options: {
    lanes?: Array<Record<string, unknown>>;
    activeItemId?: string | null;
    /** Foreign machine slices, keyed by machine id, as the union stores them. */
    machines?: Record<string, Record<string, unknown>>;
  } = {},
) {
  seedStore({
    lanes: options.lanes ?? [makeLane()],
    sessionsCacheByProject: { [PROJECT_ROOT]: sessions },
    workViewByProject: {
      [PROJECT_ROOT]: { activeItemId: options.activeItemId ?? null },
    },
    crossMachineLanesByMachineId: options.machines ?? {},
  });
}

describe("CommandPalette", () => {
  const browseDirectories = vi.fn();
  const chooseDirectory = vi.fn();
  // `mockClear` (not `mockReset`) keeps this default implementation across
  // tests, so stray setTimeouts that fire after a test completes still get a
  // Promise back instead of undefined.
  const getDetail = vi.fn().mockResolvedValue({
    rootPath: "/Users/admin/Projects/Versic",
    isGitRepo: true,
    branchName: "main",
    dirtyCount: 0,
    dirtyBreakdown: null,
    aheadBehind: null,
    lastCommit: null,
    readmeExcerpt: null,
    languages: [],
    laneCount: null,
    lastOpenedAt: null,
    subdirectoryCount: null,
  });
  const resolveIcon = vi.fn(async () => ({
    dataUrl: null,
    sourcePath: null,
    mimeType: null,
  }));
  const getDroppedPath = vi.fn(() => "");

  beforeEach(() => {
    browseDirectories.mockReset();
    chooseDirectory.mockReset();
    getDetail.mockClear();
    resolveIcon.mockClear();
    // The per-location browse-path memory is localStorage-backed; clear it so a
    // path persisted by one test can't seed `browseInput` in the next.
    globalThis.localStorage?.clear();
    seedStore();
    globalThis.window.ade = {
      app: {
        ping: vi.fn(async () => "pong"),
      },
      project: {
        browseDirectories,
        chooseDirectory,
        getDetail,
        getDroppedPath,
        resolveIcon,
      },
    } as any;
  });

  // The shared test setup doesn't auto-unmount, so without this each test's
  // dialog would linger in the DOM and `getAll*` queries would match elements
  // (e.g. the inline "Open" buttons) from previously mounted components.
  afterEach(() => {
    cleanup();
  });

  it("opens the ADE project browser in browse intent mode", async () => {
    browseDirectories.mockResolvedValue({
      inputPath: "../",
      resolvedPath: "/Users/admin/Projects",
      directoryPath: "/Users/admin/Projects",
      parentPath: "/Users/admin",
      exactDirectoryPath: "/Users/admin/Projects",
      openableProjectRoot: null,
      entries: [
        {
          name: "Versic",
          fullPath: "/Users/admin/Projects/Versic",
          isGitRepo: true,
        },
      ],
    });

    render(
      <MemoryRouter>
        <CommandPalette open intent="project-browse" onOpenChange={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(browseDirectories).toHaveBeenCalledWith({
        partialPath: "../",
        cwd: "/Users/admin/Projects/ADE",
        limit: 200,
      });
    });

    expect(
      await screen.findByRole("button", { name: /choose folder/i }),
    ).toBeTruthy();
    expect(screen.getByText("Versic")).toBeTruthy();
  });

  it("opens a git repo row directly from its inline Open button", async () => {
    const switchProjectToPath = vi.fn(async () => {});
    seedStore({ switchProjectToPath });
    browseDirectories.mockResolvedValue({
      inputPath: "../",
      resolvedPath: "/Users/admin/Projects",
      directoryPath: "/Users/admin/Projects",
      parentPath: "/Users/admin",
      exactDirectoryPath: "/Users/admin/Projects",
      openableProjectRoot: null,
      entries: [
        {
          name: "Versic",
          fullPath: "/Users/admin/Projects/Versic",
          isGitRepo: true,
        },
      ],
    });

    render(
      <MemoryRouter>
        <CommandPalette open intent="project-browse" onOpenChange={vi.fn()} />
      </MemoryRouter>,
    );

    // Both the row's inline Open button and the footer Open button advertise
    // "Open Versic"; pick the row one (the footer carries a data-tour marker).
    const rowOpenButton = await waitFor(() => {
      const match = screen
        .getAllByRole("button", { name: /open versic/i })
        .find((button) => !button.hasAttribute("data-tour"));
      if (!match) throw new Error("row Open button not found yet");
      return match;
    });
    fireEvent.click(rowOpenButton);

    await waitFor(() => {
      expect(switchProjectToPath).toHaveBeenCalledWith(
        "/Users/admin/Projects/Versic",
      );
    });
  });

  it("shows a worktree-of badge and callout in the browse preview for a linked worktree", async () => {
    getDetail.mockResolvedValueOnce({
      rootPath: "/Users/admin/Projects/app-feature",
      isGitRepo: true,
      worktreeOf: { rootPath: "/Users/admin/Projects/app", displayName: "app" },
      branchName: "feature/x",
      dirtyCount: 0,
      dirtyBreakdown: null,
      aheadBehind: null,
      lastCommit: null,
      readmeExcerpt: null,
      languages: [],
      laneCount: null,
      lastOpenedAt: null,
      subdirectoryCount: null,
    });
    browseDirectories.mockResolvedValue({
      inputPath: "/Users/admin/Projects/app-feature",
      resolvedPath: "/Users/admin/Projects/app-feature",
      directoryPath: "/Users/admin/Projects/app-feature",
      // No parent row so the single git entry auto-highlights and its detail loads.
      parentPath: null,
      exactDirectoryPath: "/Users/admin/Projects/app-feature",
      openableProjectRoot: null,
      entries: [
        {
          name: "app-feature",
          fullPath: "/Users/admin/Projects/app-feature",
          isGitRepo: true,
          worktreeOf: {
            rootPath: "/Users/admin/Projects/app",
            displayName: "app",
          },
        },
      ],
    });

    render(
      <MemoryRouter>
        <CommandPalette open intent="project-browse" onOpenChange={vi.fn()} />
      </MemoryRouter>,
    );

    // The preview chip (RepoDetailBlocks) is distinct from the row's short chip.
    expect(await screen.findByText("worktree of app")).toBeTruthy();
    expect(
      screen.getByText(/Opening will offer to add it as a lane in app\./),
    ).toBeTruthy();
  });

  it("can fall back to the directory picker from the browser footer", async () => {
    const switchProjectToPath = vi.fn(async () => {});
    seedStore({ switchProjectToPath });
    browseDirectories.mockResolvedValue({
      inputPath: "/Users/admin/Projects/",
      resolvedPath: "/Users/admin/Projects",
      directoryPath: "/Users/admin/Projects",
      parentPath: "/Users/admin",
      exactDirectoryPath: "/Users/admin/Projects",
      openableProjectRoot: null,
      entries: [],
    });
    chooseDirectory.mockResolvedValue("/Users/admin/Projects/Versic");

    render(
      <MemoryRouter>
        <CommandPalette open intent="project-browse" onOpenChange={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(browseDirectories).toHaveBeenCalledWith({
        partialPath: "../",
        cwd: "/Users/admin/Projects/ADE",
        limit: 200,
      });
    });
    const button = await screen.findByRole("button", {
      name: /choose folder/i,
    });
    fireEvent.click(button);

    await waitFor(() => {
      expect(chooseDirectory).toHaveBeenCalledWith({
        title: "Open project",
        defaultPath: "/Users/admin/Projects",
      });
      expect(switchProjectToPath).toHaveBeenCalledWith(
        "/Users/admin/Projects/Versic",
      );
    });
  });

  it("closes the project browser when requested", async () => {
    const onOpenChange = vi.fn();
    browseDirectories.mockResolvedValue({
      inputPath: "../",
      resolvedPath: "/Users/admin/Projects",
      directoryPath: "/Users/admin/Projects",
      parentPath: "/Users/admin",
      exactDirectoryPath: "/Users/admin/Projects",
      openableProjectRoot: null,
      entries: [],
    });

    render(
      <MemoryRouter>
        <CommandPalette
          open
          intent="project-browse"
          onOpenChange={onOpenChange}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        document.querySelector('[data-tour="project.browser"]'),
      ).toBeTruthy();
    });
    window.dispatchEvent(new CustomEvent(PROJECT_BROWSER_CLOSE_EVENT));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens the latest dropped folder and ignores stale browse results", async () => {
    const switchProjectToPath = vi.fn(async () => {});
    seedStore({ switchProjectToPath });

    const initialBrowseResult = {
      inputPath: "../",
      resolvedPath: "/Users/admin/Projects",
      directoryPath: "/Users/admin/Projects",
      parentPath: "/Users/admin",
      exactDirectoryPath: "/Users/admin/Projects",
      openableProjectRoot: null,
      entries: [],
    };
    const staleDrop = deferred<any>();
    const latestDrop = deferred<any>();

    browseDirectories
      .mockResolvedValueOnce(initialBrowseResult)
      .mockImplementationOnce(() => staleDrop.promise)
      .mockImplementationOnce(() => latestDrop.promise)
      .mockResolvedValue({
        inputPath: "/Users/admin/Projects/FreshFolder/",
        resolvedPath: "/Users/admin/Projects/FreshFolder",
        directoryPath: "/Users/admin/Projects/FreshFolder",
        parentPath: "/Users/admin/Projects",
        exactDirectoryPath: "/Users/admin/Projects/FreshFolder",
        openableProjectRoot: null,
        entries: [],
      });

    getDroppedPath
      .mockImplementationOnce(() => "/Users/admin/Projects/StaleRepo")
      .mockImplementationOnce(() => "/Users/admin/Projects/FreshFolder");

    render(
      <MemoryRouter>
        <CommandPalette open intent="project-browse" onOpenChange={vi.fn()} />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(browseDirectories).toHaveBeenCalledWith({
        partialPath: "../",
        cwd: "/Users/admin/Projects/ADE",
        limit: 200,
      });
    });
    const inputs = await screen.findAllByPlaceholderText(
      /paste a path, type to filter, or drop a folder anywhere/i,
    );
    const input = inputs.at(-1) as HTMLInputElement;
    fireEvent.drop(input, {
      dataTransfer: { files: [new File(["stale"], "stale")] },
    });
    fireEvent.drop(input, {
      dataTransfer: { files: [new File(["fresh"], "fresh")] },
    });

    staleDrop.resolve({
      inputPath: "/Users/admin/Projects/StaleRepo/",
      resolvedPath: "/Users/admin/Projects/StaleRepo",
      directoryPath: "/Users/admin/Projects/StaleRepo",
      parentPath: "/Users/admin/Projects",
      exactDirectoryPath: "/Users/admin/Projects/StaleRepo",
      openableProjectRoot: "/Users/admin/Projects/StaleRepo",
      entries: [],
    });
    latestDrop.resolve({
      inputPath: "/Users/admin/Projects/FreshFolder/",
      resolvedPath: "/Users/admin/Projects/FreshFolder",
      directoryPath: "/Users/admin/Projects/FreshFolder",
      parentPath: "/Users/admin/Projects",
      exactDirectoryPath: "/Users/admin/Projects/FreshFolder",
      openableProjectRoot: null,
      entries: [],
    });

    await waitFor(() => {
      expect(switchProjectToPath).toHaveBeenCalledWith(
        "/Users/admin/Projects/FreshFolder",
      );
      expect(switchProjectToPath).toHaveBeenCalledTimes(1);
      expect(switchProjectToPath).not.toHaveBeenCalledWith(
        "/Users/admin/Projects/StaleRepo",
      );
      expect(browseDirectories).toHaveBeenCalledWith({
        partialPath: "/Users/admin/Projects/StaleRepo/",
        cwd: "/Users/admin/Projects/ADE",
        limit: 200,
      });
      expect(browseDirectories).toHaveBeenCalledWith({
        partialPath: "/Users/admin/Projects/FreshFolder/",
        cwd: "/Users/admin/Projects/ADE",
        limit: 200,
      });
    });
  });

  it("opens a project on another machine directly, even when matching local work is dirty", async () => {
    const switchRemoteProject = vi.fn(async () => {});
    seedStore({
      projectBinding: null,
      switchRemoteProject,
    });
    const remoteProject = {
      projectId: "project-remote-ade",
      rootPath: "/remote/ADE",
      displayName: "ADE",
      addedAt: 1,
      lastOpenedAt: 2,
      gitOriginUrl: "git@github.com:example/ade.git",
    };
    const remoteRuntime = {
      getConnectionSnapshot: vi.fn(async () => ({
        connectedCount: 1,
        updatedAt: Date.now(),
        connections: [
          {
            target: {
              id: "target-1",
              name: "Mac Studio",
              hostname: "studio.tailnet.ts.net",
              sshUser: "admin",
              port: 22,
              sshKeyPath: null,
              lastSeenArch: "darwin-arm64",
              runtimeBinaryVersion: "1.0.0",
              lastConnectedAt: Date.now(),
            },
            state: "connected",
            arch: "darwin-arm64",
            version: "1.0.0",
            projects: [],
            lastError: null,
            lastAttemptedAt: Date.now(),
            connectedAt: Date.now(),
          },
        ],
      })),
      onConnectionSnapshotChanged: vi.fn(() => () => {}),
      browseDirectories: vi.fn(async () => ({
        inputPath: "~/",
        resolvedPath: "/remote/ADE",
        directoryPath: "/remote/ADE",
        parentPath: "/remote",
        exactDirectoryPath: "/remote/ADE",
        openableProjectRoot: "/remote/ADE",
        entries: [],
      })),
      getProjectDetail: vi.fn(async () => ({
        rootPath: "/remote/ADE",
        isGitRepo: true,
        branchName: "main",
        dirtyCount: 0,
        dirtyBreakdown: null,
        aheadBehind: null,
        lastCommit: null,
        readmeExcerpt: null,
        languages: [],
        laneCount: null,
        lastOpenedAt: null,
        subdirectoryCount: null,
      })),
      addProject: vi.fn(async () => remoteProject),
    };
    globalThis.window.ade = {
      ...globalThis.window.ade,
      remoteRuntime,
    } as any;

    render(
      <MemoryRouter>
        <CommandPalette open intent="project-add" onOpenChange={vi.fn()} />
      </MemoryRouter>,
    );

    const machineButton = await screen.findByRole("button", {
      name: /Mac Studio/i,
    });
    fireEvent.click(machineButton);
    fireEvent.click(await screen.findByRole("button", { name: /OPEN/i }));

    await waitFor(() =>
      expect(remoteRuntime.browseDirectories).toHaveBeenCalledWith("target-1", {
        partialPath: "~/",
        cwd: null,
        limit: 200,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Open ADE/i }));

    // One tab per repo: switching the machine rebinds the existing tab, so the
    // old "this creates a separate tab" confirmation no longer applies.
    await waitFor(() =>
      expect(switchRemoteProject).toHaveBeenCalledWith(
        "target-1",
        "project-remote-ade",
      ),
    );
    expect(
      screen.queryByRole("dialog", {
        name: "You already work on this repo locally",
      }),
    ).toBeNull();
  });

  describe("threads", () => {
    it("lists recent threads with their lane context and marks the current one", async () => {
      seedThreads(
        [
          makeSession(),
          makeSession({
            id: "session-2",
            title: "Redesign ADE Sidebar UI",
            laneId: "lane-2",
            laneName: "sidebar",
            status: "completed",
            runtimeState: "exited",
            exitCode: 0,
            toolType: "shell",
            lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          }),
        ],
        {
          lanes: [
            makeLane(),
            makeLane({
              id: "lane-2",
              name: "sidebar",
              branchRef: "t3code/refine-ade-chat-sidebar",
            }),
          ],
          activeItemId: "session-2",
        },
      );

      render(
        <MemoryRouter>
          <CommandPalette open onOpenChange={vi.fn()} />
        </MemoryRouter>,
      );

      expect(await screen.findByText("Recent threads")).toBeTruthy();
      expect(screen.getByText("Redesign ADE Chat and Prompt UI")).toBeTruthy();
      // Project · branch, with the active session annotated in place.
      expect(
        screen.getByText("ADE · #t3code/refine-ade-chat-sidebar"),
      ).toBeTruthy();
      expect(screen.getByText(/Current thread/)).toBeTruthy();
    });

    it("matches threads on branch and lane name, not just title", async () => {
      seedThreads(
        [
          makeSession({ id: "session-1", title: "Alpha" }),
          makeSession({
            id: "session-2",
            title: "Beta",
            laneId: "lane-2",
            laneName: "payments",
          }),
        ],
        {
          lanes: [
            makeLane({ id: "lane-1", branchRef: "t3code/pty-foundation" }),
            makeLane({
              id: "lane-2",
              name: "payments",
              branchRef: "feat/stripe",
            }),
          ],
        },
      );

      render(
        <MemoryRouter>
          <CommandPalette open onOpenChange={vi.fn()} />
        </MemoryRouter>,
      );

      const input = screen.getByPlaceholderText(
        "Search commands, projects, and threads…",
      );

      // Branch-only hit: "pty-foundation" appears in neither title nor lane name.
      fireEvent.change(input, { target: { value: "pty-foundation" } });
      await waitFor(() => {
        expect(screen.getByText("Alpha")).toBeTruthy();
      });
      expect(screen.queryByText("Beta")).toBeNull();

      // Lane-name-only hit.
      fireEvent.change(input, { target: { value: "payments" } });
      await waitFor(() => {
        expect(screen.getByText("Beta")).toBeTruthy();
      });
      expect(screen.queryByText("Alpha")).toBeNull();
    });

    it("renders the status indicator from the shared tone classes", async () => {
      seedThreads([makeSession()]);

      render(
        <MemoryRouter>
          <CommandPalette open onOpenChange={vi.fn()} />
        </MemoryRouter>,
      );

      const status = await screen.findByTestId("thread-status-session-1");
      expect(status.textContent).toContain("Working");
      // The whole point of the redesign: one hue table. A running session is
      // blue, and both the word and the dot come from the shared maps.
      expect(status.className).toContain(SESSION_TONE_TEXT_CLASS.blue);
      const dot = status.querySelector("span");
      expect(dot?.className).toContain(SESSION_TONE_DOT_CLASS.blue);
    });

    it("omits the status indicator for calm threads", async () => {
      seedThreads([
        makeSession({
          status: "completed",
          runtimeState: "exited",
          exitCode: 0,
          toolType: "shell",
          settledAt: new Date().toISOString(),
        }),
      ]);

      render(
        <MemoryRouter>
          <CommandPalette open onOpenChange={vi.fn()} />
        </MemoryRouter>,
      );

      expect(await screen.findByText("Recent threads")).toBeTruthy();
      expect(screen.queryByTestId("thread-status-session-1")).toBeNull();
    });

    it("navigates to the Work tab and focuses the session when a thread is picked", async () => {
      const onOpenChange = vi.fn();
      const selectEvents: Array<{
        sessionId: string;
        laneId?: string;
        binding?: unknown;
      }> = [];
      const listener = (event: Event) => {
        selectEvents.push((event as CustomEvent).detail);
      };
      window.addEventListener("ade:work:select-session", listener);
      seedThreads([makeSession()]);

      render(
        <MemoryRouter>
          <LocationProbe />
          <CommandPalette open onOpenChange={onOpenChange} />
        </MemoryRouter>,
      );

      fireEvent.click(
        await screen.findByText("Redesign ADE Chat and Prompt UI"),
      );

      await waitFor(() => {
        expect(screen.getByTestId("location").textContent).toBe(
          "/work?sessionId=session-1&laneId=lane-1",
        );
      });
      expect(selectEvents).toEqual([
        { sessionId: "session-1", laneId: "lane-1" },
      ]);
      // A local thread carries no binding: the Work tab focuses it against the
      // already-current project, so the deeplink in the URL is the whole route.
      expect(selectEvents[0]?.binding).toBeUndefined();
      expect(onOpenChange).toHaveBeenCalledWith(false);
      window.removeEventListener("ade:work:select-session", listener);
    });

    it("caps the thread group and says how many matches are hidden", async () => {
      // Age BOTH timestamps: `recencyRank` takes the max of them, so leaving
      // `startedAt` at the default "now" would make all 12 rows equally recent
      // and hand the order to sub-millisecond loop timing.
      const base = Date.now();
      seedThreads(
        Array.from({ length: 12 }, (_, i) => {
          const iso = new Date(base - i * 60_000).toISOString();
          return makeSession({
            id: `session-${i}`,
            title: `Thread ${i}`,
            startedAt: iso,
            lastActivityAt: iso,
          });
        }),
      );

      render(
        <MemoryRouter>
          <CommandPalette open onOpenChange={vi.fn()} />
        </MemoryRouter>,
      );

      expect(await screen.findByText("Recent threads")).toBeTruthy();
      expect(
        screen.getByText(/Showing 8 of 12 threads/),
      ).toBeTruthy();
      expect(screen.getByText(/Showing 8 of 12 threads/).getAttribute("aria-hidden")).toBeNull();
      // Newest first, oldest past the cap dropped.
      expect(screen.getByText("Thread 0")).toBeTruthy();
      expect(screen.queryByText("Thread 8")).toBeNull();
    });

    it("renders the persistent keyboard hint footer", async () => {
      seedStore();

      render(
        <MemoryRouter>
          <CommandPalette open onOpenChange={vi.fn()} />
        </MemoryRouter>,
      );

      expect(await screen.findByText("Navigate")).toBeTruthy();
      expect(screen.getByText("Select")).toBeTruthy();
      expect(screen.getByText("Close")).toBeTruthy();
    });

    // The Work sidebar is a union across every connected machine, always. The
    // palette is that sidebar's search, so a thread the user can see one pane
    // over must be findable here — anything less answers "no results" for work
    // that is plainly on screen.
    describe("across machines", () => {
      it("lists a thread from another machine and marks it with that machine", async () => {
        seedThreads([makeSession()], {
          machines: { "target-studio": makeForeignMachine() },
        });

        render(
          <MemoryRouter>
            <CommandPalette open onOpenChange={vi.fn()} />
          </MemoryRouter>,
        );

        expect(await screen.findByText("Ship the release notes")).toBeTruthy();
        // Local and foreign rows share one group — the machine is a property of
        // the row, not a separate section.
        expect(screen.getByText("Redesign ADE Chat and Prompt UI")).toBeTruthy();

        const row = document.querySelector<HTMLElement>(
          '[data-thread-id="session-remote-1"]',
        );
        expect(row?.dataset.machineId).toBe("target-studio");
        // Identity, not status: the marker lives in the context line, so the
        // row's status slot is still free for the session's own state.
        const marker = row?.querySelector<HTMLElement>("[data-machine-marker-mode]");
        expect(marker?.textContent).toContain("Mac Studio");
        expect(
          screen.getByTestId("thread-status-session-remote-1").contains(marker!),
        ).toBe(false);
        // The foreign lane resolves through its OWN machine's lane list, not
        // the locally-bound project's.
        expect(screen.getByText("ADE · #t3code/release-notes")).toBeTruthy();
      });

      it("labels a foreign thread with its bound project rather than the current project", async () => {
        seedThreads([makeSession()], {
          machines: {
            "target-studio": makeForeignMachine({
              binding: { ...REMOTE_BINDING, displayName: "Remote Tools" },
            }),
          },
        });

        render(
          <MemoryRouter>
            <CommandPalette open onOpenChange={vi.fn()} />
          </MemoryRouter>,
        );

        expect(await screen.findByText("Remote Tools · #t3code/release-notes")).toBeTruthy();
      });

      it("matches a thread on its machine name", async () => {
        seedThreads([makeSession()], {
          machines: { "target-studio": makeForeignMachine() },
        });

        render(
          <MemoryRouter>
            <CommandPalette open onOpenChange={vi.fn()} />
          </MemoryRouter>,
        );

        const input = screen.getByPlaceholderText(
          "Search commands, projects, and threads…",
        );
        // "studio" appears in neither title, lane name, nor branch.
        fireEvent.change(input, { target: { value: "studio" } });

        await waitFor(() => {
          expect(screen.getByText("Ship the release notes")).toBeTruthy();
        });
        expect(screen.queryByText("Redesign ADE Chat and Prompt UI")).toBeNull();
      });

      it("keeps an offline machine's threads findable but receded", async () => {
        seedThreads([], {
          machines: {
            "target-studio": makeForeignMachine({ online: false }),
          },
        });

        render(
          <MemoryRouter>
            <CommandPalette open onOpenChange={vi.fn()} />
          </MemoryRouter>,
        );

        expect(await screen.findByText("Ship the release notes")).toBeTruthy();

        const row = document.querySelector<HTMLElement>(
          '[data-thread-id="session-remote-1"]',
        );
        // Same attribute the sidebar puts on a receded cross-machine group.
        expect(row?.dataset.dimmed).toBe("true");
        expect(row?.dataset.machineOnline).toBe("false");
        // The status is the LAST THING REPORTED, not a live claim — a dropped
        // machine's chat still reads "Working" — so it must not look as
        // trustworthy as a live row.
        const status = screen.getByTestId("thread-status-session-remote-1");
        expect(status.textContent).toContain("Working");
        expect(status.closest("[data-dimmed]")).toBe(row);
      });

      it("routes a foreign thread through its binding instead of a stale deeplink", async () => {
        const onOpenChange = vi.fn();
        const selectEvents: Array<{
          sessionId: string;
          laneId?: string;
          binding?: unknown;
        }> = [];
        const listener = (event: Event) => {
          selectEvents.push((event as CustomEvent).detail);
        };
        window.addEventListener("ade:work:select-session", listener);
        seedThreads([], {
          machines: { "target-studio": makeForeignMachine() },
        });

        render(
          <MemoryRouter>
            <LocationProbe />
            <CommandPalette open onOpenChange={onOpenChange} />
          </MemoryRouter>,
        );

        fireEvent.click(await screen.findByText("Ship the release notes"));

        expect(selectEvents).toEqual([
          {
            sessionId: "session-remote-1",
            laneId: "lane-remote",
            binding: REMOTE_BINDING,
          },
        ]);
        // The tab still switches to Work, but WITHOUT the session deeplink: the
        // project switch the listener starts is async, and `useWorkSessions`
        // would resolve `?sessionId=` against the still-current project a tick
        // from now, find nothing, and strip it. The binding is the durable
        // route; the listener focuses once the switch resolves.
        await waitFor(() => {
          expect(screen.getByTestId("location").textContent).toBe("/work");
        });
        expect(onOpenChange).toHaveBeenCalledWith(false);
        window.removeEventListener("ade:work:select-session", listener);
      });

      it("never lists a session twice when the union overlaps the local list", async () => {
        // While the tab is bound remotely, that machine's slice and the local
        // session list are the same rows. "Never show one session twice" is the
        // invariant; the local entry wins so it keeps the local routing path.
        seedThreads([makeSession()], {
          machines: {
            "target-studio": makeForeignMachine({
              sessions: [makeSession(), makeSession({ id: "session-remote-1" })],
            }),
          },
        });

        render(
          <MemoryRouter>
            <CommandPalette open onOpenChange={vi.fn()} />
          </MemoryRouter>,
        );

        await screen.findByText("Recent threads");
        expect(
          document.querySelectorAll('[data-thread-id="session-1"]'),
        ).toHaveLength(1);
        // The deduped row keeps the LOCAL identity — so picking it takes the
        // synchronous path. It is attributed to this Mac rather than to nothing
        // (that is what makes it findable by machine name), and attribution is
        // precisely what withholds the marker: a badge means "not here".
        const row = document.querySelector<HTMLElement>('[data-thread-id="session-1"]');
        expect(row?.dataset.machineId).toBe(THIS_MACHINE_ID);
        expect(row?.dataset.machineOnline).toBeUndefined();
        expect(row?.querySelector("[data-machine-marker-mode]")).toBeNull();
      });

      it("finds a remote-bound tab's own threads by that machine's name", async () => {
        // The payoff of attributing the tab's own sessions. The scorer has always
        // matched machine names; those entries simply had no machine to match,
        // so with the tab bound to the Studio, typing "studio" found every
        // thread on every OTHER machine and none of the ones right in front of
        // you.
        // A remote-bound tab keys its caches by the BINDING key, not the root
        // path — see `selectActiveProjectStateKey`.
        const boundKey = "remote:target-studio:project-a";
        seedStore({
          projectBinding: {
            kind: "remote",
            key: boundKey,
            targetId: "target-studio",
            runtimeName: "Arul's Mac Studio",
            projectId: "project-a",
            rootPath: PROJECT_ROOT,
            displayName: "Repo A",
          },
          lanes: [makeLane()],
          sessionsCacheByProject: {
            [boundKey]: [makeSession({ id: "session-1", title: "Audit rebase settings" })],
          },
          workViewByProject: { [boundKey]: { activeItemId: null } },
          crossMachineLanesByMachineId: {
            "target-studio": makeForeignMachine({ online: false, sessions: [] }),
          },
        });

        render(
          <MemoryRouter>
            <CommandPalette open onOpenChange={vi.fn()} />
          </MemoryRouter>,
        );

        await screen.findByText("Recent threads");
        fireEvent.change(
          screen.getByPlaceholderText("Search commands, projects, and threads…"),
          { target: { value: "studio" } },
        );

        const row = await waitFor(() => {
          const found = document.querySelector<HTMLElement>('[data-thread-id="session-1"]');
          expect(found).toBeTruthy();
          return found!;
        });
        // Found by machine, and marked as elsewhere — the tab points at the
        // Studio but the app is running on this Mac.
        expect(row.dataset.machineId).toBe("target-studio");
        expect(row.dataset.machineOnline).toBe("false");
        expect(row.dataset.dimmed).toBe("true");
        expect(row.querySelector("[data-machine-marker-mode]")).toBeTruthy();
      });

      it("uses the bound target connection when its retained Work slice is absent", async () => {
        const boundKey = "remote:target-studio:project-a";
        seedStore({
          projectBinding: {
            kind: "remote",
            key: boundKey,
            targetId: "target-studio",
            runtimeName: "Arul's Mac Studio",
            projectId: "project-a",
            rootPath: PROJECT_ROOT,
            displayName: "Repo A",
          },
          lanes: [makeLane()],
          sessionsCacheByProject: {
            [boundKey]: [makeSession({ id: "session-1", title: "Audit rebase settings" })],
          },
          workViewByProject: { [boundKey]: { activeItemId: null } },
          // The work-union refresh is still in flight, so it has not retained
          // a lane slice for the bound target yet.
          crossMachineLanesByMachineId: {},
        });
        globalThis.window.ade.remoteRuntime = {
          getConnectionSnapshot: vi.fn(async () => ({
            connectedCount: 0,
            updatedAt: Date.now(),
            connections: [{
              target: { id: "target-studio", name: "Arul's Mac Studio" },
              state: "error",
              projects: [],
              lastError: "Connection lost",
              lastAttemptedAt: Date.now(),
              connectedAt: null,
              arch: null,
              version: null,
            }],
          })),
          onConnectionSnapshotChanged: vi.fn(() => () => {}),
        } as any;

        render(
          <MemoryRouter>
            <CommandPalette open onOpenChange={vi.fn()} />
          </MemoryRouter>,
        );

        const row = await waitFor(() => {
          const found = document.querySelector<HTMLElement>('[data-thread-id="session-1"]');
          expect(found?.dataset.machineOnline).toBe("false");
          return found!;
        });
        expect(row.dataset.dimmed).toBe("true");
        expect(row.querySelector("[data-machine-marker-mode]")).toBeTruthy();
      });
    });
  });
});
