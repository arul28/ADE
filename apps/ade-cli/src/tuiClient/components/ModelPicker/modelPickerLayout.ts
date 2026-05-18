import { scoreModelPickerSearch } from "../../../../../desktop/src/renderer/components/shared/ModelPicker/modelPickerSearch";
import { sortModelItems } from "../../../../../desktop/src/renderer/components/shared/ModelPicker/modelOrdering";
import type { AgentChatModelInfo } from "../../../../../desktop/src/shared/types/chat";
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
  if (value === "cursor") return "cursor";
  if (value === "droid" || value === "factory") return "droid";
  return "codex";
}

function descriptorFor(modelInfo: AgentChatModelInfo): ModelDescriptor | undefined {
  const id = modelInfo.modelId ?? modelInfo.id;
  return getModelById(id);
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
  };
}

export type BuildLayoutInput = {
  models: AgentChatModelInfo[];
  favorites: string[];
  recents: string[];
  activeModelId: string | null;
  query: string;
  selection: { kind: "favorites" } | { kind: "recents" } | { kind: "provider"; provider: AdeCodeProvider };
  focusedIndex: number;
  searchMode: boolean;
};

export function buildModelPickerLayout(input: BuildLayoutInput): ModelPickerState {
  const favoritesSet = new Set(input.favorites);
  const allEntries = input.models.map((m) => entryFromModelInfo(m, favoritesSet));

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

  let pool: ModelPickerEntry[];
  if (searchActive) {
    pool = allEntries;
  } else if (input.selection.kind === "favorites") {
    pool = allEntries.filter((entry) => favoritesSet.has(entry.modelId));
  } else if (input.selection.kind === "recents") {
    const recentSet = new Set(input.recents);
    const order = new Map(input.recents.map((id, i) => [id, i] as const));
    pool = allEntries
      .filter((entry) => recentSet.has(entry.modelId))
      .sort((a, b) => (order.get(a.modelId) ?? 0) - (order.get(b.modelId) ?? 0));
  } else {
    const target = input.selection.provider;
    pool = allEntries.filter((entry) => entry.family === target);
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
  if (input.selection.kind === "favorites") {
    railIndex = 0;
  } else if (input.selection.kind === "recents") {
    railIndex = 1;
  } else {
    const targetProvider = input.selection.provider;
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
