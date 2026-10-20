/**
 * The model sheet: every model this user can run, organized by the kind of
 * task it is good for.
 *
 * It carries two things for each model. Numbers, for code: a 0-to-1 score per
 * task kind, computed here from the registry's benchmarks with the weight
 * table below, plus speed and cost tiers. Words, for people and for Jev (which
 * matches plain-English descriptions far better than it compares numbers): a
 * curated summary, strengths, weaknesses, and best-for / avoid-for lists from
 * `modelSheetNotes.json`, or words generated from the scores when a family has
 * no curated notes.
 *
 * Runnable models the router cannot map onto the registry are resolved
 * through `modelSheetMatches.json`, a curated table that only the sheet reads
 * (the router keeps its own aliases). A `nearest-sibling` match is shown as a
 * note and never lends its scores.
 *
 * Pure: the caller passes the snapshot and the user's catalogue
 * (`buildUserModelCatalog`). Scores refresh with every snapshot; the curated
 * words do not, and each says which benchmark it rests on (`basis`).
 */
import {
  MODEL_REGISTRY_AA_ATTRIBUTION,
  type ModelRegistryModel,
  type ModelRegistrySnapshot,
} from "../../../shared/routerRegistry";
import type { UserCatalogModel, UserModelCatalog } from "./modelCatalog";
import type { RouteBilling, RouteHarness } from "./routeCatalog";
import curatedMatches from "./modelSheetMatches.json";
import curatedNotes from "./modelSheetNotes.json";

/**
 * The kinds of task the sheet scores. The composer's classifier (Jev) sorts a
 * prompt into the first eight; its separate `media` hint is not a sheet kind.
 */
export const MODEL_SHEET_TASK_KINDS = [
  "question",
  "research",
  "review",
  "small_edit",
  "feature",
  "debugging",
  "refactor",
  "writing",
  "vision",
] as const;
export type ModelSheetTaskKind = (typeof MODEL_SHEET_TASK_KINDS)[number];

/**
 * The benchmarks a task-kind score reads. Each one is normalized to 0..1
 * across current models (min to max), flipped when lower is better.
 */
type MetricKey =
  | "intelligenceIndex"
  | "terminalBench40"
  | "terminalBenchHard"
  | "sciCode"
  | "ifBench"
  | "gpqa"
  | "humanitysLastExam"
  | "longContextReasoning"
  | "critPt"
  | "tau2Bench"
  | "tauBanking"
  | "terminalBench21"
  | "itBenchSre"
  | "frontierCode"
  | "mmmuPro"
  | "gdpval"
  | "briefcaseRubricPassRate"
  | "knowledgeAccuracy"
  | "hallucinationRate"
  | "slop"
  | "codingAgentIndex";

type MetricDef = { label: string; lowerIsBetter?: boolean };

/** What each metric is, as the review doc and the CLI print it. */
export const MODEL_SHEET_METRICS: Record<MetricKey, MetricDef> = {
  intelligenceIndex: { label: "AA Intelligence Index" },
  terminalBench40: { label: "Terminal-Bench 4.0" },
  terminalBenchHard: { label: "Terminal-Bench Hard" },
  sciCode: { label: "SciCode" },
  ifBench: { label: "IFBench (instruction following)" },
  gpqa: { label: "GPQA Diamond" },
  humanitysLastExam: { label: "Humanity's Last Exam" },
  longContextReasoning: { label: "AA-LCR (long-context reasoning)" },
  critPt: { label: "CritPt (physics research)" },
  tau2Bench: { label: "τ²-Bench Telecom (tool use)" },
  tauBanking: { label: "τ-Bench Banking (tool use)" },
  terminalBench21: { label: "Terminal-Bench 2.1" },
  itBenchSre: { label: "ITBench SRE (incident debugging)" },
  frontierCode: { label: "FrontierCode" },
  mmmuPro: { label: "MMMU-Pro (image understanding)" },
  gdpval: { label: "GDPval-AA (knowledge work)" },
  briefcaseRubricPassRate: { label: "AA Briefcase rubric (document work)" },
  knowledgeAccuracy: { label: "AA-Omniscience accuracy" },
  hallucinationRate: { label: "AA-Omniscience hallucination rate", lowerIsBetter: true },
  slop: { label: "PersonalityBench slop", lowerIsBetter: true },
  codingAgentIndex: { label: "Coding Agent Index (mean over harnesses)" },
};

type KindWeights = {
  weights: Partial<Record<MetricKey, number>>;
  /** Metrics without which the kind has no score at all. */
  requires?: MetricKey[];
};

/**
 * How each task kind is scored: a weighted mean of normalized benchmarks.
 * Weights sum to 1 per kind. Artificial Analysis no longer runs some older
 * evals (IFBench, GPQA, Terminal-Bench Hard, τ²-Bench) on new models, and runs
 * others (FrontierCode, Briefcase, the Coding Agent Index) only on featured
 * ones, so each kind leans on the benchmarks every current model has
 * (Intelligence Index, Terminal-Bench 4.0, SciCode, HLE, AA-LCR, CritPt,
 * GDPval, Omniscience) for at least `MIN_WEIGHT_COVERAGE` of its weight, and
 * adds the rest where measured. A model missing benchmarks is scored on the
 * ones it has, while they carry at least that share; below it, or without a
 * required metric, the kind is null.
 */
export const TASK_KIND_WEIGHTS: Record<ModelSheetTaskKind, KindWeights> = {
  // A quick answer about code or the world: it needs to know things and not
  // make them up. Omniscience measures both; GPQA and the index add reasoning.
  question: {
    weights: { knowledgeAccuracy: 0.3, hallucinationRate: 0.2, intelligenceIndex: 0.3, gpqa: 0.2 },
  },
  // Digging through sources and long material to a sound conclusion:
  // frontier reasoning (HLE, CritPt, GPQA) plus holding a long context (AA-LCR).
  research: {
    weights: { humanitysLastExam: 0.3, longContextReasoning: 0.25, intelligenceIndex: 0.15, critPt: 0.1, knowledgeAccuracy: 0.1, gpqa: 0.1 },
  },
  // Reading a diff and its surroundings to find real problems: long-context
  // reading, code understanding (SciCode, Terminal-Bench, the agent index),
  // and not inventing issues (hallucination rate).
  review: {
    weights: { intelligenceIndex: 0.25, longContextReasoning: 0.2, sciCode: 0.15, terminalBench40: 0.15, hallucinationRate: 0.1, codingAgentIndex: 0.15 },
  },
  // A small, well-specified change: competent code (SciCode), a short shell
  // loop (Terminal-Bench), doing exactly what was asked (IFBench, where
  // measured) and clean tool calls (τ-Bench). Nearly every coding model can.
  small_edit: {
    weights: { sciCode: 0.3, terminalBench40: 0.25, intelligenceIndex: 0.15, ifBench: 0.15, tauBanking: 0.075, tau2Bench: 0.075 },
  },
  // Building something across files in an agent harness: Terminal-Bench and
  // the Coding Agent Index measure exactly that; FrontierCode backs them up.
  feature: {
    weights: { terminalBench40: 0.3, sciCode: 0.15, intelligenceIndex: 0.15, codingAgentIndex: 0.25, frontierCode: 0.1, terminalBench21: 0.05 },
  },
  // Reproducing and fixing a failure from a shell: Terminal-Bench is that
  // loop; ITBench SRE is incident diagnosis; SciCode is careful code reasoning.
  debugging: {
    weights: { terminalBench40: 0.35, sciCode: 0.15, intelligenceIndex: 0.1, codingAgentIndex: 0.2, itBenchSre: 0.1, terminalBenchHard: 0.05, terminalBench21: 0.05 },
  },
  // Many coordinated edits that must keep behavior: agent work across a
  // codebase, holding a long context, and following the constraints given.
  refactor: {
    weights: { terminalBench40: 0.25, longContextReasoning: 0.2, sciCode: 0.15, intelligenceIndex: 0.05, codingAgentIndex: 0.25, ifBench: 0.1 },
  },
  // Docs, PR descriptions, messages: knowledge-work output people rate well
  // (GDPval, Briefcase), following the brief (IFBench), without made-up facts
  // or slop.
  writing: {
    weights: { gdpval: 0.3, intelligenceIndex: 0.15, hallucinationRate: 0.15, ifBench: 0.15, briefcaseRubricPassRate: 0.15, slop: 0.1 },
  },
  // Screenshots, diagrams, UI: MMMU-Pro is the image-understanding benchmark.
  // A model without an MMMU-Pro score has no vision score.
  vision: {
    weights: { mmmuPro: 0.8, intelligenceIndex: 0.2 },
    requires: ["mmmuPro"],
  },
};

/** A kind needs benchmarks carrying at least this share of its weight. */
export const MIN_WEIGHT_COVERAGE = 0.6;
/** Two efforts within this score of each other count as a tie; the cheaper wins. */
export const EFFORT_TIE = 0.02;

export type ModelSheetSpeedTier = "fast" | "medium" | "slow";
export type ModelSheetCostTier = "cheap" | "mid" | "premium";

/**
 * Tier thresholds. Speed reads the seconds one Intelligence Index task took
 * (thinking included); without it, the seconds for a whole 500-token answer on
 * the long-prompt workload. Cost reads the dollars one index task cost;
 * without it, the list price blended 3:1 input to output. Roughly the 25th
 * and 75th percentiles of current models (2026-10-20).
 */
export const MODEL_SHEET_TIERS = {
  speed: {
    secondsPerIndexTask: { fast: 150, medium: 500 },
    endToEndSeconds: { fast: 12, medium: 40 },
  },
  cost: {
    costPerIndexTaskUsd: { cheap: 0.25, mid: 1.5 },
    blendedPricePerMillion: { cheap: 1, mid: 5 },
  },
  /** A first answer token later than this is called out as a quirk. */
  slowFirstTokenSeconds: 30,
} as const;

export type ModelSheetMatchRelation = "same" | "same-model-faster-serving" | "nearest-sibling" | "none";

export type ModelSheetMatch = {
  harnessModelId: string;
  registryFamily: string | null;
  relation: ModelSheetMatchRelation;
  confidence: "high" | "medium" | "low";
  reason: string;
  /** Set when the harness lists the model but it may not run for this user. */
  availabilityDoubt?: string;
};

export type ModelSheetNotes = {
  summary: string;
  strengths: string[];
  weaknesses: string[];
  bestFor: Array<{ kind: ModelSheetTaskKind; why: string }>;
  avoidFor: Array<{ kind: ModelSheetTaskKind; why: string }>;
  notes: string[];
  /** The benchmark behind each claim, so a reviewer can check it. */
  basis: string[];
  /** `curated` from modelSheetNotes.json; `generated` from scores and tiers. */
  source: "curated" | "generated";
};

export type ModelSheetVariant = {
  slug: string;
  effort: string | null;
  /** 0..1 per task kind; a kind without enough data is absent. */
  kinds: Partial<Record<ModelSheetTaskKind, number>>;
  speed: ModelSheetSpeedTier | null;
  cost: ModelSheetCostTier | null;
  intelligenceIndex: number | null;
  costPerIndexTaskUsd: number | null;
  secondsPerIndexTask: number | null;
  timeToFirstAnswerTokenSeconds: number | null;
  outputTokensPerSecond: number | null;
};

export type ModelSheetEffort = {
  effort: string | null;
  isDefault: boolean;
  /**
   * The registry variant measured at this exact level (its scores, tiers, and
   * cost and time per task are in the family's `variants`); null when none was.
   */
  slug: string | null;
};

export type ModelSheetModel = {
  harness: RouteHarness;
  modelId: string;
  displayName: string;
  billing: RouteBilling;
  /** The curated match, for a model the router could not map itself. */
  match: Omit<ModelSheetMatch, "harnessModelId"> | null;
  /** The variant the headline scores come from, and its effort. */
  scoredSlug: string | null;
  scoredEffort: string | null;
  /** The effort a task runs at when it names none (`isDefault`, else `high`, else the first). */
  defaultEffort: string | null;
  /** The best measured effort for each kind; within `EFFORT_TIE`, the cheaper one. */
  bestEffort: Partial<Record<ModelSheetTaskKind, string | null>>;
  efforts: ModelSheetEffort[];
};

export type ModelSheetFamily = {
  /** The registry family slug; null for a model with no registry data. */
  family: string | null;
  name: string;
  creator: string | null;
  releaseDate: string | null;
  openWeights: boolean | null;
  contextWindow: number | null;
  inputModalities: string[] | null;
  /** `record` / `leaderboard`: current data; `carried`: Artificial Analysis no longer lists it. */
  data: string | null;
  /** Headline scores, at `high` where measured, else AA's own default variant (`headlineSlug`). */
  headlineSlug: string | null;
  kinds: Partial<Record<ModelSheetTaskKind, number>>;
  speed: ModelSheetSpeedTier | null;
  cost: ModelSheetCostTier | null;
  notes: ModelSheetNotes;
  variants: ModelSheetVariant[];
  models: ModelSheetModel[];
};

export type ModelSheet = {
  attribution: typeof MODEL_REGISTRY_AA_ATTRIBUTION;
  generatedAt: string | null;
  kinds: readonly ModelSheetTaskKind[];
  families: ModelSheetFamily[];
};

type CuratedNote = Omit<ModelSheetNotes, "source">;

const MATCHES = new Map((curatedMatches.matches as ModelSheetMatch[]).map((match) => [match.harnessModelId, match]));
const NOTES = curatedNotes.families as Record<string, CuratedNote>;

/** A curated match for a runnable model id, if the table has one. */
export function modelSheetMatchFor(modelId: string): ModelSheetMatch | null {
  return MATCHES.get(modelId) ?? null;
}

/** The curated notes for a registry family, if any. */
export function curatedModelNotes(family: string): CuratedNote | null {
  return NOTES[family] ?? null;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

type MetricReader = (model: ModelRegistryModel) => number | null;

function metricReaders(snapshot: ModelRegistrySnapshot): Record<MetricKey, MetricReader> {
  const agentScores = new Map<string, number[]>();
  for (const row of snapshot.agents) {
    if (row.pair || !row.modelSlug || row.score == null) continue;
    const list = agentScores.get(row.modelSlug) ?? [];
    list.push(row.score);
    agentScores.set(row.modelSlug, list);
  }
  const evalOf = (key: string): MetricReader => (model) => model.evals?.[key] ?? null;
  return {
    intelligenceIndex: (model) => model.intelligenceIndex,
    terminalBench40: (model) => model.terminalBench40,
    terminalBenchHard: evalOf("terminalBenchHard"),
    sciCode: (model) => model.sciCode,
    ifBench: (model) => model.ifBench,
    gpqa: (model) => model.gpqa,
    humanitysLastExam: (model) => model.humanitysLastExam,
    longContextReasoning: (model) => model.longContextReasoning,
    critPt: evalOf("critPt"),
    tau2Bench: evalOf("tau2Bench"),
    tauBanking: evalOf("tauBanking"),
    terminalBench21: evalOf("terminalBench21"),
    itBenchSre: evalOf("itBenchSre"),
    frontierCode: evalOf("frontierCode"),
    mmmuPro: evalOf("mmmuPro"),
    gdpval: evalOf("gdpval"),
    briefcaseRubricPassRate: evalOf("briefcaseRubricPassRate"),
    knowledgeAccuracy: evalOf("omniscienceAccuracy"),
    hallucinationRate: evalOf("omniscienceHallucinationRate"),
    slop: (model) => model.personality?.slop ?? null,
    codingAgentIndex: (model) => {
      const scores = agentScores.get(model.slug);
      return scores?.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
    },
  };
}

/** Variants Artificial Analysis lists today: the population scores are normalized over. */
function isCurrent(model: ModelRegistryModel): boolean {
  return !model.deprecated && model.profile !== "carried";
}

/**
 * Scores every registry variant on every task kind. Each metric is min-max
 * normalized over current variants.
 */
export function scoreTaskKinds(snapshot: ModelRegistrySnapshot): Map<string, Partial<Record<ModelSheetTaskKind, number>>> {
  const readers = metricReaders(snapshot);
  const current = snapshot.models.filter(isCurrent);
  const ranges = new Map<MetricKey, { min: number; max: number }>();
  for (const key of Object.keys(readers) as MetricKey[]) {
    const values = current.map(readers[key]).filter((value): value is number => value != null && Number.isFinite(value));
    if (values.length >= 2) ranges.set(key, { min: Math.min(...values), max: Math.max(...values) });
  }
  const normalized = (key: MetricKey, model: ModelRegistryModel): number | null => {
    const value = readers[key](model);
    const range = ranges.get(key);
    if (value == null || !Number.isFinite(value) || !range || range.max === range.min) return null;
    const share = Math.min(1, Math.max(0, (value - range.min) / (range.max - range.min)));
    return MODEL_SHEET_METRICS[key].lowerIsBetter ? 1 - share : share;
  };
  const out = new Map<string, Partial<Record<ModelSheetTaskKind, number>>>();
  for (const model of snapshot.models) {
    const kinds: Partial<Record<ModelSheetTaskKind, number>> = {};
    for (const kind of MODEL_SHEET_TASK_KINDS) {
      const spec = TASK_KIND_WEIGHTS[kind];
      if (spec.requires?.some((key) => normalized(key, model) == null)) continue;
      let total = 0;
      let covered = 0;
      let sum = 0;
      for (const [key, weight] of Object.entries(spec.weights) as Array<[MetricKey, number]>) {
        total += weight;
        const value = normalized(key, model);
        if (value == null) continue;
        covered += weight;
        sum += weight * value;
      }
      if (covered > 0 && covered >= MIN_WEIGHT_COVERAGE * total) kinds[kind] = round2(sum / covered);
    }
    out.set(model.slug, kinds);
  }
  return out;
}

function speedTier(model: ModelRegistryModel): ModelSheetSpeedTier | null {
  const { secondsPerIndexTask, endToEndSeconds } = MODEL_SHEET_TIERS.speed;
  if (model.secondsPerIndexTask != null) {
    if (model.secondsPerIndexTask <= secondsPerIndexTask.fast) return "fast";
    return model.secondsPerIndexTask <= secondsPerIndexTask.medium ? "medium" : "slow";
  }
  if (model.endToEndSeconds != null) {
    if (model.endToEndSeconds <= endToEndSeconds.fast) return "fast";
    return model.endToEndSeconds <= endToEndSeconds.medium ? "medium" : "slow";
  }
  return null;
}

function costTier(model: ModelRegistryModel): ModelSheetCostTier | null {
  const { costPerIndexTaskUsd, blendedPricePerMillion } = MODEL_SHEET_TIERS.cost;
  if (model.costPerIndexTaskUsd != null) {
    if (model.costPerIndexTaskUsd <= costPerIndexTaskUsd.cheap) return "cheap";
    return model.costPerIndexTaskUsd <= costPerIndexTaskUsd.mid ? "mid" : "premium";
  }
  const { input, output } = model.price;
  if (input == null || output == null) return null;
  const blended = (input * 3 + output) / 4;
  if (blended <= blendedPricePerMillion.cheap) return "cheap";
  return blended <= blendedPricePerMillion.mid ? "mid" : "premium";
}

/**
 * The variant Artificial Analysis measured at exactly this ADE effort level,
 * or null. Stricter than the router, which rates an unmeasured level from a
 * neighbor: the sheet shows no score it did not measure. A model without
 * levels runs at its default, which AA files under the family slug.
 */
function measuredVariantFor(variants: readonly ModelRegistryModel[], family: string, effort: string | null): ModelRegistryModel | null {
  if (effort == null) return variants.find((model) => model.slug === family) ?? (variants.length === 1 ? variants[0]! : null);
  if (effort === "none") return variants.find((model) => model.slug.endsWith("-non-reasoning")) ?? null;
  const wanted = effort === "ultra" || effort === "ultracode" || effort === "thinking" ? "max" : effort;
  return variants.find((model) => model.effort === wanted) ?? null;
}

/** The family name without the effort in parentheses: `Claude Opus 5.5 (Max)` → `Claude Opus 5.5`. */
function familyName(model: ModelRegistryModel): string {
  return model.name.replace(/\s*\((?:[^()]*\b(?:max|xhigh|high|medium|low|minimal|reasoning|non-reasoning|fallback)\b[^()]*)\)\s*$/i, "").trim() || model.name;
}

const KIND_WORDS: Record<ModelSheetTaskKind, string> = {
  question: "quick questions",
  research: "research",
  review: "code review",
  small_edit: "small edits",
  feature: "feature work",
  debugging: "debugging",
  refactor: "refactors",
  writing: "writing",
  vision: "images and screenshots",
};

/** Premium or slow models are a poor fit for the sheet's quick task kinds. */
function enforceQuickTaskNotes(
  notes: ModelSheetNotes,
  speed: ModelSheetSpeedTier | null,
  cost: ModelSheetCostTier | null,
): ModelSheetNotes {
  if (speed !== "slow" && cost !== "premium") return notes;

  const quickKinds = ["question", "small_edit"] as const;
  const avoidFor = [...notes.avoidFor];
  for (const kind of quickKinds) {
    const existing = avoidFor.find((entry) => entry.kind === kind);
    const why = existing?.why ?? "";
    const reasons = [
      ...(cost === "premium" && !why.toLowerCase().includes("overkill")
        ? [`overkill for ${kind === "question" ? "quick questions" : "small edits"}`]
        : []),
      ...(speed === "slow" && !why.toLowerCase().includes("slow for quick tasks")
        ? ["slow for quick tasks"]
        : []),
    ];
    if (existing) {
      existing.why = [existing.why, ...reasons].filter(Boolean).join("; ");
    } else {
      avoidFor.push({ kind, why: reasons.join("; ") });
    }
  }
  return {
    ...notes,
    bestFor: notes.bestFor.filter((entry) => !quickKinds.includes(entry.kind as (typeof quickKinds)[number])),
    avoidFor,
  };
}

/**
 * Words from the numbers, for a family without curated notes: kinds in the top
 * fifth of current models are strengths, the bottom two fifths weaknesses.
 */
function generatedNotes(
  name: string,
  variant: ModelSheetVariant | null,
  model: ModelRegistryModel | null,
  percentile: (kind: ModelSheetTaskKind, score: number) => number,
): ModelSheetNotes {
  if (!variant || !model) {
    return {
      summary: `${name}: no public benchmark data, so the sheet cannot say what it is good for.`,
      strengths: [],
      weaknesses: ["No benchmark data"],
      bestFor: [],
      avoidFor: [],
      notes: [],
      basis: [],
      source: "generated",
    };
  }
  const ranked = MODEL_SHEET_TASK_KINDS
    .filter((kind) => variant.kinds[kind] != null)
    .map((kind) => ({ kind, score: variant.kinds[kind]!, pct: percentile(kind, variant.kinds[kind]!) }))
    .sort((a, b) => b.pct - a.pct);
  const strong = ranked.filter((entry) => entry.pct >= 0.8);
  const weak = ranked.filter((entry) => entry.pct < 0.4);
  const tiers = [variant.speed, variant.cost].filter(Boolean).join(", ");
  const best = strong.slice(0, 3).map((entry) => KIND_WORDS[entry.kind]);
  const summary = best.length
    ? `${name}: among the stronger current models for ${best.join(", ")}${tiers ? `; ${tiers}` : ""}.`
    : `${name}: below the top fifth of current models on every task kind${tiers ? `; ${tiers}` : ""}.`;
  const notes: string[] = [];
  if (model.openWeights) notes.push("Open weights.");
  if ((model.timeToFirstAnswerTokenSeconds ?? 0) > MODEL_SHEET_TIERS.slowFirstTokenSeconds) {
    notes.push(`Slow first answer token (${Math.round(model.timeToFirstAnswerTokenSeconds!)} s on a long prompt).`);
  }
  if (model.profile === "carried") notes.push("Artificial Analysis no longer lists this model; its data may be stale.");
  return {
    summary,
    strengths: strong.map((entry) => `${KIND_WORDS[entry.kind]} (top ${Math.max(1, Math.round((1 - entry.pct) * 100))}%)`),
    weaknesses: weak.map((entry) => `${KIND_WORDS[entry.kind]} (bottom ${Math.max(1, Math.round(entry.pct * 100))}%)`),
    bestFor: strong.slice(0, 3).map((entry) => ({ kind: entry.kind, why: `score ${entry.score.toFixed(2)}` })),
    avoidFor: weak.slice(-2).map((entry) => ({ kind: entry.kind, why: `score ${entry.score.toFixed(2)}` })),
    notes,
    basis: ["Task-kind scores from TASK_KIND_WEIGHTS over the current snapshot"],
    source: "generated",
  };
}

type Resolved = {
  entry: UserCatalogModel;
  family: string | null;
  match: ModelSheetMatch | null;
};

/** The family a catalogue entry scores under: the router's own map, else the curated match. */
function resolveEntry(entry: UserCatalogModel, families: Set<string>): Resolved {
  const match = entry.profile ? null : modelSheetMatchFor(entry.modelId);
  if (entry.family) return { entry, family: entry.family, match };
  if (match?.registryFamily && families.has(match.registryFamily)
    && (match.relation === "same" || match.relation === "same-model-faster-serving")) {
    return { entry, family: match.registryFamily, match };
  }
  return { entry, family: null, match };
}

/**
 * This user's model sheet: their runnable models grouped by registry family,
 * each with task-kind scores per measured effort, tiers, billing, how it was
 * matched, and words. Families are ordered by the Intelligence Index of their
 * headline variant; families without registry data come last.
 */
export function buildModelSheet(snapshot: ModelRegistrySnapshot, catalog: UserModelCatalog): ModelSheet {
  const scores = scoreTaskKinds(snapshot);
  const bySlug = new Map(snapshot.models.map((model) => [model.slug, model]));
  const familyVariants = new Map<string, ModelRegistryModel[]>();
  for (const model of snapshot.models) {
    const list = familyVariants.get(model.releaseSlug) ?? [];
    list.push(model);
    familyVariants.set(model.releaseSlug, list);
  }
  const currentScores = new Map<ModelSheetTaskKind, number[]>();
  for (const model of snapshot.models.filter(isCurrent)) {
    for (const [kind, score] of Object.entries(scores.get(model.slug) ?? {}) as Array<[ModelSheetTaskKind, number]>) {
      const list = currentScores.get(kind) ?? [];
      list.push(score);
      currentScores.set(kind, list);
    }
  }
  const percentile = (kind: ModelSheetTaskKind, score: number): number => {
    const list = currentScores.get(kind) ?? [];
    return list.length ? list.filter((value) => value < score).length / list.length : 0;
  };
  const variantOf = (model: ModelRegistryModel): ModelSheetVariant => ({
    slug: model.slug,
    effort: model.effort,
    kinds: scores.get(model.slug) ?? {},
    speed: speedTier(model),
    cost: costTier(model),
    intelligenceIndex: model.intelligenceIndex == null ? null : round2(model.intelligenceIndex),
    costPerIndexTaskUsd: model.costPerIndexTaskUsd == null ? null : round2(model.costPerIndexTaskUsd),
    secondsPerIndexTask: model.secondsPerIndexTask == null ? null : Math.round(model.secondsPerIndexTask),
    timeToFirstAnswerTokenSeconds: model.timeToFirstAnswerTokenSeconds == null ? null : round2(model.timeToFirstAnswerTokenSeconds),
    outputTokensPerSecond: model.outputTokensPerSecond == null ? null : Math.round(model.outputTokensPerSecond),
  });

  const groups = new Map<string, Resolved[]>();
  const familySlugs = new Set(familyVariants.keys());
  for (const entry of catalog.models) {
    const resolved = resolveEntry(entry, familySlugs);
    const key = resolved.family ?? `unmatched:${entry.displayName.toLowerCase()}`;
    const list = groups.get(key) ?? [];
    list.push(resolved);
    groups.set(key, list);
  }

  const families: ModelSheetFamily[] = [];
  for (const members of groups.values()) {
    const family = members[0]!.family;
    const variants = family ? familyVariants.get(family) ?? [] : [];
    const usedSlugs = new Set<string>();
    const models: ModelSheetModel[] = members.map(({ entry, match }) => {
      const efforts: ModelSheetEffort[] = entry.efforts.map((level) => {
        const variant = family ? measuredVariantFor(variants, family, level.effort) : null;
        if (variant) usedSlugs.add(variant.slug);
        return {
          effort: level.effort,
          isDefault: level.isDefault,
          slug: variant?.slug ?? null,
        };
      });
      const main = efforts.find((level) => level.isDefault)
        ?? efforts.find((level) => level.effort === "high")
        ?? efforts[0]
        ?? null;
      // Without a measured default level, the headline is AA's own default variant (the family slug).
      const headline = main?.slug
        ?? (variants.find((model) => model.slug === family) ?? variants[0])?.slug
        ?? null;
      if (headline) usedSlugs.add(headline);
      const bestEffort: Partial<Record<ModelSheetTaskKind, string | null>> = {};
      const measured = efforts.filter((level) => level.slug);
      const costOf = (level: ModelSheetEffort): number => bySlug.get(level.slug!)?.costPerIndexTaskUsd ?? Infinity;
      if (measured.length > 1) {
        for (const kind of MODEL_SHEET_TASK_KINDS) {
          const scored = measured
            .map((level) => ({ level, score: scores.get(level.slug!)?.[kind] }))
            .filter((entry): entry is { level: ModelSheetEffort; score: number } => entry.score != null);
          if (!scored.length) continue;
          const top = Math.max(...scored.map((entry) => entry.score));
          // Ties go to the cheaper level; `measured` keeps the harness's order (cheapest first) as the fallback.
          const pick = scored
            .filter((entry) => entry.score >= top - EFFORT_TIE)
            .reduce((best, entry) => (costOf(entry.level) < costOf(best.level) ? entry : best));
          bestEffort[kind] = pick.level.effort;
        }
      }
      return {
        harness: entry.harness,
        modelId: entry.modelId,
        displayName: entry.displayName,
        billing: entry.billing,
        match: match ? { registryFamily: match.registryFamily, relation: match.relation, confidence: match.confidence, reason: match.reason, ...(match.availabilityDoubt ? { availabilityDoubt: match.availabilityDoubt } : {}) } : null,
        scoredSlug: headline,
        scoredEffort: headline ? bySlug.get(headline)?.effort ?? null : null,
        defaultEffort: main?.effort ?? null,
        bestEffort,
        efforts,
      };
    });
    const sheetVariants: ModelSheetVariant[] = variants.filter((model) => usedSlugs.has(model.slug)).map(variantOf);
    // One effort for every family, so families compare: `high` where measured, else AA's own default variant.
    const familyHeadline = family
      ? variants.find((model) => model.effort === "high") ?? variants.find((model) => model.slug === family) ?? null
      : null;
    if (familyHeadline && !usedSlugs.has(familyHeadline.slug)) {
      usedSlugs.add(familyHeadline.slug);
      sheetVariants.push(variantOf(familyHeadline));
    }
    const headlineSlug = familyHeadline?.slug ?? models.find((model) => model.scoredSlug)?.scoredSlug ?? null;
    const headline = sheetVariants.find((variant) => variant.slug === headlineSlug) ?? null;
    const headlineModel = headlineSlug ? bySlug.get(headlineSlug) ?? null : null;
    const reference = headlineModel ?? variants[0] ?? null;
    const facts = variants.find((model) => model.modalities) ?? null;
    const name = reference ? familyName(reference) : members[0]!.entry.displayName;
    const curated = family ? curatedModelNotes(family) : null;
    // A model with no registry data borrows nothing but the curated note on its match.
    const unmatchedNote = !family && members[0]!.match
      ? `${members[0]!.match.reason}${members[0]!.match.relation === "nearest-sibling" && members[0]!.match.registryFamily ? ` Nearest measured model: ${members[0]!.match.registryFamily} (not used for scores).` : ""}`
      : null;
    const rawNotes: ModelSheetNotes = curated
      ? { ...curated, source: "curated" }
      : generatedNotes(name, headline, headlineModel, percentile);
    const notes = enforceQuickTaskNotes(rawNotes, headline?.speed ?? null, headline?.cost ?? null);
    if (unmatchedNote) notes.notes = [unmatchedNote, ...notes.notes];
    families.push({
      family,
      name: family ? name : members[0]!.entry.displayName,
      creator: reference?.creator ?? null,
      releaseDate: reference?.releaseDate ?? null,
      openWeights: reference ? reference.openWeights : null,
      contextWindow: reference?.contextWindow ?? null,
      inputModalities: facts?.modalities?.input ?? null,
      data: reference?.profile ?? null,
      headlineSlug,
      kinds: headline?.kinds ?? {},
      speed: headline?.speed ?? null,
      cost: headline?.cost ?? null,
      notes,
      variants: sheetVariants,
      models,
    });
  }
  const index = (entry: ModelSheetFamily): number =>
    entry.variants.find((variant) => variant.slug === entry.headlineSlug)?.intelligenceIndex ?? -1;
  families.sort((a, b) => index(b) - index(a) || a.name.localeCompare(b.name));
  return {
    attribution: MODEL_REGISTRY_AA_ATTRIBUTION,
    generatedAt: catalog.generatedAt,
    kinds: MODEL_SHEET_TASK_KINDS,
    families,
  };
}
