/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitTimeline } from "./CommitTimeline";

describe("CommitTimeline", () => {
  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  it("shows a lane-state message when the lane worktree is missing", async () => {
    (window as any).ade = {
      git: {
        listRecentCommits: vi.fn(async () => {
          throw new Error(
            "Error invoking remote method 'ade.git.listRecentCommits': Lane worktree is missing. Restore or recreate the lane worktree at /tmp/missing before viewing history.",
          );
        }),
      },
    };

    render(
      <CommitTimeline
        laneId="lane-1"
        selectedSha={null}
        onSelectCommit={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Lane worktree is missing\./)).toBeTruthy();
    });
    expect(screen.getByText(/Restore or recreate the lane worktree at \/tmp\/missing before viewing history\./)).toBeTruthy();
  });

  it("does not load commits while inactive", () => {
    const listRecentCommits = vi.fn(async () => []);
    (window as any).ade = {
      git: { listRecentCommits },
    };

    render(
      <CommitTimeline
        laneId="lane-1"
        active={false}
        selectedSha={null}
        onSelectCommit={vi.fn()}
      />,
    );

    expect(listRecentCommits).not.toHaveBeenCalled();
  });

  it("loads commits when an inactive timeline becomes active", async () => {
    const listRecentCommits = vi.fn(async () => []);
    (window as any).ade = {
      git: { listRecentCommits },
    };

    const view = render(
      <CommitTimeline
        laneId="lane-1"
        active={false}
        selectedSha={null}
        onSelectCommit={vi.fn()}
      />,
    );
    expect(listRecentCommits).not.toHaveBeenCalled();

    view.rerender(
      <CommitTimeline
        laneId="lane-1"
        active
        selectedSha={null}
        onSelectCommit={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(listRecentCommits).toHaveBeenCalledWith({ laneId: "lane-1", limit: 40 });
    });
  });
});
