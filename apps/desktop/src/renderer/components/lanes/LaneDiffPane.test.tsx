/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileDiff, FilePatch, GitCommitSummary } from "../../../shared/types";
import { LaneDiffPane } from "./LaneDiffPane";

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div data-testid="resize-group">{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}));

vi.mock("../shared/AdeDiffViewer", () => ({
  AdeDiffViewer: React.forwardRef((_props: unknown, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({
      getModifiedValue: () => "updated text",
      revealLineInCenter: vi.fn(),
    }));
    return <div data-testid="ade-diff-viewer" />;
  }),
}));

const originalAde = window.ade;

const commit: GitCommitSummary = {
  sha: "abc123def456",
  shortSha: "abc123d",
  parents: ["parent123"],
  authorName: "Ada Developer",
  authoredAt: "2026-05-12T00:00:00.000Z",
  subject: "Update many files",
  pushed: false,
};

function fileDiff(path: string): FileDiff {
  return {
    path,
    mode: "unstaged",
    original: { exists: true, text: "before" },
    modified: { exists: true, text: "after" },
  };
}

function filePatch(path: string, patch = "@@ -1 +1 @@\n-before\n+after\n"): FilePatch {
  return {
    path,
    mode: "unstaged",
    patch,
    additions: 1,
    deletions: 1,
    status: "modified",
  };
}

function installDiffApi({
  commitFiles = [],
  getFile = vi.fn().mockResolvedValue(fileDiff("src/file-0.ts")),
  getFilePatch = vi.fn().mockResolvedValue(filePatch("src/file-0.ts")),
}: {
  commitFiles?: string[];
  getFile?: ReturnType<typeof vi.fn>;
  getFilePatch?: ReturnType<typeof vi.fn>;
} = {}) {
  const api = {
    git: {
      listCommitFiles: vi.fn().mockResolvedValue(commitFiles),
    },
    diff: {
      getFile,
      getFilePatch,
    },
  };
  window.ade = api as unknown as typeof window.ade;
  return api;
}

function renderPane(props: Partial<React.ComponentProps<typeof LaneDiffPane>> = {}) {
  render(
    <MemoryRouter>
      <LaneDiffPane
        laneId="lane-1"
        selectedPath={null}
        selectedFileMode={null}
        selectedCommit={null}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("LaneDiffPane", () => {
  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (window as unknown as { ade?: unknown }).ade;
    } else {
      window.ade = originalAde;
    }
  });

  it("shows all commit files after the bounded commit file list", async () => {
    const user = userEvent.setup();
    const commitFiles = Array.from({ length: 503 }, (_, index) => `src/generated/file-${index}.ts`);
    const api = installDiffApi({ commitFiles });

    renderPane({ selectedCommit: commit });

    expect(await screen.findByText("Showing first 500 of 503 files.")).toBeTruthy();
    expect(screen.getByText("src/generated/file-0.ts")).toBeTruthy();
    expect(screen.queryByText("src/generated/file-500.ts")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show all" }));

    expect(screen.getByText("src/generated/file-500.ts")).toBeTruthy();
    expect(api.git.listCommitFiles).toHaveBeenCalledWith({ laneId: "lane-1", commitSha: commit.sha });
  });

  it("retries a failed working-tree diff", async () => {
    const user = userEvent.setup();
    let fail = true;
    const getFile = vi.fn(async () => {
      if (fail) throw new Error("diff unavailable");
      return fileDiff("src/app.ts");
    });
    const getFilePatch = vi.fn(async () => filePatch("src/app.ts", ""));
    installDiffApi({ getFile, getFilePatch });

    renderPane({ selectedPath: "src/app.ts", selectedFileMode: "unstaged" });

    expect(await screen.findByText("Failed to load diff")).toBeTruthy();

    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(getFile).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("ade-diff-viewer")).toBeTruthy();
  });
});
