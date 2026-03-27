import React from "react";
import { cn } from "../../../ui/cn";

export type VisualSelectorOption = {
  value: string;
  label: string;
  description?: string;
  color?: string;
};

type Props = {
  options: VisualSelectorOption[];
  value: string;
  onChange: (value: string) => void;
};

export function VisualSelector({ options, value, onChange }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const active = opt.value === value;
        const accent = opt.color ?? "#38BDF8";
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex flex-col items-start rounded-xl px-3 py-2.5 text-left transition-all duration-200",
              "min-w-[120px] max-w-[180px] flex-1",
              !active && "hover:bg-white/[0.03]",
            )}
            style={{
              background: active ? `${accent}0D` : "rgba(19,24,34,0.6)",
              border: `1px solid ${active ? `${accent}40` : "rgba(255,255,255,0.06)"}`,
            }}
          >
            <span
              className="text-[11px] font-medium leading-tight"
              style={{ color: active ? accent : "var(--color-fg)" }}
            >
              {opt.label}
            </span>
            {opt.description && (
              <span className="mt-1 text-[10px] leading-snug text-muted-fg/40">
                {opt.description}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
