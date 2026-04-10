export type FeedbackCategory = "bug" | "feature" | "enhancement" | "question";

export type FeedbackSubmission = {
  id: string;
  category: FeedbackCategory;
  userDescription: string;
  modelId: string;
  reasoningEffort?: string | null;
  status: "pending" | "generating" | "posting" | "posted" | "failed";
  generatedTitle: string | null;
  generatedBody: string | null;
  issueUrl: string | null;
  issueNumber: number | null;
  issueState: "open" | "closed" | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type FeedbackSubmitArgs = {
  category: FeedbackCategory;
  userDescription: string;
  modelId: string;
  reasoningEffort?: string | null;
};

export type FeedbackSubmissionEvent = {
  type: "feedback-submission-updated";
  submission: FeedbackSubmission;
};
