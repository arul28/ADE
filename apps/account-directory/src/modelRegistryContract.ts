/**
 * The model registry wire contract: the Worker's copy.
 *
 * `GET /router/registry` serves one `ModelRegistrySnapshot`, and the desktop
 * app's router reads it. The Worker is a separate deploy unit and must not
 * import from the app, so it keeps this copy of
 * `apps/desktop/src/shared/routerRegistry.ts`. Change one, change both:
 * `test/modelRegistryContract.test.ts` imports the desktop file and fails when
 * the two disagree.
 */

export const MODEL_REGISTRY_SCHEMA_VERSION = 1 as const;
export const MODEL_REGISTRY_PATH = "/router/registry";
/** Attribution Artificial Analysis asks for wherever its data is shown. */
export const MODEL_REGISTRY_AA_ATTRIBUTION = "Source: Artificial Analysis (artificialanalysis.ai)";

/** USD per million tokens. Null when the source has no figure. */
export type ModelRegistryPrice = {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** Higher rates above a context size, when the source lists them. */
  tiers?: Array<{ aboveContextTokens: number; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null }>;
};

/**
 * One Artificial Analysis model variant. A family with effort levels has one
 * variant per level (`claude-sonnet-5-5-high`, `claude-sonnet-5-5`, ...).
 * Scores are fractions from 0 to 1 unless named `...Index` (0 to 100).
 */
export type ModelRegistryModel = {
  slug: string;
  /** The family slug shared by every effort variant. */
  releaseSlug: string;
  name: string;
  shortName: string | null;
  creator: string | null;
  releaseDate: string | null;
  deprecated: boolean;
  /** `low` | `medium` | `high` | `xhigh` | `max` | ...; null for a model without levels. */
  effort: string | null;
  reasoning: boolean;
  openWeights: boolean;
  contextWindow: number | null;
  intelligenceIndex: number | null;
  intelligenceIndexEstimated: boolean;
  terminalBench40: number | null;
  sciCode: number | null;
  longContextReasoning: number | null;
  humanitysLastExam: number | null;
  gpqa: number | null;
  ifBench: number | null;
  /** What one Intelligence Index task cost and took on this variant. */
  costPerIndexTaskUsd: number | null;
  secondsPerIndexTask: number | null;
  outputTokensPerSecond: number | null;
  timeToFirstTokenSeconds: number | null;
  /** The first-party list price Artificial Analysis records. */
  price: ModelRegistryPrice;
};

/** One Coding Agent Index row: a harness running a model (or a model pair). */
export type ModelRegistryAgentRow = {
  id: string;
  /** Harness name as Artificial Analysis shows it: `Claude Code`, `Codex`, `Opencode`, ... */
  agent: string;
  label: string;
  /** The variant the row ran, when it maps to one; null for pairs and unknown names. */
  modelSlug: string | null;
  /** True for a lead + sidekick pair (Devin Fusion). */
  pair: boolean;
  /** Coding Agent Index score, 0 to 1. */
  score: number | null;
  evals: Array<{ name: string; score: number | null }>;
  costUsdPerTask: number | null;
  minutesPerTask: number | null;
  stepsPerTask: number | null;
  cacheHitRate: number | null;
  tokensPerTask: number | null;
};

export type ModelRegistrySourceStatus = {
  /** When the Worker last read this source successfully. */
  fetchedAt: string | null;
  ok: boolean;
  /** Why the last read failed, when it did. A failed read keeps the previous data. */
  error?: string;
};

export type ModelRegistrySnapshot = {
  schemaVersion: typeof MODEL_REGISTRY_SCHEMA_VERSION;
  generatedAt: string;
  attribution: typeof MODEL_REGISTRY_AA_ATTRIBUTION;
  sources: {
    artificialAnalysis: ModelRegistrySourceStatus;
    modelsDev: ModelRegistrySourceStatus;
  };
  models: ModelRegistryModel[];
  agents: ModelRegistryAgentRow[];
  /**
   * Per-token prices by channel, then by the channel's own model id. Channels:
   * `anthropic`, `openai`, `opencode` (OpenCode Zen), `opencode-go`,
   * `deepseek`, `xai`, `google`, `zai`, `moonshotai`.
   */
  prices: Record<string, Record<string, ModelRegistryPrice>>;
};

/** The models.dev providers the Worker copies prices from. */
export const MODEL_REGISTRY_PRICE_CHANNELS = [
  "anthropic",
  "openai",
  "opencode",
  "opencode-go",
  "deepseek",
  "xai",
  "google",
  "zai",
  "moonshotai",
] as const;

export function isModelRegistrySnapshot(value: unknown): value is ModelRegistrySnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<ModelRegistrySnapshot>;
  return v.schemaVersion === MODEL_REGISTRY_SCHEMA_VERSION
    && typeof v.generatedAt === "string"
    && Array.isArray(v.models)
    && Array.isArray(v.agents)
    && !!v.prices && typeof v.prices === "object";
}
