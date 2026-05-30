import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { MODEL_REGISTRY, type ModelDescriptor, type ProviderFamily } from "../../../../shared/modelRegistry";
import { cn } from "../../ui/cn";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerRail, type RailEntry, type RailSelection, type AuthStatus } from "./ModelPickerRail";
import { useModelFavorites } from "./useModelFavorites";
import { useModelRecents } from "./useModelRecents";
import { useAuthOnlyFilter } from "./useAuthOnlyFilter";
import { usePerSurfaceModelDefaults } from "./usePerSurfaceModelDefaults";
import { useProviderAuthStatus } from "./useProviderAuthStatus";
import { scoreModelPickerSearch } from "./modelPickerSearch";
import { sortModelItems } from "./modelOrdering";
import { ProviderEmptyState, ProviderSetupBanner } from "./providerEmptyState";
import type { AgentChatModelCatalogRefreshProvider } from "../../../../shared/types";

const MODEL_ROW_ESTIMATED_HEIGHT = 44;

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
    // Sub-header text used in grouped lists. Already inside the OpenCode rail
    // when this fires, so "via OpenCode" was redundant — show the underlying
    // provider name only. Title-case so "anthropic" reads as "Anthropic".
    const id = model.openCodeProviderId;
    return id.charAt(0).toUpperCase() + id.slice(1);
  }
  return "";
}

function modelSubProviderKey(model: ModelDescriptor): string {
  const key = (model as ModelDescriptor & { subProviderKey?: string }).subProviderKey;
  if (typeof key === "string" && key.trim().length) return key.trim();
  if (model.providerRoute === "opencode" && model.openCodeProviderId) return model.openCodeProviderId;
  return modelSubProvider(model) || "__default__";
}

function refreshProviderForFamily(family: ProviderFamily): AgentChatModelCatalogRefreshProvider | null {
  if (family === "opencode") return "opencode";
  if (family === "ollama") return "ollama";
  if (family === "lmstudio") return "lmstudio";
  if (family === "cursor") return "cursor";
  if (family === "factory") return "droid";
  return null;
}

function refreshProviderLabel(provider: AgentChatModelCatalogRefreshProvider): string {
  if (provider === "lmstudio") return "LM Studio";
  if (provider === "droid") return "Droid";
  return providerLabel(provider);
}

function providerIsReady(status: AuthStatus | undefined): boolean {
  return status === "ok" || status === "limited";
}

export type ModelPickerContentProps = {
  value: string;
  surfaceKey: string;
  models: readonly ModelDescriptor[];
  isAvailable: (modelId: string) => boolean;
  providerAuthStatus?: Partial<Record<ProviderFamily, AuthStatus>>;
  onSelect: (modelId: string) => void;
  onRequestClose: () => void;
  onProviderRailSelect?: (family: ProviderFamily) => void;
  /**
   * When true (set by orchestration `model_selection` pending input), hide
   * any permission-related rail/picker rows so the user only chooses model
   * + fast-mode + reasoning. The permission tier is forced by the
   * orchestration spawn profile (see `goal.md` §12, §10.9).
   *
   * v1 ModelPickerContent does not render permission rows directly — the
   * permission picker lives in `AgentChatComposer.tsx` alongside the model
   * picker — so this flag is a forward-compat hook. It is propagated to
   * children that may render permission-aware affordances (e.g. sign-in
   * rails) so they can elide them when the surface is orchestrated.
   */
  hidePermissionRail?: boolean;
  refreshingProvider?: AgentChatModelCatalogRefreshProvider | null;
  onOpenSignIn?: () => void;
  allowCliOnlyModels?: boolean;
  cursorAvailabilityMode?: "chat" | "cli" | "all";
  allowRegistryExpansion?: boolean;
};

export const ModelPickerContent = memo(function ModelPickerContent({
  value,
  surfaceKey,
  models,
  isAvailable,
  providerAuthStatus,
  onSelect,
  onRequestClose,
  onProviderRailSelect,
  refreshingProvider,
  onOpenSignIn,
  hidePermissionRail = false,
  allowCliOnlyModels = false,
  cursorAvailabilityMode = allowCliOnlyModels ? "cli" : "chat",
  allowRegistryExpansion = true,
}: ModelPickerContentProps) {
  // hidePermissionRail is currently a forward-compat hook (see prop docs).
  // Reference it so unused-var lint stays quiet, and so future code paths
  // that branch on the flag can drop in here without touching the signature.
  void hidePermissionRail;
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const { favorites, isFavorite, toggleFavorite } = useModelFavorites();
  const { recents, recordUsage } = useModelRecents();
  const { authOnly, toggleAuthOnly } = useAuthOnlyFilter();
  const { setDefault: setSurfaceDefault } = usePerSurfaceModelDefaults();
  const internalAuth = useProviderAuthStatus();

  const recentSet = useMemo(() => new Set(recents), [recents]);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const effectiveAuth = useMemo<Partial<Record<ProviderFamily, AuthStatus>>>(() => {
    if (providerAuthStatus && Object.keys(providerAuthStatus).length > 0) {
      return providerAuthStatus;
    }
    return internalAuth.status;
  }, [providerAuthStatus, internalAuth.status]);

  // The cheap binary probe answers "is OpenCode installed?" in ms (separate
  // from the slow full getStatus probe). Until that lands we don't render
  // the OpenCode-required empty state — we just show an empty list so we
  // don't make a false "Install OpenCode" claim during the brief unknown
  // window.
  const opencodeBinaryInstalled = internalAuth.opencodeBinaryInstalled;
  const opencodeBinaryKnown = internalAuth.binaryProbed;
  const isOpencodeRequiredFamily = useCallback(
    (family: ProviderFamily): family is "opencode" | "ollama" | "lmstudio" =>
      family === "opencode" || family === "ollama" || family === "lmstudio",
    [],
  );

  const familyIsReady = useCallback(
    (family: ProviderFamily): boolean => {
      const status = effectiveAuth[family];
      if (status == null) return true;
      return status === "ok" || status === "limited";
    },
    [effectiveAuth],
  );

  const matchesCursorAvailabilityMode = useCallback(
    (m: ModelDescriptor): boolean => {
      if (m.family !== "cursor" || cursorAvailabilityMode === "all") return true;
      const availability = m.cursorAvailability;
      if (!availability) return false;
      if (cursorAvailabilityMode === "cli") return availability.cli === true;
      return availability.sdk === true;
    },
    [cursorAvailabilityMode],
  );

  const expandedModels = useMemo<readonly ModelDescriptor[]>(() => {
    if (authOnly || !allowRegistryExpansion) return models;
    const merged = new Map<string, ModelDescriptor>();
    for (const m of models) merged.set(m.id, m);
    for (const m of MODEL_REGISTRY) {
      if (m.deprecated) continue;
      if (!merged.has(m.id)) merged.set(m.id, m);
    }
    return [...merged.values()];
  }, [allowRegistryExpansion, authOnly, models]);

  const providersPresent = useMemo<ProviderFamily[]>(() => {
    const set = new Set<ProviderFamily>();
    for (const m of expandedModels) set.add(m.family);
    // Always include dynamic-only provider families (Cursor, Droid, OpenCode,
    // local runtimes). Their models may not exist until a catalog refresh runs,
    // but the rail entry must still be reachable without toggling "Show all models".
    for (const family of ALL_PROVIDER_FAMILIES) set.add(family);
    // Stabilize rail order so it doesn't flicker as catalog discovery streams in.
    return ALL_PROVIDER_FAMILIES.filter((family) => set.has(family))
      .concat([...set].filter((family) => !ALL_PROVIDER_FAMILIES.includes(family)));
  }, [expandedModels]);

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
    if (next !== "favorites" && next !== "recents") {
      onProviderRailSelect?.(next.slice("provider:".length) as ProviderFamily);
    }
    setSelection(next);
    searchRef.current?.focus({ preventScroll: true });
  }, [onProviderRailSelect]);

  // authOnly === true hides models whose family isn't ready;
  // when off, all models are shown (including unauthed, which the row dims + offers sign-in).
  const filterAvailable = useCallback(
    (m: ModelDescriptor): boolean => {
      // Models for opencode/ollama/lmstudio require the OpenCode CLI runtime.
      // When the cheap binary check has completed AND OpenCode isn't installed,
      // hide them so the panes surface the "Install OpenCode" empty state.
      // While the probe is still in-flight (binaryKnown === false) we don't
      // hide anything — the alternative would flash "Install OpenCode" briefly
      // for users who do have it.
      if (opencodeBinaryKnown && !opencodeBinaryInstalled && isOpencodeRequiredFamily(m.family)) {
        return false;
      }
      if (!matchesCursorAvailabilityMode(m)) return false;
      if (!authOnly) return true;
      // Prefer auth-derived gate; fall back to caller-provided `isAvailable` if no auth signal exists.
      if (Object.keys(effectiveAuth).length > 0) {
        return familyIsReady(m.family);
      }
      return isAvailable(m.id);
    },
    [authOnly, effectiveAuth, familyIsReady, isAvailable, isOpencodeRequiredFamily, matchesCursorAvailabilityMode, opencodeBinaryInstalled, opencodeBinaryKnown],
  );

  const searchActive = query.trim().length > 0;

  const toSearchItem = useCallback(
    (m: ModelDescriptor) => ({
      name: m.displayName,
      shortName: m.shortId,
      aliases: m.aliases,
      subProvider: modelSubProvider(m) || undefined,
      family: m.family,
      providerDisplayName: providerLabel(m.family),
      isFavorite: favoriteSet.has(m.id),
    }),
    [favoriteSet],
  );

  const candidateModels = useMemo<ModelDescriptor[]>(() => {
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

  const activeProviderFamily = useMemo<ProviderFamily | null>(() => {
    if (searchActive) return null;
    if (selection === "favorites" || selection === "recents") return null;
    return selection.slice("provider:".length) as ProviderFamily;
  }, [searchActive, selection]);

  const activeRefreshProvider = activeProviderFamily ? refreshProviderForFamily(activeProviderFamily) : null;
  const activeProviderRefreshing = activeRefreshProvider != null && refreshingProvider === activeRefreshProvider;

  const providerTabs = useMemo(() => {
    if (!activeProviderFamily) return [];
    const byKey = new Map<string, { key: string; label: string; models: ModelDescriptor[]; hasAvailable: boolean }>();
    for (const model of candidateModels) {
      const key = modelSubProviderKey(model);
      const label = modelSubProvider(model) || providerLabel(activeProviderFamily);
      const existing = byKey.get(key);
      if (existing) {
        existing.models.push(model);
        existing.hasAvailable = existing.hasAvailable || isAvailable(model.id);
      } else {
        byKey.set(key, { key, label, models: [model], hasAvailable: isAvailable(model.id) });
      }
    }
    return [...byKey.values()];
  }, [activeProviderFamily, candidateModels, isAvailable]);

  const [activeProviderTabKey, setActiveProviderTabKey] = useState<string | null>(null);
  useEffect(() => {
    if (providerTabs.length <= 1) {
      setActiveProviderTabKey(null);
      return;
    }
    setActiveProviderTabKey((current) => {
      if (current && providerTabs.some((tab) => tab.key === current)) return current;
      const activeModel = expandedModels.find((model) => model.id === value);
      const activeKey = activeModel && activeProviderFamily === activeModel.family
        ? modelSubProviderKey(activeModel)
        : null;
      if (activeKey && providerTabs.some((tab) => tab.key === activeKey)) return activeKey;
      return providerTabs.find((tab) => tab.hasAvailable)?.key ?? providerTabs[0]?.key ?? null;
    });
  }, [activeProviderFamily, expandedModels, providerTabs, value]);

  const visibleModels = useMemo<ModelDescriptor[]>(() => {
    if (providerTabs.length <= 1 || !activeProviderTabKey) return candidateModels;
    return providerTabs.find((tab) => tab.key === activeProviderTabKey)?.models ?? candidateModels;
  }, [activeProviderTabKey, candidateModels, providerTabs]);

  const [focusedIndex, setFocusedIndex] = useState(0);
  useEffect(() => {
    setFocusedIndex(0);
  }, [activeProviderTabKey, selection, query]);

  const flatVisibleIds = useMemo(
    () => visibleModels.map((m) => m.id),
    [visibleModels],
  );

  const getVirtualModelKey = useCallback(
    (index: number) => visibleModels[index]?.id ?? index,
    [visibleModels],
  );
  const modelListVirtualizer = useVirtualizer({
    count: visibleModels.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => MODEL_ROW_ESTIMATED_HEIGHT,
    getItemKey: getVirtualModelKey,
    overscan: 8,
  });
  const virtualRows = modelListVirtualizer.getVirtualItems();
  const renderedVirtualRows = virtualRows.length > 0 || visibleModels.length === 0
    ? virtualRows
    : visibleModels.slice(0, 36).map((_, index) => ({
        key: getVirtualModelKey(index),
        index,
        start: index * MODEL_ROW_ESTIMATED_HEIGHT,
      }));
  const virtualListHeight = Math.max(
    modelListVirtualizer.getTotalSize(),
    visibleModels.length * MODEL_ROW_ESTIMATED_HEIGHT,
  );
  useEffect(() => {
    modelListVirtualizer.scrollToIndex(0, { align: "start" });
  }, [activeProviderTabKey, modelListVirtualizer, selection, query]);

  const isAvailableForUse = useCallback(
    (m: ModelDescriptor): boolean => {
      if (!matchesCursorAvailabilityMode(m)) return false;
      if (cursorAvailabilityMode === "cli" && m.family === "cursor" && m.cursorAvailability?.cli === true) {
        return Object.keys(effectiveAuth).length > 0 ? familyIsReady(m.family) : true;
      }
      if (Object.keys(effectiveAuth).length > 0) {
        return familyIsReady(m.family) && isAvailable(m.id);
      }
      return isAvailable(m.id);
    },
    [cursorAvailabilityMode, effectiveAuth, familyIsReady, isAvailable, matchesCursorAvailabilityMode],
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
        setFocusedIndex((i) => {
          const next = Math.min(i + 1, Math.max(0, flatVisibleIds.length - 1));
          modelListVirtualizer.scrollToIndex(next, { align: "auto" });
          return next;
        });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocusedIndex((i) => {
          const next = Math.max(0, i - 1);
          modelListVirtualizer.scrollToIndex(next, { align: "auto" });
          return next;
        });
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
      modelListVirtualizer,
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
      void navigator.clipboard.writeText(modelId).catch(() => {
        // ignore clipboard failures
      });
    } catch {
      // ignore clipboard failures
    }
  }, []);

  const activeModel = useMemo(
    () => expandedModels.find((m) => m.id === value) ?? null,
    [expandedModels, value],
  );

  const isEmpty = visibleModels.length === 0;

  // Show the setup banner only when the active provider rail is unauthed AND
  // the caller has wired a sign-in handler. Auth status of `undefined` (no
  // signal yet) is treated as "not unauthed" so the banner doesn't flash
  // before status loads.
  //
  // Suppress the per-provider banner for opencode/ollama/lmstudio when the
  // OpenCode binary itself is missing — those families render a unified
  // "Install OpenCode" empty state instead.
  const activeFamilyNeedsOpencode =
    activeProviderFamily != null
    && isOpencodeRequiredFamily(activeProviderFamily)
    && opencodeBinaryKnown
    && !opencodeBinaryInstalled;
  const showSetupBanner =
    activeProviderFamily != null
    && onOpenSignIn != null
    && effectiveAuth[activeProviderFamily] === "unauthed"
    && !activeFamilyNeedsOpencode
    && !activeProviderRefreshing;

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
	            {providerTabs.length > 1 ? (
	              <div className="sticky top-0 z-[6] mb-1 flex gap-1 overflow-x-auto border-b border-white/[0.05] bg-[#13111A]/95 px-0.5 pb-1 backdrop-blur">
	                {providerTabs.map((tab) => {
	                  const active = tab.key === activeProviderTabKey;
	                  return (
	                    <button
	                      key={tab.key}
	                      type="button"
	                      className={cn(
	                        "h-6 shrink-0 rounded-md border px-2 text-[10px] font-medium leading-none transition-colors",
	                        active
	                          ? "border-violet-400/30 bg-violet-500/[0.10] text-violet-100"
	                          : "border-white/[0.07] bg-white/[0.02] text-muted-fg/65 hover:border-white/[0.12] hover:text-fg/85",
	                      )}
	                      onClick={() => setActiveProviderTabKey(tab.key)}
	                    >
	                      {tab.label}
	                    </button>
	                  );
	                })}
	              </div>
	            ) : null}

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

            {showSetupBanner && activeProviderFamily ? (
              <ProviderSetupBanner family={activeProviderFamily} onOpenSignIn={onOpenSignIn} />
            ) : null}

            {isEmpty ? (
              <EmptyState
                selection={selection}
                searchActive={searchActive}
                opencodeBinaryInstalled={opencodeBinaryInstalled}
                opencodeBinaryKnown={opencodeBinaryKnown}
                refreshingProvider={activeProviderRefreshing ? activeRefreshProvider : null}
                providerAuthStatus={effectiveAuth}
                {...(onOpenSignIn ? { onOpenSignIn } : {})}
              />
            ) : (
              <div
                data-model-picker-virtual-list="true"
                style={{
                  height: virtualListHeight,
                  position: "relative",
                }}
              >
                {renderedVirtualRows.map((virtualRow) => {
                  const m = visibleModels[virtualRow.index];
                  if (!m) return null;
                  const isFocused = virtualRow.index === focusedIndex;
                  const isActive = m.id === value;
                  return (
                    <div
                      key={virtualRow.key}
                      ref={modelListVirtualizer.measureElement}
                      data-index={virtualRow.index}
                      data-focused={isFocused ? "true" : undefined}
                      className={cn(
                        "absolute left-0 top-0 w-full",
                        isFocused && "outline-none ring-1 ring-violet-400/30 rounded-md",
                      )}
                      style={{
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
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
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
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
  opencodeBinaryInstalled,
  opencodeBinaryKnown,
  refreshingProvider,
  providerAuthStatus,
  onOpenSignIn,
}: {
  selection: RailSelection;
  searchActive: boolean;
  opencodeBinaryInstalled: boolean;
  opencodeBinaryKnown: boolean;
  refreshingProvider?: AgentChatModelCatalogRefreshProvider | null;
  providerAuthStatus?: Partial<Record<ProviderFamily, AuthStatus>>;
  onOpenSignIn?: () => void;
}) {
  if (!searchActive && selection !== "favorites" && selection !== "recents") {
    const family = selection.slice("provider:".length) as ProviderFamily;
    if (
      opencodeBinaryKnown
      && !opencodeBinaryInstalled
      && (family === "opencode" || family === "ollama" || family === "lmstudio")
    ) {
      return (
        <ProviderEmptyState
          mode="opencode-required"
          family={family}
          {...(onOpenSignIn ? { onOpenSignIn } : {})}
        />
      );
    }
    if (refreshingProvider) {
      const label = refreshProviderLabel(refreshingProvider);
      return (
        <div
          data-empty-state-mode="runtime-loading"
          data-refresh-provider={refreshingProvider}
          className="flex h-full min-h-[200px] flex-col items-center justify-center gap-1.5 px-4 py-6 text-center"
        >
          <span className="text-[12px] font-semibold text-fg/80">Checking {label}</span>
          <span className="max-w-[260px] text-[11px] leading-relaxed text-muted-fg/60">
            Loading the cached catalog and refreshing it in the background.
          </span>
        </div>
      );
    }
    return (
      <ProviderEmptyState
        family={family}
        mode={providerIsReady(providerAuthStatus?.[family]) ? "discovery-empty" : "default"}
        {...(onOpenSignIn ? { onOpenSignIn } : {})}
      />
    );
  }
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
