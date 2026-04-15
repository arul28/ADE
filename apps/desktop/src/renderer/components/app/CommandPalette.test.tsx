/* @vitest-environment jsdom */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CommandPalette } from "./CommandPalette";
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
  const getDetail = vi.fn();
  const getDroppedPath = vi.fn(() => "");

  beforeEach(() => {
    browseDirectories.mockReset();
    chooseDirectory.mockReset();
    getDetail.mockReset();
    getDetail.mockResolvedValue({
      rootPath: "/Users/admin/Projects/Versic",
      isGitRepo: true,
      branchName: "main",
      dirtyCount: 0,
      aheadBehind: null,
      lastCommit: null,
      readmeExcerpt: null,
      languages: [],
      laneCount: null,
      lastOpenedAt: null,
      subdirectoryCount: null,
    });
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
      },
    } as any;
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
        <CommandPalette
          open
          intent="project-browse"
          onOpenChange={vi.fn()}
        />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(browseDirectories).toHaveBeenCalledWith({
        partialPath: "../",
        cwd: "/Users/admin/Projects/ADE",
        limit: 200,
      });
    });

    expect(await screen.findByRole("button", { name: /open directory/i })).toBeTruthy();
    expect(screen.getByText("Versic")).toBeTruthy();
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
        <CommandPalette
          open
          intent="project-browse"
          onOpenChange={vi.fn()}
        />
      </MemoryRouter>
    );

    const button = await screen.findByRole("button", { name: /open directory/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(chooseDirectory).toHaveBeenCalledWith({
        title: "Open project",
        defaultPath: "/Users/admin/Projects",
      });
      expect(switchProjectToPath).toHaveBeenCalledWith(
        "/Users/admin/Projects/Versic"
      );
    });
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
        <CommandPalette
          open
          intent="project-browse"
          onOpenChange={vi.fn()}
        />
      </MemoryRouter>
    );

    const inputs = await screen.findAllByPlaceholderText(/paste a path, type to filter, or drop a folder anywhere/i);
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
      expect(switchProjectToPath).toHaveBeenCalledWith("/Users/admin/Projects/FreshFolder");
      expect(switchProjectToPath).toHaveBeenCalledTimes(1);
      expect(browseDirectories).toHaveBeenCalledTimes(3);
    });
  });
});
