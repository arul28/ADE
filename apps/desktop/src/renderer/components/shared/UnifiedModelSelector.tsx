import { useMemo, useState, useRef, useEffect } from "react";
import {
  MODEL_REGISTRY,
  getModelById,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { CaretDown, Check } from "@phosphor-icons/react";

type UnifiedModelSelectorProps = {
  value: string;
  onChange: (modelId: string) => void;
  filter?: (model: ModelDescriptor) => boolean;
  availableModelIds?: string[];
  className?: string;
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
  "openai/gpt-5-chat-latest": {
    label: "ChatGPT",
    tone: "border-green-400/25 bg-green-400/10 text-green-200",
  },
  "openai/gpt-5.4-pro": {
    label: "Latest Pro",
    tone: "border-cyan-400/25 bg-cyan-400/10 text-cyan-200",
  },
  "openai/gpt-5.3-codex": {
    label: "Coding",
    tone: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  },
  "openai/gpt-5.3-codex-api": {
    label: "Coding",
    tone: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  },
};

const selectCls = cn(
  "h-7 border border-border/40 bg-bg/70 px-2 text-xs",
  "outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30",
  "font-mono text-[11px]",
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

export function UnifiedModelSelector({
  value,
  onChange,
  filter,
  availableModelIds,
  className,
  showReasoning,
  reasoningEffort,
  onReasoningEffortChange,
  onConfigureMore,
}: UnifiedModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [activeBucket, setActiveBucket] = useState<SelectorBucket>("subscription");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const availableSet = useMemo(
    () => (availableModelIds ? new Set(availableModelIds.map((entry) => String(entry ?? "").trim()).filter(Boolean)) : null),
    [availableModelIds],
  );
  const modelOrder = useMemo(
    () => new Map(MODEL_REGISTRY.map((model, index) => [model.id, index])),
    [],
  );

  const grouped = useMemo(() => {
    let models = MODEL_REGISTRY.filter((model) => !model.deprecated);
    if (filter) {
      models = models.filter(filter);
    }

    const byBucket = new Map<SelectorBucket, Map<string, ModelDescriptor[]>>();
    for (const model of models) {
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
              return (modelOrder.get(a.id) ?? 0) - (modelOrder.get(b.id) ?? 0);
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
  }, [availableSet, filter, modelOrder]);

  const selectedModel = getModelById(value);
  const reasoningTiers = selectedModel?.reasoningTiers ?? [];
  const selectedBucket = useMemo(
    () => grouped.find((bucket) => bucket.sections.some((section) => section.models.some((model) => model.id === value)))?.key ?? grouped[0]?.key ?? "subscription",
    [grouped, value],
  );
  const activeGroup = grouped.find((bucket) => bucket.key === activeBucket) ?? grouped[0] ?? null;

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    setActiveBucket((current) => {
      if (grouped.some((bucket) => bucket.key === current)) {
        return current;
      }
      return selectedBucket;
    });
  }, [grouped, selectedBucket]);

  const handleSelect = (modelId: string, isAvailable: boolean) => {
    if (!isAvailable) return;
    onChange(modelId);
    setOpen(false);
  };

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-[14px] border border-border/40 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.012))] px-3 font-mono text-[11px] text-fg/80",
            "transition-colors hover:border-accent/30 hover:bg-surface-raised/50",
            open && "border-accent/40 bg-surface-raised/50",
          )}
          style={{ minWidth: 220 }}
          aria-label="Select model"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span
            className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
            style={{ backgroundColor: selectedModel?.color ?? "#A78BFA" }}
          />
          <span className="flex-1 truncate text-left">
            {selectedModel?.displayName ?? value}
          </span>
          <CaretDown
            size={10}
            weight="bold"
            className={cn("flex-shrink-0 text-muted-fg/50 transition-transform", open && "rotate-180")}
          />
        </button>

        {open ? (
          <div
            role="listbox"
            className="absolute bottom-full left-0 z-50 mb-3 w-[380px] max-w-[86vw] overflow-hidden rounded-[22px] border border-border/16 bg-card/95 shadow-[var(--shadow-float)] backdrop-blur-xl"
            style={{ maxHeight: 360 }}
          >
            <div className="border-b border-border/10 bg-[linear-gradient(90deg,rgba(167,139,250,0.08),transparent)] px-3 py-2.5">
              <div className="mb-2 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-muted-fg/38">
                Model source
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
            </div>

            {activeGroup ? (
              <div className="max-h-[292px] overflow-y-auto">
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

                {activeGroup.sections.map((section) => (
                  <div key={`${activeGroup.key}:${section.key}`} className="border-b border-border/8 last:border-b-0">
                    <div className="px-3 pt-2.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-muted-fg/35">
                      {section.label}
                    </div>
                    <div className="py-1.5">
                      {section.models.map((model) => {
                        const isSelected = model.id === value;
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
                            <span
                              className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
                              style={{ backgroundColor: model.color ?? "#A78BFA", opacity: isAvailable ? 1 : 0.45 }}
                            />
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
                ))}
              </div>
            ) : null}

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
        ) : null}
      </div>

      {showReasoning && reasoningTiers.length > 0 && onReasoningEffortChange ? (
        <select
          value={reasoningEffort ?? ""}
          onChange={(event) => onReasoningEffortChange(event.target.value || null)}
          className={cn(selectCls, "min-w-[120px] rounded-[12px]")}
          aria-label="Reasoning effort"
        >
          {reasoningTiers.map((tier) => (
            <option key={tier} value={tier}>
              {tier === "xhigh" ? "Extra High" : tier.charAt(0).toUpperCase() + tier.slice(1)}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
