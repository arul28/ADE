import type { FeedbackCategory, FeedbackDraftInput, FeedbackSubmission } from "../../../desktop/src/shared/types/feedback";
import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";
import type { ProjectLaunchContext } from "./types";

export type FeedbackFormFieldName =
  | "category"
  | "summary"
  | "details"
  | "expected"
  | "actual"
  | "environment"
  | "additionalContext";

export type FeedbackFormValues = Partial<Record<FeedbackFormFieldName, string>>;

export type FeedbackFormField = {
  name: FeedbackFormFieldName;
  label: string;
  required?: boolean;
  placeholder?: string;
  initialValue?: string;
};

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function appendContext(...parts: Array<string | null | undefined>): string {
  return parts.map(clean).filter(Boolean).join("\n\n");
}

export function normalizeFeedbackCategory(value: string | null | undefined): FeedbackCategory {
  const normalized = clean(value).toLowerCase();
  if (normalized === "feature") return "feature";
  if (normalized === "enhancement") return "enhancement";
  if (normalized === "question") return "question";
  return "bug";
}

export function buildFeedbackEnvironment(project: ProjectLaunchContext, lane: LaneSummary | null): string {
  return [
    `Source: ADE Code`,
    `Project: ${project.projectRoot}`,
    `Workspace: ${project.workspaceRoot}`,
    lane ? `Lane: ${lane.name}` : null,
    lane ? `Branch: ${lane.branchRef}` : null,
    lane ? `Worktree: ${lane.worktreePath}` : null,
  ].filter(Boolean).join("\n");
}

export function feedbackFormFields(environment: string): FeedbackFormField[] {
  return [
    { name: "category", label: "Category", initialValue: "bug", placeholder: "bug, feature, enhancement, or question" },
    { name: "summary", label: "Summary", required: true, placeholder: "What changed, broke, or should be improved?" },
    { name: "details", label: "Details", placeholder: "Steps to reproduce, use case, or question context" },
    { name: "expected", label: "Expected", placeholder: "What should have happened or what guidance would help?" },
    { name: "actual", label: "Actual", placeholder: "What happened instead, or the current behavior" },
    { name: "environment", label: "Environment", initialValue: environment, placeholder: "ADE version, lane, OS, or runtime context" },
    { name: "additionalContext", label: "Additional", placeholder: "Links, screenshots, workaround notes, or anything else useful" },
  ];
}

export function buildFeedbackDraftInput(values: FeedbackFormValues): FeedbackDraftInput {
  const category = normalizeFeedbackCategory(values.category);
  const summary = clean(values.summary);
  const details = clean(values.details);
  const expected = clean(values.expected);
  const actual = clean(values.actual);
  const environment = clean(values.environment);
  const additionalContext = clean(values.additionalContext);

  if (category === "feature" || category === "enhancement") {
    return {
      category,
      summary,
      useCase: details,
      proposedSolution: expected,
      alternativesConsidered: actual,
      additionalContext: appendContext(additionalContext, environment ? `Environment:\n${environment}` : null),
    };
  }

  if (category === "question") {
    return {
      category: "question",
      summary,
      context: details,
      expectedGuidance: expected,
      additionalContext: appendContext(
        additionalContext,
        actual ? `Current behavior:\n${actual}` : null,
        environment ? `Environment:\n${environment}` : null,
      ),
    };
  }

  return {
    category: "bug",
    summary,
    stepsToReproduce: details,
    expectedBehavior: expected,
    actualBehavior: actual,
    environment,
    additionalContext,
  };
}

export function feedbackSubmissionNotice(submission: FeedbackSubmission): {
  text: string;
  tone: "success" | "error";
} {
  if (submission.status === "posted") {
    return {
      text: submission.issueNumber
        ? `Feedback posted as GitHub issue #${submission.issueNumber}.`
        : "Feedback posted to GitHub.",
      tone: "success",
    };
  }

  return {
    text: submission.error ?? "GitHub posting failed. The draft was saved in the feedback hub.",
    tone: "error",
  };
}
