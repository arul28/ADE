import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { IPC } from "../../../shared/ipc";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createGithubService } from "../github/githubService";
import type {
  FeedbackSubmission,
  FeedbackSubmitArgs,
  FeedbackSubmissionEvent,
} from "../../../shared/types/feedback";

const DB_KEY = "feedback:submissions";

function nowIso(): string {
  return new Date().toISOString();
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

      const result = await aiIntegrationService.executeTask({
        feature: "pr_descriptions",
        taskType: "pr_description",
        prompt: `Category: ${submission.category}\n\nUser description:\n${submission.userDescription}`,
        systemPrompt: systemPromptForCategory(submission.category),
        cwd: projectRoot,
        model: submission.modelId,
        permissionMode: "read-only",
        oneShot: true,
      });

      let parsed: { title: string; body: string; labels: string[] };
      try {
        const text = result.text.trim();
        // Strip markdown fences if present
        const jsonText = text.startsWith("```")
          ? text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
          : text;
        parsed = JSON.parse(jsonText);
        const ALLOWED_LABELS = new Set([
          "bug", "enhancement", "question", "documentation",
          "good first issue", "help wanted", "invalid", "wontfix",
        ]);
        parsed.labels = (parsed.labels ?? []).filter(
          (label: string) => ALLOWED_LABELS.has(label),
        );
      } catch {
        throw new Error("Failed to parse AI response as JSON");
      }

      submission.generatedTitle = parsed.title;
      submission.generatedBody = parsed.body;

      // -- Post to GitHub --
      submission.status = "posting";
      save(submission);
      emitUpdate(submission);

      const { data } = await githubService.apiRequest<{
        html_url: string;
        number: number;
      }>({
        method: "POST",
        path: "/repos/arul28/ADE/issues",
        body: {
          title: parsed.title,
          body: parsed.body,
          labels: parsed.labels,
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
