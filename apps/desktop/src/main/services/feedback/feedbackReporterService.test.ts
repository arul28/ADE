import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFeedbackReporterService } from "./feedbackReporterService";

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

function createDb() {
  const store = new Map<string, unknown>();
  return {
    getJson<T>(key: string): T | null {
      return (store.get(key) as T | undefined) ?? null;
    },
    setJson(key: string, value: unknown) {
      store.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("createFeedbackReporterService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prepares a deterministic bug body and uses AI for title and labels when available", async () => {
    const db = createDb();
    const logger = createLogger();
    const executeTask = vi.fn(async () => ({
      text: [
        "Here is the metadata:",
        "```json",
        JSON.stringify({
          title: "Failed submissions should show the error reason",
          labels: ["bug", "documentation"],
        }),
        "```",
      ].join("\n"),
      structuredOutput: null,
    }));

    const service = createFeedbackReporterService({
      db: db as any,
      logger: logger as any,
      projectRoot: "/Users/admin/Projects/ADE",
      aiIntegrationService: { executeTask } as any,
      githubService: { apiRequest: vi.fn() } as any,
    });

    const draft = await service.prepareDraft({
      modelId: "anthropic/claude-opus-4-7",
      draftInput: {
        category: "bug",
        summary: "Failed submissions should show the error reason.",
        stepsToReproduce: "1. Submit a report\n2. Force GitHub failure",
        expectedBehavior: "Show the saved error.",
        actualBehavior: "Only a failed badge is visible.",
        environment: "ADE Desktop on macOS",
        additionalContext: "The issue is easier to debug when the saved payload is visible.",
      },
    });

    expect(draft.generationMode).toBe("ai_assisted");
    expect(draft.generationWarning).toBeNull();
    expect(draft.title).toBe("Failed submissions should show the error reason");
    expect(draft.labels).toEqual(["bug", "documentation"]);
    expect(draft.body).toContain("## Steps to Reproduce");
    expect(draft.body).toContain("Only a failed badge is visible.");
    expect(draft.body).toContain("## Additional Context");
  });

  it("prepares a deterministic draft when no AI model is selected", async () => {
    const db = createDb();
    const logger = createLogger();
    const executeTask = vi.fn();

    const service = createFeedbackReporterService({
      db: db as any,
      logger: logger as any,
      projectRoot: "/Users/admin/Projects/ADE",
      aiIntegrationService: { executeTask } as any,
      githubService: { apiRequest: vi.fn() } as any,
    });

    const draft = await service.prepareDraft({
      draftInput: {
        category: "enhancement",
        summary: "Make previous submissions expandable.",
        useCase: "Inspect what was posted and why it failed.",
        proposedSolution: "Show a preview panel before posting.",
        alternativesConsidered: "",
        additionalContext: "",
      },
    });

    expect(executeTask).not.toHaveBeenCalled();
    expect(draft.generationMode).toBe("deterministic");
    expect(draft.generationWarning).toContain("no AI model was selected");
    expect(draft.title).toBe("Make previous submissions expandable.");
    expect(draft.labels).toEqual(["enhancement"]);
    expect(draft.body).toContain("## Proposed Solution");
  });

  it("stores a failed submission when GitHub posting fails", async () => {
    const db = createDb();
    const logger = createLogger();
    const apiRequest = vi.fn(async () => {
      throw new Error("GitHub API unavailable");
    });

    const service = createFeedbackReporterService({
      db: db as any,
      logger: logger as any,
      projectRoot: "/Users/admin/Projects/ADE",
      aiIntegrationService: { executeTask: vi.fn() } as any,
      githubService: { apiRequest } as any,
    });

    const submission = await service.submitPreparedDraft({
      draft: {
        category: "bug",
        draftInput: {
          category: "bug",
          summary: "Posting should preserve the prepared draft.",
          stepsToReproduce: "1. Prepare draft",
          expectedBehavior: "Keep the reviewed draft when post fails.",
          actualBehavior: "GitHub rejects the request.",
          environment: "ADE Desktop",
          additionalContext: "",
        },
        userDescription: "## Summary\n\nPosting should preserve the prepared draft.",
        modelId: "anthropic/claude-opus-4-7",
        reasoningEffort: null,
        title: "Preserve reviewed drafts when GitHub posting fails",
        body: "## Description\n\nDeterministic body.",
        labels: ["bug"],
        generationMode: "ai_assisted",
        generationWarning: null,
      },
      title: "Preserve reviewed drafts when GitHub posting fails",
      body: "## Description\n\nDeterministic body.",
      labels: ["bug"],
    });

    expect(submission.generatedTitle).toBe("Preserve reviewed drafts when GitHub posting fails");
    expect(submission.generationMode).toBe("ai_assisted");
    expect(submission.status).toBe("failed");
    expect(submission.error).toBe("Posting failed: GitHub API unavailable");
    expect(logger.error).toHaveBeenCalledWith(
      "feedback.failed",
      expect.objectContaining({
        error: "Posting failed: GitHub API unavailable",
      }),
    );
  });

  it("stores a posted submission after a reviewed draft is submitted", async () => {
    const db = createDb();
    const logger = createLogger();
    const apiRequest = vi.fn(async () => ({
      data: {
        html_url: "https://github.com/arul28/ADE/issues/999",
        number: 999,
      },
    }));

    const service = createFeedbackReporterService({
      db: db as any,
      logger: logger as any,
      projectRoot: "/Users/admin/Projects/ADE",
      aiIntegrationService: { executeTask: vi.fn() } as any,
      githubService: { apiRequest } as any,
    });

    const submission = await service.submitPreparedDraft({
      draft: {
        category: "question",
        draftInput: {
          category: "question",
          summary: "Clarify what happens when feedback posting fails.",
          context: "Users currently only see a failed badge.",
          expectedGuidance: "Explain the failure and preserve the draft.",
          additionalContext: "",
        },
        userDescription: "## Summary\n\nClarify what happens when feedback posting fails.",
        modelId: null,
        reasoningEffort: null,
        title: "Clarify failed feedback submission behavior",
        body: "## Description\n\nExplain the failure state.",
        labels: ["question"],
        generationMode: "deterministic",
        generationWarning: "ADE used a deterministic draft because no AI model was selected.",
      },
      title: "Clarify failed feedback submission behavior",
      body: "## Description\n\nExplain the failure state.",
      labels: ["question"],
    });

    expect(submission.status).toBe("posted");
    expect(submission.issueNumber).toBe(999);
    expect(submission.modelId).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      "feedback.posted",
      expect.objectContaining({ issueNumber: 999 }),
    );
  });
});
