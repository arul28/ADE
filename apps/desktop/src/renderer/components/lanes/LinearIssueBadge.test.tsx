/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneLinearIssue } from "../../../shared/types";
import { LinearIssueBadge } from "./LinearIssueBadge";

function makeIssue(overrides: Partial<LaneLinearIssue> = {}): LaneLinearIssue {
  return {
    id: "issue-1",
    identifier: "ADE-123",
    title: "Connect lane to Linear issue",
    description: null,
    url: "https://linear.app/ade/issue/ADE-123/connect-lane-to-linear-issue",
    projectId: "project-1",
    projectSlug: "ade",
    projectName: "ADE",
    teamId: "team-1",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high",
    labels: ["desktop"],
    assigneeId: "user-1",
    assigneeName: "Arul",
    creatorId: null,
    creatorName: null,
    dueDate: null,
    estimate: null,
    branchName: "ade-123-connect-lane-to-linear-issue",
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("LinearIssueBadge", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "ade");
    vi.restoreAllMocks();
  });

  it("copies the Linear issue link to the clipboard", async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { app: { writeClipboardText } },
    });

    const issue = makeIssue();
    render(<LinearIssueBadge issue={issue} />);

    fireEvent.click(screen.getByRole("button", { name: /copy link/i }));

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(issue.url);
    });
    expect(screen.getByRole("button", { name: /copied/i })).toBeTruthy();
  });

  it("starts a new chat with issue context from the hover card", () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { app: { writeClipboardText: vi.fn(async () => undefined), openExternal: vi.fn(async () => undefined) } },
    });
    const onStartChatWithIssue = vi.fn();

    render(<LinearIssueBadge issue={makeIssue()} onStartChatWithIssue={onStartChatWithIssue} />);

    fireEvent.click(screen.getByRole("button", { name: /start chat with context/i }));

    expect(onStartChatWithIssue).toHaveBeenCalledTimes(1);
  });

  it("opens only http or https Linear links externally", () => {
    const openExternal = vi.fn(async () => undefined);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { app: { openExternal } },
    });

    const { rerender } = render(<LinearIssueBadge issue={makeIssue()} />);

    fireEvent.click(screen.getByRole("button", { name: /open in linear/i }));
    expect(openExternal).toHaveBeenCalledWith("https://linear.app/ade/issue/ADE-123/connect-lane-to-linear-issue");

    openExternal.mockClear();
    rerender(<LinearIssueBadge issue={makeIssue({ url: "javascript:alert(1)" })} />);
    fireEvent.click(screen.getByRole("button", { name: /open in linear/i }));
    expect(openExternal).not.toHaveBeenCalled();
  });
});
