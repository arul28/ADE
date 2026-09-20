import {
  CURSOR_CLI_LINE_ORDER,
  DROID_CLI_LINE_ORDER,
  MODEL_REGISTRY,
  cursorCliLineGroupFromSdkId,
  cursorCliLineGroupLabel,
  droidCliLineGroupFromModelId,
  droidCliLineGroupLabel,
  formatPiProviderLabel,
  resolveProviderGroupForModel,
  type CursorCliLineGroup,
  type DroidCliLineGroup,
  type ModelDescriptor,
  type ModelProviderGroup,
} from "./modelRegistry";
import {
  EMPTY_OPENCODE_BADGE_FALLBACK_COLOR,
  PROVIDER_BADGE_COLORS as SHARED_PROVIDER_BADGE_COLORS,
  PROVIDER_BADGE_FALLBACK_COLOR,
  PROVIDER_GROUP_COLORS as SHARED_PROVIDER_GROUP_COLORS,
} from "./providerColors";

export type ProviderGroupKey = ModelProviderGroup | "ollama" | "lmstudio";

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
  qwen: "cloud-api",
  moonshot: "cloud-api",
  "github-copilot": "cloud-api",
};

export const PROVIDER_CATEGORY_LABELS: Record<ProviderCategory, string> = {
  "cloud-api": "Cloud",
  local: "Local",
  router: "Router",
};

export function getProviderCategory(family: string): ProviderCategory {
  return PROVIDER_CATEGORY_MAP[family] ?? "cloud-api";
}

export type ModelSubsection = {
  key: string;
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

/**
 * Canonical provider rail order for every model-picker surface. Favorites and
 * recents are added by each client before this list; these are the runtime
 * group keys behind the user-facing Anthropic/OpenAI/etc. labels.
 */
export const MODEL_PICKER_PROVIDER_ORDER = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "pi",
  "copilot",
  "grok",
  "droid",
  "kimi",
  "qwen",
  "ollama",
  "lmstudio",
] as const satisfies readonly ProviderGroupKey[];

const PROVIDER_LABELS: Record<string, string> = {
  opencode: "OpenCode (Free)",
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  cursor: "Cursor",
  factory: "Factory Droid",
  pi: "Pi",
  google: "Google",
  "github-copilot": "GitHub Copilot",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  xai: "xAI",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  groq: "Groq",
  together: "Together",
  meta: "Meta",
  qwen: "Qwen",
  moonshot: "Moonshot",
};

export const PROVIDER_BADGE_COLORS: Record<string, string> = { ...SHARED_PROVIDER_BADGE_COLORS };

export const PROVIDER_ORDER: string[] = [
  "opencode",
  "anthropic",
  "openai",
  "openai-codex",
  "google",
  "github-copilot",
  "qwen",
  "moonshot",
  "deepseek",
  "mistral",
  "xai",
  "groq",
  "together",
  "openrouter",
  "ollama",
  "lmstudio",
  "cursor",
  "factory",
  "pi",
];

const PROVIDER_GROUP_ORDER = Object.fromEntries(
  MODEL_PICKER_PROVIDER_ORDER.map((groupKey, index) => [groupKey, index]),
) as Record<ProviderGroupKey, number>;

/** Provider-group colors are shared with usage, chat, model, and iOS surfaces. */
export const PROVIDER_GROUP_COLORS = SHARED_PROVIDER_GROUP_COLORS as Record<ProviderGroupKey, string>;

const CURSOR_SECTION_PREFIX = "__cursor_line__:";
const DROID_SECTION_PREFIX = "__droid_line__:";
const OPENCODE_PROVIDER_PREFIX = "__ocprov__:";
const PI_PROVIDER_PREFIX = "__piprov__:";
/**
 * Models reachable through one stored API key, grouped under their own heading.
 *
 * Section-keyed exactly like a Pi profile, and for the same reason: two keys on
 * the same provider can declare the same model id against different endpoints,
 * so the key is part of the identity of the row, not a footnote on it.
 */
const CREDENTIAL_SECTION_PREFIX = "__credential__:";

export function credentialSubsectionKey(credentialId: string): string {
  return `${CREDENTIAL_SECTION_PREFIX}${encodeURIComponent(credentialId)}`;
}

export function credentialIdFromSubsectionKey(key: string): string | null {
  if (!key.startsWith(CREDENTIAL_SECTION_PREFIX)) return null;
  try {
    return decodeURIComponent(key.slice(CREDENTIAL_SECTION_PREFIX.length)) || null;
  } catch {
    return key.slice(CREDENTIAL_SECTION_PREFIX.length) || null;
  }
}

function piSubsectionParts(key: string): { profileId: string; providerId: string } | null {
  if (!key.startsWith(PI_PROVIDER_PREFIX)) return null;
  const encoded = key.slice(PI_PROVIDER_PREFIX.length).split(":");
  try {
    if (encoded.length >= 2) {
      return {
        profileId: decodeURIComponent(encoded[0] || "default") || "default",
        providerId: decodeURIComponent(encoded.slice(1).join(":")),
      };
    }
    // Keep old cached catalogs readable while new catalogs use profile-aware keys.
    return { profileId: "default", providerId: decodeURIComponent(encoded[0] ?? "") };
  } catch {
    return null;
  }
}

export function providerLabel(family: string): string {
  return PROVIDER_LABELS[family] ?? family;
}

export function providerBadgeColor(provider: string, models: ModelDescriptor[]): string {
  return PROVIDER_BADGE_COLORS[provider] ?? models[0]?.color ?? PROVIDER_BADGE_FALLBACK_COLOR;
}

export function classifyProviderGroup(model: ModelDescriptor): ProviderGroupKey {
  if (model.family === "ollama" || model.family === "lmstudio") {
    return model.family;
  }
  return resolveProviderGroupForModel(model);
}

/**
 * Group labels, as an exhaustive table rather than a switch with a default.
 * A new group is a compile error here, not a row that silently renders under
 * its own key.
 */
const PROVIDER_GROUP_LABELS: Record<ProviderGroupKey, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  pi: "Pi",
  qwen: "Qwen",
  kimi: "Kimi",
  grok: "Grok",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

export function providerGroupLabel(group: ProviderGroupKey): string {
  return PROVIDER_GROUP_LABELS[group];
}

export function subsectionKeyForModel(model: ModelDescriptor, group: ProviderGroupKey): string {
  // Checked first: a key-backed row belongs under its key on whatever provider
  // page it came from, including providers that have their own sectioning.
  if (model.credentialId?.trim()) return credentialSubsectionKey(model.credentialId.trim());
  if (model.family === "cursor" && group === "cursor") {
    return `${CURSOR_SECTION_PREFIX}${cursorCliLineGroupFromSdkId(model.providerModelId)}`;
  }
  if (model.family === "factory" && group === "droid") {
    return `${DROID_SECTION_PREFIX}${droidCliLineGroupFromModelId(model.providerModelId)}`;
  }
  if (group === "pi" && model.piProviderId) {
    const profileId = model.piProfileId?.trim() || "default";
    return `${PI_PROVIDER_PREFIX}${encodeURIComponent(profileId)}:${encodeURIComponent(model.piProviderId)}`;
  }
  if (group === "opencode" && model.openCodeProviderId) {
    return `${OPENCODE_PROVIDER_PREFIX}${model.openCodeProviderId}`;
  }
  return "__default__";
}

export function subsectionLabel(family: string, key: string): string {
  if (key === "__default__") return "";
  const credentialId = credentialIdFromSubsectionKey(key);
  if (credentialId) return credentialId;
  const piParts = piSubsectionParts(key);
  if (piParts) {
    const provider = formatPiProviderLabel(piParts.providerId);
    return piParts.profileId === "default" ? provider : `${provider} · ${piParts.profileId}`;
  }
  if (family === "opencode" && key.startsWith(OPENCODE_PROVIDER_PREFIX)) {
    const pid = key.slice(OPENCODE_PROVIDER_PREFIX.length);
    return providerLabel(pid);
  }
  if (family === "cursor" && key.startsWith(CURSOR_SECTION_PREFIX)) {
    const group = key.slice(CURSOR_SECTION_PREFIX.length) as CursorCliLineGroup;
    return cursorCliLineGroupLabel(group);
  }
  if (family === "factory" && key.startsWith(DROID_SECTION_PREFIX)) {
    const group = key.slice(DROID_SECTION_PREFIX.length) as DroidCliLineGroup;
    return droidCliLineGroupLabel(group);
  }
  return "";
}

export function subsectionSortOrder(family: string, key: string): number {
  // Keys sort after the provider's own curated lines: they are an addition the
  // user made, not part of what the provider ships.
  if (key.startsWith(CREDENTIAL_SECTION_PREFIX)) return PROVIDER_ORDER.length + 2;
  if (key.startsWith(PI_PROVIDER_PREFIX)) return PROVIDER_ORDER.length + 1;
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
  if (family === "factory" && key.startsWith(DROID_SECTION_PREFIX)) {
    const group = key.slice(DROID_SECTION_PREFIX.length) as DroidCliLineGroup;
    const index = DROID_CLI_LINE_ORDER.indexOf(group);
    return index === -1 ? DROID_CLI_LINE_ORDER.length + 50 : index;
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
    model.piProviderId ?? "",
    model.piModelId ?? "",
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

export function buildProviderGroupBlocks(
  models: ModelDescriptor[],
  modelOrder: Map<string, number>,
  opencodeProviders?: Array<{ id: string; name: string; connected: boolean; modelCount: number }>,
  includeEmptyOpenCodeProviders = true,
): ModelProviderGroupBlock[] {
  const byGroup = new Map<ProviderGroupKey, Map<string, Map<string, ModelDescriptor[]>>>();
  const opencodeProviderNameById = new Map((opencodeProviders ?? []).map((provider) => [provider.id, provider.name] as const));

  for (const model of models) {
    const group = classifyProviderGroup(model);
    const family = group === "opencode" && model.openCodeProviderId
      ? model.openCodeProviderId
      : group === "pi" && model.piProviderId
        ? model.piProviderId
        : model.family;
    const subKey = group === "opencode" && model.openCodeProviderId
      ? "__default__"
      : subsectionKeyForModel(model, group);
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

  if (includeEmptyOpenCodeProviders && !byGroup.has("opencode")) {
    byGroup.set("opencode", new Map());
  }

  const result: ModelProviderGroupBlock[] = [];
  const groupKeys = [...byGroup.keys()].sort((a, b) => PROVIDER_GROUP_ORDER[a] - PROVIDER_GROUP_ORDER[b]);
  for (const groupKey of groupKeys) {
    const famMap = byGroup.get(groupKey);
    if (!famMap) continue;
    const providers: ModelProviderBlock[] = [];
    for (const family of [...famMap.keys()].sort(compareProviderKeys)) {
      const subMap = famMap.get(family)!;
      const rawSubsections: ModelSubsection[] = [...subMap.entries()]
        .map(([key, ms]) => ({
          key,
          // A key's own label wins over the derived one: the id is a slug, and
          // "OpenRouter" is what the user typed on the provider page.
          label: ms.find((model) => model.credentialLabel?.trim())?.credentialLabel?.trim()
            || subsectionLabel(family, key),
          models: sortModels(ms, modelOrder),
        }))
        .sort((a, b) => subsectionSortOrder(family, a.key) - subsectionSortOrder(family, b.key));

      const labeled: ModelSubsection[] = [];
      const unlabeledModels: ModelDescriptor[] = [];
      for (const sub of rawSubsections) {
        if (sub.label.trim() === "") unlabeledModels.push(...sub.models);
        else labeled.push(sub);
      }
      const subsections: ModelSubsection[] = unlabeledModels.length > 0
        ? [{ key: "__default__", label: "", models: sortModels(unlabeledModels, modelOrder) }, ...labeled]
        : labeled;
      const modelCount = subsections.reduce((acc, sub) => acc + sub.models.length, 0);
      providers.push({
        key: family,
        label: groupKey === "opencode"
          ? opencodeProviderNameById.get(family) ?? providerLabel(family)
          : groupKey === "pi"
            ? formatPiProviderLabel(family)
            : providerLabel(family),
        badgeColor: providerBadgeColor(family, subsections.flatMap((s) => s.models)),
        subsections,
        modelCount,
      });
    }

    if (groupKey === "opencode" && includeEmptyOpenCodeProviders) {
      const existingFamilies = new Set(providers.map((p) => p.key));
      const potentialProviders = opencodeProviders?.map((p) => ({ id: p.id, name: p.name })) ?? [];
      for (const { id, name } of potentialProviders) {
        if (id === "ollama" || id === "lmstudio") continue;
        if (!existingFamilies.has(id)) {
          providers.push({
            key: id,
            label: PROVIDER_LABELS[id] ?? name,
            badgeColor: PROVIDER_BADGE_COLORS[id] ?? EMPTY_OPENCODE_BADGE_FALLBACK_COLOR,
            subsections: [],
            modelCount: 0,
          });
          existingFamilies.add(id);
        }
      }
      providers.sort((a, b) => compareProviderKeys(a.key, b.key));
    }

    result.push({ key: groupKey, label: providerGroupLabel(groupKey), providers });
  }
  return result;
}

export function createModelOrderMap(): Map<string, number> {
  return new Map(MODEL_REGISTRY.map((model, index) => [model.id, index]));
}
