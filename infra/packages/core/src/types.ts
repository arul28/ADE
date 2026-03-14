export type HostedJobType =
  | "NarrativeGeneration"
  | "ConflictResolution"
  | "ProposeConflictResolution"
  | "DraftPrDescription";

export type JobPayload = {
  projectId: string;
  userId: string;
  jobId: string;
  type: HostedJobType;
  laneId: string;
  params: Record<string, unknown>;
  submittedAt: string;
};

export type JobArtifact = {
  artifactType: "narrative" | "diff" | "pr-description";
  content: string;
  confidence?: number;
  metadata: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    generatedAt: string;
  };
};

export type LlmProvider = "mock" | "openai" | "anthropic" | "gemini";

export type LlmGatewayConfig = {
  provider: LlmProvider;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
};

export type PromptTemplate = {
  system: string;
  user: string;
  expectedArtifactType: JobArtifact["artifactType"];
};

export type LlmGatewayResult = {
  text: string;
  provider: LlmProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};
