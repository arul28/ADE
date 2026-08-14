/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectBrowseResult } from "../../../shared/types";
import { CreateProjectForm } from "./CreateProjectForm";

function emptyBrowse(): ProjectBrowseResult {
  return {
    inputPath: "",
    resolvedPath: "",
    directoryPath: "",
    parentPath: null,
    exactDirectoryPath: null,
    openableProjectRoot: null,
    entries: [],
  };
}

describe("CreateProjectForm", () => {
  afterEach(() => {
    cleanup();
  });
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/Users/test";
  const defaultParent = `${home.replace(/\\/g, "/")}/Projects`;

  it("shows the default location and opens the folder picker from Change", async () => {
    const getDefaultParentDir = vi.fn(async () => defaultParent);
    const chooseDirectory = vi.fn(async () => `${home.replace(/\\/g, "/")}/Code`);
    const browseDirectories = vi.fn(async () => emptyBrowse());
    const createProject = vi.fn();

    render(
      <CreateProjectForm
        onCancel={vi.fn()}
        onCreated={vi.fn()}
        getDefaultParentDir={getDefaultParentDir}
        browseDirectories={browseDirectories}
        chooseDirectory={chooseDirectory}
        createProject={createProject}
      />,
    );

    expect(await screen.findByText("~/Projects")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^change$/i }));
    await waitFor(() => {
      expect(chooseDirectory).toHaveBeenCalledWith({
        title: "Choose where to create the project",
        defaultPath: defaultParent,
      });
    });
    expect(await screen.findByDisplayValue(`${home.replace(/\\/g, "/")}/Code`)).toBeTruthy();
  });

  it("creates then reports the project without a success interstitial", async () => {
    const onCreated = vi.fn();
    const createProject = vi.fn(async () => ({
      rootPath: `${defaultParent}/spark`,
    }));

    render(
      <CreateProjectForm
        onCancel={vi.fn()}
        onCreated={onCreated}
        getDefaultParentDir={async () => defaultParent}
        browseDirectories={async () => emptyBrowse()}
        chooseDirectory={vi.fn()}
        createProject={createProject}
      />,
    );

    await screen.findByPlaceholderText("my-new-project");
    const name = screen.getByPlaceholderText("my-new-project");
    fireEvent.change(name, { target: { value: "spark" } });
    fireEvent.click(screen.getByRole("button", { name: /create and open/i }));

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith({
        name: "spark",
        parentDir: defaultParent,
      });
      expect(onCreated).toHaveBeenCalledWith({
        rootPath: `${defaultParent}/spark`,
        displayName: "spark",
        projectId: undefined,
      });
    });
  });

  it("keeps Create and open disabled until the open callback finishes", async () => {
    let resolveOpen!: () => void;
    const onCreated = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const createProject = vi.fn(async () => ({
      rootPath: `${defaultParent}/spark`,
    }));

    render(
      <CreateProjectForm
        onCancel={vi.fn()}
        onCreated={onCreated}
        getDefaultParentDir={async () => defaultParent}
        browseDirectories={async () => emptyBrowse()}
        chooseDirectory={vi.fn()}
        createProject={createProject}
      />,
    );

    await screen.findByPlaceholderText("my-new-project");
    fireEvent.change(screen.getByPlaceholderText("my-new-project"), {
      target: { value: "spark" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create and open/i }));

    await screen.findByText("Opening…");
    expect(screen.getByRole("button", { name: /opening/i })).toHaveProperty("disabled", true);
    resolveOpen();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create and open/i })).toHaveProperty(
        "disabled",
        false,
      );
    });
  });
});
