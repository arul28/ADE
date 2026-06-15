import { describe, expect, it } from "vitest";
import {
  buildFeedbackDraftInput,
  buildFeedbackEnvironment,
  feedbackFormFields,
  feedbackSubmissionNotice,
  normalizeFeedbackCategory,
} from "../feedback";
import type { LaneSummary } from "../../../../desktop/src/shared/types/lanes";

function lane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Feedback lane",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/feedback",
    worktreePath: "/tmp/project/.ade/worktrees/feedback",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: 0,
      rebaseInProgress: false,
    },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-05-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("ADE Code feedback helpers", () => {
  it("normalizes unsupported categories to bug", () => {
    expect(normalizeFeedbackCategory("question")).toBe("question");
    expect(normalizeFeedbackCategory("Feature")).toBe("feature");
    expect(normalizeFeedbackCategory("something else")).toBe("bug");
  });

  it("builds a bug draft from the compact TUI form fields", () => {
    const draft = buildFeedbackDraftInput({
      category: "bug",
      summary: "Submitting feedback should close the pane.",
      details: "1. Run /feedback\n2. Fill in the summary\n3. Press Enter",
      expected: "The issue posts and the pane closes.",
      actual: "The pane stays open.",
      environment: "ADE Code",
      additionalContext: "Seen in the TUI.",
    });

    expect(draft).toEqual({
      category: "bug",
      summary: "Submitting feedback should close the pane.",
      stepsToReproduce: "1. Run /feedback\n2. Fill in the summary\n3. Press Enter",
      expectedBehavior: "The issue posts and the pane closes.",
      actualBehavior: "The pane stays open.",
      environment: "ADE Code",
      additionalContext: "Seen in the TUI.",
    });
  });

  it("keeps environment context when mapping non-bug feedback", () => {
    const draft = buildFeedbackDraftInput({
      category: "enhancement",
      summary: "Show the feedback hub count in ADE Code.",
      details: "I want to see previous submissions without opening desktop.",
      expected: "Add a small feedback history command.",
      actual: "No TUI history surface exists.",
      environment: "Source: ADE Code",
    });

    expect(draft.category).toBe("enhancement");
    expect(draft.additionalContext).toContain("Environment:");
    expect(draft.additionalContext).toContain("Source: ADE Code");
  });

  it("prepopulates form environment from the active ADE Code context", () => {
    const environment = buildFeedbackEnvironment({
      launchCwd: "/tmp/project",
      projectRoot: "/tmp/project",
      workspaceRoot: "/tmp/project",
      laneHint: null,
      sessionHint: null,
      remote: false,
    }, lane());
    const fields = feedbackFormFields(environment);

    expect(environment).toContain("Source: ADE Code");
    expect(environment).toContain("Lane: Feedback lane");
    expect(fields.find((field) => field.name === "environment")?.initialValue).toBe(environment);
  });

  it("formats posted and failed submission notices", () => {
    expect(feedbackSubmissionNotice({
      id: "sub-1",
      category: "bug",
      userDescription: "",
      modelId: null,
      reasoningEffort: null,
      status: "posted",
      generationMode: "deterministic",
      generationWarning: null,
      generatedTitle: "Title",
      generatedBody: "Body",
      issueUrl: "https://github.com/arul28/ADE/issues/123",
      issueNumber: 123,
      issueState: "open",
      error: null,
      createdAt: "2026-05-13T12:00:00.000Z",
      completedAt: "2026-05-13T12:00:01.000Z",
    })).toEqual({ text: "Feedback posted as GitHub issue #123.", tone: "success" });

    expect(feedbackSubmissionNotice({
      id: "sub-2",
      category: "bug",
      userDescription: "",
      modelId: null,
      reasoningEffort: null,
      status: "failed",
      generationMode: "deterministic",
      generationWarning: null,
      generatedTitle: "Title",
      generatedBody: "Body",
      issueUrl: null,
      issueNumber: null,
      issueState: null,
      error: "Posting failed: GitHub token missing",
      createdAt: "2026-05-13T12:00:00.000Z",
      completedAt: "2026-05-13T12:00:01.000Z",
    })).toEqual({ text: "Posting failed: GitHub token missing", tone: "error" });
  });
});
