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
  // The profile below is optional: snapshots before 2026-10-20 have none of
  // it, and a field with no figure is left out rather than written as null.
  /** Where this variant's data came from; see `ModelRegistryProfileSource`. */
  profile?: ModelRegistryProfileSource;
  /**
   * Every other evaluation score Artificial Analysis publishes for the variant,
   * by the keys in `MODEL_REGISTRY_EVALS` (units there). An eval without a
   * score is absent.
   */
  evals?: Record<string, number>;
  /** GDPval-AA by occupation group (`legal`, `engineering`, ...), 0 to 100. */
  domains?: Record<string, number>;
  /** AA PersonalityBench indices (`warmth`, `slop`, `conviction`, ...), 0 to 100. */
  personality?: Record<string, number>;
  modalities?: { input: ModelRegistryModality[]; output: ModelRegistryModality[] };
  license?: string;
  /** Artificial Analysis's category: `proprietary`, `permissive`, `commercial-license`, ... */
  licenseCategory?: string;
  parametersBillions?: number;
  activeParametersBillions?: number;
  /** `tiny` | `small` | `medium` | `large`, as Artificial Analysis sizes open models. */
  sizeClass?: string;
  knowledgeCutoff?: string;
  /** Seconds to the first answer token, thinking included, on the long-prompt workload. */
  timeToFirstAnswerTokenSeconds?: number;
  /** Seconds for a whole 500-token answer on the long-prompt workload. */
  endToEndSeconds?: number;
  /** Output tokens (reasoning and answer) one Intelligence Index task took. */
  outputTokensPerIndexTask?: number;
};

/**
 * - `record`: Artificial Analysis's full model record (a model page carries
 *   these only for its featured models): every field it publishes.
 * - `leaderboard`: a `/leaderboards/models` row. It has the scores, speed and
 *   prices, not the modalities, license or domain and personality indices;
 *   those stay from an earlier `record` copy of the same slug, if any.
 * - `carried`: no current page lists the variant (Artificial Analysis lists
 *   only current models); the last data seen is kept.
 */
export type ModelRegistryProfileSource = "record" | "leaderboard" | "carried";

export type ModelRegistryModality = "text" | "image" | "speech" | "video";

/**
 * The keys of `ModelRegistryModel.evals`, with units. Fractions are 0 to 1;
 * higher is better unless the note says otherwise.
 */
export const MODEL_REGISTRY_EVALS = {
  terminalBench21: "Terminal-Bench 2.1, fraction",
  terminalBenchHard: "Terminal-Bench Hard, fraction",
  terminalBenchScience: "Terminal-Bench Science, fraction",
  critPt: "CritPt (physics research), fraction",
  mmmuPro: "MMMU-Pro (image understanding), fraction",
  apexAgents: "APEX-Agents, fraction",
  analystAgent: "AA Analyst Agent, fraction",
  tau2Bench: "τ²-Bench Telecom (tool use), fraction",
  tauBanking: "τ-Bench Banking, fraction",
  itBenchSre: "ITBench SRE, fraction",
  harveyLab: "Harvey LAB (legal), fraction",
  frontierCode: "FrontierCode, fraction",
  enterpriseOpsGym: "EnterpriseOps-Gym, fraction",
  automationBench: "AutomationBench (partial score), fraction",
  gdpPdf: "GDP-PDF (all checks pass), fraction",
  gdpval: "GDPval-AA (knowledge work), normalized fraction",
  gdpvalElo: "GDPval-AA, Elo",
  briefcaseElo: "AA Briefcase (document work), Elo",
  briefcaseRubricPassRate: "AA Briefcase rubric pass rate, fraction",
  aa3dElo: "AA 3D (3D scene generation), Elo",
  mlcr: "MLCR (multilingual long context), fraction",
  omniscienceIndex: "AA-Omniscience index, -100 to 100",
  omniscienceAccuracy: "AA-Omniscience accuracy, fraction",
  omniscienceHallucinationRate: "AA-Omniscience hallucination rate, fraction, lower is better",
  aime25: "AIME 2025 (math), fraction",
  liveCodeBench: "LiveCodeBench, fraction",
  opennessIndex: "AA Openness Index, 0 to 100",
} as const;

export type ModelRegistryMediaKind = "text-to-speech" | "speech-to-text" | "speech-to-speech";

/**
 * One row of an Artificial Analysis speech leaderboard: a speech model as one
 * host serves it. Speech models are mostly not LLMs, so a row stands on its
 * own; `modelSlug` links it to an LLM variant only when the names match
 * exactly.
 */
export type ModelRegistryMediaRow = {
  kind: ModelRegistryMediaKind;
  /** Artificial Analysis's id for the host + model pair. */
  id: string;
  model: string;
  host: string | null;
  releaseDate: string | null;
  openWeights: boolean | null;
  /** The LLM variant whose name or short name is exactly `model`; null otherwise. */
  modelSlug: string | null;
  /** By the keys in `MODEL_REGISTRY_MEDIA_SCORES` for the row's kind. Absent when unmeasured. */
  scores: Record<string, number>;
};

/** The keys of `ModelRegistryMediaRow.scores` for each kind, with units. */
export const MODEL_REGISTRY_MEDIA_SCORES = {
  "text-to-speech": {
    qualityElo: "Speech Arena quality, Elo",
    pricePer1mCharacters: "USD per million characters",
    charactersPerSecond: "median characters generated per second",
    generationSeconds: "median seconds to generate the benchmark passage",
  },
  "speech-to-text": {
    werIndex: "AA-WER index, word error rate, lower is better",
    aaSttWer: "AA-STT dataset word error rate, lower is better",
    voxPopuliWer: "VoxPopuli word error rate, lower is better",
    earnings22Wer: "Earnings-22 word error rate, lower is better",
    pricePer1kMinutes: "USD per 1,000 minutes of audio",
    speedFactor: "median seconds of audio transcribed per second",
  },
  "speech-to-speech": {
    qualityIndex: "Speech-to-speech quality index, 0 to 100",
    bigBenchAudio: "Big Bench Audio (reasoning over speech), fraction",
    fullDuplexBench: "Full-Duplex-Bench (turn taking, interruptions), fraction",
    tauVoice: "τ-Voice (voice agent tasks), fraction",
    timeToFirstAudioSeconds: "seconds to the first audio",
    costPerHourInputAudio: "USD per hour of input audio, measured",
    pricePerHourInput: "USD per hour of input audio, list",
    pricePerHourOutput: "USD per hour of output audio, list",
  },
} as const;

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
    /** The speech leaderboards; absent before 2026-10-20. */
    media?: ModelRegistrySourceStatus;
  };
  models: ModelRegistryModel[];
  agents: ModelRegistryAgentRow[];
  /** Speech leaderboard rows; absent before 2026-10-20. */
  media?: ModelRegistryMediaRow[];
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
