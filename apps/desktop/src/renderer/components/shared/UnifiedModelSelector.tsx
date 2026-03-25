import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  MODEL_REGISTRY,
  resolveModelDescriptor,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { CaretDown, Check, MagnifyingGlass, X } from "@phosphor-icons/react";
import { ClaudeLogo, CodexLogo } from "../terminals/ToolLogos";

type UnifiedModelSelectorProps = {
  value: string;
  onChange: (modelId: string) => void;
  filter?: (model: ModelDescriptor) => boolean;
  availableModelIds?: string[];
  className?: string;
  disabled?: boolean;
  showReasoning?: boolean;
  reasoningEffort?: string | null;
  onReasoningEffortChange?: (effort: string | null) => void;
  onConfigureMore?: () => void;
};

type SelectorBucket = "subscription" | "api" | "local";

type ProviderSection = {
  key: string;
  label: string;
  models: ModelDescriptor[];
};

type BucketGroup = {
  key: SelectorBucket;
  label: string;
  badgeText: string;
  badgeColor: string;
  sections: ProviderSection[];
};

type PopupLayout =
  | {
      mode: "anchored";
      top: number;
      left: number;
      width: number;
      maxHeight: number;
    }
  | {
      mode: "modal";
      top: number;
      left: number;
      width: number;
      maxHeight: number;
    };

const BUCKET_LABELS: Record<SelectorBucket, { label: string; badgeText: string; badgeColor: string }> = {
  subscription: { label: "Subscription", badgeText: "Sub", badgeColor: "#A78BFA" },
  api: { label: "API", badgeText: "API", badgeColor: "#22C55E" },
  local: { label: "Local", badgeText: "Local", badgeColor: "#F59E0B" },
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
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

const PROVIDER_ORDER: string[] = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "mistral",
  "xai",
  "openrouter",
  "groq",
  "together",
  "ollama",
  "lmstudio",
  "vllm",
  "meta",
];

const MODEL_CALLOUTS: Record<string, { label: string; tone: string }> = {
  "openai/gpt-5.4-codex": {
    label: "Latest",
    tone: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  },
  "openai/gpt-5.4": {
    label: "Latest",
    tone: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  },
  "openai/gpt-5.4-mini": {
    label: "Fast",
    tone: "border-sky-400/25 bg-sky-400/10 text-sky-200",
  },
  "openai/gpt-5.3-codex": {
    label: "Coding",
    tone: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  },
};

const selectCls = cn(
  "h-8 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 font-mono text-[11px] text-fg/70",
  "outline-none focus:border-white/[0.14]",
);

function classifyBucket(model: ModelDescriptor): SelectorBucket {
  if (model.isCliWrapped) return "subscription";
  if (model.authTypes.includes("local")) return "local";
  return "api";
}

function providerLabel(family: string): string {
  return PROVIDER_LABELS[family] ?? family;
}

function modelAvailabilityLabel(model: ModelDescriptor, isAvailable: boolean): string {
  if (!isAvailable) return "Not configured";
  if (model.isCliWrapped) return "Subscription ready";
  if (model.authTypes.includes("local")) return "Local runtime ready";
  return "API ready";
}

function tierLabel(tier: string): string {
  if (tier === "xhigh") return "Extra High";
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function ModelGlyph({ model, size = 12 }: { model: ModelDescriptor; size?: number }) {
  if (model.family === "anthropic" || model.cliCommand === "claude") {
    return <ClaudeLogo size={size} className="shrink-0" />;
  }
  if (model.cliCommand === "codex") {
    return <CodexLogo size={size} className="shrink-0 text-fg/80" />;
  }
  return (
    <span
      className="inline-block shrink-0 rounded-full"
      style={{ width: size * 0.55, height: size * 0.55, backgroundColor: model.color ?? "#A78BFA" }}
    />
  );
}

function matchesQuery(model: ModelDescriptor, query: string): boolean {
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

function mergeSelectorModels(availableModelIds?: string[], filter?: (model: ModelDescriptor) => boolean): ModelDescriptor[] {
  const merged = new Map<string, ModelDescriptor>();
  const availableSet = availableModelIds
    ? new Set(availableModelIds.map((entry) => String(entry ?? "").trim()).filter(Boolean))
    : null;

  for (const model of MODEL_REGISTRY) {
    if (model.deprecated) continue;
    if (filter && !filter(model)) continue;
    if (availableSet && !availableSet.has(model.id)) continue;
    merged.set(model.id, model);
  }
  for (const rawId of availableModelIds ?? []) {
    const modelId = String(rawId ?? "").trim();
    if (!modelId.length) continue;
    const descriptor = resolveModelDescriptor(modelId);
    if (!descriptor || descriptor.deprecated) continue;
    if (filter && !filter(descriptor)) continue;
    merged.set(descriptor.id, descriptor);
  }
  return [...merged.values()];
}

export function UnifiedModelSelector({
  value,
  onChange,
  filter,
  availableModelIds,
  className,
  disabled = false,
  showReasoning,
  reasoningEffort,
  onReasoningEffortChange,
  onConfigureMore,
}: UnifiedModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [activeBucket, setActiveBucket] = useState<SelectorBucket>("subscription");
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<PopupLayout | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const availableSet = useMemo(
    () => (availableModelIds ? new Set(availableModelIds.map((entry) => String(entry ?? "").trim()).filter(Boolean)) : null),
    [availableModelIds],
  );
  const modelOrder = useMemo(
    () => new Map(MODEL_REGISTRY.map((model, index) => [model.id, index])),
    [],
  );
  const selectorModels = useMemo(
    () => mergeSelectorModels(availableModelIds, filter),
    [availableModelIds, filter],
  );

  const grouped = useMemo(() => {
    const byBucket = new Map<SelectorBucket, Map<string, ModelDescriptor[]>>();
    for (const model of selectorModels) {
      if (!matchesQuery(model, query)) continue;
      const bucket = classifyBucket(model);
      const sections = byBucket.get(bucket) ?? new Map<string, ModelDescriptor[]>();
      const providerKey = model.family;
      const list = sections.get(providerKey) ?? [];
      list.push(model);
      sections.set(providerKey, list);
      byBucket.set(bucket, sections);
    }

    const orderedBuckets: SelectorBucket[] = ["subscription", "api", "local"];
    return orderedBuckets
      .map((bucket) => {
        const sections = byBucket.get(bucket);
        if (!sections?.size) return null;
        const sortedSections = [...sections.entries()]
          .map(([key, modelsForProvider]) => ({
            key,
            label: providerLabel(key),
            models: [...modelsForProvider].sort((a, b) => {
              if (availableSet) {
                const availabilityCompare =
                  Number(!availableSet.has(a.id)) - Number(!availableSet.has(b.id));
                if (availabilityCompare !== 0) return availabilityCompare;
              }
              return (modelOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (modelOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER);
            }),
          }))
          .sort((a, b) => {
            const leftOrder = PROVIDER_ORDER.indexOf(a.key);
            const rightOrder = PROVIDER_ORDER.indexOf(b.key);
            const orderCompare =
              (leftOrder === -1 ? Number.MAX_SAFE_INTEGER : leftOrder)
              - (rightOrder === -1 ? Number.MAX_SAFE_INTEGER : rightOrder);
            if (orderCompare !== 0) return orderCompare;
            return a.label.localeCompare(b.label);
          });
        return {
          key: bucket,
          ...BUCKET_LABELS[bucket],
          sections: sortedSections,
        } satisfies BucketGroup;
      })
      .filter((group): group is BucketGroup => group != null);
  }, [availableSet, modelOrder, query, selectorModels]);

  const selectedModel = useMemo(
    () => resolveModelDescriptor(value),
    [value],
  );
  const reasoningTiers = selectedModel?.reasoningTiers ?? [];
  const selectedBucket = useMemo(
    () => grouped.find((bucket) => bucket.sections.some((section) => section.models.some((model) => model.id === selectedModel?.id)))?.key ?? grouped[0]?.key ?? "subscription",
    [grouped, selectedModel?.id],
  );
  const activeGroup = grouped.find((bucket) => bucket.key === activeBucket) ?? grouped[0] ?? null;

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
    setActiveBucket((current) => {
      if (grouped.some((bucket) => bucket.key === current)) {
        return current;
      }
      return selectedBucket;
    });
  }, [grouped, selectedBucket]);

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

  const recomputeLayout = useCallback(() => {
    if (!open || !triggerRef.current || typeof window === "undefined") return;
    const rect = triggerRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const useModal = viewportWidth < 720 || rect.width > viewportWidth - 80;

    if (useModal) {
      const width = Math.min(460, viewportWidth - 24);
      const top = Math.max(12, Math.round(viewportHeight * 0.08));
      setLayout({
        mode: "modal",
        top,
        left: Math.round((viewportWidth - width) / 2),
        width,
        maxHeight: Math.max(260, viewportHeight - top - 12),
      });
      return;
    }

    const width = Math.min(Math.max(rect.width + 110, 400), viewportWidth - 24);
    const left = Math.max(12, Math.min(rect.left, viewportWidth - width - 12));
    const estimatedHeight = Math.min(panelRef.current?.offsetHeight ?? 420, viewportHeight - 24);
    const spaceBelow = viewportHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    const openUpwards = spaceBelow < 300 && spaceAbove > spaceBelow;
    const top = openUpwards
      ? Math.max(12, rect.top - estimatedHeight - 8)
      : Math.min(viewportHeight - estimatedHeight - 12, rect.bottom + 8);
    const maxHeight = Math.max(240, openUpwards ? rect.top - 20 : viewportHeight - rect.bottom - 20);
    setLayout({
      mode: "anchored",
      top,
      left,
      width,
      maxHeight,
    });
  }, [open]);

  useLayoutEffect(() => {
    recomputeLayout();
  }, [recomputeLayout, grouped, open, query]);

  useEffect(() => {
    if (!open) return;
    const handler = () => recomputeLayout();
    const triggerElement = triggerRef.current;
    const resizeObserver = typeof ResizeObserver !== "undefined" && triggerElement
      ? new ResizeObserver(() => recomputeLayout())
      : null;
    if (resizeObserver && triggerElement) {
      resizeObserver.observe(triggerElement);
    }
    window.addEventListener("resize", handler);
    window.addEventListener("scroll", handler, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", handler);
      window.removeEventListener("scroll", handler, true);
    };
  }, [open, recomputeLayout]);

  const handleSelect = (modelId: string, isAvailable: boolean) => {
    if (disabled || !isAvailable) return;
    onChange(modelId);
    setOpen(false);
  };

  const panel = open && layout ? createPortal(
    <>
      {layout.mode === "modal" ? (
        <div className="fixed inset-0 z-[79] bg-black/40 backdrop-blur-sm" />
      ) : null}
      <div
        ref={panelRef}
        role="listbox"
        className={cn(
          "fixed z-[80] overflow-hidden rounded-xl border border-white/[0.08] bg-[#1a1a1e] shadow-[var(--shadow-float)] backdrop-blur-xl",
          layout.mode === "modal" ? "w-full" : "",
        )}
        style={{
          top: layout.top,
          left: layout.left,
          width: layout.width,
          maxHeight: layout.maxHeight,
        }}
      >
        <div className="border-b border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted-fg/38">
              Model source
            </div>
            {layout.mode === "modal" ? (
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/12 text-muted-fg/55 transition-colors hover:border-border/24 hover:text-fg/80"
                onClick={() => setOpen(false)}
                aria-label="Close model picker"
              >
                <X size={12} weight="bold" />
              </button>
            ) : null}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {(["subscription", "api", "local"] as SelectorBucket[]).map((bucketKey) => {
              const bucket = grouped.find((entry) => entry.key === bucketKey);
              const isActive = activeGroup?.key === bucketKey;
              return (
                <button
                  key={bucketKey}
                  type="button"
                  disabled={!bucket}
                  className={cn(
                    "rounded-[12px] border px-2.5 py-2 text-left transition-colors",
                    bucket
                      ? isActive
                        ? "border-accent/35 bg-white/[0.06]"
                        : "border-border/10 bg-white/[0.02] hover:border-border/20 hover:bg-white/[0.04]"
                      : "cursor-not-allowed border-border/6 bg-white/[0.01] opacity-35",
                  )}
                  onClick={() => bucket && setActiveBucket(bucketKey)}
                >
                  <div
                    className="font-mono text-[9px] font-bold uppercase tracking-[0.16em]"
                    style={{ color: bucket?.badgeColor ?? "var(--color-muted-fg)" }}
                  >
                    {BUCKET_LABELS[bucketKey].label}
                  </div>
                  <div className="mt-1 font-mono text-[9px] text-muted-fg/42">
                    {bucket ? `${bucket.sections.reduce((count, section) => count + section.models.length, 0)} models` : "Unavailable"}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="mt-2.5 flex items-center gap-2 rounded-[14px] border border-border/10 bg-black/10 px-2.5 py-2">
            <MagnifyingGlass size={12} className="text-muted-fg/45" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models, ids, aliases..."
              className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-fg/80 outline-none placeholder:text-muted-fg/28"
              autoFocus
            />
          </div>
        </div>

        {activeGroup ? (
          <div
            className="overflow-y-auto"
            style={{ maxHeight: layout.maxHeight - 120 }}
          >
            <div className="flex items-center gap-2 border-b border-border/8 px-3 py-2">
              <span
                className="font-mono text-[9px] font-bold uppercase tracking-[0.18em]"
                style={{ color: `${activeGroup.badgeColor}CC` }}
              >
                {activeGroup.label}
              </span>
              <span
                className="inline-flex items-center rounded-full border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.14em]"
                style={{
                  color: activeGroup.badgeColor,
                  background: `${activeGroup.badgeColor}18`,
                  borderColor: `${activeGroup.badgeColor}30`,
                }}
              >
                {activeGroup.badgeText}
              </span>
            </div>

            {activeGroup.sections.length > 0 ? activeGroup.sections.map((section) => (
              <div key={`${activeGroup.key}:${section.key}`} className="border-b border-border/8 last:border-b-0">
                <div className="px-3 pt-2.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-muted-fg/35">
                  {section.label}
                </div>
                <div className="py-1.5">
                  {section.models.map((model) => {
                    const isSelected = model.id === selectedModel?.id;
                    const isAvailable = !availableSet || availableSet.has(model.id);
                    const callout = MODEL_CALLOUTS[model.id];
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        aria-disabled={!isAvailable}
                        className={cn(
                          "mx-1.5 flex w-[calc(100%-12px)] items-center gap-2 rounded-[12px] px-3 py-2 text-left font-mono text-[11px] transition-colors",
                          isSelected
                            ? "bg-accent/10 text-fg"
                            : isAvailable
                              ? "text-fg/72 hover:bg-border/8 hover:text-fg/92"
                              : "cursor-not-allowed text-muted-fg/28",
                        )}
                        onClick={() => handleSelect(model.id, isAvailable)}
                      >
                        <span className={cn("inline-flex flex-shrink-0 items-center justify-center", !isAvailable && "opacity-45")}>
                          <ModelGlyph model={model} size={13} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <div className="truncate">{model.displayName}</div>
                            {callout ? (
                              <span
                                className={cn(
                                  "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.14em]",
                                  callout.tone,
                                )}
                              >
                                {callout.label}
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-[9px] uppercase tracking-[0.12em] text-muted-fg/35">
                            {modelAvailabilityLabel(model, isAvailable)}
                          </div>
                        </div>
                        {isSelected ? (
                          <Check size={11} weight="bold" className="flex-shrink-0 text-accent" />
                        ) : (
                          <span className="w-[11px]" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )) : (
              <div className="px-4 py-5 font-mono text-[11px] text-muted-fg/45">
                No models match this search.
              </div>
            )}
          </div>
        ) : (
          <div className="px-4 py-5 font-mono text-[11px] text-muted-fg/45">
            No models available in this category.
          </div>
        )}

        {onConfigureMore ? (
          <div className="border-t border-border/12 px-3 py-2">
            <button
              type="button"
              className="font-mono text-[10px] text-accent/60 hover:text-accent"
              onClick={() => {
                setOpen(false);
                onConfigureMore();
              }}
            >
              + Configure more models...
            </button>
          </div>
        ) : null}
      </div>
    </>,
    document.body,
  ) : null;

  return (
    <div className={cn("flex max-w-full items-center gap-1.5", className)}>
      <div ref={containerRef} className="relative min-w-0">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            setOpen((current) => !current);
          }}
          className={cn(
            "inline-flex h-8 w-full min-w-[220px] max-w-full items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 font-mono text-[11px] text-fg/70",
            "transition-colors hover:border-white/[0.12] hover:bg-white/[0.06]",
            open && "border-white/[0.14] bg-white/[0.06]",
            disabled && "cursor-not-allowed opacity-70 hover:border-white/[0.08] hover:bg-white/[0.04]",
          )}
          aria-label="Select model"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          {selectedModel ? <ModelGlyph model={selectedModel} size={14} /> : null}
          <span className={cn("flex-1 truncate text-left", !selectedModel && !value && "text-muted-fg/40")}>
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
          className={cn(selectCls, "min-w-[120px]", disabled && "cursor-not-allowed opacity-70")}
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
