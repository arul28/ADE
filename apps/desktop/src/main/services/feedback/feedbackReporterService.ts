import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { IPC } from "../../../shared/ipc";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createGithubService } from "../github/githubService";
import { parseStructuredOutput } from "../ai/utils";
import type {
  FeedbackSubmission,
  FeedbackSubmitArgs,
  FeedbackSubmissionEvent,
} from "../../../shared/types/feedback";

const DB_KEY = "feedback:submissions";
const ALLOWED_LABELS = new Set([
  "bug", "enhancement", "question", "documentation",
  "good first issue", "help wanted", "invalid", "wontfix",
]);
const FEEDBACK_ISSUE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    labels: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["title", "body", "labels"],
} as const;

type FeedbackIssueDraft = {
  title: string;
  body: string;
  labels: string[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clampText(value: string, maxLength: number): string {
  const trimmed = normalizeWhitespace(value);
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function titleCaseFirst(value: string): string {
  if (!value) return value;
  return value[0]!.toUpperCase() + value.slice(1);
}

function defaultLabelsForCategory(category: FeedbackSubmission["category"]): string[] {
  switch (category) {
    case "bug":
      return ["bug"];
    case "question":
      return ["question"];
    case "feature":
    case "enhancement":
      return ["enhancement"];
  }
}

function normalizeLabels(
  category: FeedbackSubmission["category"],
  labels: unknown,
): string[] {
  const normalized = Array.isArray(labels)
    ? labels
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter((value) => ALLOWED_LABELS.has(value))
    : [];
  const combined = [...normalized, ...defaultLabelsForCategory(category)];
  return Array.from(new Set(combined));
}

function fallbackTitle(submission: FeedbackSubmission): string {
  const firstLine = submission.userDescription
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .find((line) => line.length > 0);
  const candidate = firstLine && firstLine.length > 0
    ? firstLine
    : `${submission.category} report`;
  return titleCaseFirst(clampText(candidate, 90));
}

function fallbackBody(submission: FeedbackSubmission): string {
  const description = submission.userDescription.trim();
  switch (submission.category) {
    case "bug":
      return [
        "## Description",
        "",
        description,
        "",
        "## Steps to Reproduce",
        "",
        "Not provided.",
        "",
        "## Expected Behavior",
        "",
        "Not provided.",
        "",
        "## Actual Behavior",
        "",
        "Not provided.",
        "",
        "## Environment",
        "",
        "- App: ADE Desktop",
        `- Model: ${submission.modelId}`,
      ].join("\n");
    case "question":
      return [
        "## Description",
        "",
        description,
        "",
        "## Context",
        "",
        "Not provided.",
        "",
        "## Expected Guidance",
        "",
        "Not provided.",
      ].join("\n");
    case "feature":
    case "enhancement":
      return [
        "## Description",
        "",
        description,
        "",
        "## Use Case",
        "",
        "Not provided.",
        "",
        "## Proposed Solution",
        "",
        "Not provided.",
        "",
        "## Alternatives Considered",
        "",
        "Not provided.",
      ].join("\n");
  }
}

function normalizeIssueDraft(
  submission: FeedbackSubmission,
  structuredOutput: unknown,
): { draft: FeedbackIssueDraft; usedFallback: boolean } {
  const candidate = isRecord(structuredOutput) ? structuredOutput : null;
  const title =
    typeof candidate?.title === "string" && candidate.title.trim().length > 0
      ? candidate.title.trim()
      : fallbackTitle(submission);
  const body =
    typeof candidate?.body === "string" && candidate.body.trim().length > 0
      ? candidate.body.trim()
      : fallbackBody(submission);
  const labels = normalizeLabels(submission.category, candidate?.labels);
  const usedFallback = candidate == null
    || title === fallbackTitle(submission)
    || body === fallbackBody(submission);

  return {
    draft: {
      title,
      body,
      labels,
    },
    usedFallback,
  };
}

function emitUpdate(submission: FeedbackSubmission): void {
  const event: FeedbackSubmissionEvent = {
    type: "feedback-submission-updated",
    submission,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.feedbackOnUpdate, event);
  }
}

const SYSTEM_PROMPT_BUG = `You are a GitHub issue writer for the ADE open-source project (github.com/arul28/ADE).
The user is reporting a bug. Generate a well-structured GitHub issue.

Use this format:
- Title: a concise summary of the bug
- Body (GitHub-flavored markdown):
  ## Description
  ## Steps to Reproduce
  ## Expected Behavior
  ## Actual Behavior
  ## Environment

Apply appropriate labels from: bug, enhancement, question, documentation, good first issue, help wanted, invalid, wontfix.
For bug reports, always include the "bug" label.

Respond with ONLY valid JSON (no markdown fences): { "title": string, "body": string, "labels": string[] }`;

const SYSTEM_PROMPT_FEATURE = `You are a GitHub issue writer for the ADE open-source project (github.com/arul28/ADE).
The user is requesting a feature or enhancement. Generate a well-structured GitHub issue.

Use this format:
- Title: a concise summary of the request
- Body (GitHub-flavored markdown):
  ## Description
  ## Use Case
  ## Proposed Solution
  ## Alternatives Considered

Apply appropriate labels from: bug, enhancement, question, documentation, good first issue, help wanted, invalid, wontfix.
For features use "enhancement". For questions use "question".

Respond with ONLY valid JSON (no markdown fences): { "title": string, "body": string, "labels": string[] }`;

function systemPromptForCategory(category: FeedbackSubmission["category"]): string {
  return category === "bug" ? SYSTEM_PROMPT_BUG : SYSTEM_PROMPT_FEATURE;
}

export function createFeedbackReporterService({
  db,
  logger,
  projectRoot,
  aiIntegrationService,
  githubService,
}: {
  db: AdeDb;
  logger: Logger;
  projectRoot: string;
  aiIntegrationService: ReturnType<typeof createAiIntegrationService>;
  githubService: ReturnType<typeof createGithubService>;
}) {
  function loadAll(): FeedbackSubmission[] {
    return db.getJson<FeedbackSubmission[]>(DB_KEY) ?? [];
  }

  function save(submission: FeedbackSubmission): void {
    const all = loadAll();
    const idx = all.findIndex((s) => s.id === submission.id);
    if (idx >= 0) {
      all[idx] = submission;
    } else {
      all.push(submission);
    }
    db.setJson(DB_KEY, all);
  }

  async function runSubmission(submission: FeedbackSubmission): Promise<void> {
    try {
      // -- Generate --
      submission.status = "generating";
      save(submission);
      emitUpdate(submission);

      let normalizedDraft: FeedbackIssueDraft;
      try {
        const result = await aiIntegrationService.executeTask({
          feature: "pr_descriptions",
          taskType: "pr_description",
          prompt: `Category: ${submission.category}\n\nUser description:\n${submission.userDescription}`,
          systemPrompt: systemPromptForCategory(submission.category),
          cwd: projectRoot,
          model: submission.modelId,
          jsonSchema: FEEDBACK_ISSUE_JSON_SCHEMA,
          permissionMode: "read-only",
          oneShot: true,
          timeoutMs: 300_000,
          ...(submission.reasoningEffort ? { reasoningEffort: submission.reasoningEffort } : {}),
        });

        const structuredCandidate = result.structuredOutput ?? parseStructuredOutput(result.text);
        const normalized = normalizeIssueDraft(submission, structuredCandidate);
        normalizedDraft = normalized.draft;

        if (normalized.usedFallback) {
          logger.warn("feedback.generated_with_fallback", {
            id: submission.id,
            category: submission.category,
            modelId: submission.modelId,
          });
        }

        submission.generatedTitle = normalized.draft.title;
        submission.generatedBody = normalized.draft.body;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("feedback.generation_failed_using_fallback", {
          id: submission.id,
          category: submission.category,
          modelId: submission.modelId,
          error: message,
        });
        normalizedDraft = {
          title: fallbackTitle(submission),
          body: fallbackBody(submission),
          labels: defaultLabelsForCategory(submission.category),
        };
        submission.generatedTitle = normalizedDraft.title;
        submission.generatedBody = normalizedDraft.body;
      }

      // -- Post to GitHub --
      submission.status = "posting";
      save(submission);
      emitUpdate(submission);

      try {
        const { data } = await githubService.apiRequest<{
          html_url: string;
          number: number;
        }>({
          method: "POST",
          path: "/repos/arul28/ADE/issues",
          body: {
            title: normalizedDraft.title,
            body: normalizedDraft.body,
            labels: normalizedDraft.labels,
          },
        });

        submission.issueUrl = data.html_url;
        submission.issueNumber = data.number;
        submission.issueState = "open";
        submission.status = "posted";
        submission.completedAt = nowIso();
        save(submission);
        emitUpdate(submission);

        logger.info("feedback.posted", {
          id: submission.id,
          issueNumber: data.number,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Posting failed: ${message}`);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      submission.status = "failed";
      submission.error = message;
      submission.completedAt = nowIso();
      save(submission);
      emitUpdate(submission);

      logger.error("feedback.failed", {
        id: submission.id,
        error: message,
      });
    }
  }

  function submit(args: FeedbackSubmitArgs): FeedbackSubmission {
    const submission: FeedbackSubmission = {
      id: randomUUID(),
      category: args.category,
      userDescription: args.userDescription,
      modelId: args.modelId,
      reasoningEffort: args.reasoningEffort ?? null,
      status: "pending",
      generatedTitle: null,
      generatedBody: null,
      issueUrl: null,
      issueNumber: null,
      issueState: null,
      error: null,
      createdAt: nowIso(),
      completedAt: null,
    };

    save(submission);
    emitUpdate(submission);

    // Run generation + posting in the background
    runSubmission(submission).catch(() => {
      // Error already handled inside runSubmission
    });

    return submission;
  }

  function list(): FeedbackSubmission[] {
    return loadAll().sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  return { submit, list };
}
