import { useMemo, useState, useRef, useEffect } from "react";
import {
  MODEL_REGISTRY,
  getModelById,
  type ModelDescriptor,
  type AuthType,
} from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { CaretDown, Check } from "@phosphor-icons/react";

type UnifiedModelSelectorProps = {
  value: string;
  onChange: (modelId: string) => void;
  filter?: (model: ModelDescriptor) => boolean;
  /** When provided, ONLY models in this set are shown (configured/available models). */
  availableModelIds?: string[];
  className?: string;
  /** When true, also render a reasoning tier selector next to the model picker. */
  showReasoning?: boolean;
  reasoningEffort?: string | null;
  onReasoningEffortChange?: (effort: string | null) => void;
  /** When provided, renders a "Configure more..." link that navigates to settings. */
  onConfigureMore?: () => void;
};

type AuthGroup = {
  label: string;
  authType: AuthType;
  models: ModelDescriptor[];
};

function classifyAuthGroup(model: ModelDescriptor): AuthType {
  if (model.isCliWrapped) return "cli-subscription";
  if (model.authTypes.includes("local")) return "local";
  if (model.authTypes.includes("openrouter")) return "api-key";
  return "api-key";
}

const GROUP_ORDER: AuthType[] = ["cli-subscription", "api-key", "local"];
const GROUP_LABELS: Record<AuthType, string> = {
  "cli-subscription": "CLI Subscription",
  "api-key": "API Key",
  oauth: "OAuth",
  openrouter: "OpenRouter",
  local: "Local",
};

function badgeForAuth(authGroup: AuthType): { text: string; color: string } {
  if (authGroup === "cli-subscription") return { text: "CLI", color: "#A78BFA" };
  if (authGroup === "local") return { text: "Local", color: "#F59E0B" };
  return { text: "API", color: "#22C55E" };
}

const selectCls = cn(
  "h-7 border border-border/40 bg-bg/70 px-2 text-xs",
  "outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30",
  "font-mono text-[11px]",
);

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
  const containerRef = useRef<HTMLDivElement | null>(null);

  const grouped = useMemo(() => {
    const available = availableModelIds ? new Set(availableModelIds) : null;

    let models = [...MODEL_REGISTRY].filter((m) => {
      if (m.deprecated) return false;
      if (available && !available.has(m.id)) return false;
      return true;
    });
    if (filter) {
      models = models.filter(filter);
    }

    const groups = new Map<AuthType, ModelDescriptor[]>();
    for (const m of models) {
      const group = classifyAuthGroup(m);
      const existing = groups.get(group);
      if (existing) {
        existing.push(m);
      } else {
        groups.set(group, [m]);
      }
    }

    const result: AuthGroup[] = [];
    for (const authType of GROUP_ORDER) {
      const list = groups.get(authType);
      if (!list?.length) continue;
      list.sort((a, b) => a.displayName.localeCompare(b.displayName));
      result.push({ label: GROUP_LABELS[authType], authType, models: list });
    }
    return result;
  }, [availableModelIds, filter]);

  const selectedModel = getModelById(value);
  const reasoningTiers = selectedModel?.reasoningTiers ?? [];

  /* Close dropdown when clicking outside */
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = (modelId: string) => {
    onChange(modelId);
    setOpen(false);
  };

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      {/* Custom dropdown trigger */}
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 border border-border/40 bg-bg/70 px-2 font-mono text-[11px] text-fg/80",
            "transition-colors hover:border-accent/30 hover:bg-surface-raised/50",
            open && "border-accent/40 bg-surface-raised/50"
          )}
          style={{ minWidth: 160 }}
          aria-label="Select model"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          {/* Color dot */}
          <span
            className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
            style={{ backgroundColor: selectedModel?.color ?? "#A78BFA" }}
          />
          {/* Model name */}
          <span className="flex-1 truncate text-left">
            {selectedModel?.displayName ?? value}
          </span>
          <CaretDown
            size={10}
            weight="bold"
            className={cn("flex-shrink-0 text-muted-fg/50 transition-transform", open && "rotate-180")}
          />
        </button>

        {/* Dropdown panel */}
        {open ? (
          <div
            role="listbox"
            className="absolute bottom-full left-0 z-50 mb-1 border border-border/25 bg-[#0F0D14]/98 shadow-[0_-8px_32px_-8px_rgba(0,0,0,0.8)]"
            style={{ minWidth: 240, maxHeight: 280, overflowY: "auto" }}
          >
            {grouped.map(({ label, authType, models }) => {
              const badge = badgeForAuth(authType);
              return (
                <div key={authType}>
                  {/* Group header */}
                  <div className="flex items-center gap-2 border-b border-border/8 px-3 py-1.5">
                    <span
                      className="font-mono text-[9px] font-bold uppercase tracking-[1.5px]"
                      style={{ color: badge.color + "90" }}
                    >
                      {label}
                    </span>
                    <span
                      className="inline-flex items-center px-1 py-0.5 font-mono text-[8px] font-bold uppercase"
                      style={{
                        color: badge.color,
                        background: badge.color + "18",
                        border: `1px solid ${badge.color}30`,
                      }}
                    >
                      {badge.text}
                    </span>
                  </div>
                  {/* Models in group */}
                  {models.map((m) => {
                    const isSelected = m.id === value;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[11px] transition-colors",
                          isSelected
                            ? "bg-accent/10 text-fg"
                            : "text-fg/70 hover:bg-border/8 hover:text-fg/90"
                        )}
                        onClick={() => handleSelect(m.id)}
                      >
                        {/* Color dot */}
                        <span
                          className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: m.color ?? "#A78BFA" }}
                        />
                        {/* Display name */}
                        <span className="flex-1 truncate">{m.displayName}</span>
                        {/* Selected check */}
                        {isSelected ? (
                          <Check size={11} weight="bold" className="flex-shrink-0 text-accent" />
                        ) : (
                          <span className="w-[11px]" />
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}

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

      {/* Reasoning effort selector */}
      {showReasoning && reasoningTiers.length > 0 && onReasoningEffortChange ? (
        <select
          value={reasoningEffort ?? ""}
          onChange={(e) => onReasoningEffortChange(e.target.value || null)}
          className={cn(selectCls, "min-w-[100px]")}
          style={{ borderRadius: 0 }}
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
