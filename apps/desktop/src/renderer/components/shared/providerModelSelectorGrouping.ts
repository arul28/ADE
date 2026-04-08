import {
  CURSOR_CLI_LINE_ORDER,
  MODEL_REGISTRY,
  cursorCliLineGroupFromSdkId,
  cursorCliLineGroupLabel,
  type CursorCliLineGroup,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";

/** Top-level provider groups — the four first-class ADE runtime providers. */
export type ProviderGroupKey = "claude" | "codex" | "cursor" | "opencode";

/** Category within the OpenCode provider group. */
export type ProviderCategory = "cloud-api" | "local" | "router";

export const PROVIDER_CATEGORY_MAP: Record<string, ProviderCategory> = {
  anthropic: "cloud-api",
  openai: "cloud-api",
  google: "cloud-api",
  deepseek: "cloud-api",
  mistral: "cloud-api",
  xai: "cloud-api",
  groq: "cloud-api",
  together: "cloud-api",
  opencode: "cloud-api",
  openrouter: "router",
  ollama: "local",
  lmstudio: "local",
};

export const PROVIDER_CATEGORY_LABELS: Record<ProviderCategory, string> = {
  "cloud-api": "Cloud",
  "local": "Local",
  "router": "Router",
};

export function getProviderCategory(family: string): ProviderCategory {
  return PROVIDER_CATEGORY_MAP[family] ?? "cloud-api";
}

export function sortOpenCodeProvidersByCategory(providers: ModelProviderBlock[]): {
  cloud: ModelProviderBlock[];
  local: ModelProviderBlock[];
  router: ModelProviderBlock[];
} {
  const cloud: ModelProviderBlock[] = [];
  const local: ModelProviderBlock[] = [];
  const router: ModelProviderBlock[] = [];
  for (const p of providers) {
    const cat = getProviderCategory(p.key);
    if (cat === "local") local.push(p);
    else if (cat === "router") router.push(p);
    else cloud.push(p);
  }
  return { cloud, local, router };
}

export type ModelSubsection = {
  key: string;
  /** Human-readable subsection title (e.g. Cursor CLI line family). Empty when a single default bucket. */
  label: string;
  models: ModelDescriptor[];
};

export type ModelProviderBlock = {
  key: string;
  label: string;
  badgeColor: string;
  subsections: ModelSubsection[];
  modelCount: number;
};

export type ModelProviderGroupBlock = {
  key: ProviderGroupKey;
  label: string;
  providers: ModelProviderBlock[];
};

const PROVIDER_LABELS: Record<string, string> = {
  opencode: "OpenCode (Free)",
  anthropic: "Anthropic",
  openai: "OpenAI",
  cursor: "Cursor",
  google: "Google",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  xai: "xAI",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  groq: "Groq",
  together: "Together",
  meta: "Meta",
};

/** Brand colors for provider chips, row accents, and picker chrome. */
export const PROVIDER_BADGE_COLORS: Record<string, string> = {
  opencode: "#2563EB",
  anthropic: "#D97706",
  openai: "#10A37F",
  cursor: "#A78BFA",
  google: "#F59E0B",
  deepseek: "#3B82F6",
  mistral: "#F97316",
  xai: "#DC2626",
  openrouter: "#6B7280",
  ollama: "#71717A",
  lmstudio: "#64748B",
  groq: "#06B6D4",
  together: "#22C55E",
  meta: "#3B82F6",
};

/** Provider ordering within a group section. */
export const PROVIDER_ORDER: string[] = [
  "opencode",
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "mistral",
  "xai",
  "groq",
  "together",
  "openrouter",
  "ollama",
  "lmstudio",
  "cursor",
];

const PROVIDER_GROUP_ORDER: Record<ProviderGroupKey, number> = {
  claude: 10,
  codex: 20,
  cursor: 30,
  opencode: 40,
};

/** Brand colors for the four top-level provider groups. */
export const PROVIDER_GROUP_COLORS: Record<ProviderGroupKey, string> = {
  claude: "#D97706",
  codex: "#10A37F",
  cursor: "#A78BFA",
  opencode: "#2563EB",
};

const CURSOR_SECTION_PREFIX = "__cursor_line__:";
const OPENCODE_PROVIDER_PREFIX = "__ocprov__:";

export function providerLabel(family: string): string {
  return PROVIDER_LABELS[family] ?? family;
}

export function providerBadgeColor(provider: string, models: ModelDescriptor[]): string {
  return PROVIDER_BADGE_COLORS[provider] ?? models[0]?.color ?? "#A78BFA";
}

/** Classify a model into one of the four top-level provider groups. */
export function classifyProviderGroup(model: ModelDescriptor): ProviderGroupKey {
  if (model.isCliWrapped) {
    if (model.family === "anthropic" || model.cliCommand === "claude") return "claude";
    if (model.family === "openai" || model.cliCommand === "codex") return "codex";
    if (model.family === "cursor" || model.cliCommand === "cursor") return "cursor";
  }
  return "opencode";
}

export function providerGroupLabel(group: ProviderGroupKey): string {
  switch (group) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
  }
}

export function subsectionKeyForModel(model: ModelDescriptor, group: ProviderGroupKey): string {
  if (model.family === "cursor" && group === "cursor") {
    return `${CURSOR_SECTION_PREFIX}${cursorCliLineGroupFromSdkId(model.providerModelId)}`;
  }
  if (group === "opencode" && model.openCodeProviderId) {
    return `${OPENCODE_PROVIDER_PREFIX}${model.openCodeProviderId}`;
  }
  return "__default__";
}

export function subsectionLabel(family: string, key: string): string {
  if (key === "__default__") return "";
  if (family === "opencode" && key.startsWith(OPENCODE_PROVIDER_PREFIX)) {
    const pid = key.slice(OPENCODE_PROVIDER_PREFIX.length);
    return providerLabel(pid);
  }
  if (family === "cursor" && key.startsWith(CURSOR_SECTION_PREFIX)) {
    const group = key.slice(CURSOR_SECTION_PREFIX.length) as CursorCliLineGroup;
    return cursorCliLineGroupLabel(group);
  }
  return "";
}

export function subsectionSortOrder(family: string, key: string): number {
  if (family === "opencode" && key.startsWith(OPENCODE_PROVIDER_PREFIX)) {
    const pid = key.slice(OPENCODE_PROVIDER_PREFIX.length);
    const index = PROVIDER_ORDER.indexOf(pid);
    return index === -1 ? PROVIDER_ORDER.length + 10 : index;
  }
  if (family === "cursor" && key.startsWith(CURSOR_SECTION_PREFIX)) {
    const group = key.slice(CURSOR_SECTION_PREFIX.length) as CursorCliLineGroup;
    const index = CURSOR_CLI_LINE_ORDER.indexOf(group);
    return index === -1 ? CURSOR_CLI_LINE_ORDER.length + 50 : index;
  }
  return 0;
}

export function matchesQuery(model: ModelDescriptor, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized.length) return true;
  return [
    model.displayName,
    model.id,
    model.shortId,
    model.providerModelId,
    model.openCodeProviderId ?? "",
    ...(model.aliases ?? []),
  ]
    .join(" ")
    .toLowerCase()
    .includes(normalized);
}

function sortModels(models: ModelDescriptor[], modelOrder: Map<string, number>): ModelDescriptor[] {
  return [...models].sort((a, b) => {
    const oa = modelOrder.get(a.id);
    const ob = modelOrder.get(b.id);
    if (oa != null && ob != null && oa !== ob) return oa - ob;
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
  });
}

function compareProviderKeys(a: string, b: string): number {
  const ia = PROVIDER_ORDER.indexOf(a);
  const ib = PROVIDER_ORDER.indexOf(b);
  return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
}

/** Fallback provider list when dynamic OpenCode provider data is unavailable. */
export const OPENCODE_FALLBACK_PROVIDERS: string[] = [
  "opencode",
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "mistral",
  "xai",
  "groq",
  "together",
  "openrouter",
  "ollama",
  "lmstudio",
];

/** Group models: provider group → provider family → subsection (Cursor lines, else single block). */
export function buildProviderGroupBlocks(
  models: ModelDescriptor[],
  modelOrder: Map<string, number>,
  opencodeProviders?: Array<{ id: string; name: string; connected: boolean; modelCount: number }>,
): ModelProviderGroupBlock[] {
  const byGroup = new Map<ProviderGroupKey, Map<string, Map<string, ModelDescriptor[]>>>();

  for (const model of models) {
    const group = classifyProviderGroup(model);
    const family = model.family;
    const subKey = subsectionKeyForModel(model, group);

    let famMap = byGroup.get(group);
    if (!famMap) {
      famMap = new Map();
      byGroup.set(group, famMap);
    }
    let subMap = famMap.get(family);
    if (!subMap) {
      subMap = new Map();
      famMap.set(family, subMap);
    }
    const list = subMap.get(subKey) ?? [];
    list.push(model);
    subMap.set(subKey, list);
  }

  // Always ensure the opencode group exists so the OPENCODE tab is never disabled
  if (!byGroup.has("opencode")) {
    byGroup.set("opencode", new Map());
  }

  const groupKeys = [...byGroup.keys()].sort(
    (a, b) => PROVIDER_GROUP_ORDER[a] - PROVIDER_GROUP_ORDER[b],
  );

  const result: ModelProviderGroupBlock[] = [];
  for (const groupKey of groupKeys) {
    const famMap = byGroup.get(groupKey);
    if (!famMap) continue;

    const familyKeys = [...famMap.keys()].sort(compareProviderKeys);
    const providers: ModelProviderBlock[] = [];

    for (const family of familyKeys) {
      const subMap = famMap.get(family)!;
      const rawSubsections: ModelSubsection[] = [...subMap.entries()]
        .map(([key, ms]) => {
          return {
            key,
            label: subsectionLabel(family, key),
            models: sortModels(ms, modelOrder),
          };
        })
        .sort((a, b) => subsectionSortOrder(family, a.key) - subsectionSortOrder(family, b.key));

      // Merge all empty-label subsections into a single "Models" bucket to avoid
      // duplicate "Models (N)" tabs in the UI.
      const labeled: ModelSubsection[] = [];
      const unlabeledModels: ModelDescriptor[] = [];
      for (const sub of rawSubsections) {
        if (sub.label.trim() === "") {
          unlabeledModels.push(...sub.models);
        } else {
          labeled.push(sub);
        }
      }
      const subsections: ModelSubsection[] = unlabeledModels.length > 0
        ? [{ key: "__default__", label: "", models: sortModels(unlabeledModels, modelOrder) }, ...labeled]
        : labeled;

      const modelCount = subsections.reduce((acc, sub) => acc + sub.models.length, 0);
      providers.push({
        key: family,
        label: providerLabel(family),
        badgeColor: providerBadgeColor(family, subsections.flatMap((s) => s.models)),
        subsections,
        modelCount,
      });
    }

    // For the opencode group, inject empty provider blocks for providers that have no models yet.
    // Uses the dynamic list from OpenCode's provider.list() when available, falls back to a curated list.
    if (groupKey === "opencode") {
      const existingFamilies = new Set(providers.map((p) => p.key));
      const potentialProviders = opencodeProviders?.length
        ? opencodeProviders.map((p) => ({ id: p.id, name: p.name }))
        : OPENCODE_FALLBACK_PROVIDERS.map((id) => ({ id, name: providerLabel(id) }));
      for (const { id, name } of potentialProviders) {
        if (!existingFamilies.has(id)) {
          providers.push({
            key: id,
            label: PROVIDER_LABELS[id] ?? name,
            badgeColor: PROVIDER_BADGE_COLORS[id] ?? "#6B7280",
            subsections: [],
            modelCount: 0,
          });
        }
      }
      providers.sort((a, b) => compareProviderKeys(a.key, b.key));
    }

    result.push({
      key: groupKey,
      label: providerGroupLabel(groupKey),
      providers,
    });
  }

  return result;
}

export function createModelOrderMap(): Map<string, number> {
  return new Map(MODEL_REGISTRY.map((model, index) => [model.id, index]));
}
