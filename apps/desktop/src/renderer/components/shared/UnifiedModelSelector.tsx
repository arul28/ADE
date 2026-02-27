import React, { useMemo } from "react";
import {
  MODEL_REGISTRY,
  MODEL_FAMILIES,
  getModelById,
  type ModelDescriptor,
  type ProviderFamily,
} from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";

type UnifiedModelSelectorProps = {
  value: string;
  onChange: (modelId: string) => void;
  filter?: (model: ModelDescriptor) => boolean;
  availableModelIds?: string[];
  className?: string;
  /** When true, also render a reasoning tier selector next to the model picker. */
  showReasoning?: boolean;
  reasoningEffort?: string | null;
  onReasoningEffortChange?: (effort: string | null) => void;
  /** When provided, renders an "Add more providers..." link below the select. */
  onAddProvider?: () => void;
};

const selectCls = cn(
  "h-7 rounded border border-border/40 bg-bg/70 px-2 text-xs",
  "outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30",
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
  onAddProvider,
}: UnifiedModelSelectorProps) {
  const grouped = useMemo(() => {
    let models = [...MODEL_REGISTRY].filter((m) => !m.deprecated);
    if (availableModelIds) {
      const allowed = new Set(availableModelIds);
      models = models.filter((m) => allowed.has(m.id));
    }
    if (filter) {
      models = models.filter(filter);
    }
    const groups = new Map<ProviderFamily, ModelDescriptor[]>();
    for (const m of models) {
      const existing = groups.get(m.family);
      if (existing) {
        existing.push(m);
      } else {
        groups.set(m.family, [m]);
      }
    }
    return groups;
  }, [availableModelIds, filter]);

  const selectedModel = getModelById(value);
  const reasoningTiers = selectedModel?.reasoningTiers ?? [];

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(selectCls, "min-w-[180px]")}
      >
        {[...grouped.entries()].map(([family, models]) => (
          <optgroup key={family} label={MODEL_FAMILIES[family].displayName}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      {showReasoning && reasoningTiers.length > 0 && onReasoningEffortChange ? (
        <select
          value={reasoningEffort ?? ""}
          onChange={(e) => onReasoningEffortChange(e.target.value || null)}
          className={cn(selectCls, "min-w-[100px]")}
          aria-label="Reasoning effort"
        >
          {reasoningTiers.map((tier) => (
            <option key={tier} value={tier}>
              {tier.charAt(0).toUpperCase() + tier.slice(1)}
            </option>
          ))}
        </select>
      ) : null}

      {onAddProvider ? (
        <button
          onClick={onAddProvider}
          className="text-[10px] hover:underline"
          style={{ color: "var(--color-accent, #A78BFA)", background: "none", border: "none", cursor: "pointer", whiteSpace: "nowrap" }}
        >
          + Add more providers...
        </button>
      ) : null}
    </div>
  );
}
