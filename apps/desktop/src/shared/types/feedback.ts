export type FeedbackCategory = "bug" | "feature" | "enhancement" | "question";

export type FeedbackGenerationMode = "ai_assisted" | "deterministic";

type FeedbackDraftInputBase = {
  summary: string;
  additionalContext?: string | null;
};

export type FeedbackBugDraftInput = FeedbackDraftInputBase & {
  category: "bug";
  stepsToReproduce?: string | null;
  expectedBehavior?: string | null;
  actualBehavior?: string | null;
  environment?: string | null;
};

export type FeedbackEnhancementDraftInput = FeedbackDraftInputBase & {
  category: "feature" | "enhancement";
  useCase?: string | null;
  proposedSolution?: string | null;
  alternativesConsidered?: string | null;
};

export type FeedbackQuestionDraftInput = FeedbackDraftInputBase & {
  category: "question";
  context?: string | null;
  expectedGuidance?: string | null;
};

export type FeedbackDraftInput =
  | FeedbackBugDraftInput
  | FeedbackEnhancementDraftInput
  | FeedbackQuestionDraftInput;

export type FeedbackPreparedDraft = {
  category: FeedbackCategory;
  draftInput: FeedbackDraftInput;
  userDescription: string;
  modelId: string | null;
  reasoningEffort?: string | null;
  title: string;
  body: string;
  labels: string[];
  generationMode: FeedbackGenerationMode;
  generationWarning: string | null;
};

export type FeedbackPrepareDraftArgs = {
  draftInput: FeedbackDraftInput;
  modelId?: string | null;
  reasoningEffort?: string | null;
};

export type FeedbackSubmitDraftArgs = {
  draft: FeedbackPreparedDraft;
  title: string;
  body: string;
  labels: string[];
};

export type FeedbackSubmission = {
  id: string;
  category: FeedbackCategory;
  userDescription: string;
  modelId: string | null;
  reasoningEffort?: string | null;
  status: "pending" | "generating" | "posting" | "posted" | "failed";
  generationMode: FeedbackGenerationMode | null;
  generationWarning: string | null;
  generatedTitle: string | null;
  generatedBody: string | null;
  issueUrl: string | null;
  issueNumber: number | null;
  issueState: "open" | "closed" | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type FeedbackSubmissionEvent = {
  type: "feedback-submission-updated";
  submission: FeedbackSubmission;
};
