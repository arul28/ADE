/**
 * Route catalog: every way this machine can run a model, rated from the model
 * registry.
 *
 * A route is harness × model × effort. The harness is the ADE chat provider
 * (`claude`, `codex`, `opencode`, `cursor`); the channel is who bills it (a
 * plan, a metered gateway, or free). Each route gets:
 * - a quality estimate: the Artificial Analysis Coding Agent Index score when
 *   AA measured this harness running this variant, otherwise a line fitted
 *   from the rows AA did measure (agent score against the model's Intelligence
 *   Index). On 2026-09-29 that line had R² 0.94 over 23 rows, and the harness
 *   moved the score by at most ±0.02, so model and effort decide quality.
 * - a cost and time shape: what one AA Intelligence Index task cost and took
 *   on that variant. It is a relative size, the same task on every route.
 *
 * Pure: no I/O. The caller passes the model list and the registry snapshot.
 */
import type { AgentChatModelInfo } from "../../../shared/types/chat";
import type {
  ModelRegistryAgentRow,
  ModelRegistryModel,
  ModelRegistryPrice,
  ModelRegistrySnapshot,
} from "../../../shared/routerRegistry";

export type RouteHarness = "claude" | "codex" | "opencode" | "cursor";

export type RouteBilling =
  | { kind: "plan"; plan: "claude" | "codex" | "cursor" | "opencode-go" }
  | { kind: "metered"; channel: string }
  | { kind: "free" };

export type RouteQuality = {
  /** Coding Agent Index scale, 0 to 1. Null when no public data covers the model. */
  score: number | null;
  source: "aa_agent_row" | "aa_index_fit" | "none";
  /** True when the effort level had no AA variant and the score was scaled. */
  effortScaled: boolean;
};

export type ModelRoute = {
  /** `harness|modelId|effort`, stable across refreshes. */
  id: string;
  harness: RouteHarness;
  modelId: string;
  displayName: string;
  /** Effort level, or null for a model without levels. */
  effort: string | null;
  billing: RouteBilling;
  /** The registry variant the ratings came from. */
  registrySlug: string | null;
  quality: RouteQuality;
  costPerIndexTaskUsd: number | null;
  secondsPerIndexTask: number | null;
  outputTokensPerSecond: number | null;
  /** The channel's own per-token price, when models.dev lists it. */
  price: ModelRegistryPrice | null;
};

/** Harness names as Artificial Analysis writes them in the Coding Agent Index. */
const AA_HARNESS_NAME: Record<RouteHarness, string | null> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "Opencode",
  cursor: null,
};

/** ADE model names that AA files under another family slug. */
const FAMILY_ALIASES: Record<string, string> = {
  "claude-haiku-4-5": "claude-4-5-haiku",
  "claude-sonnet-4-5": "claude-4-5-sonnet",
  "gemini-3-1-pro": "gemini-3-1-pro-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
  "deepseek-flash": "deepseek-v4-1-flash",
  "mimo-v2-5": "mimo-v2-5-0424",
  "glm-5p3": "glm-5-3",
  "glm-5p3-flash": "glm-5-3-flash",
};

/**
 * Fallback for the effort levels AA did not measure: the median share of the
 * `max` Intelligence Index that each level keeps, over 13 families (2026-09-29).
 */
const EFFORT_SHARE_OF_MAX: Record<string, number> = {
  low: 0.713,
  medium: 0.837,
  high: 0.902,
  xhigh: 0.937,
  max: 1,
};

/** ADE's effort names that mean the same AA level. */
function aaEffortFor(effort: string | null): string | null {
  if (!effort) return null;
  switch (effort) {
    case "ultra":
    case "ultracode":
    case "thinking":
      return "max";
    case "minimal":
    case "none":
      return "low";
    default:
      return effort;
  }
}

/** The family slug of an ADE model id: `openai/gpt-5.6-sol` → `gpt-5-6-sol`. */
export function registryFamilyForModelId(modelId: string): string {
  let name = (modelId.split("/").pop() ?? modelId).toLowerCase();
  name = name.replace(/-20\d{6}$/, "");
  name = name.replace(/-(free|fast|exp|contributor|contributor-free)$/, "");
  name = name.replace(/-contributor$/, "");
  name = name.replace(/(\d)\.(\d)/g, "$1-$2");
  return FAMILY_ALIASES[name] ?? name;
}

export function routeHarnessOf(provider: string): RouteHarness | null {
  return provider === "claude" || provider === "codex" || provider === "opencode" || provider === "cursor"
    ? provider
    : null;
}

/** Who bills a route, from the harness and the model id's gateway segment. */
export function routeBillingFor(harness: RouteHarness, modelId: string): RouteBilling {
  if (/(^|[-/])free($|[-/])/.test(modelId)) return { kind: "free" };
  if (harness === "claude" || harness === "codex" || harness === "cursor") return { kind: "plan", plan: harness };
  const gateway = modelId.split("/")[1] ?? "";
  if (gateway === "opencode-go") return { kind: "plan", plan: "opencode-go" };
  if (gateway === "opencode") return { kind: "metered", channel: "opencode-zen" };
  return { kind: "metered", channel: `opencode-${gateway || "unknown"}` };
}

/** The models.dev price table and model id a route bills against. */
function priceFor(snapshot: ModelRegistrySnapshot, harness: RouteHarness, modelId: string): ModelRegistryPrice | null {
  const segments = modelId.split("/");
  const name = segments[segments.length - 1] ?? modelId;
  let channel: string | null = null;
  if (harness === "claude") channel = "anthropic";
  else if (harness === "codex") channel = "openai";
  else if (harness === "opencode") {
    const gateway = segments[1] ?? "";
    channel = gateway === "opencode" ? "opencode" : gateway;
  }
  if (!channel) return null;
  const table = snapshot.prices[channel];
  return table?.[name] ?? table?.[name.replace(/-20\d{6}$/, "")] ?? null;
}

export type AgentScoreFit = { intercept: number; slope: number; rows: number };

/**
 * Agent score as a line in the Intelligence Index, fitted from the snapshot's
 * own single-model agent rows, so the line moves with every refresh.
 */
export function fitAgentScore(snapshot: ModelRegistrySnapshot): AgentScoreFit {
  const bySlug = new Map(snapshot.models.map((model) => [model.slug, model]));
  const points: Array<[number, number]> = [];
  for (const row of snapshot.agents) {
    if (row.pair || !row.modelSlug || row.score == null) continue;
    const index = bySlug.get(row.modelSlug)?.intelligenceIndex;
    if (index == null) continue;
    points.push([index / 100, row.score]);
  }
  // Too few rows to trust a fresh fit: keep the 2026-09-29 line.
  if (points.length < 8) return { intercept: -0.059, slope: 1.284, rows: points.length };
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  let covariance = 0;
  let variance = 0;
  for (const [x, y] of points) {
    covariance += (x - meanX) * (y - meanY);
    variance += (x - meanX) ** 2;
  }
  const slope = variance > 0 ? covariance / variance : 0;
  return { intercept: meanY - slope * meanX, slope, rows: points.length };
}

type FamilyIndex = Map<string, ModelRegistryModel[]>;

function indexFamilies(snapshot: ModelRegistrySnapshot): FamilyIndex {
  const families: FamilyIndex = new Map();
  for (const model of snapshot.models) {
    const list = families.get(model.releaseSlug) ?? [];
    list.push(model);
    families.set(model.releaseSlug, list);
  }
  return families;
}

/**
 * The variant for an effort level. Exact when AA measured that level;
 * otherwise the family's best-measured variant, with the index scaled by the
 * effort curve.
 */
function variantFor(
  family: ModelRegistryModel[] | undefined,
  effort: string | null,
): { model: ModelRegistryModel; index: number | null; scaled: boolean } | null {
  if (!family?.length) return null;
  const wanted = aaEffortFor(effort);
  const exact = family.find((model) => model.effort === wanted) ?? (wanted ? null : family.find((model) => !model.effort));
  if (exact) return { model: exact, index: exact.intelligenceIndex, scaled: false };
  const base = family.find((model) => model.effort === "max")
    ?? family.find((model) => model.effort === "xhigh")
    ?? [...family].sort((a, b) => (b.intelligenceIndex ?? 0) - (a.intelligenceIndex ?? 0))[0]!;
  const baseShare = base.effort ? EFFORT_SHARE_OF_MAX[base.effort] : undefined;
  const wantedShare = wanted ? EFFORT_SHARE_OF_MAX[wanted] : undefined;
  const index = base.intelligenceIndex != null && baseShare && wantedShare
    ? base.intelligenceIndex * (wantedShare / baseShare)
    : base.intelligenceIndex;
  return { model: base, index, scaled: Boolean(baseShare && wantedShare && wanted !== base.effort) };
}

function measuredAgentRow(
  agents: readonly ModelRegistryAgentRow[],
  harness: RouteHarness,
  slug: string,
): ModelRegistryAgentRow | null {
  const name = AA_HARNESS_NAME[harness];
  if (!name) return null;
  return agents.find((row) => !row.pair && row.modelSlug === slug && row.agent.startsWith(name) && row.score != null) ?? null;
}

export type CatalogModel = { provider: string; info: AgentChatModelInfo };

/** Every route of the given models, one per effort level they offer. */
export function buildModelRoutes(models: readonly CatalogModel[], snapshot: ModelRegistrySnapshot): ModelRoute[] {
  const families = indexFamilies(snapshot);
  const fit = fitAgentScore(snapshot);
  const routes: ModelRoute[] = [];
  for (const { provider, info } of models) {
    const harness = routeHarnessOf(provider);
    if (!harness) continue;
    const modelId = info.modelId ?? info.id;
    const efforts: Array<string | null> = info.reasoningEfforts?.length
      ? info.reasoningEfforts.map((entry) => entry.effort)
      : [null];
    const family = families.get(registryFamilyForModelId(modelId));
    for (const effort of efforts) {
      const variant = variantFor(family, effort);
      const measured = variant && !variant.scaled ? measuredAgentRow(snapshot.agents, harness, variant.model.slug) : null;
      let quality: RouteQuality = { score: null, source: "none", effortScaled: false };
      if (measured?.score != null) {
        quality = { score: measured.score, source: "aa_agent_row", effortScaled: false };
      } else if (variant?.index != null) {
        const score = fit.intercept + fit.slope * (variant.index / 100);
        quality = { score: Math.max(0, Math.min(1, score)), source: "aa_index_fit", effortScaled: variant.scaled };
      }
      routes.push({
        id: `${harness}|${modelId}|${effort ?? "-"}`,
        harness,
        modelId,
        displayName: info.displayName,
        effort,
        billing: routeBillingFor(harness, modelId),
        registrySlug: variant?.model.slug ?? null,
        quality,
        costPerIndexTaskUsd: variant?.model.costPerIndexTaskUsd ?? null,
        secondsPerIndexTask: variant?.model.secondsPerIndexTask ?? null,
        outputTokensPerSecond: variant?.model.outputTokensPerSecond ?? null,
        price: priceFor(snapshot, harness, modelId),
      });
    }
  }
  return routes;
}
