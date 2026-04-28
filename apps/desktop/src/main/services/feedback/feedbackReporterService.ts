import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { IPC } from "../../../shared/ipc";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createGithubService } from "../github/githubService";
import { parseStructuredOutput } from "../ai/utils";
import type {
  FeedbackCategory,
  FeedbackDraftInput,
  FeedbackGenerationMode,
  FeedbackPreparedDraft,
  FeedbackPrepareDraftArgs,
  FeedbackSubmission,
  FeedbackSubmissionEvent,
  FeedbackSubmitDraftArgs,
} from "../../../shared/types/feedback";

const DB_KEY = "feedback:submissions";
const ALLOWED_LABELS = new Set([
  "bug", "enhancement", "question", "documentation",
  "good first issue", "help wanted", "invalid", "wontfix",
]);
const FEEDBACK_METADATA_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    labels: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["title", "labels"],
} as const;

const DETERMINISTIC_NO_MODEL_WARNING = "ADE used a deterministic draft because no AI model was selected. Review the generated title and labels before posting.";
const DETERMINISTIC_FORMAT_WARNING = "ADE used a deterministic draft because the AI title and label suggestion did not match the expected structured format.";

type FeedbackMetadataSuggestion = {
  title: string;
  labels: string[];
  generationMode: FeedbackGenerationMode;
  generationWarning: string | null;
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

function normalizeMultiline(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function defaultLabelsForCategory(category: FeedbackCategory): string[] {
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

function normalizeLabels(category: FeedbackCategory, labels: unknown): string[] {
  const normalized = Array.isArray(labels)
    ? labels
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter((value) => ALLOWED_LABELS.has(value))
    : [];
  const combined = [...normalized, ...defaultLabelsForCategory(category)];
  return Array.from(new Set(combined));
}

type SectionHeadings = {
  summary: string;
  bug: { steps: string; expected: string; actual: string; environment: string };
  feature: { useCase: string; proposed: string; alternatives: string };
  question: { context: string; guidance: string };
  additional: string;
};

const USER_DESCRIPTION_HEADINGS: SectionHeadings = {
  summary: "Summary",
  bug: {
    steps: "Steps to reproduce",
    expected: "Expected behavior",
    actual: "Actual behavior",
    environment: "Environment",
  },
  feature: {
    useCase: "Use case",
    proposed: "Proposed solution",
    alternatives: "Alternatives considered",
  },
  question: {
    context: "Context",
    guidance: "Expected guidance",
  },
  additional: "Additional context",
};

const ISSUE_BODY_HEADINGS: SectionHeadings = {
  summary: "Description",
  bug: {
    steps: "Steps to Reproduce",
    expected: "Expected Behavior",
    actual: "Actual Behavior",
    environment: "Environment",
  },
  feature: {
    useCase: "Use Case",
    proposed: "Proposed Solution",
    alternatives: "Alternatives Considered",
  },
  question: {
    context: "Context",
    guidance: "Expected Guidance",
  },
  additional: "Additional Context",
};

function appendSection(lines: string[], heading: string, value: string): void {
  lines.push(`## ${heading}`, "", value.length > 0 ? value : "Not provided.", "");
}

function normalizeDraftInput(input: FeedbackDraftInput): FeedbackDraftInput {
  const summary = normalizeMultiline(input.summary);
  const additionalContext = normalizeMultiline(input.additionalContext);
  switch (input.category) {
    case "bug":
      return {
        category: "bug",
        summary,
        stepsToReproduce: normalizeMultiline(input.stepsToReproduce),
        expectedBehavior: normalizeMultiline(input.expectedBehavior),
        actualBehavior: normalizeMultiline(input.actualBehavior),
        environment: normalizeMultiline(input.environment),
        additionalContext,
      };
    case "feature":
    case "enhancement":
      return {
        category: input.category,
        summary,
        useCase: normalizeMultiline(input.useCase),
        proposedSolution: normalizeMultiline(input.proposedSolution),
        alternativesConsidered: normalizeMultiline(input.alternativesConsidered),
        additionalContext,
      };
    case "question":
      return {
        category: "question",
        summary,
        context: normalizeMultiline(input.context),
        expectedGuidance: normalizeMultiline(input.expectedGuidance),
        additionalContext,
      };
  }
}

function renderSections(input: FeedbackDraftInput, headings: SectionHeadings): string {
  const lines: string[] = [];
  appendSection(lines, headings.summary, input.summary);
  switch (input.category) {
    case "bug":
      appendSection(lines, headings.bug.steps, normalizeMultiline(input.stepsToReproduce));
      appendSection(lines, headings.bug.expected, normalizeMultiline(input.expectedBehavior));
      appendSection(lines, headings.bug.actual, normalizeMultiline(input.actualBehavior));
      appendSection(lines, headings.bug.environment, normalizeMultiline(input.environment));
      break;
    case "feature":
    case "enhancement":
      appendSection(lines, headings.feature.useCase, normalizeMultiline(input.useCase));
      appendSection(lines, headings.feature.proposed, normalizeMultiline(input.proposedSolution));
      appendSection(lines, headings.feature.alternatives, normalizeMultiline(input.alternativesConsidered));
      break;
    case "question":
      appendSection(lines, headings.question.context, normalizeMultiline(input.context));
      appendSection(lines, headings.question.guidance, normalizeMultiline(input.expectedGuidance));
      break;
  }
  const additional = normalizeMultiline(input.additionalContext);
  if (additional.length > 0) {
    appendSection(lines, headings.additional, additional);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function buildUserDescription(input: FeedbackDraftInput): string {
  return renderSections(input, USER_DESCRIPTION_HEADINGS);
}

function buildIssueBody(input: FeedbackDraftInput): string {
  return renderSections(input, ISSUE_BODY_HEADINGS);
}

function fallbackTitleForInput(input: FeedbackDraftInput): string {
  const candidate = input.summary.length > 0 ? input.summary : `${input.category} report`;
  return titleCaseFirst(clampText(candidate, 90));
}

function normalizeGenerationWarning(value: unknown): string | null {
  const warning = typeof value === "string" ? value.trim() : "";
  return warning.length > 0 ? warning : null;
}

function normalizeGenerationMode(value: unknown): FeedbackGenerationMode | null {
  if (value === "ai_assisted" || value === "deterministic") return value;
  if (value === "ai_structured") return "ai_assisted";
  if (value === "fallback_template") return "deterministic";
  return null;
}

function normalizeStoredSubmission(submission: FeedbackSubmission): FeedbackSubmission {
  return {
    ...submission,
    modelId: pickTrimmed(submission.modelId),
    reasoningEffort: submission.reasoningEffort ?? null,
    generationMode: normalizeGenerationMode(submission.generationMode),
    generationWarning: normalizeGenerationWarning(submission.generationWarning),
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

const METADATA_SYSTEM_PROMPT = `You help convert structured ADE feedback into GitHub issue metadata.

Return ONLY valid JSON with:
- title: a concise GitHub issue title
- labels: an array of allowed GitHub labels

Allowed labels: bug, enhancement, question, documentation, good first issue, help wanted, invalid, wontfix.
Use only details present in the provided structured fields and deterministic issue body. Do not invent missing sections or behavior.`;

function buildMetadataPrompt(input: FeedbackDraftInput, body: string): string {
  return [
    `Category: ${input.category}`,
    "",
    "Structured input:",
    JSON.stringify(input, null, 2),
    "",
    "Deterministic issue body:",
    body,
    "",
    "Suggest the best title and labels for this issue.",
  ].join("\n");
}

function normalizeMetadataSuggestion(
  category: FeedbackCategory,
  fallbackTitle: string,
  structuredOutput: unknown,
): FeedbackMetadataSuggestion {
  const candidate = isRecord(structuredOutput) ? structuredOutput : null;
  const aiTitle = typeof candidate?.title === "string" ? candidate.title.trim() : "";
  if (aiTitle.length === 0) {
    return {
      title: fallbackTitle,
      labels: defaultLabelsForCategory(category),
      generationMode: "deterministic",
      generationWarning: DETERMINISTIC_FORMAT_WARNING,
    };
  }
  return {
    title: aiTitle,
    labels: normalizeLabels(category, candidate?.labels),
    generationMode: "ai_assisted",
    generationWarning: null,
  };
}

function pickTrimmed(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function normalizePreparedDraft(
  draft: FeedbackPreparedDraft,
  overrides?: { title?: string; body?: string; labels?: string[] },
): FeedbackPreparedDraft {
  const draftInput = normalizeDraftInput(draft.draftInput);
  const category = draftInput.category;
  const fallbackTitle = fallbackTitleForInput(draftInput);
  const userDescription = pickTrimmed(draft.userDescription) ?? buildUserDescription(draftInput);
  const title = pickTrimmed(overrides?.title, draft.title) ?? fallbackTitle;
  const body = pickTrimmed(overrides?.body, draft.body) ?? buildIssueBody(draftInput);
  const labels = normalizeLabels(category, overrides?.labels ?? draft.labels);
  return {
    category,
    draftInput,
    userDescription,
    modelId: pickTrimmed(draft.modelId),
    reasoningEffort: draft.reasoningEffort ?? null,
    title,
    body,
    labels,
    generationMode: normalizeGenerationMode(draft.generationMode) ?? "deterministic",
    generationWarning: normalizeGenerationWarning(draft.generationWarning),
  };
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
    return (db.getJson<FeedbackSubmission[]>(DB_KEY) ?? []).map(normalizeStoredSubmission);
  }

  function save(submission: FeedbackSubmission): void {
    const all = loadAll();
    const idx = all.findIndex((entry) => entry.id === submission.id);
    if (idx >= 0) {
      all[idx] = submission;
    } else {
      all.push(submission);
    }
    db.setJson(DB_KEY, all);
  }

  async function prepareDraft(args: FeedbackPrepareDraftArgs): Promise<FeedbackPreparedDraft> {
    const draftInput = normalizeDraftInput(args.draftInput);
    const category = draftInput.category;
    const body = buildIssueBody(draftInput);
    const userDescription = buildUserDescription(draftInput);
    const fallbackTitle = fallbackTitleForInput(draftInput);
    const modelId = pickTrimmed(args.modelId);
    const reasoningEffort = args.reasoningEffort ?? null;

    let title = fallbackTitle;
    let labels = defaultLabelsForCategory(category);
    let generationMode: FeedbackGenerationMode = "deterministic";
    let generationWarning: string | null = modelId ? DETERMINISTIC_FORMAT_WARNING : DETERMINISTIC_NO_MODEL_WARNING;

    if (modelId) {
      try {
        const result = await aiIntegrationService.executeTask({
          feature: "pr_descriptions",
          taskType: "pr_description",
          prompt: buildMetadataPrompt(draftInput, body),
          systemPrompt: METADATA_SYSTEM_PROMPT,
          cwd: projectRoot,
          model: modelId,
          jsonSchema: FEEDBACK_METADATA_JSON_SCHEMA,
          permissionMode: "read-only",
          oneShot: true,
          timeoutMs: 120_000,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        });
        const suggestion = normalizeMetadataSuggestion(
          category,
          fallbackTitle,
          result.structuredOutput ?? parseStructuredOutput(result.text),
        );
        title = suggestion.title;
        labels = suggestion.labels;
        generationMode = suggestion.generationMode;
        generationWarning = suggestion.generationWarning;
        if (suggestion.generationMode === "deterministic") {
          logger.warn("feedback.draft_generated_deterministically", {
            category,
            modelId,
          });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("feedback.draft_ai_failed_using_deterministic", {
          category,
          modelId,
          error: message,
        });
        generationWarning = `ADE used a deterministic draft because AI title and label suggestion failed: ${message}`;
      }
    }

    return {
      category,
      draftInput,
      userDescription,
      modelId,
      reasoningEffort,
      title,
      body,
      labels,
      generationMode,
      generationWarning,
    };
  }

  async function submitPreparedDraft(args: FeedbackSubmitDraftArgs): Promise<FeedbackSubmission> {
    const prepared = normalizePreparedDraft(args.draft, {
      title: args.title,
      body: args.body,
      labels: args.labels,
    });

    const submission: FeedbackSubmission = {
      id: randomUUID(),
      category: prepared.category,
      userDescription: prepared.userDescription,
      modelId: prepared.modelId,
      reasoningEffort: prepared.reasoningEffort ?? null,
      status: "posting",
      generationMode: prepared.generationMode,
      generationWarning: prepared.generationWarning,
      generatedTitle: prepared.title,
      generatedBody: prepared.body,
      issueUrl: null,
      issueNumber: null,
      issueState: null,
      error: null,
      createdAt: nowIso(),
      completedAt: null,
    };

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
          title: prepared.title,
          body: prepared.body,
          labels: prepared.labels,
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
      submission.error = `Posting failed: ${message}`;
      submission.completedAt = nowIso();
      save(submission);
      emitUpdate(submission);

      logger.error("feedback.failed", {
        id: submission.id,
        error: submission.error,
      });
    }

    return submission;
  }

  function list(): FeedbackSubmission[] {
    return loadAll().sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  return {
    prepareDraft,
    submitPreparedDraft,
    list,
  };
}
