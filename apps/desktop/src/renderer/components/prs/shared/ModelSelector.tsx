import React from "react";
import { cn } from "../../ui/cn";

type ModelSelectorProps = {
  model: "codex" | "claude";
  reasoningLevel: string;
  onChange: (model: "codex" | "claude", reasoningLevel: string) => void;
};

const MODELS: Array<{ value: "codex" | "claude"; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
];

const REASONING_LEVELS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const selectCls = cn(
  "h-7 rounded-md border border-border/30 bg-card/60 px-2 text-xs text-foreground",
  "focus:outline-none focus:ring-1 focus:ring-accent/40",
);

export function ModelSelector({ model, reasoningLevel, onChange }: ModelSelectorProps) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <select
        value={model}
        onChange={(e) => onChange(e.target.value as "codex" | "claude", reasoningLevel)}
        className={selectCls}
      >
        {MODELS.map((m) => (
          <option key={m.value} value={m.value}>
            {m.label}
          </option>
        ))}
      </select>
      <select
        value={reasoningLevel}
        onChange={(e) => onChange(model, e.target.value)}
        className={selectCls}
      >
        {REASONING_LEVELS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
    </div>
  );
}
