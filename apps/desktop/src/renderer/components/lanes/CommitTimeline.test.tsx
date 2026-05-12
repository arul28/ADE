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
});
