import React, { useMemo } from "react";
import {
  MODEL_REGISTRY,
  getModelById,
  type ModelDescriptor,
  type AuthType,
} from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";

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

const selectCls = cn(
  "h-7 border border-border/40 bg-bg/70 px-2 text-xs",
  "outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/30",
  "font-mono text-[11px]",
);

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
  "cli-subscription": "Subscription (CLI)",
  "api-key": "API Key",
  oauth: "OAuth",
  openrouter: "OpenRouter",
  local: "Local",
};

function badgeForAuth(authGroup: AuthType): { text: string; color: string } {
  if (authGroup === "cli-subscription") return { text: "(CLI)", color: "#A78BFA" };
  if (authGroup === "local") return { text: "(Local)", color: "#F59E0B" };
  return { text: "(API)", color: "#22C55E" };
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
  const grouped = useMemo(() => {
    const available = availableModelIds ? new Set(availableModelIds) : null;

    let models = [...MODEL_REGISTRY].filter((m) => {
      if (m.deprecated) return false;
      // Only show models the user has configured auth for
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

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(selectCls, "min-w-[180px]")}
        style={{ borderRadius: 0 }}
        aria-label="Model"
      >
        {grouped.map(({ label, authType, models }) => (
          <optgroup key={authType} label={label}>
            {models.map((m) => {
              const badge = badgeForAuth(classifyAuthGroup(m));
              return (
                <option key={m.id} value={m.id}>
                  {m.displayName} {badge.text}
                </option>
              );
            })}
          </optgroup>
        ))}
      </select>

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

      {onConfigureMore ? (
        <button
          onClick={onConfigureMore}
          className="text-[10px] hover:underline"
          style={{ color: "var(--color-accent, #A78BFA)", background: "none", border: "none", cursor: "pointer", whiteSpace: "nowrap" }}
        >
          + More models...
        </button>
      ) : null}
    </div>
  );
}
