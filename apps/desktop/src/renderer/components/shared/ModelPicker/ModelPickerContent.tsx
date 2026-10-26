import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MagnifyingGlass } from "@phosphor-icons/react";
import {
  MODEL_REGISTRY,
  modelSupportsFastMode,
  type FastTier,
  modelSupportsServiceTier,
  resolveCliProviderForModel,
  type AuthType,
  type ModelDescriptor,
  type ProviderFamily,
} from "../../../../shared/modelRegistry";
import type { CursorCloudServiceTier } from "../../../../shared/types/config";
import {
  MODEL_PICKER_PROVIDER_ORDER,
  type ProviderGroupKey,
} from "../../../../shared/modelCatalog";
import { cn } from "../../ui/cn";
import { POPOVER_SURFACE_CLASS } from "../../ui/paneMenuTokens";
import { cursorProviderAvailable } from "../../../lib/platform";
import { ModelListRow } from "./ModelListRow";
import { isPiRoutedModel, providerLabel, subProviderKey, subProviderLabel } from "./modelFacts";
import { ModelRowLogo, ProviderLogo } from "../ProviderLogos";
import { ModelPickerRail, type RailEntry, type RailSelection, type AuthStatus } from "./ModelPickerRail";
import { ModelPickerEmptyState, ProviderRefreshError } from "./ModelPickerEmptyState";
import { useModelFavorites } from "./useModelFavorites";
import { useModelRecents } from "./useModelRecents";
import { useAuthOnlyFilter } from "./useAuthOnlyFilter";
import { useProviderAuthStatus } from "./useProviderAuthStatus";
import { scoreModelPickerSearch } from "./modelPickerSearch";
import { sortModelItems } from "./modelOrdering";
import { ProviderSetupBanner } from "./providerEmptyState";
import {
  filterFallbackModelsToRuntimeCatalog,
  type RuntimeCatalogModelDescriptor,
} from "./modelCatalog";
import type { AgentChatModelCatalogRefreshProvider, OpenProjectBinding } from "../../../../shared/types";
import { refreshProviderForFamily } from "./runtimeCatalogCache";
import { CustomPickerPane } from "./CustomPickerPane";
import { useSmartBalanceProviders } from "../../settings/providers/accounts/useProviderInstances";
import { isImeComposing } from "../../../lib/imeComposition";

/**
 * The two picker families that map onto a multi-account CLI provider.
 *
 * Only Claude and Codex can hold more than one local login, so only their rails
 * can carry the smart-balance note. Named here rather than derived so an
 * unrelated family can never inherit a sentence about accounts it does not have.
 */
const SMART_BALANCE_FAMILIES: Partial<Record<ProviderFamily, { provider: "claude" | "codex"; label: string }>> = {
  anthropic: { provider: "claude", label: "Claude Code" },
  openai: { provider: "codex", label: "Codex CLI" },
};

/** A row (48px, fixed in ModelListRow) plus its 2px gap. Exact, so rows are never measured. */
const MODEL_ROW_HEIGHT = 50;

// Order matters for rail layout — top-tier providers first, then routers,
// then local runtimes. Listed here (not derived from PROVIDER_LABELS) because
// PROVIDER_LABELS may include experimental entries we don't want surfaced.
// ACP CLI families (Qwen / Kimi / Grok / Copilot) are first-class rails so
// they stay reachable before catalog refresh, same as Cursor and Droid.
const PICKER_FAMILY_BY_GROUP: Record<ProviderGroupKey, ProviderFamily> = {
  claude: "anthropic",
  codex: "openai",
  muse: "muse",
  cursor: "cursor",
  opencode: "opencode",
  pi: "pi",
  copilot: "github-copilot",
  grok: "xai",
  droid: "factory",
  kimi: "moonshot",
  qwen: "qwen",
  devin: "devin",
  antigravity: "antigravity",
  ollama: "ollama",
  lmstudio: "lmstudio",
};

const ALL_PROVIDER_FAMILIES: readonly ProviderFamily[] = MODEL_PICKER_PROVIDER_ORDER.map(
  (groupKey) => PICKER_FAMILY_BY_GROUP[groupKey],
);

function refreshProviderLabel(provider: AgentChatModelCatalogRefreshProvider): string {
  if (provider === "lmstudio") return "LM Studio";
  if (provider === "droid") return "Droid";
  return providerLabel(provider);
}

function providerIsReady(status: AuthStatus | undefined): boolean {
  return status === "ok" || status === "limited";
}

/** Picker grouping follows the selected harness; model.family remains the
 * underlying provider family for capability and logo metadata. */
function pickerFamilyForModel(model: ModelDescriptor): ProviderFamily {
  return isPiRoutedModel(model) ? "pi" : model.family;
}

function providerAuthEstablishesModelAvailability(model: ModelDescriptor): boolean {
  if (isPiRoutedModel(model)) return true;
  const provider = resolveCliProviderForModel(model);
  return provider === "claude"
    || provider === "codex"
    || provider === "muse"
    || provider === "droid"
    || provider === "qwen"
    || provider === "kimi"
    || provider === "grok"
    || provider === "copilot"
    || provider === "antigravity";
}

// The runtime catalog flags a model as requiring configuration when it is
// listed but not usable yet (an unconfigured OpenCode sub-provider, a missing
// API key, etc.). This boolean is precomputed in modelCatalog.ts, so reading it
// here costs nothing on the hot render path — it just makes the annotation
// authoritative for the picker's dim + connect-routing decision.
function modelRequiresConfiguration(model: ModelDescriptor): boolean {
  return (model as RuntimeCatalogModelDescriptor).catalogRequiresConfiguration === true;
}

/**
 * What a picker row hands back.
 *
 * `presetId` is set only by the Custom tab, and it is the picker's own type
 * rather than a chat type: this module can describe "the user picked a saved
 * harness" without the chat contract growing a field before the launch path
 * that reads it exists.
 */
export type ModelPickerSelection = {
  fastMode: boolean;
  serviceTier?: CursorCloudServiceTier | null;
  /** Set when the selection came from a saved harness preset. */
  presetId?: string;
  /**
   * Set when the selection came from a row a stored API key makes reachable.
   * Never set together with `presetId`: a preset already names its own brain.
   */
  credentialId?: string;
  /** Set when the selection came from a Copilot row's context chip. */
  copilotContextTier?: "default" | "long_context";
};

export type ModelPickerContentProps = {
  value: string;
  models: readonly ModelDescriptor[];
  isAvailable: (modelId: string) => boolean;
  providerAuthStatus?: Partial<Record<ProviderFamily, AuthStatus>>;
  onSelect: (modelId: string, options?: ModelPickerSelection) => void;
  onRequestClose: () => void;
  /** Opens Settings › Providers › Custom from the Custom empty state. */
  onOpenHarnessSettings?: () => void;
  /**
   * The runtime catalog bucket this picker reads. Forwarded to the preset rows
   * so a pinned picker names a runtime-only model instead of printing its slug.
   */
  catalogScopeKey?: string;
  onProviderRailSelect?: (family: ProviderFamily) => void;
  /**
   * When true, hide any permission-related rail/picker rows so the user only
   * chooses model + fast-mode + reasoning, because the caller already pins the
   * permission tier.
   *
   * v1 ModelPickerContent does not render permission rows directly — the
   * permission picker lives in `AgentChatComposer.tsx` alongside the model
   * picker — so this flag is a forward-compat hook. It is propagated to
   * children that may render permission-aware affordances (e.g. sign-in
   * rails) so they can elide them when the permission tier is pinned.
   */
  hidePermissionRail?: boolean;
  refreshingProvider?: AgentChatModelCatalogRefreshProvider | null;
  refreshErrorProvider?: AgentChatModelCatalogRefreshProvider | null;
  onOpenSignIn?: (family?: ProviderFamily, authTypes?: readonly AuthType[]) => void;
  hideSignInFamilies?: readonly ProviderFamily[];
  allowCliOnlyModels?: boolean;
  /**
   * Whether this picker offers the Custom rail entry at all.
   *
   * False for a surface launching a tracked CLI. Four of the ten harnesses
   * take no key from the launch, so a preset chosen there would be silently
   * dropped — and offering a choice that is then ignored is worse than not
   * offering it. The launch path enforces the same rule
   * (`shared/harnessPresetCliGate.ts`); this is the half that keeps the user
   * from making the choice in the first place.
   */
  listsHarnessPresets?: boolean;
  /**
   * Whether this picker starts a chat or a tracked CLI. The Custom tab shows
   * in both; in CLI mode the CLIs that take no endpoint from the launch are
   * listed as unavailable with the reason.
   */
  harnessLaunchMode?: "chat" | "cli";
  /** The saved preset or ad-hoc route id the surface runs on, for the Custom tab's highlight. */
  activePresetId?: string | null;
  cursorAvailabilityMode?: "chat" | "cli" | "all";
  allowRegistryExpansion?: boolean;
  registryFilter?: (model: ModelDescriptor) => boolean;
  /**
   * Fast mode is a single bit on the surface, and it belongs to whichever model
   * is selected — so only the selected row ever draws an "on" chip. Without
   * `onFastModeChange` (or `onFastModeLocked` on a locked account) the surface
   * has not opted in and no row shows a fast affordance.
   */
  fastMode?: boolean;
  /** The selected model's Fast tier, when Fast is on. */
  fastTier?: FastTier | null;
  /** The surface can carry Fast's tier; only then do rows offer Ultrafast. */
  ultrafastEnabled?: boolean;
  /**
   * The tier the server last reported for this chat's Fast. Shown on the
   * selected row so a request the server declined or downgraded is visible.
   */
  effectiveFastTier?: string | null;
  onFastModeChange?: (next: boolean, tier?: FastTier) => void;
  /**
   * Set when the account does not allow Fast. The Fast chips still show, but a
   * press that would turn Fast on calls this instead, before anything is
   * selected or recorded as recent.
   */
  onFastModeLocked?: () => void;
  /** Why Fast cannot run with the selected model's other picks; shown on its chip. */
  fastModeUnavailableReason?: string | null;
  serviceTierMode?: boolean;
  serviceTier?: CursorCloudServiceTier | null;
  onServiceTierChange?: (modelId: string, next: CursorCloudServiceTier | null) => void;
  copilotContextTier?: "default" | "long_context";
  onCopilotContextTierChange?: (modelId: string, next: "default" | "long_context") => void;
  /** Prompt-box / chat machine for OpenCode-installed and auth probes. */
  runtimePin?: OpenProjectBinding | null;
};

export const ModelPickerContent = memo(function ModelPickerContent({
  value,
  models,
  isAvailable,
  providerAuthStatus,
  onSelect,
  onRequestClose,
  onOpenHarnessSettings,
  catalogScopeKey,
  onProviderRailSelect,
  refreshingProvider,
  refreshErrorProvider,
  onOpenSignIn,
  hideSignInFamilies,
  hidePermissionRail = false,
  allowCliOnlyModels = false,
  listsHarnessPresets = true,
  harnessLaunchMode = allowCliOnlyModels ? "cli" : "chat",
  activePresetId = null,
  cursorAvailabilityMode = allowCliOnlyModels ? "cli" : "chat",
  allowRegistryExpansion = true,
  registryFilter,
  fastMode = false,
  onFastModeChange,
  onFastModeLocked,
  fastTier = null,
  ultrafastEnabled = false,
  effectiveFastTier = null,
  fastModeUnavailableReason = null,
  serviceTierMode = false,
  serviceTier = null,
  onServiceTierChange,
  copilotContextTier = "default",
  onCopilotContextTierChange,
  runtimePin = null,
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
  const hasExternalAuthStatus = Boolean(providerAuthStatus && Object.keys(providerAuthStatus).length > 0);
  const internalAuth = useProviderAuthStatus({
    loadStatus: !hasExternalAuthStatus,
    ...(allowCliOnlyModels ? { allowCliOnlyModels: true } : {}),
    ...(runtimePin ? { runtimePin } : {}),
  });

  const recentSet = useMemo(() => new Set(recents), [recents]);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);

  const effectiveAuth = useMemo<Partial<Record<ProviderFamily, AuthStatus>>>(() => {
    if (hasExternalAuthStatus) {
      return providerAuthStatus ?? internalAuth.status;
    }
    return internalAuth.status;
  }, [hasExternalAuthStatus, providerAuthStatus, internalAuth.status]);

  // The cheap binary probe answers "is OpenCode installed?" in ms (separate
  // from the slow full getStatus probe). Until that lands we don't render
  // the OpenCode-required empty state — we just show an empty list so we
  // don't make a false "OpenCode needed" claim during the brief unknown
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
    if (!allowRegistryExpansion) return models;
    const merged = new Map<string, ModelDescriptor>();
    for (const m of models) merged.set(m.id, m);
    for (const m of MODEL_REGISTRY) {
      if (m.deprecated) continue;
      if (registryFilter && !registryFilter(m)) continue;
      if (
        authOnly
        && !(providerAuthEstablishesModelAvailability(m) && familyIsReady(pickerFamilyForModel(m)))
      ) {
        continue;
      }
      if (!merged.has(m.id)) merged.set(m.id, m);
    }
    const runtimeCatalogModels = models.filter(
      (model): model is RuntimeCatalogModelDescriptor =>
        (model as RuntimeCatalogModelDescriptor).catalogAvailable === true,
    );
    return filterFallbackModelsToRuntimeCatalog([...merged.values()], runtimeCatalogModels);
  }, [allowRegistryExpansion, authOnly, familyIsReady, models, registryFilter]);

  const providersPresent = useMemo<ProviderFamily[]>(() => {
    // Cursor drops out of the rail on Windows on ARM, where @cursor/sdk has no
    // build — otherwise the rail would offer a provider that can never load.
    // See shared/providerPlatformSupport.ts.
    const families = cursorProviderAvailable()
      ? ALL_PROVIDER_FAMILIES
      : ALL_PROVIDER_FAMILIES.filter((family) => family !== "cursor");
    const set = new Set<ProviderFamily>();
    for (const m of expandedModels) {
      const pickerFamily = pickerFamilyForModel(m);
      if (pickerFamily === "cursor" && !cursorProviderAvailable()) continue;
      set.add(pickerFamily);
    }
    // Always include first-class provider families (Cursor, Droid, ACP CLIs,
    // OpenCode, local runtimes). Their models may not exist until a catalog
    // refresh runs, but the rail entry must still be reachable without
    // toggling "Show all models".
    for (const family of families) set.add(family);
    // Stabilize rail order so it doesn't flicker as catalog discovery streams in.
    return families.filter((family) => set.has(family))
      .concat([...set].filter((family) => !families.includes(family)));
  }, [expandedModels]);

  const railEntries = useMemo<RailEntry[]>(() => {
    const out: RailEntry[] = [
      ...(listsHarnessPresets ? [{ kind: "harnesses" } as RailEntry] : []),
      { kind: "favorites" },
      { kind: "recents" },
    ];
    for (const family of providersPresent) {
      out.push({ kind: "provider", family, label: providerLabel(family) });
    }
    return out;
  }, [listsHarnessPresets, providersPresent]);

  const initialSelectionRef = useRef<RailSelection | null>(null);
  if (initialSelectionRef.current == null) {
    if (recents.length > 0) {
      initialSelectionRef.current = "recents";
    } else {
      const activeModel = expandedModels.find((m) => m.id === value);
      initialSelectionRef.current = activeModel
        ? `provider:${pickerFamilyForModel(activeModel)}`
        : providersPresent[0]
          ? `provider:${providersPresent[0]}`
          : "favorites";
    }
  }
  const [selection, setSelection] = useState<RailSelection>(initialSelectionRef.current);

  // Focus after the first paint, not in a layout effect: focusing forces a
  // style and layout pass, and on mount the popover has not been placed yet,
  // so it ran a second, wasted pass before the panel could appear.
  useEffect(() => {
    const frame = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  const handleSelectRail = useCallback((next: RailSelection) => {
    if (next !== "favorites" && next !== "recents" && next !== "harnesses") {
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
      // hide them so the panes surface the "OpenCode needed" empty state.
      // While the probe is still in-flight (binaryKnown === false) we don't
      // hide anything — the alternative would flash "OpenCode needed" briefly
      // for users who do have it.
      if (opencodeBinaryKnown && !opencodeBinaryInstalled && isOpencodeRequiredFamily(pickerFamilyForModel(m))) {
        return false;
      }
      if (!matchesCursorAvailabilityMode(m)) return false;
      if (!authOnly) return true;
      if (modelRequiresConfiguration(m)) return false;
      // Prefer auth-derived gate; fall back to caller-provided `isAvailable` if no auth signal exists.
      if (Object.keys(effectiveAuth).length > 0) {
        return familyIsReady(pickerFamilyForModel(m));
      }
      return isAvailable(m.id);
    },
    [authOnly, effectiveAuth, familyIsReady, isAvailable, isOpencodeRequiredFamily, matchesCursorAvailabilityMode, opencodeBinaryInstalled, opencodeBinaryKnown],
  );

  const searchActive = query.trim().length > 0;
  const harnessesActive = listsHarnessPresets && selection === "harnesses";

  // The Custom tab searches its own lists (saved providers and what the Run-in
  // harness can reach): the box in front of you filters the list you are
  // looking at, which is the only behaviour that does not require explaining.
  const handleCustomSelect = useCallback(
    (modelId: string, presetId: string | undefined) => {
      onSelect(modelId, presetId ? { fastMode: false, presetId } : { fastMode: false });
    },
    [onSelect],
  );

  const toSearchItem = useCallback(
    (m: ModelDescriptor) => ({
      name: m.displayName,
      shortName: m.shortId,
      aliases: m.aliases,
      subProvider: subProviderLabel(m) ?? undefined,
      family: pickerFamilyForModel(m),
      providerDisplayName: providerLabel(pickerFamilyForModel(m)),
      isFavorite: favoriteSet.has(m.id),
    }),
    [favoriteSet],
  );

  const candidateModels = useMemo<ModelDescriptor[]>(() => {
    let pool: ModelDescriptor[] = [];
    if (harnessesActive) return pool;
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
      pool = expandedModels.filter((m) => pickerFamilyForModel(m) === family).filter(filterAvailable);
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
    harnessesActive,
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
    if (selection === "favorites" || selection === "recents" || selection === "harnesses") return null;
    return selection.slice("provider:".length) as ProviderFamily;
  }, [searchActive, selection]);

  // A fresh picker can open directly on a provider selected by the persisted
  // draft model. Refresh that provider once on mount so the first list is based
  // on the current ACP verdict, not yesterday's curated fallback rows.
  const initialProviderRefreshRequestedRef = useRef(false);
  useEffect(() => {
    if (initialProviderRefreshRequestedRef.current) return;
    initialProviderRefreshRequestedRef.current = true;
    if (activeProviderFamily) onProviderRailSelect?.(activeProviderFamily);
  }, [activeProviderFamily, onProviderRailSelect]);

  const activeRefreshProvider = activeProviderFamily ? refreshProviderForFamily(activeProviderFamily) : null;
  const activeProviderRefreshing = activeRefreshProvider != null && refreshingProvider === activeRefreshProvider;
  const activeProviderRefreshFailed = activeRefreshProvider != null && refreshErrorProvider === activeRefreshProvider;

  const providerTabs = useMemo(() => {
    if (!activeProviderFamily) return [];
    const byKey = new Map<string, { key: string; label: string; models: ModelDescriptor[]; hasAvailable: boolean }>();
    for (const model of candidateModels) {
      const key = subProviderKey(model);
      const label = subProviderLabel(model) || providerLabel(activeProviderFamily);
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
      const activeKey = activeModel && activeProviderFamily === pickerFamilyForModel(activeModel)
        ? subProviderKey(activeModel)
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
  const focusRowOnNextRenderRef = useRef(false);
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
    estimateSize: () => MODEL_ROW_HEIGHT,
    getItemKey: getVirtualModelKey,
    // The list shows about seven rows. Every rendered row is restyled each
    // time the popover is positioned as it opens, so keep the margin small.
    overscan: 4,
  });
  const virtualRows = modelListVirtualizer.getVirtualItems();
  const renderedVirtualRows = virtualRows.length > 0 || visibleModels.length === 0
    ? virtualRows
    // Before the scroller has a height: one screen of rows, not a long list
    // that is thrown away a frame later.
    : visibleModels.slice(0, 10).map((_, index) => ({
        key: getVirtualModelKey(index),
        index,
        start: index * MODEL_ROW_HEIGHT,
      }));
  const virtualListHeight = Math.max(
    modelListVirtualizer.getTotalSize(),
    visibleModels.length * MODEL_ROW_HEIGHT,
  );
  useEffect(() => {
    modelListVirtualizer.scrollToIndex(0, { align: "start" });
  }, [activeProviderTabKey, modelListVirtualizer, selection, query]);

  useLayoutEffect(() => {
    if (!focusRowOnNextRenderRef.current) return;
    const model = visibleModels[focusedIndex];
    if (!model) {
      focusRowOnNextRenderRef.current = false;
      return;
    }
    const row = listRef.current?.querySelector<HTMLElement>(
      // An attribute selector: an encoded id ("%2F") is not a valid `#id`.
      `[id="model-picker-row-${encodeURIComponent(model.id)}"]`,
    );
    if (!row) {
      focusRowOnNextRenderRef.current = false;
      return;
    }
    row.focus();
    focusRowOnNextRenderRef.current = false;
  }, [focusedIndex, renderedVirtualRows, visibleModels]);

  const isAvailableForUse = useCallback(
    (m: ModelDescriptor): boolean => {
      if (!matchesCursorAvailabilityMode(m)) return false;
      // A configuration-gated model is never directly selectable — the row
      // dims and its click routes to the connect affordance instead. This
      // overrides the family-ready shortcut below, which would otherwise mark
      // a gated Claude/Codex/Droid model available just because its provider
      // family is authed.
      if (modelRequiresConfiguration(m)) return false;
      if (cursorAvailabilityMode === "cli" && pickerFamilyForModel(m) === "cursor" && m.cursorAvailability?.cli === true) {
        return Object.keys(effectiveAuth).length > 0 ? familyIsReady(pickerFamilyForModel(m)) : true;
      }
      if (Object.keys(effectiveAuth).length > 0) {
        if (providerAuthEstablishesModelAvailability(m)) return familyIsReady(pickerFamilyForModel(m));
        return familyIsReady(pickerFamilyForModel(m)) && isAvailable(m.id);
      }
      return isAvailable(m.id);
    },
    [cursorAvailabilityMode, effectiveAuth, familyIsReady, isAvailable, matchesCursorAvailabilityMode],
  );

  const handleRowSelect = useCallback(
    (modelId: string) => {
      recordUsage(modelId);
      // A row a stored key makes reachable hands its credential back with the
      // model id. Without it the launch would find the model but not the
      // endpoint it is served from.
      const credentialId = expandedModels
        .find((entry) => entry.id === modelId)?.credentialId?.trim();
      onSelect(modelId, credentialId ? { fastMode: false, credentialId } : undefined);
    },
    [expandedModels, onSelect, recordUsage],
  );

  /**
   * Arrow keys on the harnesses tab.
   *
   * The model list's arrow handling walks `visibleModels`, which is empty here
   * — so before this the tab answered nothing at all to ArrowUp/ArrowDown and
   * a preset could only be reached by tabbing past every control above it.
   * Roving focus over the rendered rows keeps the keyboard contract the same
   * on both tabs; Enter is then the button's own activation, and
   * ArrowRight/ArrowLeft open and close the details the row hides.
   */
  const handleHarnessListKeyDown = useCallback(
    (event: React.KeyboardEvent): boolean => {
      const container = listRef.current;
      if (!container) return false;
      const rows = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "[data-harness-preset-select]:not([aria-disabled='true']), [data-reachable-select]:not(:disabled)",
        ),
      );
      if (rows.length === 0) return false;
      const active = document.activeElement as HTMLElement | null;
      const current = rows.findIndex((row) => row === active || row.contains(active));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = event.key === "ArrowDown"
          ? Math.min(current + 1, rows.length - 1)
          : current <= 0 ? 0 : current - 1;
        rows[next]?.focus();
        return true;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        (event.key === "Home" ? rows[0] : rows[rows.length - 1])?.focus();
        return true;
      }
      if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && current >= 0) {
        const presetId = rows[current]?.getAttribute("data-harness-preset-select");
        const toggle = presetId
          ? container.querySelector<HTMLButtonElement>(`[data-harness-preset-expand="${presetId}"]`)
          : null;
        if (!toggle) return false;
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        if (expanded === (event.key === "ArrowRight")) return true;
        event.preventDefault();
        toggle.click();
        return true;
      }
      return false;
    },
    [],
  );

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (isImeComposing(event)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onRequestClose();
        return;
      }
      if (harnessesActive) {
        if (handleHarnessListKeyDown(event)) return;
        // Enter on a focused Custom row is that button's own activation; the
        // model list's Enter handling below would swallow it.
        if (event.key === "Enter") return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusRowOnNextRenderRef.current = true;
        setFocusedIndex((i) => {
          const next = Math.min(i + 1, Math.max(0, flatVisibleIds.length - 1));
          modelListVirtualizer.scrollToIndex(next, { align: "auto" });
          return next;
        });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusRowOnNextRenderRef.current = true;
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
          const family = pickerFamilyForModel(target);
          if (!hideSignInFamilies?.includes(family)) onOpenSignIn?.(family, target.authTypes);
          return;
        }
        handleRowSelect(target.id);
      }
    },
    [
      flatVisibleIds,
      focusedIndex,
      handleRowSelect,
      isAvailableForUse,
      modelListVirtualizer,
      onOpenSignIn,
      hideSignInFamilies,
      onRequestClose,
      visibleModels,
      harnessesActive,
      handleHarnessListKeyDown,
    ],
  );

  const handleProviderTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (!(event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")) return;
    event.preventDefault();
    event.stopPropagation();
    const tabs = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[data-model-picker-provider-tab]") ?? [],
    );
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex < 0 || tabs.length === 0) return;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : Math.min(
            Math.max(0, currentIndex + (event.key === "ArrowRight" ? 1 : -1)),
            tabs.length - 1,
          );
    const next = providerTabs[nextIndex];
    if (!next) return;
    setActiveProviderTabKey(next.key);
    tabs[nextIndex]?.focus();
  }, [providerTabs]);

  /**
   * One press on a non-selected row's chip means "use this model, fast" — it
   * commits the selection and turns fast on. On the selected row it is a plain
   * toggle that leaves both the selection and the open popover alone. On a
   * locked account a press that would turn Fast on calls `onFastModeLocked`
   * instead, after the sign-in check and before anything is selected.
   */
  const handleFastChipChange = useCallback(
    (modelId: string, next: boolean, tier?: FastTier) => {
      const model = expandedModels.find((m) => m.id === modelId);
      if (!model || !modelSupportsFastMode(model)) return;
      if (modelId === value && !onFastModeLocked) {
        // Fast-only callers keep the one-argument call they always got.
        if (next && tier === "ultrafast") onFastModeChange?.(true, "ultrafast");
        else onFastModeChange?.(next);
        return;
      }
      if (!isAvailableForUse(model)) {
        const family = pickerFamilyForModel(model);
        if (!hideSignInFamilies?.includes(family)) onOpenSignIn?.(family, model.authTypes);
        return;
      }
      if (onFastModeLocked) {
        if (next) onFastModeLocked();
        return;
      }
      recordUsage(modelId);
      // Model + service tier are one selection. Emitting a single change keeps
      // controlled consumers from rebuilding two patches from the same render.
      onSelect(modelId, { fastMode: true });
    },
    [expandedModels, hideSignInFamilies, isAvailableForUse, onFastModeChange, onFastModeLocked, onOpenSignIn, onSelect, recordUsage, value],
  );

  /**
   * Same rule as the fast chip: on the selected row the context chip toggles
   * the tier; on any other row it picks that model with the tier it shows next.
   */
  const handleCopilotContextTierChange = useCallback(
    (modelId: string, next: "default" | "long_context") => {
      const model = expandedModels.find((m) => m.id === modelId);
      if (!model) return;
      if (modelId === value) {
        onCopilotContextTierChange?.(modelId, next);
        return;
      }
      if (!isAvailableForUse(model)) {
        const family = pickerFamilyForModel(model);
        if (!hideSignInFamilies?.includes(family)) onOpenSignIn?.(family, model.authTypes);
        return;
      }
      recordUsage(modelId);
      onSelect(modelId, { fastMode: false, copilotContextTier: next });
    },
    [expandedModels, hideSignInFamilies, isAvailableForUse, onCopilotContextTierChange, onOpenSignIn, onSelect, recordUsage, value],
  );

  const handleServiceTierChange = useCallback(
    (modelId: string, next: CursorCloudServiceTier | null) => {
      const model = expandedModels.find((entry) => entry.id === modelId);
      if (!model) return;
      if (next === "fast" && !modelSupportsServiceTier(model, "fast")) return;
      if (next === "standard" && !modelSupportsServiceTier(model, "standard")) return;
      if (!isAvailableForUse(model)) {
        const family = pickerFamilyForModel(model);
        if (!hideSignInFamilies?.includes(family)) onOpenSignIn?.(family, model.authTypes);
        return;
      }
      if (next === "fast" && onFastModeLocked) {
        onFastModeLocked();
        return;
      }
      recordUsage(modelId);
      if (modelId === value) {
        onServiceTierChange?.(modelId, next);
      } else {
        onSelect(modelId, { fastMode: next === "fast", serviceTier: next });
      }
    },
    [expandedModels, hideSignInFamilies, isAvailableForUse, onFastModeLocked, onOpenSignIn, onSelect, onServiceTierChange, recordUsage, value],
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

  // Inside a provider's rail its own name is the panel title, so a row whose
  // family is that provider drops it. A row from another maker routed through
  // the rail (an OpenAI model in Pi) keeps its maker. Search, Favorites and
  // Recents mix providers and keep it everywhere.
  const providerScopedList = !searchActive && selection.startsWith("provider:");

  // The raised list panel names what it shows, so the rail's icon-only tabs
  // never leave you guessing which provider you are looking at.
  const panelLabel = searchActive && !harnessesActive
    ? `${visibleModels.length} ${visibleModels.length === 1 ? "result" : "results"}`
    : selection === "harnesses"
      ? "Custom"
      : selection === "favorites"
        ? "Favorites"
        : selection === "recents"
          ? "Recents"
          : providerLabel(selection.slice("provider:".length));

  // Show the setup banner only when the active provider rail is unauthed AND
  // the caller has wired a sign-in handler. Auth status of `undefined` (no
  // signal yet) is treated as "not unauthed" so the banner doesn't flash
  // before status loads.
  //
  // Suppress the per-provider banner for opencode/ollama/lmstudio when the
  // OpenCode binary itself is missing — those families render a unified
  // "OpenCode needed" empty state instead.
  const activeFamilyNeedsOpencode =
    activeProviderFamily != null
    && isOpencodeRequiredFamily(activeProviderFamily)
    && opencodeBinaryKnown
    && !opencodeBinaryInstalled;
  const showSetupBanner =
    activeProviderFamily != null
    && onOpenSignIn != null
    && effectiveAuth[activeProviderFamily] === "unauthed"
    && !hideSignInFamilies?.includes(activeProviderFamily)
    && !activeFamilyNeedsOpencode
    && !activeProviderRefreshFailed
    && !activeProviderRefreshing;

  // Which providers are spreading new chats across their accounts. Read once
  // per mount; the setting only changes from Settings, which is not open at the
  // same time as the picker.
  const smartBalanceProviders = useSmartBalanceProviders();
  const smartBalanceFamily = activeProviderFamily ? SMART_BALANCE_FAMILIES[activeProviderFamily] : undefined;
  const smartBalanceNote =
    smartBalanceFamily && smartBalanceProviders.has(smartBalanceFamily.provider)
      ? `Smart balance is on for ${smartBalanceFamily.label}`
      : null;

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
        // Capped to the room Radix measured beside the trigger, so a short
        // window (a laptop browser tab) shrinks the body instead of running it
        // off the bottom of the viewport. Outside a popover the variable is
        // unset and the viewport is the cap.
        "flex max-h-[var(--radix-popover-content-available-height,100vh)] w-[460px] max-w-[calc(100vw-32px)] flex-col overflow-hidden",
        POPOVER_SURFACE_CLASS,
      )}
      onKeyDown={handleListKeyDown}
    >
      {/* The rail and the search bar share one recessed L; the list sits on a
          raised panel cut into it, so the eye lands on the models first. */}
      <div className="flex h-[400px] min-h-[160px] shrink bg-black/[0.2]">
        <ModelPickerRail
          entries={railEntries}
          selected={selection}
          onSelect={handleSelectRail}
          providerAuthStatus={effectiveAuth}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 pl-2 pr-2.5">
            <MagnifyingGlass size={14} className="shrink-0 text-muted-fg/60" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={harnessesActive ? "Search custom..." : "Search models..."}
              aria-label={harnessesActive ? "Search custom setups" : "Search models"}
              className={cn(
                "min-w-0 flex-1 bg-transparent text-[13px] leading-tight tracking-tight",
                // The field is auto-focused on open, which is right — you opened
                // it to search. The focus *ring* is the part that reads as an
                // error box around the whole row, so suppress the shadow-based
                // ring too; `outline-none` alone does not cover it.
                "text-fg placeholder:text-muted-fg/45 outline-none focus:outline-none focus-visible:outline-none",
                "shadow-none focus:shadow-none focus-visible:shadow-none focus:ring-0 focus-visible:ring-0",
                // The global `input:focus` rule paints an accent border and ring
                // and out-specifies utilities; this field sits in a bar that is
                // already the focus affordance.
                "border-0 focus:border-transparent! focus:shadow-none! transition-none!",
              )}
            />
            {/* The harnesses tab lists saved presets, not the model catalog, so
                the catalog's auth filter has nothing to act on there. Leaving a
                live switch that changes nothing is the kind of dead control
                that makes a user doubt the rest of the panel. */}
            {harnessesActive ? null : (
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
                "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[10px] font-medium leading-none transition-colors",
                !authOnly
                  ? "border-violet-400/30 bg-violet-500/[0.10] text-violet-100"
                  : "border-fg/[0.08] bg-fg/[0.02] text-muted-fg/70 hover:border-fg/[0.12] hover:text-fg/85",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "relative inline-block h-3 w-5 rounded-full transition-colors",
                  !authOnly ? "bg-violet-400/70" : "bg-fg/[0.10]",
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
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-tl-xl bg-(color:--work-popover-bg) shadow-[inset_1px_1px_0_rgba(255,255,255,0.05)]">
          <div
            className="flex shrink-0 items-center px-3.5 pb-1 pt-2.5 font-mono text-[10.5px] leading-none text-muted-fg/60"
            data-model-picker-panel-label="true"
          >
            <span className="truncate">{panelLabel}</span>
          </div>

	          {providerTabs.length > 1 ? (
	            <div
              role="group"
              aria-label={activeProviderFamily === "pi" ? "Pi providers" : "Provider sources"}
	              className="flex shrink-0 gap-1 overflow-x-auto px-3 pb-1.5 pt-1 [scrollbar-width:none]"
	            >
	              {providerTabs.map((tab) => {
	                const active = tab.key === activeProviderTabKey;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    data-model-picker-provider-tab="true"
                    aria-pressed={active}
                    tabIndex={active ? 0 : -1}
                    className={cn(
                      "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border pl-2 pr-2.5 text-[10px] font-medium leading-none transition-colors",
                      active
                        ? "border-violet-400/30 bg-violet-500/[0.10] text-violet-100"
                        : "border-fg/[0.07] bg-fg/[0.02] text-muted-fg/65 hover:border-fg/[0.12] hover:text-fg/85",
                    )}
                    onClick={() => setActiveProviderTabKey(tab.key)}
                    onKeyDown={handleProviderTabKeyDown}
                  >
                    <ProviderTabLogo tabKey={tab.key} model={tab.models[0]} />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* One muted line, and nothing else: the picker still lists every
              model and still honours an explicit pick. This only says which
              account a new chat would start on. */}
          {smartBalanceNote ? (
            <div className="shrink-0 px-3.5 pb-1 text-[10px] leading-tight text-muted-fg/60">
              {smartBalanceNote}
            </div>
          ) : null}

	          <div
	            ref={listRef}
	            id="model-picker-model-list"
            role="listbox"
	            aria-label={harnessesActive ? "Custom" : "Models"}
	            aria-busy={activeProviderRefreshing || undefined}
	            className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5 [scrollbar-width:thin]"
	          >

	            {harnessesActive ? (
              <CustomPickerPane
                query={query}
                value={value}
                activePresetId={activePresetId}
                mode={harnessLaunchMode}
                {...(catalogScopeKey ? { catalogScopeKey } : {})}
                onSelect={handleCustomSelect}
                {...(onOpenHarnessSettings ? { onOpenHarnessSettings } : {})}
              />
            ) : (
              <>
	            {activeOutOfView && activeModel ? (
              <div
                className={cn(
                  "sticky top-0 z-[5] mx-0.5 mb-1 rounded-lg border border-fg/[0.08] bg-(color:--work-popover-bg) px-2.5 py-1 shadow-[0_4px_12px_rgba(0,0,0,0.25)]",
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

            {activeProviderRefreshFailed && activeRefreshProvider && !isEmpty ? (
              <ProviderRefreshError
                provider={activeRefreshProvider}
                onRetry={activeProviderFamily && onProviderRailSelect
                  ? () => onProviderRailSelect(activeProviderFamily)
                  : undefined}
                getProviderLabel={refreshProviderLabel}
              />
            ) : null}

            {isEmpty ? (
              <ModelPickerEmptyState
                selection={selection}
                searchActive={searchActive}
                opencodeBinaryInstalled={opencodeBinaryInstalled}
                opencodeBinaryKnown={opencodeBinaryKnown}
                refreshingProvider={activeProviderRefreshing ? activeRefreshProvider : null}
                refreshErrorProvider={activeProviderRefreshFailed ? activeRefreshProvider : null}
                onRetryRefresh={activeProviderFamily && onProviderRailSelect
                  ? () => onProviderRailSelect(activeProviderFamily)
                  : undefined}
                providerAuthStatus={effectiveAuth}
                getProviderLabel={refreshProviderLabel}
                isProviderReady={providerIsReady}
                {...(onOpenSignIn
                  && (!activeProviderFamily || !hideSignInFamilies?.includes(activeProviderFamily))
                  ? { onOpenSignIn }
                  : {})}
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
                        data-index={virtualRow.index}
                        data-focused={isFocused ? "true" : undefined}
                      className={cn(
                        "absolute left-0 top-0 w-full",
                        "pb-0.5",
                        isFocused && "outline-none [&>[role=option]:not([data-active])]:bg-fg/[0.04]",
                      )}
                      style={{
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <ModelListRow
                        model={m}
                        isFavorite={isFavorite(m.id)}
                        isActive={isActive}
                        isFocused={isFocused}
                        isAvailable={isAvailableForUse(m)}
                        onSelect={handleRowSelect}
                        onToggleFavorite={toggleFavorite}
                        onFocus={() => setFocusedIndex(virtualRow.index)}
                        onCopyId={handleCopyId}
                        fastModeOn={!serviceTierMode && fastMode && isActive}
                        fastTier={isActive ? fastTier : null}
                        ultrafastEnabled={ultrafastEnabled}
                        effectiveFastTier={effectiveFastTier}
                        {...(!serviceTierMode && (onFastModeChange || onFastModeLocked) ? { onFastModeChange: handleFastChipChange } : {})}
                        {...(isActive && fastModeUnavailableReason ? { fastUnavailableReason: fastModeUnavailableReason } : {})}
                        {...(serviceTierMode ? {
                          serviceTierMode: true,
                          serviceTier: isActive ? serviceTier : null,
                          onServiceTierChange: handleServiceTierChange,
                        } : {})}
                        {...(onCopilotContextTierChange ? {
                          copilotContextTier: isActive ? copilotContextTier : "default",
                          onCopilotContextTierChange: handleCopilotContextTierChange,
                        } : {})}
                        omitProviderInDetail={providerScopedList && m.family === activeProviderFamily}
                        {...(onOpenSignIn && !hideSignInFamilies?.includes(pickerFamilyForModel(m))
                          ? { onSignIn: () => onOpenSignIn(pickerFamilyForModel(m), m.authTypes) }
                          : {})}
                      />
                    </div>
                  );
                })}
              </div>
            )}
              </>
            )}
          </div>
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * The maker's mark on a sub-provider tab ("Anthropic (via Cursor)" gets the
 * Claude mark, "Cursor Composer" the Cursor one). Taken from the tab's first
 * model, which shares the tab's maker by construction; a catch-all group mixes
 * makers, so it gets no mark rather than a misleading one.
 */
const ProviderTabLogo = memo(function ProviderTabLogo({
  tabKey,
  model,
}: {
  tabKey: string;
  model: ModelDescriptor | undefined;
}) {
  if (!model || /(^|[:/])other$/i.test(tabKey)) return null;
  if (isPiRoutedModel(model) && model.piProviderId) {
    return <ProviderLogo family={model.piProviderId} size={12} className="shrink-0" />;
  }
  return (
    <ModelRowLogo
      modelFamily={model.family}
      cliCommand={model.cliCommand}
      modelId={model.id}
      providerModelId={model.providerModelId}
      {...(model.openCodeProviderId ? { openCodeProviderId: model.openCodeProviderId } : {})}
      size={12}
      className="shrink-0"
    />
  );
});

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}
