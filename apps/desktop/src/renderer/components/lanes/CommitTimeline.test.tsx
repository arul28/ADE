/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommitSummary } from "../../../shared/types";
import { CommitTimeline } from "./CommitTimeline";

function buildCommit(overrides: Partial<GitCommitSummary> = {}): GitCommitSummary {
  return {
    sha: overrides.sha ?? "3333333333333333333333333333333333333333",
    shortSha: overrides.shortSha ?? "3333333",
    subject: overrides.subject ?? "Newest commit",
    authorName: overrides.authorName ?? "ADE",
    authoredAt: overrides.authoredAt ?? "2026-03-30T12:00:00.000Z",
    parents: overrides.parents ?? ["2222222222222222222222222222222222222222"],
    pushed: overrides.pushed ?? false,
  };
}

describe("CommitTimeline", () => {
  const originalAde = globalThis.window.ade;
  let originalScrollHeight: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 640,
    });

    globalThis.window.ade = {
      git: {
        listRecentCommits: vi.fn(async () => [
          buildCommit({
            sha: "cccccccccccccccccccccccccccccccccccccccc",
            shortSha: "ccccccc",
            subject: "Newest commit",
            authoredAt: "2026-03-30T12:00:00.000Z",
          }),
          buildCommit({
            sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            shortSha: "bbbbbbb",
            subject: "Middle commit",
            authoredAt: "2026-03-29T12:00:00.000Z",
            parents: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          }),
          buildCommit({
            sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            shortSha: "aaaaaaa",
            subject: "Oldest commit",
            authoredAt: "2026-03-28T12:00:00.000Z",
            parents: ["9999999999999999999999999999999999999999"],
            pushed: true,
          }),
        ]),
        listCommitFiles: vi.fn(async () => []),
        getCommitMessage: vi.fn(async () => ""),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
    } else {
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
    if (originalAde === undefined) {
      delete (globalThis.window as typeof globalThis.window & { ade?: unknown }).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("shows the newest commits first by initially scrolling to the bottom of the timeline", async () => {
    const { container } = render(
      <CommitTimeline
        laneId="lane-1"
        selectedSha={null}
        onSelectCommit={vi.fn()}
      />,
    );

    const scrollContainer = container.querySelector(".overflow-auto");
    expect(scrollContainer).toBeInstanceOf(HTMLDivElement);

    await waitFor(() => {
      expect(globalThis.window.ade.git.listRecentCommits).toHaveBeenCalledWith({ laneId: "lane-1", limit: 40 });
      expect((scrollContainer as HTMLDivElement).scrollTop).toBe(640);
    });
  });
});
