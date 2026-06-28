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
import { MemoryRouter } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
import { PROJECT_BROWSER_CLOSE_EVENT } from "../../lib/projectBrowserEvents";
import { useAppStore } from "../../state/appStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function seedStore(overrides: Record<string, unknown> = {}) {
  useAppStore.setState({
    project: {
      rootPath: "/Users/admin/Projects/ADE",
      displayName: "ADE",
      baseRef: "main",
    },
    lanes: [],
    selectedLaneId: null,
    selectLane: vi.fn(),
    switchProjectToPath: vi.fn(async () => {}),
    ...overrides,
  } as any);
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

  it("warns before opening a remote project when matching local work is dirty", async () => {
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
      checkLocalWork: vi.fn(async () => ({
        remoteProjectId: remoteProject.projectId,
        remoteDisplayName: remoteProject.displayName,
        remoteGitOriginUrl: remoteProject.gitOriginUrl,
        hasDirtyWork: true,
        matches: [
          {
            rootPath: "/Users/admin/Projects/ADE",
            displayName: "ADE",
            gitOriginUrl: "git@github.com:example/ade.git",
            dirtyCount: 3,
            workSummary: {
              rootPath: "/Users/admin/Projects/ADE",
              laneCount: 1,
              checkedLaneCount: 1,
              dirtyLaneCount: 1,
              dirtyFileCount: 3,
              primaryDirtyCount: 3,
              lanes: [
                {
                  rootPath: "/Users/admin/Projects/ADE",
                  name: "main",
                  branchName: "main",
                  dirtyCount: 3,
                  isPrimary: true,
                },
              ],
            },
          },
        ],
      })),
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

    await waitFor(() =>
      expect(
        screen.getByRole("dialog", {
          name: "You already work on this repo locally",
        }),
      ).toBeTruthy(),
    );
    expect(screen.getAllByText("Changes").length).toBeGreaterThan(0);
    expect(screen.getByTitle(/Primary.*3 files/)).toBeTruthy();
    expect(screen.getAllByTitle("/Users/admin/Projects/ADE").length).toBeGreaterThan(0);
    expect(switchRemoteProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open on Mac Studio" }));
    await waitFor(() =>
      expect(switchRemoteProject).toHaveBeenCalledWith(
        "target-1",
        "project-remote-ade",
      ),
    );
  });
});
