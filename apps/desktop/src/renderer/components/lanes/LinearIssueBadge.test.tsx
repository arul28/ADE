/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneLinearIssue } from "../../../shared/types";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../test/builtinSurfaces";
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
  // The badge is a Linear entry point, so it is only in the product on a
  // machine that has `ade-linear`. Every rendering test therefore describes
  // such a machine; the gate itself is asserted from both sides below.
  beforeEach(() => {
    seedBuiltinSurfacePlugins(["linear"]);
  });

  afterEach(() => {
    cleanup();
    resetBuiltinSurfacePlugins();
    Reflect.deleteProperty(window, "ade");
    vi.restoreAllMocks();
  });

  it("renders nothing when the Linear plugin is not installed", () => {
    resetBuiltinSurfacePlugins();
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { plugins: {}, app: { writeClipboardText: vi.fn(async () => undefined) } },
    });

    const { container } = render(<LinearIssueBadge issue={makeIssue()} />);

    expect(container.textContent).toBe("");
    expect(screen.queryByText("ADE-123")).toBeNull();
  });

  it("renders the issue once the Linear plugin is installed", () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { plugins: {}, app: { writeClipboardText: vi.fn(async () => undefined) } },
    });

    render(<LinearIssueBadge issue={makeIssue()} />);

    expect(screen.getAllByText("ADE-123").length).toBeGreaterThan(0);
  });

  it("copies the Linear issue link to the clipboard", async () => {
    const writeClipboardText = vi.fn(async () => undefined);
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: { plugins: {}, app: { writeClipboardText } },
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
      value: { plugins: {}, app: { writeClipboardText: vi.fn(async () => undefined), openExternal: vi.fn(async () => undefined) } },
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
      value: { plugins: {}, app: { openExternal } },
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
