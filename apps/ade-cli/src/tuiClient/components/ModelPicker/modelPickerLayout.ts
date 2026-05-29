import { scoreModelPickerSearch } from "../../../../../desktop/src/renderer/components/shared/ModelPicker/modelPickerSearch";
import { sortModelItems } from "../../../../../desktop/src/renderer/components/shared/ModelPicker/modelOrdering";
import type { AgentChatModelCatalog, AgentChatModelInfo } from "../../../../../desktop/src/shared/types/chat";
import {
  getModelById,
  resolveProviderGroupForModel,
  type ModelDescriptor,
  type ProviderFamily,
} from "../../../../../desktop/src/shared/modelRegistry";
import type { AdeCodeProvider } from "../../types";
import type {
  ModelPickerEntry,
  ModelPickerRailEntry,
  ModelPickerState,
} from "./types";

const PROVIDER_LABELS: Record<AdeCodeProvider, string> = {
  codex: "OpenAI",
  claude: "Anthropic",
  opencode: "OpenCode",
  cursor: "Cursor",
  droid: "Droid",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

function providerLabel(provider: AdeCodeProvider): string {
  return PROVIDER_LABELS[provider] ?? provider;
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
  if (groupKey === "claude" || groupKey === "codex" || groupKey === "opencode" || groupKey === "cursor" || groupKey === "droid") {
    return groupKey;
  }
  if (groupKey === "ollama" || groupKey === "lmstudio") return groupKey;
  return normalizeProvider(fallbackFamily);
}

function descriptorFor(modelInfo: AgentChatModelInfo): ModelDescriptor | undefined {
  const id = modelInfo.modelId ?? modelInfo.id;
  return getModelById(id);
}

function entriesFromCatalog(
  catalog: AgentChatModelCatalog,
  favoritesSet: Set<string>,
): ModelPickerEntry[] {
  const entries: ModelPickerEntry[] = [];
  const seen = new Set<string>();
  for (const group of catalog.groups ?? []) {
    for (const provider of group.providers ?? []) {
      for (const subsection of provider.subsections ?? []) {
        for (const model of subsection.models ?? []) {
          if (seen.has(model.id)) continue;
          seen.add(model.id);
          entries.push({
            modelId: model.id,
            runtimeModelId: model.runtimeModelId || model.id,
            displayName: model.displayName,
            family: providerFromCatalogGroup(String(model.groupKey || group.key), model.family),
            subProvider: model.providerName || provider.displayName || subsection.label || undefined,
            subProviderKey: model.providerId || provider.key || subsection.key || undefined,
            isFavorite: favoritesSet.has(model.id),
            isAvailable: model.isAvailable,
            ...(model.serviceTiers?.length ? { serviceTiers: [...model.serviceTiers] } : {}),
            ...(model.cursorAvailability ? { cursorAvailability: { ...model.cursorAvailability } } : {}),
          });
        }
      }
    }
  }
  return entries;
}

function entryFromModelInfo(
  modelInfo: AgentChatModelInfo,
  favoritesSet: Set<string>,
): ModelPickerEntry {
  const modelId = modelInfo.modelId ?? modelInfo.id;
  const descriptor = descriptorFor(modelInfo);
  const provider: AdeCodeProvider = descriptor
    ? normalizeProvider(resolveProviderGroupForModel(descriptor))
    : normalizeProvider(modelInfo.family);
  const runtimeModelId = descriptor?.providerModelId ?? descriptor?.shortId ?? modelInfo.id;
  const cursorAvailability = modelInfo.cursorAvailability ?? descriptor?.cursorAvailability;
  return {
    modelId,
    runtimeModelId,
    displayName: modelInfo.displayName,
    family: provider,
    ...(descriptor?.openCodeProviderId
      ? { subProvider: `${descriptor.openCodeProviderId} via OpenCode` }
      : {}),
    isFavorite: favoritesSet.has(modelId),
    isAvailable: true,
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
  query: string;
  selection: { kind: "favorites" } | { kind: "recents" } | { kind: "provider"; provider: AdeCodeProvider };
  providerTabKey?: string | null;
  focusedIndex: number;
  searchMode: boolean;
};

export function buildModelPickerLayout(input: BuildLayoutInput): ModelPickerState {
  const favoritesSet = new Set(input.favorites);
  const allEntries = input.catalog
    ? entriesFromCatalog(input.catalog, favoritesSet)
    : input.models.map((m) => entryFromModelInfo(m, favoritesSet));

  // Providers actually present in the registry-filtered model list.
  const providersPresent = Array.from(
    new Set(allEntries.map((entry) => entry.family)),
  );
  const railEntries: ModelPickerRailEntry[] = [
    { kind: "favorites", label: "Favorites" },
    { kind: "recents", label: "Recents" },
    ...providersPresent.map((provider) => ({
      kind: "provider" as const,
      provider,
      label: providerLabel(provider),
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
    pool = allEntries;
  } else if (normalizedSelection.kind === "favorites") {
    pool = allEntries.filter((entry) => favoritesSet.has(entry.modelId));
  } else if (normalizedSelection.kind === "recents") {
    const recentSet = new Set(input.recents);
    const order = new Map(input.recents.map((id, i) => [id, i] as const));
    pool = allEntries
      .filter((entry) => recentSet.has(entry.modelId))
      .sort((a, b) => (order.get(a.modelId) ?? 0) - (order.get(b.modelId) ?? 0));
  } else {
    const target = normalizedSelection.provider;
    pool = allEntries.filter((entry) => entry.family === target);
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
