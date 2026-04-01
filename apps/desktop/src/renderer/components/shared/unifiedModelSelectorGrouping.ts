import {
  CURSOR_CLI_LINE_ORDER,
  MODEL_REGISTRY,
  cursorCliLineGroupFromSdkId,
  cursorCliLineGroupLabel,
  type CursorCliLineGroup,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";

export type SourceSectionKey = "subscription" | "api" | "local";

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

export type ModelSourceBlock = {
  key: SourceSectionKey;
  label: string;
  providers: ModelProviderBlock[];
};

const PROVIDER_LABELS: Record<string, string> = {
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
  vllm: "vLLM",
  groq: "Groq",
  together: "Together",
  meta: "Meta",
};

/** Brand colors for provider chips, row accents, and picker chrome. */
export const PROVIDER_BADGE_COLORS: Record<string, string> = {
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
  vllm: "#475569",
  groq: "#06B6D4",
  together: "#22C55E",
  meta: "#3B82F6",
};

export const PROVIDER_ORDER: string[] = [
  "anthropic",
  "openai",
  "cursor",
  "google",
  "deepseek",
  "mistral",
  "xai",
  "openrouter",
  "ollama",
  "lmstudio",
  "vllm",
];

const SOURCE_SECTION_ORDER: Record<SourceSectionKey, number> = {
  subscription: 10,
  api: 20,
  local: 30,
};

const CURSOR_SECTION_PREFIX = "__cursor_line__:";

export function providerLabel(family: string): string {
  return PROVIDER_LABELS[family] ?? family;
}

export function providerBadgeColor(provider: string, models: ModelDescriptor[]): string {
  return PROVIDER_BADGE_COLORS[provider] ?? models[0]?.color ?? "#A78BFA";
}

export function classifySourceSection(model: ModelDescriptor): SourceSectionKey {
  if (model.isCliWrapped) return "subscription";
  if (model.authTypes.includes("local")) return "local";
  return "api";
}

export function sourceSectionLabel(section: SourceSectionKey): string {
  switch (section) {
    case "subscription":
      return "Subscription";
    case "local":
      return "Local";
    case "api":
    default:
      return "API";
  }
}

export function subsectionKeyForModel(model: ModelDescriptor, source: SourceSectionKey): string {
  if (model.family === "cursor" && source === "subscription") {
    return `${CURSOR_SECTION_PREFIX}${cursorCliLineGroupFromSdkId(model.sdkModelId)}`;
  }
  return "__default__";
}

export function subsectionLabel(family: string, key: string): string {
  if (key === "__default__") return "";
  if (family === "cursor" && key.startsWith(CURSOR_SECTION_PREFIX)) {
    const group = key.slice(CURSOR_SECTION_PREFIX.length) as CursorCliLineGroup;
    return cursorCliLineGroupLabel(group);
  }
  return "";
}

export function subsectionSortOrder(family: string, key: string): number {
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
    model.sdkModelId,
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

/** Group models: source → provider → subsection (Cursor subscription lines, else single block). */
export function buildSourceBlocksForModels(
  models: ModelDescriptor[],
  modelOrder: Map<string, number>,
): ModelSourceBlock[] {
  const bySource = new Map<SourceSectionKey, Map<string, Map<string, ModelDescriptor[]>>>();

  for (const model of models) {
    const source = classifySourceSection(model);
    const family = model.family;
    const subKey = subsectionKeyForModel(model, source);

    let famMap = bySource.get(source);
    if (!famMap) {
      famMap = new Map();
      bySource.set(source, famMap);
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

  const sourceKeys = [...bySource.keys()].sort(
    (a, b) => SOURCE_SECTION_ORDER[a] - SOURCE_SECTION_ORDER[b],
  );

  const result: ModelSourceBlock[] = [];
  for (const sourceKey of sourceKeys) {
    const famMap = bySource.get(sourceKey);
    if (!famMap) continue;

    const familyKeys = [...famMap.keys()].sort(compareProviderKeys);
    const providers: ModelProviderBlock[] = [];

    for (const family of familyKeys) {
      const subMap = famMap.get(family)!;
      const subsections: ModelSubsection[] = [...subMap.entries()]
        .map(([key, ms]) => {
          return {
            key,
            label: subsectionLabel(family, key),
            models: sortModels(ms, modelOrder),
          };
        })
        .sort((a, b) => subsectionSortOrder(family, a.key) - subsectionSortOrder(family, b.key));

      const modelCount = subsections.reduce((acc, sub) => acc + sub.models.length, 0);
      providers.push({
        key: family,
        label: providerLabel(family),
        badgeColor: providerBadgeColor(family, subsections.flatMap((s) => s.models)),
        subsections,
        modelCount,
      });
    }

    if (providers.length) {
      result.push({
        key: sourceKey,
        label: sourceSectionLabel(sourceKey),
        providers,
      });
    }
  }

  return result;
}

export function createModelOrderMap(): Map<string, number> {
  return new Map(MODEL_REGISTRY.map((model, index) => [model.id, index]));
}
