/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubStackInspector } from "./GitHubStackInspector";
import type { GitHubPrListItem, GitHubPrStack, GitHubStackMutationResult } from "../../../../shared/types";

afterEach(cleanup);

function stack(over: Partial<GitHubPrStack> = {}): GitHubPrStack {
  return {
    id: "stack-1",
    number: 4,
    nodeId: null,
    repoOwner: "ade",
    repoName: "desktop",
    baseBranch: "main",
    open: true,
    createdAt: "2026-03-24T12:00:00.000Z",
    syncedAt: "2026-03-24T12:00:00.000Z",
    lastError: null,
    entries: [{
      githubPrNumber: 19,
      position: 1,
      state: "open",
      isDraft: false,
      mergedAt: null,
      headBranch: "layer-1",
      headSha: "abc",
    }],
    ...over,
  };
}

function item(): GitHubPrListItem {
  return {
    id: "item-19",
    scope: "repo",
    repoOwner: "ade",
    repoName: "desktop",
    githubPrNumber: 19,
    githubUrl: "https://github.com/ade/desktop/pull/19",
    title: "Layer 1",
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "layer-1",
    author: "arul",
    createdAt: "2026-03-24T12:00:00.000Z",
    updatedAt: "2026-03-24T12:00:00.000Z",
    linkedPrId: null,
    linkedGroupId: null,
    linkedLaneId: null,
    linkedLaneName: null,
    adeKind: null,
    workflowDisplayState: null,
    cleanupState: null,
    labels: [],
    isBot: false,
    commentCount: 0,
  };
}

describe("GitHubStackInspector", () => {
  it("keeps Merge stack enabled after rebase reports unavailable", async () => {
    const onRebase = vi.fn().mockResolvedValue({
      ok: false,
      method: "unavailable",
      disabledReason: "Updating a stacked PR's branch via this endpoint is not supported",
    });
    const onMerge = vi.fn().mockResolvedValue({ ok: true, method: "merge_async" });
    render(
      <GitHubStackInspector
        stack={stack()}
        items={[item()]}
        selectedPrNumber={19}
        syncing={false}
        onSelectPr={() => {}}
        onOpenGitHub={() => {}}
        onSync={() => {}}
        onAddPullRequests={async () => {}}
        onUnstack={async () => {}}
        onMerge={onMerge}
        onRebase={onRebase}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rebase stack" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm rebase" }));
    expect(await screen.findByText(/not supported/)).toBeTruthy();
    const merge = screen.getByRole("button", { name: "Merge stack" });
    expect((merge as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(merge);
    fireEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
    await waitFor(() => expect(onMerge).toHaveBeenCalled());
  });

  it("does not apply a merge result after the selected stack changes", async () => {
    let finishMerge!: (value: GitHubStackMutationResult) => void;
    const mergePromise = new Promise<GitHubStackMutationResult>((resolve) => {
      finishMerge = resolve;
    });
    const onMerge = vi.fn().mockReturnValue(mergePromise);
    const { rerender } = render(
      <GitHubStackInspector
        stack={stack()}
        items={[item()]}
        selectedPrNumber={19}
        syncing={false}
        onSelectPr={() => {}}
        onOpenGitHub={() => {}}
        onSync={() => {}}
        onAddPullRequests={async () => {}}
        onUnstack={async () => {}}
        onMerge={onMerge}
        onRebase={async () => ({ ok: true, method: "stack_api" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge stack" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
    rerender(
      <GitHubStackInspector
        stack={stack({ id: "stack-2", number: 5 })}
        items={[item()]}
        selectedPrNumber={19}
        syncing={false}
        onSelectPr={() => {}}
        onOpenGitHub={() => {}}
        onSync={() => {}}
        onAddPullRequests={async () => {}}
        onUnstack={async () => {}}
        onMerge={onMerge}
        onRebase={async () => ({ ok: true, method: "stack_api" })}
      />,
    );
    finishMerge({
      ok: false,
      stack: null,
      method: "unavailable",
      disabledReason: "stale stack result",
    });
    await waitFor(() => expect(onMerge).toHaveBeenCalled());
    expect(screen.queryByText("stale stack result")).toBeNull();
  });
});
