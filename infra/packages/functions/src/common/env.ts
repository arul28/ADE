import type { LlmProvider } from "../../../core/src/types";

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function parseNumberEnv(name: string, fallback: number): number {
  const value = optional(name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const sharedEnv = {
  appStage: required("APP_STAGE"),
  projectsTableName: required("PROJECTS_TABLE_NAME"),
  lanesTableName: required("LANES_TABLE_NAME"),
  jobsTableName: required("JOBS_TABLE_NAME"),
  artifactsTableName: required("ARTIFACTS_TABLE_NAME"),
  rateLimitsTableName: required("RATE_LIMITS_TABLE_NAME"),
  githubConnectStatesTableName: required("GITHUB_CONNECT_STATES_TABLE_NAME"),
  githubInstallationsTableName: required("GITHUB_INSTALLATIONS_TABLE_NAME"),
  githubEventsTableName: required("GITHUB_EVENTS_TABLE_NAME"),
  linearWebhookEndpointsTableName: required("LINEAR_WEBHOOK_ENDPOINTS_TABLE_NAME"),
  linearEventsTableName: required("LINEAR_EVENTS_TABLE_NAME"),
  blobsBucketName: required("BLOBS_BUCKET_NAME"),
  manifestsBucketName: required("MANIFESTS_BUCKET_NAME"),
  artifactsBucketName: required("ARTIFACTS_BUCKET_NAME"),
  jobsQueueUrl: optional("JOBS_QUEUE_URL"),
  corsOrigin: optional("API_CORS_ORIGIN"),
  llmProvider: (optional("LLM_PROVIDER") as LlmProvider | undefined) ?? "mock",
  llmModel: optional("LLM_MODEL") ?? "claude-3-5-sonnet-latest",
  llmSecretArn: optional("LLM_SECRET_ARN"),
  llmMaxInputTokens: parseNumberEnv("LLM_MAX_INPUT_TOKENS", 200_000),
  llmMaxOutputTokens: parseNumberEnv("LLM_MAX_OUTPUT_TOKENS", 4_000),
  rateLimitJobsPerMinute: parseNumberEnv("RATE_LIMIT_JOBS_PER_MINUTE", 20),
  rateLimitDailyJobs: parseNumberEnv("RATE_LIMIT_DAILY_JOBS", 500),
  rateLimitDailyEstimatedTokens: parseNumberEnv("RATE_LIMIT_DAILY_ESTIMATED_TOKENS", 250_000),
  githubAppId: optional("GITHUB_APP_ID"),
  githubAppSlug: optional("GITHUB_APP_SLUG"),
  githubAppPrivateKeyBase64: optional("GITHUB_APP_PRIVATE_KEY_BASE64"),
  githubWebhookSecret: optional("GITHUB_WEBHOOK_SECRET")
};
