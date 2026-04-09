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

  it("posts successfully when the model wraps JSON in prose", async () => {
    const db = createDb();
    const logger = createLogger();
    const executeTask = vi.fn(async () => ({
      text: [
        "I reviewed the request. Here is the issue:",
        "```json",
        JSON.stringify({
          title: "Improve failed submission details in feedback reporter",
          body: "## Description\n\nShow the saved error in My Submissions.",
          labels: ["bug"],
        }),
        "```",
      ].join("\n"),
      structuredOutput: null,
    }));
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
      aiIntegrationService: { executeTask } as any,
      githubService: { apiRequest } as any,
    });

    service.submit({
      category: "bug",
      userDescription: "The failed submission view should show the saved error.",
      modelId: "anthropic/claude-opus-4-6",
    });

    await vi.waitFor(() => {
      expect(apiRequest).toHaveBeenCalledTimes(1);
    });

    const [submission] = service.list();
    expect(submission?.status).toBe("posted");
    expect(submission?.generatedTitle).toBe("Improve failed submission details in feedback reporter");
    expect(submission?.generatedBody).toContain("Show the saved error");
    expect(submission?.issueNumber).toBe(999);
    expect(logger.warn).not.toHaveBeenCalledWith("feedback.generated_with_fallback", expect.anything());
  });

  it("falls back to a deterministic issue draft when the model output is unusable", async () => {
    const db = createDb();
    const logger = createLogger();
    const executeTask = vi.fn(async () => ({
      text: "I could not comply with the requested format, but the report seems valid.",
      structuredOutput: null,
    }));
    const apiRequest = vi.fn(async () => ({
      data: {
        html_url: "https://github.com/arul28/ADE/issues/1000",
        number: 1000,
      },
    }));

    const service = createFeedbackReporterService({
      db: db as any,
      logger: logger as any,
      projectRoot: "/Users/admin/Projects/ADE",
      aiIntegrationService: { executeTask } as any,
      githubService: { apiRequest } as any,
    });

    service.submit({
      category: "enhancement",
      userDescription: "The previous submissions tab should expand each report and show the original text.",
      modelId: "anthropic/claude-opus-4-6",
    });

    await vi.waitFor(() => {
      expect(apiRequest).toHaveBeenCalledTimes(1);
    });

    const [submission] = service.list();
    expect(submission?.status).toBe("posted");
    expect(submission?.generatedTitle).toContain("previous submissions tab");
    expect(submission?.generatedBody).toContain("## Description");
    expect(submission?.generatedBody).toContain("## Proposed Solution");
    const request = (apiRequest as any).mock.calls[0]?.[0] as { body?: { labels?: string[] } } | undefined;
    expect(request?.body?.labels).toEqual(["enhancement"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "feedback.generated_with_fallback",
      expect.objectContaining({
        category: "enhancement",
        modelId: "anthropic/claude-opus-4-6",
      }),
    );
  });

  it("stores a stage-specific error when GitHub posting fails", async () => {
    const db = createDb();
    const logger = createLogger();
    const executeTask = vi.fn(async () => ({
      text: JSON.stringify({
        title: "Improve feedback reporter determinism",
        body: "## Description\n\nDeterministic fallback formatting.",
        labels: ["bug"],
      }),
      structuredOutput: {
        title: "Improve feedback reporter determinism",
        body: "## Description\n\nDeterministic fallback formatting.",
        labels: ["bug"],
      },
    }));
    const apiRequest = vi.fn(async () => {
      throw new Error("GitHub API unavailable");
    });

    const service = createFeedbackReporterService({
      db: db as any,
      logger: logger as any,
      projectRoot: "/Users/admin/Projects/ADE",
      aiIntegrationService: { executeTask } as any,
      githubService: { apiRequest } as any,
    });

    service.submit({
      category: "bug",
      userDescription: "Posting should preserve the generated content if GitHub fails.",
      modelId: "anthropic/claude-opus-4-6",
    });

    await vi.waitFor(() => {
      const [submission] = service.list();
      expect(submission?.status).toBe("failed");
    });

    const [submission] = service.list();
    expect(submission?.generatedTitle).toBe("Improve feedback reporter determinism");
    expect(submission?.error).toBe("Posting failed: GitHub API unavailable");
    expect(logger.error).toHaveBeenCalledWith(
      "feedback.failed",
      expect.objectContaining({
        error: "Posting failed: GitHub API unavailable",
      }),
    );
  });
});
