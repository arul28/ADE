import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  MODEL_REGISTRY,
  resolveModelDescriptor,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { fadeScale } from "../../lib/motion";
import { cn } from "../ui/cn";
import { CaretDown, Check, MagnifyingGlass, X } from "@phosphor-icons/react";
import { ModelRowLogo, ProviderLogo } from "./ProviderLogos";
import {
  buildSourceBlocksForModels,
  classifySourceSection,
  createModelOrderMap,
  matchesQuery,
  PROVIDER_BADGE_COLORS,
  providerLabel,
  subsectionKeyForModel,
  sourceSectionLabel,
  type ModelProviderBlock,
  type ModelSourceBlock,
  type ModelSubsection,
  type SourceSectionKey,
} from "./unifiedModelSelectorGrouping";

type UnifiedModelSelectorProps = {
  value: string;
  onChange: (modelId: string) => void;
  filter?: (model: ModelDescriptor) => boolean;
  availableModelIds?: string[];
  catalogMode?: "all" | "available-only";
  className?: string;
  disabled?: boolean;
  showReasoning?: boolean;
  reasoningEffort?: string | null;
  onReasoningEffortChange?: (effort: string | null) => void;
  /** Opens AI / provider settings (e.g. navigate to `/settings?tab=ai#ai-providers`). */
  onOpenAiSettings?: () => void;
  /** @deprecated Use `onOpenAiSettings` */
  onConfigureMore?: () => void;
};

const SOURCE_KEYS: SourceSectionKey[] = ["subscription", "api", "local"];
const LOCAL_PROVIDER_LABELS: Record<string, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  vllm: "vLLM",
};

const selectCls = cn(
  "h-8 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 font-sans text-[11px] text-fg/70",
  "outline-none focus:border-white/[0.14]",
);

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

function getLocalProviderFromModelId(modelId: string): "ollama" | "lmstudio" | "vllm" | null {
  const provider = String(modelId ?? "").trim().split("/", 1)[0]?.toLowerCase();
  if (provider === "ollama" || provider === "lmstudio" || provider === "vllm") {
    return provider;
  }
  return null;
}

function getLocalModelShortLabel(modelId: string): string {
  const provider = getLocalProviderFromModelId(modelId);
  if (!provider) return modelId;
  const tail = String(modelId ?? "").trim().slice(provider.length + 1).trim();
  return tail.length ? tail : modelId;
}

function subsectionTabTitle(sub: ModelSubsection): string {
  return sub.label.trim() || "Models";
}

function modelAvailabilityLabel(model: ModelDescriptor, isAvailable: boolean): string {
  if (isAvailable) {
    if (model.family === "cursor" && model.isCliWrapped) return "Cursor CLI ready";
    if (model.isCliWrapped) return "Subscription ready";
    if (model.authTypes.includes("local")) return `${providerLabel(model.family)} ready`;
    if (model.authTypes.includes("api-key")) return "API ready";
    if (model.authTypes.includes("oauth")) return "OAuth ready";
    if (model.authTypes.includes("openrouter")) return "OpenRouter ready";
    return "Ready";
  }
  if (model.family === "cursor" && model.isCliWrapped) {
    return "Cursor CLI · run `agent login` or set CURSOR_API_KEY / CURSOR_AUTH_TOKEN";
  }
  if (model.isCliWrapped) return "Subscription · not configured";
  if (model.authTypes.includes("local")) return `${providerLabel(model.family)} · not configured`;
  if (model.authTypes.includes("api-key")) return "API · not configured";
  if (model.authTypes.includes("oauth")) return "OAuth · not configured";
  if (model.authTypes.includes("openrouter")) return "OpenRouter · not configured";
  return "Not configured";
}

function tierLabel(tier: string): string {
  if (tier === "xhigh") return "Extra High";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function createUnknownModelPlaceholder(modelId: string): ModelDescriptor {
  console.warn(`[UnifiedModelSelector] Unknown model ID "${modelId}" — not found in registry. Creating placeholder.`);
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
      sdkProvider: "@agentclientprotocol/sdk",
      sdkModelId: tail || modelId,
      cliCommand: "cursor",
      isCliWrapped: true,
    };
  }
  const localProvider = getLocalProviderFromModelId(modelId);
  if (localProvider) {
    const providerLabel = LOCAL_PROVIDER_LABELS[localProvider];
    const shortId = getLocalModelShortLabel(modelId);
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
      sdkProvider: "@ai-sdk/openai-compatible",
      sdkModelId: modelId,
      isCliWrapped: false,
      discoverySource: localProvider === "lmstudio" ? "lmstudio-openai" : localProvider,
      harnessProfile: "guarded",
      aliases: [providerLabel],
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
    sdkProvider: "unknown",
    sdkModelId: modelId,
    isCliWrapped: false,
  };
}

function mergeSelectorModels(
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

function flattenSourceBlocks(blocks: ModelSourceBlock[]): ModelDescriptor[] {
  return blocks.flatMap((s) => s.providers.flatMap((p) => p.subsections.flatMap((sub) => sub.models)));
}

export function UnifiedModelSelector({
  value,
  onChange,
  filter,
  availableModelIds,
  catalogMode = "all",
  className,
  disabled = false,
  showReasoning,
  reasoningEffort,
  onReasoningEffortChange,
  onOpenAiSettings,
  onConfigureMore,
}: UnifiedModelSelectorProps) {
  const openSettings = onOpenAiSettings ?? onConfigureMore;

  const [open, setOpen] = useState(false);
  const [activeSource, setActiveSource] = useState<SourceSectionKey>("subscription");
  const [activeProvider, setActiveProvider] = useState<string>("anthropic");
  const [activeSubsection, setActiveSubsection] = useState<string>("");
  const [query, setQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pickerInitRef = useRef(false);

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
    () => buildSourceBlocksForModels(selectorModels, modelOrder),
    [selectorModels, modelOrder],
  );

  const isSearchMode = query.trim().length > 0;
  const searchTree = useMemo(() => {
    const filtered = selectorModels.filter((m) => matchesQuery(m, query));
    return buildSourceBlocksForModels(filtered, modelOrder);
  }, [selectorModels, query, modelOrder]);

  const sourceModelCounts = useMemo(() => {
    const map = new Map<SourceSectionKey, number>();
    for (const block of fullTree) {
      const n = block.providers.reduce((acc, p) => acc + p.modelCount, 0);
      map.set(block.key, n);
    }
    return map;
  }, [fullTree]);

  const providersInActiveSource = useMemo(() => {
    return fullTree.find((s) => s.key === activeSource)?.providers ?? [];
  }, [fullTree, activeSource]);

  const activeProviderBlock: ModelProviderBlock | null = useMemo(() => {
    if (!providersInActiveSource.length) return null;
    return providersInActiveSource.find((p) => p.key === activeProvider) ?? providersInActiveSource[0] ?? null;
  }, [providersInActiveSource, activeProvider]);

  const flatModels = useMemo(() => {
    if (isSearchMode) return flattenSourceBlocks(searchTree);
    if (!activeProviderBlock) return [];
    const sub =
      activeProviderBlock.subsections.find((s) => s.key === activeSubsection) ?? activeProviderBlock.subsections[0];
    return sub?.models ?? [];
  }, [isSearchMode, searchTree, activeProviderBlock, activeSubsection]);

  const selectedModel = useMemo(
    () => resolveModelDescriptor(value) ?? (value ? createUnknownModelPlaceholder(value) : undefined),
    [value],
  );
  const reasoningTiers = selectedModel?.reasoningTiers ?? [];

  const selectedSource = selectedModel ? classifySourceSection(selectedModel) : null;
  const selectedProviderKey = selectedModel?.family;

  useEffect(() => {
    if (!open) {
      pickerInitRef.current = false;
      return;
    }
    if (fullTree.length === 0) return;
    if (pickerInitRef.current) return;
    pickerInitRef.current = true;
    if (selectedModel && selectedSource && selectedProviderKey) {
      const hasSource = fullTree.some((b) => b.key === selectedSource);
      const sourceKey = hasSource ? selectedSource : fullTree[0]!.key;
      setActiveSource(sourceKey);
      const provs = fullTree.find((b) => b.key === sourceKey)?.providers ?? [];
      const hasProv = provs.some((p) => p.key === selectedProviderKey);
      const nextProvKey = hasProv ? selectedProviderKey : provs[0]?.key ?? "anthropic";
      setActiveProvider(nextProvKey);
      const provBlock = provs.find((p) => p.key === nextProvKey) ?? provs[0];
      if (provBlock) {
        const sk = subsectionKeyForModel(selectedModel, sourceKey);
        setActiveSubsection(provBlock.subsections.some((s) => s.key === sk) ? sk : provBlock.subsections[0]?.key ?? "");
      }
    } else if (fullTree[0]) {
      setActiveSource(fullTree[0].key);
      const p0 = fullTree[0].providers[0];
      setActiveProvider(p0?.key ?? "anthropic");
      setActiveSubsection(p0?.subsections[0]?.key ?? "");
    }
  }, [open, selectedModel, selectedSource, selectedProviderKey, fullTree]);

  useEffect(() => {
    if (!providersInActiveSource.some((p) => p.key === activeProvider) && providersInActiveSource[0]) {
      setActiveProvider(providersInActiveSource[0].key);
    }
  }, [activeSource, providersInActiveSource, activeProvider]);

  useEffect(() => {
    if (!activeProviderBlock) return;
    const keys = activeProviderBlock.subsections.map((s) => s.key);
    if (!keys.includes(activeSubsection)) {
      setActiveSubsection(keys[0] ?? "");
    }
  }, [activeProviderBlock, activeSubsection]);

  useEffect(() => {
    setFocusedIndex(-1);
  }, [activeSource, activeProvider, activeSubsection, query, open, isSearchMode]);

  const handleSelect = useCallback(
    (modelId: string, isAvailable: boolean) => {
      if (disabled || !isAvailable) return;
      onChange(modelId);
      setOpen(false);
    },
    [disabled, onChange],
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
          if (focusedIndex >= 0 && focusedIndex < flatModels.length) {
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
    [flatModels, focusedIndex, availableSet, handleSelect],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
    }
  }, [disabled, open]);

  const stripAccentColor = activeProviderBlock
    ? providerAccent(activeProviderBlock.key, activeProviderBlock.badgeColor)
    : "var(--color-accent)";

  const renderModelRow = (model: ModelDescriptor, keyPrefix: string) => {
    const isSelected = model.id === selectedModel?.id;
    const isAvailable = !availableSet || availableSet.has(model.id);
    const isFocused = focusedIndex >= 0 && flatModels[focusedIndex]?.id === model.id;
    const isUnknown = model.sdkProvider === "unknown";
    const accent = providerAccent(model.family, model.color);
    const borderLeft = `3px solid ${accent}`;
    const bgSelected = rgbaFromHex(accent, 0.1);
    const bgFocused = isFocused && isAvailable ? rgbaFromHex(accent, 0.08) : undefined;

    const rowClass = cn(
      "mx-1.5 flex w-[calc(100%-12px)] flex-col gap-1 rounded-xl px-3 py-2 text-left font-sans text-[11px] transition-[background-color,color] duration-150",
      isAvailable ? "text-fg/90" : "text-muted-fg/22",
      isAvailable &&
        !isSelected &&
        "hover:[background-color:color-mix(in_srgb,var(--model-row-accent)_5%,transparent)]",
    );

    const rowStyle: React.CSSProperties & { "--model-row-accent"?: string } = {
      "--model-row-accent": accent,
      borderLeft,
      backgroundColor: isSelected
        ? bgSelected
        : isFocused && isAvailable
          ? bgFocused
          : isFocused && !isAvailable
            ? "rgba(255,255,255,0.02)"
            : undefined,
    };

    const inner = (
      <>
        <div className="flex items-center gap-2">
          <span className={cn("inline-flex flex-shrink-0 items-center justify-center", !isAvailable && "opacity-40 grayscale")}>
            <ModelRowLogo modelFamily={model.family} cliCommand={model.cliCommand} modelId={model.id} sdkModelId={model.sdkModelId} size={12} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <div className="truncate font-medium">{model.displayName}</div>
              {isUnknown ? (
                <span className="inline-flex shrink-0 items-center rounded-full border border-zinc-400/25 bg-zinc-400/10 px-1.5 py-0.5 font-sans text-[8px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
                  Unknown
                </span>
              ) : null}
            </div>
            <div className="truncate text-[9px] uppercase tracking-[0.12em] text-muted-fg/42">
              {modelAvailabilityLabel(model, isAvailable)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {isAvailable ? (
              <span className="font-sans text-[9px] font-semibold uppercase tracking-wide text-muted-fg/50">Ready</span>
            ) : null}
            {isSelected ? <Check size={12} weight="bold" style={{ color: accent }} /> : <span className="w-[12px]" />}
          </div>
        </div>
        {!isAvailable && openSettings ? (
          <button
            type="button"
            className="ml-7 text-left font-sans text-[10px] text-accent/70 underline-offset-2 hover:text-accent hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              openSettings();
            }}
          >
            Not configured — open AI settings
          </button>
        ) : null}
      </>
    );

    if (isAvailable) {
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
        aria-disabled
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
      return searchTree.map((sourceBlock) => (
        <div key={sourceBlock.key} className="border-b border-border/10 last:border-b-0">
          <div className="sticky top-0 z-[1] border-b border-white/[0.06] px-3 py-2 backdrop-blur-sm" style={{ background: "var(--gradient-panel)" }}>
            <div className="font-sans text-[10px] font-bold uppercase tracking-[0.2em] text-fg/55">{sourceBlock.label}</div>
          </div>
          {sourceBlock.providers.map((prov) => (
            <div key={`${sourceBlock.key}:${prov.key}`} className="border-b border-border/6 last:border-b-0">
              <div className="flex items-center gap-2 px-3 pt-3">
                <ProviderLogo family={prov.key} size={16} />
                <span className="font-sans text-[11px] font-semibold text-fg/80">{prov.label}</span>
                <span className="font-sans text-[9px] text-muted-fg/40">{prov.modelCount} models</span>
              </div>
              {prov.subsections.map((sub) => (
                <div key={`${sourceBlock.key}:${prov.key}:${sub.key}`}>
                  {sub.label ? (
                    <div className="px-3 pt-2 font-sans text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-fg/32">
                      {subsectionTabTitle(sub)}
                    </div>
                  ) : null}
                  <div className="py-1.5">{sub.models.map((m) => renderModelRow(m, `${sourceBlock.key}:${prov.key}`))}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ));
    }

    if (!activeProviderBlock) {
      return (
        <div className="px-4 py-5 font-sans text-[11px] text-muted-fg/45">
          No models in this category. Try another source or search.
        </div>
      );
    }

    if (!flatModels.length) {
      return <div className="px-4 py-5 font-sans text-[11px] text-muted-fg/45">No models in this group.</div>;
    }

    return <div className="py-1.5">{flatModels.map((m) => renderModelRow(m, activeProviderBlock.key))}</div>;
  })();

  const panel = createPortal(
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            key="model-picker-backdrop"
            className="fixed inset-0 z-[79] bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            aria-hidden
            onClick={() => setOpen(false)}
          />
          <div className="pointer-events-none fixed inset-0 z-[80] flex items-start justify-center pt-[12vh]">
            <motion.div
              key="model-picker-panel"
              ref={panelRef}
              role="presentation"
              className={cn(
                "pointer-events-auto flex w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-[color:var(--pane-border)] shadow-[var(--shadow-float)] outline-none",
                "max-h-[min(520px,70vh)]",
              )}
              style={{ background: "var(--gradient-panel)" }}
              variants={fadeScale}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <div className="h-[3px] w-full shrink-0" style={{ backgroundColor: stripAccentColor }} />

              <div className="shrink-0 space-y-3 px-4 pb-3 pt-4">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1 rounded-xl border-2 border-transparent bg-black/15 px-3 py-2.5 transition-colors focus-within:border-accent/40">
                    <div className="flex items-center gap-2">
                      <MagnifyingGlass size={14} className="shrink-0 text-muted-fg/45" />
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={handleListKeyDown}
                        placeholder="Search models, ids, aliases…"
                        className="min-w-0 flex-1 bg-transparent font-sans text-[12px] text-fg/90 outline-none placeholder:text-muted-fg/30"
                        autoFocus
                        role="combobox"
                        aria-controls="model-selector-listbox"
                        aria-expanded={true}
                        aria-activedescendant={
                          focusedIndex >= 0 && flatModels[focusedIndex] ? `model-option-${flatModels[focusedIndex].id}` : undefined
                        }
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-muted-fg/55 transition-colors hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-fg/80"
                    onClick={() => setOpen(false)}
                    aria-label="Close model picker"
                  >
                    <X size={14} weight="bold" />
                  </button>
                </div>

                <div
                  className={cn(
                    "flex gap-0 rounded-lg border border-white/[0.06] bg-black/20 p-0.5",
                    isSearchMode && "opacity-45",
                  )}
                >
                  {SOURCE_KEYS.map((key) => {
                    const count = sourceModelCounts.get(key) ?? 0;
                    const segActive = activeSource === key && !isSearchMode;
                    const empty = count === 0;
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={empty || isSearchMode}
                        title={empty ? `No ${sourceSectionLabel(key).toLowerCase()} models` : undefined}
                        className={cn(
                          "flex-1 py-1.5 px-3 text-center font-sans text-[10px] font-semibold uppercase tracking-wide transition-colors",
                          isSearchMode && "cursor-not-allowed",
                          !isSearchMode && segActive && "rounded-md bg-accent/15 text-fg shadow-[inset_0_-2px_0_0_var(--color-accent)]",
                          !isSearchMode && !segActive && !empty && "text-muted-fg/45 hover:text-fg/60",
                          !isSearchMode && !segActive && empty && "cursor-not-allowed text-muted-fg/25",
                        )}
                        onClick={() => {
                          if (isSearchMode) return;
                          setActiveSource(key);
                        }}
                      >
                        {sourceSectionLabel(key)}
                      </button>
                    );
                  })}
                </div>

                {!isSearchMode ? (
                  <div className="flex gap-2 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {providersInActiveSource.map((prov) => {
                      const isProvActive = activeProviderBlock?.key === prov.key;
                      const fill = providerAccent(prov.key, prov.badgeColor);
                      return (
                        <button
                          key={prov.key}
                          type="button"
                          className={cn(
                            "flex shrink-0 items-center gap-2 rounded-xl py-2 pl-3 pr-3 text-left transition-colors",
                            isProvActive
                              ? "text-white shadow-md"
                              : "border border-white/[0.08] bg-white/[0.04] text-fg/75 hover:border-white/[0.12] hover:bg-white/[0.06]",
                          )}
                          style={isProvActive ? { backgroundColor: fill } : undefined}
                          onClick={() => setActiveProvider(prov.key)}
                        >
                          <ProviderLogo family={prov.key} size={18} />
                          <span className="font-sans text-[11px] font-semibold">{prov.label}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="font-sans text-[10px] font-medium uppercase tracking-wide text-muted-fg/50">Search results (all sources)</div>
                )}

                {!isSearchMode && activeProviderBlock && activeProviderBlock.subsections.length > 1 ? (
                  <div className="flex gap-1 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {activeProviderBlock.subsections.map((sub) => {
                      const tabActive = activeSubsection === sub.key;
                      const count = sub.models.length;
                      return (
                        <button
                          key={sub.key}
                          type="button"
                          className={cn(
                            "shrink-0 rounded-full px-2.5 py-1 font-sans text-[10px] font-medium transition-colors",
                            tabActive ? "bg-white/[0.08] text-fg" : "text-muted-fg/40 hover:text-fg/60",
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

              <div id="model-selector-listbox" role="listbox" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
                {listContent}
              </div>

              {openSettings ? (
                <div
                  className="shrink-0 px-4 py-2.5"
                  style={{ borderTop: `1px solid color-mix(in srgb, ${stripAccentColor} 15%, transparent)` }}
                >
                  <button
                    type="button"
                    className="font-sans text-[10px] text-accent/65 hover:text-accent"
                    onClick={() => {
                      setOpen(false);
                      openSettings();
                    }}
                  >
                    Open AI settings…
                  </button>
                </div>
              ) : null}
            </motion.div>
          </div>
        </>
      ) : null}
    </AnimatePresence>,
    document.body,
  );

  return (
    <div className={cn("flex max-w-full flex-wrap items-center gap-1.5", className)}>
      <div ref={containerRef} className="relative min-w-0">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            setOpen((current) => !current);
          }}
          className={cn(
            "inline-flex h-8 w-auto min-w-[170px] max-w-[15rem] flex-none items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 font-sans text-[11px] text-fg/70",
            "transition-colors hover:border-white/[0.12] hover:bg-white/[0.06]",
            open && "border-white/[0.14] bg-white/[0.06]",
            disabled && "cursor-not-allowed opacity-70 hover:border-white/[0.08] hover:bg-white/[0.04]",
          )}
          aria-label="Select model"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          {selectedModel ? (
            <ModelRowLogo
              modelFamily={selectedModel.family}
              cliCommand={selectedModel.cliCommand}
              modelId={selectedModel.id}
              sdkModelId={selectedModel.sdkModelId}
              size={14}
            />
          ) : null}
          <span className={cn("min-w-0 flex-1 truncate text-left", !selectedModel && !value && "text-muted-fg/40")}>
            {selectedModel?.displayName ?? (value || "Select model")}
          </span>
          <CaretDown
            size={10}
            weight="bold"
            className={cn("flex-shrink-0 text-muted-fg/50 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>

      {panel}

      {showReasoning && reasoningTiers.length > 0 && onReasoningEffortChange ? (
        <select
          value={reasoningEffort ?? ""}
          disabled={disabled}
          onChange={(event) => onReasoningEffortChange(event.target.value || null)}
          className={cn(selectCls, "min-w-[92px]", disabled && "cursor-not-allowed opacity-70")}
          aria-label="Reasoning effort"
        >
          {reasoningTiers.map((tier) => (
            <option key={tier} value={tier}>
              {tierLabel(tier)}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
