/**
 * This user's model catalogue: every model this machine can run, each with
 * its full model registry profile and how the user reaches it.
 *
 * The registry knows every model Artificial Analysis measures; a user can run
 * only the ones their harnesses list. This joins the two through the router's
 * own route catalog (`buildModelRoutes`), so a model maps onto the registry
 * exactly as the router maps it. Read-only and pure: the caller passes the
 * model list and the snapshot.
 */
import {
  MODEL_REGISTRY_AA_ATTRIBUTION,
  type ModelRegistryAgentRow,
  type ModelRegistryMediaRow,
  type ModelRegistryModel,
  type ModelRegistryPrice,
  type ModelRegistrySnapshot,
} from "../../../shared/routerRegistry";
import {
  buildModelRoutes,
  registryFamilyForModelId,
  type CatalogModel,
  type RouteBilling,
  type RouteHarness,
  type RouteQuality,
} from "./routeCatalog";

export type UserCatalogEffort = {
  /** Null for a model without levels. */
  effort: string | null;
  isDefault: boolean;
  /** The registry variant this level rates from. */
  registrySlug: string | null;
  /** True when Artificial Analysis did not measure this level and the score was scaled. */
  effortScaled: boolean;
  quality: RouteQuality;
};

export type UserCatalogModel = {
  harness: RouteHarness;
  modelId: string;
  displayName: string;
  /** Who bills it: a plan, a metered channel, or free. */
  billing: RouteBilling;
  /** The channel's own per-token price, when models.dev lists it. */
  price: ModelRegistryPrice | null;
  /** The registry family the model maps to; null when the registry has none. */
  family: string | null;
  efforts: UserCatalogEffort[];
  /**
   * The full registry profile of the variant the model runs at by default (its
   * default effort, else `high`, else the first level). Null when unmatched.
   * Facts every effort level of a release shares (`FAMILY_FACTS`) come from
   * another variant of the family when this one's data lacks them.
   */
  profile: ModelRegistryModel | null;
  /** Coding Agent Index rows that ran one of this model's variants, in any harness. */
  codingAgents: Array<Pick<ModelRegistryAgentRow, "agent" | "modelSlug" | "score" | "costUsdPerTask" | "minutesPerTask">>;
  /** Speech leaderboard rows linked to one of this model's variants. */
  media: ModelRegistryMediaRow[];
};

export type UserModelCatalog = {
  attribution: typeof MODEL_REGISTRY_AA_ATTRIBUTION;
  generatedAt: string | null;
  sources: ModelRegistrySnapshot["sources"] | null;
  models: UserCatalogModel[];
  /** Runnable models the registry has no family for. */
  unmatched: number;
};

/** Release-level facts: the same for every effort level of one model. */
const FAMILY_FACTS = [
  "modalities",
  "license",
  "licenseCategory",
  "parametersBillions",
  "activeParametersBillions",
  "knowledgeCutoff",
] as const satisfies ReadonlyArray<keyof ModelRegistryModel>;

function withFamilyFacts(profile: ModelRegistryModel, family: readonly ModelRegistryModel[]): ModelRegistryModel {
  const filled: ModelRegistryModel = { ...profile };
  for (const key of FAMILY_FACTS) {
    if (filled[key] !== undefined) continue;
    const source = family.find((model) => model[key] !== undefined);
    if (source) Object.assign(filled, { [key]: source[key] });
  }
  return filled;
}

export function emptyUserModelCatalog(): UserModelCatalog {
  return { attribution: MODEL_REGISTRY_AA_ATTRIBUTION, generatedAt: null, sources: null, models: [], unmatched: 0 };
}

/** Every runnable model with its profile, best Intelligence Index first, unmatched last. */
export function buildUserModelCatalog(models: readonly CatalogModel[], snapshot: ModelRegistrySnapshot): UserModelCatalog {
  const bySlug = new Map(snapshot.models.map((model) => [model.slug, model]));
  const families = new Set(snapshot.models.map((model) => model.releaseSlug));
  const groups = new Map<string, ReturnType<typeof buildModelRoutes>>();
  for (const route of buildModelRoutes(models, snapshot)) {
    const key = `${route.harness}|${route.modelId}`;
    const group = groups.get(key) ?? [];
    group.push(route);
    groups.set(key, group);
  }
  const entries: UserCatalogModel[] = [];
  for (const group of groups.values()) {
    // The level a task runs at when it names none, as `findReferenceRoute` picks it.
    const main = group.find((route) => route.defaultEffort)
      ?? group.find((route) => route.effort === "high")
      ?? group[0]!;
    const variant = main.registrySlug ? bySlug.get(main.registrySlug) ?? null : null;
    const family = variant?.releaseSlug
      ?? (families.has(registryFamilyForModelId(main.modelId)) ? registryFamilyForModelId(main.modelId) : null);
    const variants = snapshot.models.filter((model) => model.releaseSlug === family);
    const variantSlugs = new Set(variants.map((model) => model.slug));
    const profile = variant ? withFamilyFacts(variant, variants) : null;
    entries.push({
      harness: main.harness,
      modelId: main.modelId,
      displayName: main.displayName,
      billing: main.billing,
      price: main.price,
      family,
      efforts: group.map((route) => ({
        effort: route.effort,
        isDefault: route.defaultEffort,
        registrySlug: route.registrySlug,
        effortScaled: route.quality.effortScaled,
        quality: route.quality,
      })),
      profile,
      codingAgents: snapshot.agents
        .filter((row) => !row.pair && row.modelSlug && variantSlugs.has(row.modelSlug))
        .map((row) => ({
          agent: row.agent,
          modelSlug: row.modelSlug,
          score: row.score,
          costUsdPerTask: row.costUsdPerTask,
          minutesPerTask: row.minutesPerTask,
        })),
      media: (snapshot.media ?? []).filter((row) => row.modelSlug && variantSlugs.has(row.modelSlug)),
    });
  }
  entries.sort((a, b) => (b.profile?.intelligenceIndex ?? -1) - (a.profile?.intelligenceIndex ?? -1)
    || a.harness.localeCompare(b.harness)
    || a.modelId.localeCompare(b.modelId));
  return {
    attribution: MODEL_REGISTRY_AA_ATTRIBUTION,
    generatedAt: snapshot.generatedAt,
    sources: snapshot.sources,
    models: entries,
    unmatched: entries.filter((entry) => !entry.profile).length,
  };
}
