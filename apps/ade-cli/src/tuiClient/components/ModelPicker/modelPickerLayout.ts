import { scoreModelPickerSearch } from "../../../../../desktop/src/renderer/components/shared/ModelPicker/modelPickerSearch";
import { sortModelItems } from "../../../../../desktop/src/renderer/components/shared/ModelPicker/modelOrdering";
import type { AgentChatModelCatalog, AgentChatModelInfo } from "../../../../../desktop/src/shared/types/chat";
import type { AiSettingsStatus, AiRuntimeConnectionStatus } from "../../../../../desktop/src/shared/types/config";
import {
  getModelById,
  getRuntimeModelRefForDescriptor,
  listModelDescriptorsForProvider,
  resolveProviderGroupForModel,
  type ModelDescriptor,
  type ProviderFamily,
  type ModelProviderGroup,
} from "../../../../../desktop/src/shared/modelRegistry";
import type { AdeCodeProvider } from "../../types";
import type {
  ModelPickerEntry,
  ModelPickerRailEntry,
  ModelPickerState,
  ModelPickerAuthStatus,
} from "./types";
import type { SetupPaneRow, SetupPaneRowKind } from "../../types";

const PROVIDER_LABELS: Record<AdeCodeProvider, string> = {
  codex: "OpenAI",
  claude: "Anthropic",
  opencode: "OpenCode",
  cursor: "Cursor",
  droid: "Droid",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

const PROVIDER_ORDER: readonly AdeCodeProvider[] = [
  "claude",
  "codex",
  "droid",
  "cursor",
  "opencode",
  "ollama",
  "lmstudio",
];

const RAIL_PROVIDER_ORDER: readonly AdeCodeProvider[] = PROVIDER_ORDER;
const STATIC_REGISTRY_FALLBACK_PROVIDERS: readonly ModelProviderGroup[] = ["claude", "codex"];

function providerLabel(provider: AdeCodeProvider): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function openCodeProviderLabel(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  const labels: Record<string, string> = {
    anthropic: "Anthropic",
    claude: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    deepseek: "DeepSeek",
    mistral: "Mistral",
    xai: "xAI",
    groq: "Groq",
    together: "Together",
    openrouter: "OpenRouter",
    ollama: "Ollama",
    lmstudio: "LM Studio",
  };
  return labels[normalized] ?? providerId.trim().replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function providerSignInHint(provider: AdeCodeProvider): string {
  return `/login ${provider}`;
}

function providerModelsCount(status: AiSettingsStatus | null | undefined, provider: AdeCodeProvider): number {
  if (!status) return 0;
  if (provider === "claude" || provider === "codex" || provider === "cursor" || provider === "droid") {
    return status.models?.[provider]?.length ?? 0;
  }
  const matchingRuntime = Object.values(status.runtimeConnections ?? {}).filter((connection) => {
    const key = String(connection.provider ?? "").toLowerCase();
    return key === provider || key.includes(provider);
  });
  const runtimeLoaded = matchingRuntime.reduce((total, connection) => total + (connection.loadedModelIds?.length ?? 0), 0);
  const openCodeLoaded = (status.opencodeProviders ?? [])
    .filter((entry) => entry.id.toLowerCase().includes(provider) || entry.name.toLowerCase().includes(provider))
    .reduce((total, entry) => total + entry.modelCount, 0);
  return runtimeLoaded + openCodeLoaded;
}

function runtimeReady(connection: AiRuntimeConnectionStatus | null | undefined): boolean {
  return Boolean(
    connection?.authAvailable
    || connection?.runtimeAvailable
    || (connection?.loadedModelIds?.length ?? 0) > 0,
  );
}

export function modelPickerProviderAuthStatus(
  status: AiSettingsStatus | null | undefined,
  provider: AdeCodeProvider,
): ModelPickerAuthStatus {
  if (!status) return "unknown";
  if (provider === "claude") {
    const connection = status.providerConnections?.claude;
    if (connection?.authAvailable || connection?.runtimeAvailable || status.availableProviders?.claude?.auth?.ready || providerModelsCount(status, provider) > 0) {
      return "ready";
    }
    return "unavailable";
  }
  if (provider === "codex" || provider === "cursor" || provider === "droid") {
    const connection = status.providerConnections?.[provider];
    if (connection?.authAvailable || connection?.runtimeAvailable || status.availableProviders?.[provider] === true || providerModelsCount(status, provider) > 0) {
      return "ready";
    }
    return "unavailable";
  }
  if (provider === "opencode") {
    if ((status.opencodeProviders ?? []).some((entry) => entry.connected) || status.opencodeBinaryInstalled === true) return "ready";
    if (status.opencodeBinaryInstalled === false || status.opencodeInventoryError) return "unavailable";
    return "unknown";
  }
  const matchingRuntime = Object.values(status.runtimeConnections ?? {}).filter((connection) => {
    const key = String(connection.provider ?? "").toLowerCase();
    return key === provider || key.includes(provider);
  });
  if (matchingRuntime.some(runtimeReady)) return "ready";
  const matchingOpenCodeProvider = (status.opencodeProviders ?? []).find((entry) => (
    entry.id.toLowerCase().includes(provider) || entry.name.toLowerCase().includes(provider)
  ));
  if (matchingOpenCodeProvider?.connected) return "ready";
  if (matchingOpenCodeProvider || matchingRuntime.length) return "unavailable";
  return "unknown";
}

function normalizeProvider(value: ProviderFamily | string | undefined): AdeCodeProvider {
  // resolveProviderGroupForModel already returns ModelProviderGroup values
  // (claude/codex/opencode/cursor/droid). Map ProviderFamily aliases as well so
  // raw registry families resolve correctly.
  if (value === "claude" || value === "anthropic") return "claude";
  if (value === "codex" || value === "openai") return "codex";
  if (value === "opencode") return "opencode";
  if (value === "ollama") return "ollama";
  if (value === "lmstudio") return "lmstudio";
  if (value === "cursor") return "cursor";
  if (value === "droid" || value === "factory") return "droid";
  return "codex";
}

function providerFromCatalogGroup(groupKey: string, fallbackFamily?: string): AdeCodeProvider {
  const normalized = groupKey.trim().toLowerCase();
  if (normalized === "claude" || normalized === "codex" || normalized === "opencode" || normalized === "cursor" || normalized === "droid") {
    return normalized;
  }
  if (normalized === "ollama" || normalized === "lmstudio") return normalized;
  return normalizeProvider(fallbackFamily ?? normalized);
}

function descriptorFor(modelInfo: AgentChatModelInfo): ModelDescriptor | undefined {
  const id = modelInfo.modelId ?? modelInfo.id;
  return getModelById(id);
}

function entriesFromCatalog(
  catalog: AgentChatModelCatalog,
  favoritesSet: Set<string>,
  aiStatus?: AiSettingsStatus | null,
  activeReasoningEffort?: string | null,
): ModelPickerEntry[] {
  const entries: ModelPickerEntry[] = [];
  const seen = new Set<string>();
  for (const group of catalog.groups ?? []) {
    for (const provider of group.providers ?? []) {
      for (const subsection of provider.subsections ?? []) {
        for (const model of subsection.models ?? []) {
          if (seen.has(model.id)) continue;
          seen.add(model.id);
          const family = providerFromCatalogGroup(String(model.groupKey || group.key), model.family);
          const authStatus = modelPickerProviderAuthStatus(aiStatus, family);
          entries.push({
            modelId: model.id,
            runtimeModelId: model.runtimeModelId || model.id,
            displayName: model.displayName,
            family,
            subProvider: family === "cursor" || family === "droid"
              ? subsection.label || model.providerName || provider.displayName || undefined
              : model.providerName || provider.displayName || subsection.label || undefined,
            subProviderKey: family === "cursor" || family === "droid"
              ? subsection.key || model.providerId || provider.key || undefined
              : model.providerId || provider.key || subsection.key || undefined,
            isFavorite: favoritesSet.has(model.id),
            isAvailable: model.isAvailable && authStatus !== "unavailable",
            authStatus,
            reasoningLabel: activeReasoningEffort ? `think ${activeReasoningEffort}` : null,
            ...(model.serviceTiers?.length ? { serviceTiers: [...model.serviceTiers] } : {}),
            ...(model.cursorAvailability ? { cursorAvailability: { ...model.cursorAvailability } } : {}),
          });
        }
      }
    }
  }
  return entries;
}

function entryFromDescriptor(
  descriptor: ModelDescriptor,
  favoritesSet: Set<string>,
  aiStatus?: AiSettingsStatus | null,
  activeReasoningEffort?: string | null,
): ModelPickerEntry {
  const registryProvider = resolveProviderGroupForModel(descriptor);
  const provider = normalizeProvider(registryProvider);
  const authStatus = modelPickerProviderAuthStatus(aiStatus, provider);
  return {
    modelId: descriptor.id,
    runtimeModelId: getRuntimeModelRefForDescriptor(descriptor, registryProvider),
    displayName: descriptor.displayName,
    family: provider,
    subProvider: providerLabel(provider),
    subProviderKey: provider,
    isFavorite: favoritesSet.has(descriptor.id),
    isAvailable: authStatus !== "unavailable",
    authStatus,
    reasoningLabel: activeReasoningEffort ? `think ${activeReasoningEffort}` : null,
    ...(descriptor.serviceTiers?.length ? { serviceTiers: [...descriptor.serviceTiers] } : {}),
    ...(descriptor.cursorAvailability ? { cursorAvailability: { ...descriptor.cursorAvailability } } : {}),
  };
}

function staticRegistryFallbackEntries(
  favoritesSet: Set<string>,
  aiStatus?: AiSettingsStatus | null,
  activeReasoningEffort?: string | null,
): ModelPickerEntry[] {
  return STATIC_REGISTRY_FALLBACK_PROVIDERS.flatMap((provider) =>
    listModelDescriptorsForProvider(provider).map((descriptor) =>
      entryFromDescriptor(descriptor, favoritesSet, aiStatus, activeReasoningEffort)
    )
  );
}

function entryFromModelInfo(
  modelInfo: AgentChatModelInfo,
  favoritesSet: Set<string>,
  aiStatus?: AiSettingsStatus | null,
  activeReasoningEffort?: string | null,
): ModelPickerEntry {
  const modelId = modelInfo.modelId ?? modelInfo.id;
  const descriptor = descriptorFor(modelInfo);
  const registryProvider = descriptor ? resolveProviderGroupForModel(descriptor) : null;
  const provider: AdeCodeProvider = registryProvider
    ? normalizeProvider(registryProvider)
    : normalizeProvider(modelInfo.family);
  const runtimeModelId = descriptor && registryProvider
    ? getRuntimeModelRefForDescriptor(descriptor, registryProvider)
    : modelInfo.id;
  const cursorAvailability = modelInfo.cursorAvailability ?? descriptor?.cursorAvailability;
  const authStatus = modelPickerProviderAuthStatus(aiStatus, provider);
  return {
    modelId,
    runtimeModelId,
    displayName: modelInfo.displayName,
    family: provider,
    ...(descriptor?.openCodeProviderId
      ? {
          subProvider: openCodeProviderLabel(descriptor.openCodeProviderId),
          subProviderKey: descriptor.openCodeProviderId,
        }
      : {}),
    isFavorite: favoritesSet.has(modelId),
    isAvailable: authStatus !== "unavailable",
    authStatus,
    reasoningLabel: activeReasoningEffort ? `think ${activeReasoningEffort}` : null,
    ...(modelInfo.serviceTiers?.length ? { serviceTiers: [...modelInfo.serviceTiers] } : {}),
    ...(cursorAvailability ? { cursorAvailability: { ...cursorAvailability } } : {}),
  };
}

export type BuildLayoutInput = {
  models: AgentChatModelInfo[];
  catalog?: AgentChatModelCatalog | null;
  favorites: string[];
  recents: string[];
  activeModelId: string | null;
  activeReasoningEffort?: string | null;
  aiStatus?: AiSettingsStatus | null;
  settingsRows?: SetupPaneRow[];
  footerFocus?: SetupPaneRowKind | null;
  laneLabel?: string | null;
  query: string;
  selection: { kind: "favorites" } | { kind: "recents" } | { kind: "provider"; provider: AdeCodeProvider };
  providerTabKey?: string | null;
  focusedIndex: number;
  searchMode: boolean;
};

export function buildModelPickerLayout(input: BuildLayoutInput): ModelPickerState {
  const favoritesSet = new Set(input.favorites);
  const runtimeEntries = input.catalog
    ? entriesFromCatalog(input.catalog, favoritesSet, input.aiStatus, input.activeReasoningEffort)
    : input.models.map((m) => entryFromModelInfo(m, favoritesSet, input.aiStatus, input.activeReasoningEffort));
  const entriesById = new Map<string, ModelPickerEntry>();
  for (const entry of staticRegistryFallbackEntries(favoritesSet, input.aiStatus, input.activeReasoningEffort)) {
    entriesById.set(entry.modelId, entry);
  }
  for (const entry of runtimeEntries) {
    entriesById.set(entry.modelId, entry);
  }
  const allEntries = [...entriesById.values()];
  // The TUI picker always shows the full provider catalog. Availability is
  // represented on each row (dimmed/SIGN IN), matching desktop, instead of
  // hiding models behind a separate "show all" switch.
  const visibleEntries = allEntries;

  // Keep the family rail stable so Cursor/Droid/etc. do not disappear while a
  // runtime is signed out, loading, or temporarily has no discovered models.
  const providerSet = new Set<AdeCodeProvider>([
    ...RAIL_PROVIDER_ORDER,
    ...allEntries.map((entry) => entry.family),
  ]);
  const providersPresent = RAIL_PROVIDER_ORDER
    .filter((provider) => providerSet.has(provider))
    .concat(Array.from(providerSet).filter((provider) => !RAIL_PROVIDER_ORDER.includes(provider)));
  const railEntries: ModelPickerRailEntry[] = [
    { kind: "favorites", label: "Favorites" },
    { kind: "recents", label: "Recents" },
    ...providersPresent.map((provider) => ({
      kind: "provider" as const,
      provider,
      label: providerLabel(provider),
      authStatus: modelPickerProviderAuthStatus(input.aiStatus, provider),
      signInHint: providerSignInHint(provider),
    })),
  ];

  const trimmedQuery = input.query.trim();
  const searchActive = trimmedQuery.length > 0;

  // Stale provider selections (persisted from a prior session where the provider
  // had entries) can fall through to an empty pool while railIndex defaults
  // back to favorites — leaving the rail and pool out of sync. Normalize the
  // selection up-front so both derive from the same authoritative state.
  let normalizedSelection = input.selection;
  if (
    !searchActive
    && normalizedSelection.kind === "provider"
    && !providersPresent.includes(normalizedSelection.provider)
  ) {
    normalizedSelection = providersPresent.length
      ? { kind: "provider", provider: providersPresent[0]! }
      : { kind: "favorites" };
  }

  let pool: ModelPickerEntry[];
  if (searchActive) {
    pool = visibleEntries;
  } else if (normalizedSelection.kind === "favorites") {
    pool = visibleEntries.filter((entry) => favoritesSet.has(entry.modelId));
  } else if (normalizedSelection.kind === "recents") {
    const recentSet = new Set(input.recents);
    const order = new Map(input.recents.map((id, i) => [id, i] as const));
    pool = visibleEntries
      .filter((entry) => recentSet.has(entry.modelId))
      .sort((a, b) => (order.get(a.modelId) ?? 0) - (order.get(b.modelId) ?? 0));
  } else {
    const target = normalizedSelection.provider;
    pool = visibleEntries.filter((entry) => entry.family === target);
  }

  const providerTabs = (() => {
    if (searchActive || normalizedSelection.kind !== "provider") return [];
    const groups = new Map<string, { key: string; label: string; entries: ModelPickerEntry[]; hasAvailable: boolean }>();
    for (const entry of pool) {
      const key = entry.subProviderKey || entry.subProvider || "__default__";
      const label = entry.subProvider || providerLabel(normalizedSelection.provider);
      const existing = groups.get(key);
      if (existing) {
        existing.entries.push(entry);
        existing.hasAvailable = existing.hasAvailable || entry.isAvailable;
      } else {
        groups.set(key, { key, label, entries: [entry], hasAvailable: entry.isAvailable });
      }
    }
    return [...groups.values()];
  })();
  const activeProviderTabKey = (() => {
    if (providerTabs.length <= 1) return null;
    if (input.providerTabKey && providerTabs.some((tab) => tab.key === input.providerTabKey)) {
      return input.providerTabKey;
    }
    const active = input.activeModelId ? allEntries.find((entry) => entry.modelId === input.activeModelId) : null;
    if (active?.subProviderKey && providerTabs.some((tab) => tab.key === active.subProviderKey)) {
      return active.subProviderKey;
    }
    return providerTabs.find((tab) => tab.hasAvailable)?.key ?? providerTabs[0]?.key ?? null;
  })();
  if (providerTabs.length > 1 && activeProviderTabKey) {
    pool = providerTabs.find((tab) => tab.key === activeProviderTabKey)?.entries ?? pool;
  }

  let entries: ModelPickerEntry[];
  if (searchActive) {
    const scored: Array<{ entry: ModelPickerEntry; score: number }> = [];
    for (const candidate of pool) {
      // Include the model's short id + aliases so users can type "opus"/"sonnet"
      // (matching the desktop picker), not just the full display name.
      const descriptor = getModelById(candidate.modelId);
      const score = scoreModelPickerSearch(
        {
          name: candidate.displayName,
          family: (candidate.family === "claude"
            ? "anthropic"
            : candidate.family === "codex"
              ? "openai"
              : candidate.family) as ProviderFamily,
          providerDisplayName: providerLabel(candidate.family),
          isFavorite: candidate.isFavorite,
          ...(descriptor?.shortId ? { shortName: descriptor.shortId } : {}),
          ...(descriptor?.aliases?.length ? { aliases: descriptor.aliases } : {}),
          ...(candidate.subProvider ? { subProvider: candidate.subProvider } : {}),
        },
        trimmedQuery,
      );
      if (score === null) continue;
      scored.push({ entry: candidate, score });
    }
    scored.sort((a, b) => a.score - b.score);
    entries = scored.map((s) => s.entry);
  } else {
    const sorted = sortModelItems(
      pool.map((entry) => ({ modelId: entry.modelId, _entry: entry })),
      { favoriteModelIds: favoritesSet, groupFavorites: true },
    );
    entries = sorted.map((entry) => entry._entry);
  }

  // Pick rail index from selection.
  let railIndex = 0;
  if (normalizedSelection.kind === "favorites") {
    railIndex = 0;
  } else if (normalizedSelection.kind === "recents") {
    railIndex = 1;
  } else {
    const targetProvider = normalizedSelection.provider;
    const idx = railEntries.findIndex(
      (entry) => entry.kind === "provider" && entry.provider === targetProvider,
    );
    railIndex = idx >= 0 ? idx : 0;
  }

  const focusedIndex = entries.length === 0
    ? 0
    : Math.max(0, Math.min(input.focusedIndex, entries.length - 1));
  const activeRailEntry = railEntries[railIndex] ?? null;
  const activeProviderRailEntry = activeRailEntry?.kind === "provider" ? activeRailEntry : null;

  return {
    query: input.query,
    searchMode: input.searchMode,
    railEntries,
    railIndex,
    entries,
    providerTabs: providerTabs.map((tab) => ({ key: tab.key, label: tab.label })),
    providerTabIndex: Math.max(0, providerTabs.findIndex((tab) => tab.key === activeProviderTabKey)),
    focusedIndex,
    activeModelId: input.activeModelId,
    activeProviderAuthStatus: activeProviderRailEntry
      ? activeProviderRailEntry.authStatus
      : "unknown",
    activeProviderSignInHint: activeProviderRailEntry
      ? activeProviderRailEntry.signInHint
      : null,
    settingsRows: input.settingsRows ?? [],
    footerFocus: input.footerFocus ?? null,
    laneLabel: input.laneLabel ?? null,
  };
}

export function railEntrySelection(entry: ModelPickerRailEntry):
  | { kind: "favorites" }
  | { kind: "recents" }
  | { kind: "provider"; provider: AdeCodeProvider } {
  if (entry.kind === "favorites") return { kind: "favorites" };
  if (entry.kind === "recents") return { kind: "recents" };
  return { kind: "provider", provider: entry.provider };
}

export function defaultSelectionFor(
  activeModelId: string | null,
  recents: string[],
  railEntries: ModelPickerRailEntry[],
): ReturnType<typeof railEntrySelection> {
  if (recents.length > 0) return { kind: "recents" };
  if (activeModelId) {
    const descriptor = getModelById(activeModelId);
    if (descriptor) {
      const provider = normalizeProvider(resolveProviderGroupForModel(descriptor));
      const match = railEntries.find(
        (entry) => entry.kind === "provider" && entry.provider === provider,
      );
      if (match) return railEntrySelection(match);
    }
  }
  const firstProvider = railEntries.find((entry) => entry.kind === "provider");
  if (firstProvider) return railEntrySelection(firstProvider);
  return { kind: "favorites" };
}
