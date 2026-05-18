import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { MODEL_REGISTRY, type ModelDescriptor, type ProviderFamily } from "../../../../shared/modelRegistry";
import { cn } from "../../ui/cn";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerRail, type RailEntry, type RailSelection, type AuthStatus } from "./ModelPickerRail";
import { ReasoningEffortControl } from "./ReasoningEffortControl";
import { useModelFavorites } from "./useModelFavorites";
import { useModelRecents } from "./useModelRecents";
import { useAuthOnlyFilter } from "./useAuthOnlyFilter";
import { usePerSurfaceModelDefaults } from "./usePerSurfaceModelDefaults";
import { useReasoningByFamily } from "./useReasoningByFamily";
import { useProviderAuthStatus } from "./useProviderAuthStatus";
import { scoreModelPickerSearch } from "./modelPickerSearch";
import { sortModelItems } from "./modelOrdering";

const PROVIDER_LABELS: Partial<Record<ProviderFamily, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  opencode: "OpenCode",
  google: "Google",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  xai: "xAI",
  groq: "Groq",
  together: "Together",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  cursor: "Cursor",
  factory: "Droid",
};

// Order matters for rail layout — top-tier providers first, then routers,
// then local runtimes. Listed here (not derived from PROVIDER_LABELS) because
// PROVIDER_LABELS may include experimental entries we don't want surfaced.
const ALL_PROVIDER_FAMILIES: readonly ProviderFamily[] = [
  "anthropic",
  "openai",
  "factory",
  "cursor",
  "opencode",
  "ollama",
  "lmstudio",
];

function providerLabel(family: ProviderFamily): string {
  return PROVIDER_LABELS[family] ?? family;
}

function modelSubProvider(model: ModelDescriptor): string {
  const sub = (model as ModelDescriptor & { subProvider?: string }).subProvider;
  if (typeof sub === "string" && sub.trim().length) return sub.trim();
  if (model.providerRoute === "opencode" && model.openCodeProviderId) {
    return `${model.openCodeProviderId} via OpenCode`;
  }
  return "";
}

export type ModelPickerContentProps = {
  value: string;
  surfaceKey: string;
  models: readonly ModelDescriptor[];
  isAvailable: (modelId: string) => boolean;
  providerAuthStatus?: Partial<Record<ProviderFamily, AuthStatus>>;
  onSelect: (modelId: string) => void;
  onRequestClose: () => void;
  showReasoning?: boolean;
  reasoningEffort?: string | null;
  onReasoningEffortChange?: (effort: string | null) => void;
  onOpenSignIn?: () => void;
};

export const ModelPickerContent = memo(function ModelPickerContent({
  value,
  surfaceKey,
  models,
  isAvailable,
  providerAuthStatus,
  onSelect,
  onRequestClose,
  showReasoning,
  reasoningEffort = null,
  onReasoningEffortChange,
  onOpenSignIn,
}: ModelPickerContentProps) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const { favorites, isFavorite, toggleFavorite } = useModelFavorites();
  const { recents, recordUsage } = useModelRecents();
  const { authOnly, toggleAuthOnly } = useAuthOnlyFilter();
  const { setDefault: setSurfaceDefault } = usePerSurfaceModelDefaults();
  const { rememberReasoning, getReasoningForFamily } = useReasoningByFamily();
  const internalAuth = useProviderAuthStatus();

  const recentSet = useMemo(() => new Set(recents), [recents]);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const effectiveAuth = useMemo<Partial<Record<ProviderFamily, AuthStatus>>>(() => {
    if (providerAuthStatus && Object.keys(providerAuthStatus).length > 0) {
      return providerAuthStatus;
    }
    return internalAuth.status;
  }, [providerAuthStatus, internalAuth.status]);

  const familyIsReady = useCallback(
    (family: ProviderFamily): boolean => {
      const status = effectiveAuth[family];
      if (status == null) return true;
      return status === "ok" || status === "limited";
    },
    [effectiveAuth],
  );

  const expandedModels = useMemo<readonly ModelDescriptor[]>(() => {
    if (authOnly) return models;
    const merged = new Map<string, ModelDescriptor>();
    for (const m of models) merged.set(m.id, m);
    for (const m of MODEL_REGISTRY) {
      if (m.deprecated) continue;
      if (!merged.has(m.id)) merged.set(m.id, m);
    }
    return [...merged.values()];
  }, [authOnly, models]);

  const providersPresent = useMemo<ProviderFamily[]>(() => {
    const set = new Set<ProviderFamily>();
    for (const m of expandedModels) set.add(m.family);
    if (!authOnly) {
      // Show every provider family ADE supports — including dynamic-only
      // providers (opencode, lmstudio) that have no static registry entries —
      // so the user can see the rail entry + empty state instead of wondering
      // why a provider is missing.
      for (const family of ALL_PROVIDER_FAMILIES) set.add(family);
      // Stabilize rail order so it doesn't flicker as catalog discovery streams in.
      return ALL_PROVIDER_FAMILIES.filter((family) => set.has(family))
        .concat([...set].filter((family) => !ALL_PROVIDER_FAMILIES.includes(family)));
    }
    return [...set];
  }, [authOnly, expandedModels]);

  const railEntries = useMemo<RailEntry[]>(() => {
    const out: RailEntry[] = [{ kind: "favorites" }, { kind: "recents" }];
    for (const family of providersPresent) {
      out.push({ kind: "provider", family, label: providerLabel(family) });
    }
    return out;
  }, [providersPresent]);

  const initialSelectionRef = useRef<RailSelection | null>(null);
  if (initialSelectionRef.current == null) {
    if (recents.length > 0) {
      initialSelectionRef.current = "recents";
    } else {
      const activeModel = expandedModels.find((m) => m.id === value);
      initialSelectionRef.current = activeModel
        ? `provider:${activeModel.family}`
        : providersPresent[0]
          ? `provider:${providersPresent[0]}`
          : "favorites";
    }
  }
  const [selection, setSelection] = useState<RailSelection>(initialSelectionRef.current);

  useLayoutEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSelectRail = useCallback((next: RailSelection) => {
    setSelection(next);
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  // authOnly === true hides models whose family isn't ready;
  // when off, all models are shown (including unauthed, which the row dims + offers sign-in).
  const filterAvailable = useCallback(
    (m: ModelDescriptor): boolean => {
      if (!authOnly) return true;
      // Prefer auth-derived gate; fall back to caller-provided `isAvailable` if no auth signal exists.
      if (Object.keys(effectiveAuth).length > 0) {
        return familyIsReady(m.family);
      }
      return isAvailable(m.id);
    },
    [authOnly, effectiveAuth, familyIsReady, isAvailable],
  );

  const searchActive = query.trim().length > 0;

  const toSearchItem = useCallback(
    (m: ModelDescriptor) => ({
      name: m.displayName,
      shortName: m.shortId,
      subProvider: modelSubProvider(m) || undefined,
      family: m.family,
      providerDisplayName: providerLabel(m.family),
      isFavorite: favoriteSet.has(m.id),
    }),
    [favoriteSet],
  );

  const visibleModels = useMemo<ModelDescriptor[]>(() => {
    let pool: ModelDescriptor[] = [];
    if (searchActive) {
      pool = expandedModels.filter(filterAvailable);
    } else if (selection === "favorites") {
      pool = expandedModels.filter((m) => favoriteSet.has(m.id)).filter(filterAvailable);
    } else if (selection === "recents") {
      const order = new Map(recents.map((id, i) => [id, i] as const));
      pool = expandedModels
        .filter((m) => recentSet.has(m.id))
        .filter(filterAvailable)
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return pool;
    } else {
      const family = selection.slice("provider:".length) as ProviderFamily;
      pool = expandedModels.filter((m) => m.family === family).filter(filterAvailable);
    }

    if (searchActive) {
      const scored: Array<{ model: ModelDescriptor; score: number }> = [];
      for (const m of pool) {
        const score = scoreModelPickerSearch(toSearchItem(m), query);
        if (score === null) continue;
        scored.push({ model: m, score });
      }
      scored.sort((a, b) => a.score - b.score);
      return scored.map((entry) => entry.model);
    }

    const sorted = sortModelItems(
      pool.map((m) => ({ modelId: m.id, _model: m })),
      { favoriteModelIds: favoriteSet, groupFavorites: true },
    );
    return sorted.map((entry) => entry._model);
  }, [
    searchActive,
    selection,
    expandedModels,
    filterAvailable,
    favoriteSet,
    recentSet,
    recents,
    query,
    toSearchItem,
  ]);

  const groupedRows = useMemo(() => {
    if (selection === "favorites" || selection === "recents" || searchActive) {
      return [{ subProvider: "", models: visibleModels }];
    }
    const groups = new Map<string, ModelDescriptor[]>();
    for (const m of visibleModels) {
      const key = modelSubProvider(m);
      const list = groups.get(key);
      if (list) list.push(m);
      else groups.set(key, [m]);
    }
    const arr = [...groups.entries()].map(([subProvider, modelsInGroup]) => ({
      subProvider,
      models: modelsInGroup,
    }));
    return arr;
  }, [selection, searchActive, visibleModels]);

  const showSubHeaders = groupedRows.length > 1;

  const [focusedIndex, setFocusedIndex] = useState(0);
  useEffect(() => {
    setFocusedIndex(0);
  }, [selection, query]);

  const flatVisibleIds = useMemo(
    () => visibleModels.map((m) => m.id),
    [visibleModels],
  );

  const isAvailableForUse = useCallback(
    (m: ModelDescriptor): boolean => {
      if (Object.keys(effectiveAuth).length > 0) {
        return familyIsReady(m.family) && isAvailable(m.id);
      }
      return isAvailable(m.id);
    },
    [effectiveAuth, familyIsReady, isAvailable],
  );

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onRequestClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, Math.max(0, flatVisibleIds.length - 1)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocusedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const target = visibleModels[focusedIndex];
        if (!target) return;
        if (!isAvailableForUse(target)) {
          onOpenSignIn?.();
          return;
        }
        recordUsage(target.id);
        onSelect(target.id);
      }
    },
    [
      flatVisibleIds,
      focusedIndex,
      isAvailableForUse,
      onOpenSignIn,
      onRequestClose,
      onSelect,
      recordUsage,
      visibleModels,
    ],
  );

  const handleRowSelect = useCallback(
    (modelId: string) => {
      recordUsage(modelId);
      onSelect(modelId);
    },
    [onSelect, recordUsage],
  );

  const handleSetSurfaceDefault = useCallback(
    (modelId: string) => {
      setSurfaceDefault(surfaceKey, modelId);
    },
    [setSurfaceDefault, surfaceKey],
  );

  const handleCopyId = useCallback((modelId: string) => {
    try {
      void navigator.clipboard.writeText(modelId);
    } catch {
      // ignore clipboard failures
    }
  }, []);

  const activeModel = useMemo(
    () => expandedModels.find((m) => m.id === value) ?? null,
    [expandedModels, value],
  );

  // Pick a "presentation model" used for the reasoning footer when no value is selected
  // or the active model has no reasoning tiers.
  const reasoningPresentationModel = useMemo<ModelDescriptor | null>(() => {
    if (activeModel && (activeModel.reasoningTiers?.length ?? 0) > 0) {
      return activeModel;
    }
    const firstWithReasoning = visibleModels.find((m) => (m.reasoningTiers?.length ?? 0) > 0);
    if (firstWithReasoning) return firstWithReasoning;
    const anyWithReasoning = expandedModels.find((m) => (m.reasoningTiers?.length ?? 0) > 0);
    return anyWithReasoning ?? null;
  }, [activeModel, expandedModels, visibleModels]);

  const reasoningTiers = reasoningPresentationModel?.reasoningTiers ?? [];

  const reasoningFamily = reasoningPresentationModel?.family ?? null;
  const displayedReasoningEffort = useMemo<string | null>(() => {
    // If the picker is tied to a real active model with explicit effort, use it.
    if (activeModel && reasoningEffort) return reasoningEffort;
    // Otherwise, fall back to the family-remembered effort for the presentation model.
    if (reasoningFamily) return getReasoningForFamily(reasoningFamily);
    return reasoningEffort;
  }, [activeModel, reasoningEffort, reasoningFamily, getReasoningForFamily]);

  const handleReasoningChange = useCallback(
    (next: string | null) => {
      if (reasoningFamily) {
        rememberReasoning(reasoningFamily, next);
      }
      onReasoningEffortChange?.(next);
    },
    [onReasoningEffortChange, reasoningFamily, rememberReasoning],
  );

  // Inline per-row reasoning chips appear only in Favorites/Recents (and search results),
  // never in provider rail views (the dedicated footer covers those).
  const showInlineReasoningChips =
    !searchActive && (selection === "favorites" || selection === "recents");

  const cycleReasoningForModel = useCallback(
    (model: ModelDescriptor) => {
      const tiers = model.reasoningTiers;
      if (!tiers || tiers.length === 0) return;
      const current = getReasoningForFamily(model.family);
      const idx = current ? tiers.indexOf(current) : -1;
      const nextIdx = idx < 0 ? 0 : (idx + 1) % tiers.length;
      const next = tiers[nextIdx] ?? null;
      rememberReasoning(model.family, next);
      if (activeModel?.family === model.family) {
        onReasoningEffortChange?.(next);
      }
    },
    [activeModel, getReasoningForFamily, onReasoningEffortChange, rememberReasoning],
  );

  const isEmpty = visibleModels.length === 0;

  // Sticky "Currently using" detection — show when active row is not in the visible window.
  const activeRowVisibleRef = useRef(true);
  const [activeOutOfView, setActiveOutOfView] = useState(false);
  useEffect(() => {
    if (!activeModel) return;
    if (!flatVisibleIds.includes(activeModel.id)) {
      setActiveOutOfView(false);
      return;
    }
    const container = listRef.current;
    if (!container) return;
    const targetEl = container.querySelector<HTMLElement>(
      `[data-model-id="${cssEscape(activeModel.id)}"]`,
    );
    if (!targetEl) {
      setActiveOutOfView(true);
      return;
    }
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          activeRowVisibleRef.current = entry.isIntersecting;
          setActiveOutOfView(!entry.isIntersecting);
        }
      },
      { root: container, threshold: 0.1 },
    );
    observer.observe(targetEl);
    return () => observer.disconnect();
  }, [activeModel, flatVisibleIds]);

  return (
    <div
      data-model-picker-content="true"
      className={cn(
        "flex w-[460px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-white/[0.08]",
        "bg-[#13111A]/95 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-md",
      )}
      onKeyDown={handleListKeyDown}
    >
      <div className="flex h-[380px] min-h-0">
        <ModelPickerRail
          entries={railEntries}
          selected={selection}
          onSelect={handleSelectRail}
          providerAuthStatus={effectiveAuth}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-2.5 py-2">
            <MagnifyingGlass size={13} className="shrink-0 text-muted-fg/55" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models..."
              aria-label="Search models"
              className={cn(
                "min-w-0 flex-1 bg-transparent text-[12px] font-medium leading-tight",
                "text-fg placeholder:text-muted-fg/45 outline-none",
              )}
            />
            <button
              type="button"
              role="switch"
              aria-checked={!authOnly}
              data-model-picker-auth-toggle="true"
              title={
                authOnly
                  ? "Only providers you have keys / subscriptions for. Click to include unauthenticated providers."
                  : "Including providers you haven't signed in to. Click to hide them."
              }
              onClick={toggleAuthOnly}
              className={cn(
                "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium leading-none transition-colors",
                !authOnly
                  ? "border-violet-400/30 bg-violet-500/[0.10] text-violet-100"
                  : "border-white/[0.08] bg-white/[0.02] text-muted-fg/70 hover:border-white/[0.12] hover:text-fg/85",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "relative inline-block h-3 w-5 rounded-full transition-colors",
                  !authOnly ? "bg-violet-400/70" : "bg-white/[0.10]",
                )}
              >
                <span
                  className={cn(
                    "absolute top-[1px] inline-block h-2.5 w-2.5 rounded-full bg-fg shadow-sm transition-all duration-150",
                    !authOnly ? "left-[9px]" : "left-[2px]",
                  )}
                />
              </span>
              <span>Show all models</span>
            </button>
          </div>

          <div
            ref={listRef}
            role="listbox"
            aria-label="Models"
            className="relative flex-1 overflow-y-auto px-1.5 py-1"
          >
            {activeOutOfView && activeModel ? (
              <div
                className={cn(
                  "sticky top-0 z-[5] mx-0.5 mb-1 rounded-md border border-violet-400/15 bg-violet-500/[0.08] px-2 py-1",
                  "text-[10px] font-medium text-fg/85 backdrop-blur",
                )}
              >
                <span className="text-muted-fg/55">Currently using: </span>
                <span className="font-semibold">{activeModel.displayName}</span>
              </div>
            ) : null}

            {isEmpty ? (
              <EmptyState selection={selection} searchActive={searchActive} />
            ) : (
              <div className="flex flex-col gap-px">
                {groupedRows.map((group, gi) => (
                  <div key={group.subProvider || `g${gi}`}>
                    {showSubHeaders && group.subProvider ? (
                      <div
                        className={cn(
                          "sticky top-0 z-[4] px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
                          "bg-[#13111A]/95 text-muted-fg/55 backdrop-blur",
                        )}
                      >
                        {group.subProvider}
                      </div>
                    ) : null}
                    {group.models.map((m) => {
                      const indexInFlat = flatVisibleIds.indexOf(m.id);
                      const isFocused = indexInFlat === focusedIndex;
                      const isActive = m.id === value;
                      return (
                        <div
                          key={m.id}
                          data-focused={isFocused ? "true" : undefined}
                          className={cn(isFocused && "outline-none ring-1 ring-violet-400/30 rounded-md")}
                        >
                          <ModelListRow
                            model={m}
                            isFavorite={isFavorite(m.id)}
                            isActive={isActive}
                            isAvailable={isAvailableForUse(m)}
                            onSelect={handleRowSelect}
                            onToggleFavorite={toggleFavorite}
                            onCopyId={handleCopyId}
                            onSetSurfaceDefault={handleSetSurfaceDefault}
                            {...(onOpenSignIn ? { onSignIn: onOpenSignIn } : {})}
                            {...(showInlineReasoningChips && m.reasoningTiers?.length
                              ? {
                                  inlineReasoningChip: {
                                    visible: true,
                                    effort: getReasoningForFamily(m.family),
                                    tiers: m.reasoningTiers,
                                    onCycle: () => cycleReasoningForModel(m),
                                  },
                                }
                              : {})}
                          />
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>

          {showReasoning && onReasoningEffortChange && reasoningTiers.length > 0 ? (
            <ReasoningEffortControl
              effort={displayedReasoningEffort}
              onChange={handleReasoningChange}
              tiers={reasoningTiers}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
});

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function EmptyState({
  selection,
  searchActive,
}: {
  selection: RailSelection;
  searchActive: boolean;
}) {
  let body = "No models match this view.";
  if (searchActive) body = "No models match your search.";
  else if (selection === "favorites") body = "Star a model to pin it here.";
  else if (selection === "recents") body = "Models you use will appear here.";
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-1 px-4 py-6 text-center">
      <span className="text-[11px] font-medium text-muted-fg/65">{body}</span>
    </div>
  );
}
