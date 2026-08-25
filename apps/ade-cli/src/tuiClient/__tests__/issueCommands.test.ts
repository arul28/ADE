import { describe, expect, it, vi } from "vitest";
import { ACTIVE_SESSION_PLACEHOLDER } from "../linearCommands";
import { buildIssueToolRequest, executeIssueToolRequest } from "../issueCommands";

describe("buildIssueToolRequest", () => {
  it("attaches a Linear identifier via fetch-then-attach", () => {
    expect(buildIssueToolRequest("attach ADE-123")).toEqual({
      kind: "linearAttach",
      title: "Issue attach",
      identifier: "ADE-123",
      sessionId: ACTIVE_SESSION_PLACEHOLDER,
    });
  });

  it("parses owner/repo#number as a GitHub attach", () => {
    expect(buildIssueToolRequest("attach ade/app#42")).toEqual({
      kind: "githubAttach",
      title: "Issue attach",
      ref: { owner: "ade", repo: "app", number: 42 },
      sessionId: ACTIVE_SESSION_PLACEHOLDER,
    });
  });

  it("parses #42 as a GitHub attach that needs detectRepo", () => {
    expect(buildIssueToolRequest("attach #42")).toEqual({
      kind: "githubAttach",
      title: "Issue attach",
      ref: { number: 42 },
      sessionId: ACTIVE_SESSION_PLACEHOLDER,
    });
  });

  it("lists and detaches against the active session", () => {
    expect(buildIssueToolRequest("list")).toEqual({
      kind: "list",
      title: "Attached issues",
      sessionId: ACTIVE_SESSION_PLACEHOLDER,
    });
    expect(buildIssueToolRequest("detach ADE-123")).toEqual({
      kind: "detach",
      title: "Issue detach",
      token: "ADE-123",
      sessionId: ACTIVE_SESSION_PLACEHOLDER,
    });
  });

  it("returns usage for a missing attach token", () => {
    expect(buildIssueToolRequest("attach").kind).toBe("usage");
    expect(buildIssueToolRequest("").kind).toBe("usage");
  });
});

describe("executeIssueToolRequest", () => {
  it("fetches a Linear issue before attaching it to the session", async () => {
    const fetched = {
      id: "issue-uuid",
      identifier: "ADE-123",
      title: "Ship GitHub attach",
      description: "Body",
      url: "https://linear.app/ade/issue/ADE-123",
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
      labels: ["chat"],
      assigneeId: null,
      assigneeName: null,
      creatorId: null,
      creatorName: null,
      dueDate: null,
      estimate: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const action = vi.fn(async (domain: string, name: string) => {
      if (domain === "lane" && name === "attachLinearIssueToSession") return [{ id: "link-1" }];
      return null;
    });
    const actionList = vi.fn(async () => fetched);
    const setDetails = vi.fn();
    const notifySuccess = vi.fn();

    await executeIssueToolRequest("attach ADE-123", {
      sessionId: "session-1",
      conn: { action, actionList },
      setDetails,
      notifySuccess,
      render: (value) => JSON.stringify(value),
    });

    expect(actionList).toHaveBeenCalledWith("linear_issue_tracker", "fetchIssueById", ["ADE-123"]);
    expect(action).toHaveBeenCalledWith("lane", "attachLinearIssueToSession", {
      chatSessionId: "session-1",
      issues: [expect.objectContaining({ id: "issue-uuid", identifier: "ADE-123", title: "Ship GitHub attach" })],
    });
    expect(notifySuccess).toHaveBeenCalledWith("Attached ADE-123.");
  });
});
