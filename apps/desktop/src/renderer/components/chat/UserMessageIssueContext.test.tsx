/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeGitHubIssueContextAttachment } from "../../../shared/chatContextAttachments";
import { githubIssueIdentifier } from "../../../shared/laneGitHubIssue";
import type { LaneGitHubIssue } from "../../../shared/types";
import { UserMessageIssueContext } from "./UserMessageIssueContext";

vi.mock("../app/LinearIssueSelectModal", () => ({
  LinearIssueSelectModal: () => null,
}));

vi.mock("../app/GitHubIssueSelectModal", () => ({
  GitHubIssueSelectModal: ({
    open,
    selectedIssue,
    onRemoveIssue,
  }: {
    open: boolean;
    selectedIssue: LaneGitHubIssue | null;
    onRemoveIssue?: (issue: LaneGitHubIssue) => void;
  }) => (
    open && selectedIssue
      ? (
        <button
          type="button"
          onClick={() => onRemoveIssue?.(selectedIssue)}
        >
          {`Remove ${githubIssueIdentifier(selectedIssue)} from details`}
        </button>
      )
      : null
  ),
}));

function makeGitHubIssue(overrides: Partial<LaneGitHubIssue> = {}): LaneGitHubIssue {
  return {
    id: "ade/app#41",
    number: 41,
    owner: "ade",
    repo: "app",
    title: "First issue",
    body: "Details",
    url: "https://github.com/ade/app/issues/41",
    state: "open",
    stateReason: null,
    labels: [],
    assignees: [],
    authorLogin: "arul",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("UserMessageIssueContext", () => {
  const detachGitHubIssueFromSession = vi.fn();

  beforeEach(() => {
    detachGitHubIssueFromSession.mockReset();
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        lanes: { detachGitHubIssueFromSession },
      },
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as { ade?: unknown }).ade;
  });

  it("opens and removes the GitHub issue for the clicked chip", () => {
    const first = makeGitHubIssue();
    const second = makeGitHubIssue({
      id: "ade/app#42",
      number: 42,
      title: "Second issue",
      url: "https://github.com/ade/app/issues/42",
    });

    render(
      <UserMessageIssueContext
        attachments={[]}
        contextAttachments={[
          makeGitHubIssueContextAttachment(first),
          makeGitHubIssueContextAttachment(second),
        ]}
        mode="standard"
        sessionId="chat-1"
      />,
    );

    const chips = screen.getAllByTestId("github-issue-context-chip");
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[1]!);

    fireEvent.click(screen.getByRole("button", { name: "Remove ade/app#42 from details" }));

    expect(detachGitHubIssueFromSession).toHaveBeenCalledWith({
      chatSessionId: "chat-1",
      issueId: "ade/app#42",
    });
    expect(screen.getAllByTestId("github-issue-context-chip")).toHaveLength(1);
    expect(screen.getByText("First issue")).toBeTruthy();
    expect(screen.queryByText("Second issue")).toBeNull();
  });
});
