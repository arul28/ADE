/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneGitHubIssue } from "../../../shared/types";
import { GitHubIssueSelectModal } from "./GitHubIssueSelectModal";

const issueRow = (number: number) => ({
  number,
  title: `Issue ${number}`,
  html_url: `https://github.com/acme/app/issues/${number}`,
  state: "open",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
});

const selected = (number: number) => ({
  id: `acme/app#${number}`,
  number,
  owner: "acme",
  repo: "app",
  title: `Issue ${number}`,
  url: `https://github.com/acme/app/issues/${number}`,
  state: "open",
}) as LaneGitHubIssue;

// Settle every load the picker started: each round flushes React effects and
// the resolved IPC promises behind them. A reload loop keeps calling through
// all of them.
async function settle() {
  for (let round = 0; round < 10; round += 1) {
    await act(async () => {});
  }
}

describe("GitHubIssueSelectModal", () => {
  const originalAde = globalThis.window.ade;
  let listRepoIssues: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Past a handful of calls, stop answering: a reload loop then stalls and
    // fails on the call count instead of spinning until the test times out.
    listRepoIssues = vi.fn((): Promise<unknown[]> =>
      listRepoIssues.mock.calls.length > 5 ? new Promise(() => {}) : Promise.resolve([issueRow(7)]));
    globalThis.window.ade = {
      github: {
        detectRepo: vi.fn(async () => ({ owner: "acme", name: "app" })),
        listRepoIssues,
      },
    } as unknown as typeof window.ade;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.ade = originalAde;
  });

  it("loads issues once per selection and filter, not once per render", async () => {
    const props = { open: true, onOpenChange: () => {}, onSelectIssue: () => {} };
    const view = render(<GitHubIssueSelectModal {...props} selectedIssue={selected(3)} />);
    await settle();
    expect(await screen.findByText("Issue 7")).toBeTruthy();
    expect(listRepoIssues).toHaveBeenCalledTimes(1);

    // A parent re-render hands over a new object for the same issue.
    view.rerender(<GitHubIssueSelectModal {...props} selectedIssue={selected(3)} />);
    await settle();
    expect(listRepoIssues).toHaveBeenCalledTimes(1);

    view.rerender(<GitHubIssueSelectModal {...props} selectedIssue={selected(4)} />);
    await settle();
    expect(listRepoIssues).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "closed" }));
    await settle();
    expect(listRepoIssues).toHaveBeenCalledTimes(3);
    expect(listRepoIssues).toHaveBeenLastCalledWith({ owner: "acme", name: "app", state: "closed" });
  });
});
