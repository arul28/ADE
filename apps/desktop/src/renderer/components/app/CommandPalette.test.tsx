/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
import { useAppStore } from "../../state/appStore";
import { THIS_MACHINE_ID } from "../../../shared/machineIdentity";

/** Surfaces the router location so navigation assertions read the real URL. */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

const PROJECT_ROOT = "/Users/admin/Projects/ADE";

/** The tab's copy of the project, on this computer. */
const TAB_BINDING = { kind: "local", key: `local:${PROJECT_ROOT}`, rootPath: PROJECT_ROOT, displayName: "ADE" } as const;

function seedStore(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    project: {
      rootPath: PROJECT_ROOT,
      displayName: "ADE",
      baseRef: "main",
    },
    lanes: [],
    selectedLaneId: null,
    projectBinding: TAB_BINDING,
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
    branchRef: "feature/redesign-new-chat-ui",
    worktreePath: "/tmp/wt/redesign",
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
        branchRef: "feature/release-notes",
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
        // The add form reads this computer's recents and its default folder when it opens.
        listRecent: vi.fn(async () => []),
        getDefaultParentDir: vi.fn(async () => "/Users/admin/Projects"),
      },
    } as any;
  });

  // The shared test setup doesn't auto-unmount, so without this each test's
  // dialog would linger in the DOM and `getAll*` queries would match elements
  // (e.g. the inline "Open" buttons) from previously mounted components.
  afterEach(() => {
    cleanup();
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
      getDefaultParentDir: vi.fn(async () => "/remote"),
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

    // Add project opens on its form; "Open a folder…" acts on the computer picked under it.
    const computer = await screen.findByRole("combobox", { name: "Computer for the folder or new project" });
    fireEvent.change(computer, { target: { value: "target-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Open a folder/i }));

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
    it("shows lifecycle actions on the highlighted Work result and targets that session", async () => {
      const settle = vi.fn(async () => {});
      globalThis.window.ade.sessions = { settle } as any;
      const onOpenChange = vi.fn();
      seedThreads([makeSession({
        id: "session-to-settle",
        title: "Settle this chat",
        status: "completed",
        runtimeState: "exited",
        exitCode: 0,
        endedAt: new Date().toISOString(),
      })]);

      render(
        <MemoryRouter>
          <CommandPalette open onOpenChange={onOpenChange} />
        </MemoryRouter>,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Settle session" }));

      await waitFor(() => {
        expect(settle).toHaveBeenCalledWith("session-to-settle", undefined, TAB_BINDING);
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it("persists a new-chat draft before navigating when Work is not mounted", async () => {
      const onOpenChange = vi.fn();
      seedThreads([makeSession({ title: "Start a follow-up chat" })]);

      render(
        <MemoryRouter initialEntries={["/lanes"]}>
          <LocationProbe />
          <CommandPalette open onOpenChange={onOpenChange} />
        </MemoryRouter>,
      );

      fireEvent.click(
        await screen.findByRole("button", { name: "New chat in redesign" }),
      );

      await waitFor(() => {
        expect(screen.getByTestId("location").textContent).toBe("/work");
        expect(useAppStore.getState().workViewByProject[PROJECT_ROOT]).toMatchObject({
          draftKind: "chat",
          draftLaneId: "lane-1",
          draftMachineId: null,
          activeItemId: null,
          selectedItemId: null,
          workSidebarOpen: false,
        });
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it.each([
      { online: true, drafted: true },
      { online: false, drafted: false },
    ])("drafts a new chat on another machine's lane without moving the tab (online: $online)", async ({ online, drafted }) => {
      const switchRemoteProject = vi.fn();
      const onOpenChange = vi.fn();
      seedStore({
        switchRemoteProject,
        sessionsCacheByProject: { [PROJECT_ROOT]: [] },
        workViewByProject: {},
        crossMachineLanesByMachineId: {
          "target-studio": makeForeignMachine({ online }),
        },
      });

      render(
        <MemoryRouter initialEntries={["/lanes"]}>
          <LocationProbe />
          <CommandPalette open onOpenChange={onOpenChange} />
        </MemoryRouter>,
      );

      const newChat = await screen.findByRole("button", { name: "New chat in release" });
      fireEvent.click(newChat);

      if (drafted) {
        await waitFor(() => {
          expect(screen.getByTestId("location").textContent).toBe("/work");
        });
        // The draft lives in this tab's project and names the lane's machine.
        expect(useAppStore.getState().workViewByProject[PROJECT_ROOT]).toMatchObject({
          draftKind: "chat",
          draftLaneId: "lane-remote",
          draftMachineId: "target-studio",
        });
        expect(onOpenChange).toHaveBeenCalledWith(false);
      } else {
        await act(async () => { await Promise.resolve(); });
        expect(useAppStore.getState().workViewByProject[PROJECT_ROOT]).toBeUndefined();
        expect(screen.getByTestId("location").textContent).toBe("/lanes");
      }
      expect(switchRemoteProject).not.toHaveBeenCalled();
      expect(useAppStore.getState().workViewByProject[REMOTE_BINDING.key]).toBeUndefined();
    });

    // The Work sidebar is a union across every connected machine, always. The
    // palette is that sidebar's search, so a thread the user can see one pane
    // over must be findable here — anything less answers "no results" for work
    // that is plainly on screen.
    describe("across machines", () => {
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
        // The tab still switches to Work, but WITHOUT the session deeplink: a
        // foreign `?sessionId=` would resolve against this project a tick from
        // now, find nothing, and strip. The binding is the durable route; the
        // listener pins and focuses without rebinding the tab.
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
      });

      it("keeps the active remote binding on row actions", async () => {
        const boundKey = "remote:target-studio:project-a";
        const settle = vi.fn(async () => {});
        globalThis.window.ade.sessions = { settle } as any;
        seedStore({
          projectBinding: {
            ...REMOTE_BINDING,
            key: boundKey,
            projectId: "project-a",
            rootPath: PROJECT_ROOT,
          },
          lanes: [makeLane()],
          sessionsCacheByProject: {
            [boundKey]: [makeSession({
              id: "remote-session-to-settle",
              title: "Remote completed chat",
              status: "completed",
              runtimeState: "exited",
              endedAt: new Date().toISOString(),
            })],
          },
          workViewByProject: { [boundKey]: { activeItemId: null } },
        });

        render(
          <MemoryRouter>
            <CommandPalette open onOpenChange={vi.fn()} />
          </MemoryRouter>,
        );

        fireEvent.click(await screen.findByRole("button", { name: "Settle session" }));

        await waitFor(() => {
          expect(settle).toHaveBeenCalledWith(
            "remote-session-to-settle",
            undefined,
            expect.objectContaining({
              kind: "remote",
              targetId: "target-studio",
              projectId: "project-a",
            }),
          );
        });
      });
    });
  });
});
