import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createDynamicOpenCodeModelDescriptor,
  LOCAL_PROVIDER_LABELS,
  MODEL_REGISTRY,
  getLocalModelIdTail,
  parseDynamicOpenCodeModelRef,
  parseLocalProviderFromModelId,
  resolveModelDescriptor,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { Check, Cpu, MagnifyingGlass } from "@phosphor-icons/react";
import { ModelRowLogo, ProviderLogo } from "./ProviderLogos";
import {
  buildProviderGroupBlocks,
  classifyProviderGroup,
  createModelOrderMap,
  matchesQuery,
  PROVIDER_BADGE_COLORS,
  PROVIDER_CATEGORY_LABELS,
  PROVIDER_GROUP_COLORS,
  providerGroupLabel,
  providerLabel,
  sortOpenCodeProvidersByCategory,
  subsectionKeyForModel,
  type ModelProviderBlock,
  type ModelProviderGroupBlock,
  type ModelSubsection,
  type ProviderCategory,
  type ProviderGroupKey,
} from "./providerModelSelectorGrouping";

const GROUP_KEYS: ProviderGroupKey[] = ["claude", "codex", "cursor", "opencode"];

function rgbaFromHex(hex: string, alpha: number): string {
  const n = hex.replace("#", "").trim();
  if (n.length !== 6) return `rgba(167,139,250,${alpha})`;
  const r = Number.parseInt(n.slice(0, 2), 16);
  const g = Number.parseInt(n.slice(2, 4), 16);
  const b = Number.parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function providerAccent(family: string, fallback?: string): string {
  return PROVIDER_BADGE_COLORS[family] ?? fallback ?? "#A78BFA";
}

function subsectionTabTitle(sub: ModelSubsection): string {
  return sub.label.trim() || "Models";
}

function modelAvailabilityLabel(model: ModelDescriptor, isAvailable: boolean): string {
  if (isAvailable) {
    if (model.family === "cursor" && model.isCliWrapped) return "Cursor ready";
    if (model.isCliWrapped && model.cliCommand === "claude") return "Claude ready";
    if (model.isCliWrapped && model.cliCommand === "codex") return "Codex ready";
    if (model.authTypes.includes("local")) return `${providerLabel(model.family)} ready`;
    if (model.authTypes.includes("api-key")) return "OpenCode · API ready";
    if (model.authTypes.includes("oauth")) return "OpenCode ready";
    if (model.authTypes.includes("openrouter")) return "OpenCode · OpenRouter ready";
    return "Ready";
  }
  if (model.family === "cursor" && model.isCliWrapped) {
    return "Cursor · run `agent login` or set CURSOR_API_KEY / CURSOR_AUTH_TOKEN";
  }
  if (model.isCliWrapped && model.cliCommand === "claude") return "Claude · not configured";
  if (model.isCliWrapped && model.cliCommand === "codex") return "Codex · not configured";
  if (model.isCliWrapped) return "CLI · not configured";
  if (model.authTypes.includes("local")) return `OpenCode · ${providerLabel(model.family)} not configured`;
  if (model.authTypes.includes("api-key")) return "OpenCode · API key not configured";
  if (model.authTypes.includes("oauth")) return "OpenCode · not configured";
  if (model.authTypes.includes("openrouter")) return "OpenCode · OpenRouter not configured";
  return "Not configured";
}

export function createUnknownModelPlaceholder(modelId: string): ModelDescriptor {
  console.warn(`[ModelCatalogPanel] Unknown model ID "${modelId}" — not found in registry. Creating placeholder.`);
  const openCode = parseDynamicOpenCodeModelRef(modelId);
  if (openCode) {
    return createDynamicOpenCodeModelDescriptor(openCode.modelId);
  }
  const cursorCli = modelId.startsWith("cursor/");
  if (cursorCli) {
    const tail = modelId.slice("cursor/".length);
    return {
      id: modelId,
      shortId: tail || modelId,
      displayName: tail || modelId,
      family: "cursor",
      authTypes: ["cli-subscription"],
      contextWindow: 0,
      maxOutputTokens: 0,
      capabilities: { tools: true, vision: false, reasoning: false, streaming: true },
      color: "#A78BFA",
      providerRoute: "cursor-cli",
      providerModelId: tail || modelId,
      cliCommand: "cursor",
      isCliWrapped: true,
    };
  }
  const localProvider = parseLocalProviderFromModelId(modelId);
  if (localProvider) {
    const shortId = getLocalModelIdTail(modelId, localProvider) || modelId;
    const brand = LOCAL_PROVIDER_LABELS[localProvider];
    return {
      id: modelId,
      shortId,
      displayName: shortId,
      family: localProvider,
      authTypes: ["local"],
      contextWindow: 0,
      maxOutputTokens: 0,
      capabilities: { tools: false, vision: false, reasoning: false, streaming: true },
      color: PROVIDER_BADGE_COLORS[localProvider] ?? "#64748B",
      providerRoute: "openai-compatible",
      providerModelId: shortId,
      isCliWrapped: false,
      discoverySource: localProvider === "lmstudio" ? "lmstudio-openai" : localProvider,
      harnessProfile: "guarded",
      aliases: brand ? [brand] : [],
    };
  }
  return {
    id: modelId,
    shortId: modelId,
    displayName: modelId,
    family: "openrouter",
    authTypes: ["api-key"],
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: { tools: false, vision: false, reasoning: false, streaming: false },
    color: "#6B7280",
    providerRoute: "unknown",
    providerModelId: modelId,
    isCliWrapped: false,
  };
}

export function mergeSelectorModels(
  availableModelIds?: string[],
  selectedModelId?: string,
  filter?: (model: ModelDescriptor) => boolean,
  catalogMode: "all" | "available-only" = "all",
): ModelDescriptor[] {
  const merged = new Map<string, ModelDescriptor>();
  const selectedId = String(selectedModelId ?? "").trim();
  const availableIdSet = new Set(
    (availableModelIds ?? [])
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean),
  );
  if (catalogMode === "all") {
    for (const model of MODEL_REGISTRY) {
      if (model.deprecated) continue;
      if (filter && !filter(model)) continue;
      merged.set(model.id, model);
    }
  }

  for (const rawId of availableIdSet) {
    const descriptor = resolveModelDescriptor(rawId);
    if (descriptor) {
      if (descriptor.deprecated) continue;
      if (filter && !filter(descriptor)) continue;
      merged.set(descriptor.id, descriptor);
    } else {
      const placeholder = createUnknownModelPlaceholder(rawId);
      if (filter && !filter(placeholder)) continue;
      merged.set(placeholder.id, placeholder);
    }
  }

  if (selectedId && !merged.has(selectedId)) {
    const selectedDescriptor = resolveModelDescriptor(selectedId);
    if (selectedDescriptor && !selectedDescriptor.deprecated && (!filter || filter(selectedDescriptor))) {
      merged.set(selectedDescriptor.id, selectedDescriptor);
    } else if (!selectedDescriptor) {
      const placeholder = createUnknownModelPlaceholder(selectedId);
      if (!filter || filter(placeholder)) {
        merged.set(placeholder.id, placeholder);
      }
    }
  }
  return [...merged.values()];
}

function flattenGroupBlocks(blocks: ModelProviderGroupBlock[]): ModelDescriptor[] {
  return blocks.flatMap((g) => g.providers.flatMap((p) => p.subsections.flatMap((sub) => sub.models)));
}

function OpenCodeCategorizedBadges({
  providers,
  activeProviderKey,
  onSelect,
}: {
  providers: ModelProviderBlock[];
  activeProviderKey?: string;
  onSelect: (key: string) => void;
}) {
  const { cloud, local, router } = sortOpenCodeProvidersByCategory(providers);
  const categories: { key: ProviderCategory; items: ModelProviderBlock[] }[] = [
    { key: "cloud-api", items: cloud },
    { key: "local", items: local },
    { key: "router", items: router },
  ];
  const shouldBoundHeight = providers.length > 10;

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2",
        shouldBoundHeight && "max-h-[11rem] overflow-y-auto overscroll-contain pr-1",
      )}
    >
      {categories.map(({ key: catKey, items }) => {
        if (!items.length) return null;
        return (
          <div key={catKey} className="flex min-w-0 items-start gap-2">
            <span className="w-10 shrink-0 pt-2 font-sans text-[9px] font-medium uppercase tracking-[0.14em] text-zinc-500">
              {PROVIDER_CATEGORY_LABELS[catKey]}
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {items.map((prov) => {
                const isProvActive = activeProviderKey === prov.key;
                const fill = providerAccent(prov.key, prov.badgeColor);
                const hasModels = prov.modelCount > 0;
                return (
                  <button
                    key={prov.key}
                    type="button"
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg py-1.5 pl-2.5 pr-2.5 text-left transition-all duration-150",
                      isProvActive
                        ? "bg-gradient-to-r from-violet-500/[0.10] to-violet-500/[0.04] border border-violet-400/20 text-fg shadow-sm"
                        : hasModels
                          ? "bg-white/[0.04] text-fg/65 hover:bg-white/[0.06] hover:text-fg/80"
                          : "bg-white/[0.02] text-fg/65 opacity-40",
                    )}
                    onClick={() => onSelect(prov.key)}
                  >
                    <ProviderLogo family={prov.key} size={14} />
                    <span className="font-sans text-[10px] font-semibold">{prov.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export type ModelCatalogPanelProps = {
  value?: string;
  availableModelIds?: string[];
  catalogMode?: "all" | "available-only";
  filter?: (model: ModelDescriptor) => boolean;
  onOpenAiSettings?: () => void;
  /** When set, user can activate an available model (e.g. chat picker). Omit in settings browse mode. */
  onSelectModel?: (modelId: string) => void;
  className?: string;
  listboxId?: string;
  /** Extra control in the search row (e.g. modal close). */
  headerTrailing?: ReactNode;
  /** Do not render footer link to AI settings. */
  hideOpenSettingsFooter?: boolean;
  autoFocusSearch?: boolean;
  /** When false, reset focus/tab init when re-enabled (modal closed). Default true. */
  enabled?: boolean;
};

/**
 * Shared catalog UI: same grouping, search, and rows as the Work chat model picker.
 * Use in Settings (embedded) and inside ProviderModelSelector (modal).
 */
export function ModelCatalogPanel({
  value = "",
  availableModelIds,
  catalogMode = "all",
  filter,
  onOpenAiSettings,
  onSelectModel,
  className,
  listboxId = "model-catalog-listbox",
  headerTrailing,
  hideOpenSettingsFooter = false,
  autoFocusSearch = false,
  enabled = true,
}: ModelCatalogPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pickerInitRef = useRef(false);

  // Fetch dynamic provider list from OpenCode so all providers show as badges
  const [opencodeProviders, setOpencodeProviders] = useState<Array<{ id: string; name: string; connected: boolean; modelCount: number }>>([]);
  useEffect(() => {
    let cancelled = false;
    window.ade?.ai?.getStatus?.().then((status: any) => {
      if (cancelled) return;
      if (Array.isArray(status?.opencodeProviders)) {
        setOpencodeProviders(status.opencodeProviders);
      }
    }).catch(() => { /* ignore — fallback list used */ });
    return () => { cancelled = true; };
  }, [availableModelIds]);

  const availableKey = useMemo(() => (availableModelIds ?? []).join("\0"), [availableModelIds]);

  useEffect(() => {
    if (!enabled) {
      pickerInitRef.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    pickerInitRef.current = false;
  }, [availableKey]);

  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState<ProviderGroupKey>("claude");
  const [activeProvider, setActiveProvider] = useState<string>("anthropic");
  const [activeSubsection, setActiveSubsection] = useState<string>("");
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  const availableSet = useMemo(
    () => (availableModelIds ? new Set(availableModelIds.map((entry) => String(entry ?? "").trim()).filter(Boolean)) : null),
    [availableModelIds],
  );
  const modelOrder = useMemo(() => createModelOrderMap(), []);
  const selectorModels = useMemo(
    () => mergeSelectorModels(availableModelIds, value, filter, catalogMode),
    [availableModelIds, catalogMode, filter, value],
  );

  const fullTree = useMemo(
    () => buildProviderGroupBlocks(selectorModels, modelOrder, opencodeProviders),
    [selectorModels, modelOrder, opencodeProviders],
  );

  const isSearchMode = query.trim().length > 0;
  const searchTree = useMemo(() => {
    const filtered = selectorModels.filter((m) => matchesQuery(m, query));
    return buildProviderGroupBlocks(filtered, modelOrder, opencodeProviders);
  }, [selectorModels, query, modelOrder, opencodeProviders]);

  const groupModelCounts = useMemo(() => {
    const map = new Map<ProviderGroupKey, number>();
    for (const block of fullTree) {
      const n = block.providers.reduce((acc, p) => acc + p.modelCount, 0);
      map.set(block.key, n);
    }
    return map;
  }, [fullTree]);

  const providersInActiveGroup = useMemo(() => {
    return fullTree.find((g) => g.key === activeGroup)?.providers ?? [];
  }, [fullTree, activeGroup]);

  const activeProviderBlock: ModelProviderBlock | null = useMemo(() => {
    if (!providersInActiveGroup.length) return null;
    return providersInActiveGroup.find((p) => p.key === activeProvider) ?? providersInActiveGroup[0] ?? null;
  }, [providersInActiveGroup, activeProvider]);

  const flatModels = useMemo(() => {
    if (isSearchMode) return flattenGroupBlocks(searchTree);
    if (!activeProviderBlock) return [];
    const sub =
      activeProviderBlock.subsections.find((s) => s.key === activeSubsection) ?? activeProviderBlock.subsections[0];
    return sub?.models ?? [];
  }, [isSearchMode, searchTree, activeProviderBlock, activeSubsection]);

  const selectedModel = useMemo(
    () => resolveModelDescriptor(value) ?? (value ? createUnknownModelPlaceholder(value) : undefined),
    [value],
  );

  const selectedGroup = selectedModel ? classifyProviderGroup(selectedModel) : null;
  const selectedProviderKey = selectedModel?.family;

  useEffect(() => {
    if (!enabled) return;
    if (fullTree.length === 0) return;
    if (pickerInitRef.current) return;
    pickerInitRef.current = true;
    if (selectedModel && selectedGroup && selectedProviderKey) {
      const hasGroup = fullTree.some((b) => b.key === selectedGroup);
      const groupKey = hasGroup ? selectedGroup : fullTree[0]!.key;
      setActiveGroup(groupKey);
      const provs = fullTree.find((b) => b.key === groupKey)?.providers ?? [];
      const hasProv = provs.some((p) => p.key === selectedProviderKey);
      const nextProvKey = hasProv ? selectedProviderKey : provs[0]?.key ?? "anthropic";
      setActiveProvider(nextProvKey);
      const provBlock = provs.find((p) => p.key === nextProvKey) ?? provs[0];
      if (provBlock) {
        const sk = subsectionKeyForModel(selectedModel, groupKey);
        setActiveSubsection(provBlock.subsections.some((s) => s.key === sk) ? sk : provBlock.subsections[0]?.key ?? "");
      }
    } else if (fullTree[0]) {
      setActiveGroup(fullTree[0].key);
      const p0 = fullTree[0].providers[0];
      setActiveProvider(p0?.key ?? "anthropic");
      setActiveSubsection(p0?.subsections[0]?.key ?? "");
    }
  }, [enabled, selectedModel, selectedGroup, selectedProviderKey, fullTree]);

  useEffect(() => {
    if (!providersInActiveGroup.some((p) => p.key === activeProvider) && providersInActiveGroup[0]) {
      setActiveProvider(providersInActiveGroup[0].key);
    }
  }, [activeGroup, providersInActiveGroup, activeProvider]);

  useEffect(() => {
    if (!activeProviderBlock) return;
    const keys = activeProviderBlock.subsections.map((s) => s.key);
    if (!keys.includes(activeSubsection)) {
      setActiveSubsection(keys[0] ?? "");
    }
  }, [activeProviderBlock, activeSubsection]);

  useEffect(() => {
    setFocusedIndex(-1);
  }, [activeGroup, activeProvider, activeSubsection, query, isSearchMode]);

  const openSettings = onOpenAiSettings;

  const handleSelect = useCallback(
    (modelId: string, isAvailable: boolean) => {
      if (!onSelectModel || !isAvailable) return;
      onSelectModel(modelId);
    },
    [onSelectModel],
  );

  const handleListKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!flatModels.length) return;
      let nextIndex = focusedIndex;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          nextIndex = focusedIndex < flatModels.length - 1 ? focusedIndex + 1 : 0;
          break;
        case "ArrowUp":
          event.preventDefault();
          nextIndex = focusedIndex > 0 ? focusedIndex - 1 : flatModels.length - 1;
          break;
        case "Home":
          event.preventDefault();
          nextIndex = 0;
          break;
        case "End":
          event.preventDefault();
          nextIndex = flatModels.length - 1;
          break;
        case "Enter": {
          event.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < flatModels.length && onSelectModel) {
            const model = flatModels[focusedIndex];
            const isAvailable = !availableSet || availableSet.has(model.id);
            handleSelect(model.id, isAvailable);
          }
          return;
        }
        default:
          return;
      }
      setFocusedIndex(nextIndex);

      const panel = panelRef.current;
      if (panel) {
        const options = panel.querySelectorAll("[data-model-option='true']");
        options[nextIndex]?.scrollIntoView({ block: "nearest" });
      }
    },
    [flatModels, focusedIndex, availableSet, handleSelect, onSelectModel],
  );

  const stripAccentColor = PROVIDER_GROUP_COLORS[activeGroup] ?? (activeProviderBlock
    ? providerAccent(activeProviderBlock.key, activeProviderBlock.badgeColor)
    : "var(--color-accent)");

  const selectable = Boolean(onSelectModel);

  const renderModelRow = (model: ModelDescriptor, keyPrefix: string) => {
    const isSelected = model.id === selectedModel?.id;
    const isAvailable = !availableSet || availableSet.has(model.id);
    const isFocused = focusedIndex >= 0 && flatModels[focusedIndex]?.id === model.id;
    const isUnknown = model.providerRoute === "unknown";
    const accent = providerAccent(model.family, model.color);
    const borderLeft = `3px solid ${accent}`;
    const bgSelected = rgbaFromHex(accent, 0.1);
    const bgFocused = isFocused && (selectable ? isAvailable : true) ? rgbaFromHex(accent, 0.08) : undefined;

    const rowClass = cn(
      "mx-2 flex w-[calc(100%-16px)] flex-col gap-1 rounded-xl border px-4 py-3 text-left font-sans text-[13px] transition-all duration-150",
      isSelected
        ? "border-violet-400/20 bg-gradient-to-br from-violet-500/[0.08] to-violet-500/[0.03]"
        : "border-white/[0.06] bg-white/[0.03]",
      isAvailable ? "text-fg/90" : "text-muted-fg/22",
      selectable &&
        isAvailable &&
        !isSelected &&
        "hover:bg-white/[0.05] hover:border-white/[0.08]",
    );

    const rowStyle: React.CSSProperties & { "--model-row-accent"?: string } = {
      "--model-row-accent": accent,
      backgroundColor: isSelected
        ? undefined
        : isFocused && (selectable ? isAvailable : true)
          ? bgFocused
          : isFocused && selectable && !isAvailable
            ? "rgba(255,255,255,0.02)"
            : undefined,
    };

    const inner = (
      <>
        <div className="flex items-center gap-2.5">
          <span className={cn("inline-flex flex-shrink-0 items-center justify-center", !isAvailable && "opacity-40 grayscale")}>
            <ModelRowLogo modelFamily={model.family} cliCommand={model.cliCommand} modelId={model.id} providerModelId={model.providerModelId} size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="truncate text-[13px] font-medium text-fg/90">{model.displayName}</div>
              {isSelected ? (
                <span className="inline-flex shrink-0 items-center rounded-full border border-emerald-400/20 bg-emerald-500/[0.15] px-2 py-0.5 font-sans text-[9px] font-medium text-emerald-300">
                  active
                </span>
              ) : null}
              {isUnknown ? (
                <span className="inline-flex shrink-0 items-center rounded-full border border-zinc-400/25 bg-zinc-400/10 px-1.5 py-0.5 font-sans text-[8px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
                  Unknown
                </span>
              ) : null}
            </div>
            <div className={cn("truncate text-[11px]", isAvailable ? "text-fg/50" : "text-muted-fg/35 italic")}>
              {modelAvailabilityLabel(model, isAvailable)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isAvailable && !isSelected ? (
              <span className="inline-flex items-center gap-1 font-sans text-[9px] font-medium text-emerald-400/60">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400/60" />
                Ready
              </span>
            ) : null}
            {isSelected ? <Check size={13} weight="bold" className="text-emerald-400" /> : <span className="w-[13px]" />}
          </div>
        </div>
        {!isAvailable && openSettings ? (
          <button
            type="button"
            className="ml-7 text-left font-sans text-[10px] text-accent/70 underline-offset-2 hover:text-accent hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              openSettings();
            }}
          >
            Not configured — open AI settings
          </button>
        ) : null}
      </>
    );

    if (selectable && isAvailable) {
      return (
        <button
          key={`${keyPrefix}:${model.id}`}
          id={`model-option-${model.id}`}
          type="button"
          role="option"
          data-model-option="true"
          aria-selected={isSelected}
          aria-disabled={false}
          className={rowClass}
          style={rowStyle}
          onMouseEnter={() => {
            const idx = flatModels.findIndex((m) => m.id === model.id);
            if (idx >= 0) setFocusedIndex(idx);
          }}
          onClick={() => handleSelect(model.id, true)}
        >
          {inner}
        </button>
      );
    }

    return (
      <div
        key={`${keyPrefix}:${model.id}`}
        id={`model-option-${model.id}`}
        role="option"
        data-model-option="true"
        aria-selected={isSelected}
        aria-disabled={!selectable || !isAvailable}
        className={rowClass}
        style={rowStyle}
        onMouseEnter={() => {
          const idx = flatModels.findIndex((m) => m.id === model.id);
          if (idx >= 0) setFocusedIndex(idx);
        }}
      >
        {inner}
      </div>
    );
  };

  const listContent = (() => {
    if (isSearchMode) {
      if (!searchTree.length) {
        return <div className="px-4 py-5 font-sans text-[11px] text-muted-fg/45">No models match this search.</div>;
      }
      return searchTree.map((groupBlock) => (
        <div key={groupBlock.key} className="border-b border-white/[0.04] last:border-b-0">
          <div className="sticky top-0 z-[1] border-b border-white/[0.06] px-4 py-2.5 backdrop-blur-md" style={{ background: "rgba(19,17,34,0.85)" }}>
            <div className="flex items-center gap-2 font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-fg/55">
              <ProviderLogo family={groupBlock.key === "claude" ? "anthropic" : groupBlock.key === "codex" ? "openai" : groupBlock.key} size={14} />
              {groupBlock.label}
            </div>
          </div>
          {groupBlock.providers.map((prov) => (
            <div key={`${groupBlock.key}:${prov.key}`} className="border-b border-border/6 last:border-b-0">
              {groupBlock.key === "opencode" ? (
                <div className="flex items-center gap-2 px-3 pt-3">
                  <ProviderLogo family={prov.key} size={16} />
                  <span className="font-sans text-[11px] font-semibold text-fg/80">{prov.label}</span>
                  <span className="font-sans text-[9px] text-muted-fg/40">{prov.modelCount} models</span>
                </div>
              ) : null}
              {prov.subsections.map((sub) => (
                <div key={`${groupBlock.key}:${prov.key}:${sub.key}`}>
                  {sub.label ? (
                    <div className="px-3 pt-2 font-sans text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-fg/32">
                      {subsectionTabTitle(sub)}
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-1.5 py-2">{sub.models.map((m) => renderModelRow(m, `${groupBlock.key}:${prov.key}`))}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ));
    }

    if (!activeProviderBlock || !flatModels.length) {
      if (activeGroup === "opencode") {
        const providerName = activeProviderBlock?.label ?? "this provider";
        const providerKey = activeProviderBlock?.key;
        const isLocal = providerKey && ["ollama", "lmstudio"].includes(providerKey);
        const isFree = providerKey === "opencode";
        const isKnownApiProvider = providerKey && ["anthropic", "openai", "google", "mistral", "deepseek", "xai", "groq", "together", "openrouter"].includes(providerKey);
        return (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="font-sans text-sm text-zinc-400 mb-2">
              {activeProviderBlock ? `No ${providerName} models discovered` : "No models discovered yet"}
            </div>
            <div className="font-sans text-xs text-zinc-500 mb-4 max-w-[280px]">
              {isFree
                ? "Free models from OpenCode. Hit Refresh in Settings > Providers to discover them."
                : isLocal
                  ? `Start ${providerName} and load a model, then refresh.`
                  : isKnownApiProvider
                    ? `Add your ${providerName} API key in Settings > Providers to unlock models.`
                    : activeProviderBlock
                      ? `This provider requires configuration in OpenCode. Run "opencode config" to set it up.`
                      : "Add API keys or connect local runtimes in Settings to unlock models."}
            </div>
            {openSettings ? (
              <button
                type="button"
                className="font-sans text-xs text-blue-400 hover:text-blue-300 underline"
                onClick={() => openSettings()}
              >
                {isKnownApiProvider || isLocal || isFree ? `Open Settings` : "Open Settings"}
              </button>
            ) : null}
          </div>
        );
      }
      if (!activeProviderBlock) {
        return (
          <div className="px-4 py-5 font-sans text-[11px] text-muted-fg/45">
            No models in this category. Try another source or search.
          </div>
        );
      }
      return <div className="px-4 py-5 font-sans text-[11px] text-muted-fg/45">No models in this group.</div>;
    }

    return <div className="flex flex-col gap-1.5 py-2">{flatModels.map((m) => renderModelRow(m, activeProviderBlock.key))}</div>;
  })();

  return (
    <div
      ref={panelRef}
      role="presentation"
      className={cn(
        "ade-chat-drawer-glass flex w-full flex-col overflow-hidden outline-none",
        "max-h-[min(560px,70vh)]",
        className,
      )}
    >

      <div className="shrink-0 space-y-3 border-b border-white/[0.04] px-6 pb-4 pt-5">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Cpu size={18} weight="duotone" className="shrink-0 text-violet-400" />
            <span className="font-semibold text-[15px] text-fg/[0.94] font-sans">Select Model</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="rounded-[10px] border border-white/[0.08] bg-white/[0.05] px-3 py-2 transition-colors focus-within:border-violet-400/40">
              <div className="flex items-center gap-2">
                <MagnifyingGlass size={13} className="shrink-0 text-muted-fg/40" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleListKeyDown}
                  placeholder="Search models…"
                  aria-label="Search models"
                  className="min-w-0 w-[160px] bg-transparent font-sans text-[12px] text-fg/90 outline-none placeholder:text-muted-fg/30"
                  autoFocus={autoFocusSearch}
                  role="combobox"
                  aria-controls={listboxId}
                  aria-expanded={true}
                  aria-activedescendant={
                    focusedIndex >= 0 && flatModels[focusedIndex] ? `model-option-${flatModels[focusedIndex].id}` : undefined
                  }
                />
              </div>
            </div>
            {headerTrailing ? <div className="shrink-0">{headerTrailing}</div> : null}
          </div>
        </div>

        <div
          className={cn(
            "flex gap-1 rounded-xl border border-white/[0.06] bg-white/[0.02] p-1",
            isSearchMode && "opacity-40",
          )}
        >
          {GROUP_KEYS.map((key) => {
            const count = groupModelCounts.get(key) ?? 0;
            const segActive = activeGroup === key && !isSearchMode;
            const empty = count === 0 && key !== "opencode";
            return (
              <button
                key={key}
                type="button"
                disabled={empty || isSearchMode}
                title={empty ? `No ${providerGroupLabel(key)} models` : undefined}
                className={cn(
                  "flex-1 py-1.5 px-3 text-center font-sans text-[10px] font-semibold uppercase tracking-wide transition-all duration-150",
                  isSearchMode && "cursor-not-allowed",
                  !isSearchMode && segActive && "rounded-lg bg-gradient-to-r from-violet-500/[0.12] to-violet-500/[0.05] text-fg border border-violet-400/20 shadow-sm",
                  !isSearchMode && !segActive && !empty && "rounded-lg text-muted-fg/45 hover:text-fg/60 hover:bg-white/[0.04]",
                  !isSearchMode && !segActive && empty && "cursor-not-allowed text-muted-fg/25",
                )}
                onClick={() => {
                  if (isSearchMode) return;
                  setActiveGroup(key);
                }}
              >
                {providerGroupLabel(key)}
                {key === "opencode" && count > 0 ? (
                  <span className="ml-0.5 text-[9px] opacity-60">({count})</span>
                ) : null}
              </button>
            );
          })}
        </div>

        {!isSearchMode ? (
          activeGroup === "opencode" && providersInActiveGroup.length > 0 ? (
            <OpenCodeCategorizedBadges
              providers={providersInActiveGroup}
              activeProviderKey={activeProviderBlock?.key}
              onSelect={setActiveProvider}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              {providersInActiveGroup.map((prov) => {
                const isProvActive = activeProviderBlock?.key === prov.key;
                return (
                  <button
                    key={prov.key}
                    type="button"
                    className={cn(
                      "flex items-center gap-2 rounded-lg py-2 pl-3 pr-3.5 text-left transition-all duration-150",
                      isProvActive
                        ? "bg-gradient-to-r from-violet-500/[0.10] to-violet-500/[0.04] border border-violet-400/20 text-fg shadow-sm"
                        : "bg-white/[0.04] text-fg/65 hover:bg-white/[0.06] hover:text-fg/80",
                    )}
                    onClick={() => setActiveProvider(prov.key)}
                  >
                    <ProviderLogo family={prov.key} size={16} />
                    <span className="font-sans text-[10px] font-semibold">{prov.label}</span>
                  </button>
                );
              })}
            </div>
          )
        ) : (
          <div className="font-sans text-[10px] font-medium uppercase tracking-wider text-muted-fg/40">Search results (all sources)</div>
        )}

        {!isSearchMode && activeProviderBlock && activeProviderBlock.subsections.length > 1 ? (
          <div className="flex flex-wrap gap-1.5">
            {activeProviderBlock.subsections.map((sub) => {
              const tabActive = activeSubsection === sub.key;
              const count = sub.models.length;
              return (
                <button
                  key={sub.key}
                  type="button"
                  className={cn(
                    "rounded-full px-3 py-1 font-sans text-[10px] font-medium transition-all duration-150",
                    tabActive ? "bg-violet-500/[0.10] border border-violet-400/20 text-fg" : "text-muted-fg/40 hover:text-fg/60 hover:bg-white/[0.04]",
                  )}
                  onClick={() => setActiveSubsection(sub.key)}
                >
                  {subsectionTabTitle(sub)} ({count})
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div id={listboxId} role="listbox" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-1">
        {listContent}
      </div>

      {!hideOpenSettingsFooter && openSettings ? (
        <div
          className="shrink-0 border-t border-white/[0.04] px-6 py-3"
        >
          <button
            type="button"
            className="font-sans text-[10px] text-violet-300/60 hover:text-violet-300 transition-colors"
            onClick={() => {
              openSettings();
            }}
          >
            Open AI settings…
          </button>
        </div>
      ) : null}
    </div>
  );
}
