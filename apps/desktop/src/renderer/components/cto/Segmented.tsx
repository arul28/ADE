import React from "react";
import { cn } from "../ui/cn";

export type SegmentedOption = { value: string; label: string };

/**
 * Compact segmented control used for the CTO's work-style rows. Accent is
 * personality-tinted via `accentRgb` so it stays in the CTO's color world.
 */
export function Segmented({
  options,
  value,
  onChange,
  accentRgb,
  ariaLabel,
}: {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  accentRgb: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-lg border border-white/[0.07] bg-black/20 p-0.5"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-[7px] px-3 py-1 text-[11.5px] font-medium transition-colors duration-150",
              selected ? "text-fg" : "text-muted-fg/45 hover:text-muted-fg/75",
            )}
            style={
              selected
                ? {
                    background: `rgba(${accentRgb}, 0.16)`,
                    boxShadow: `inset 0 0 0 1px rgba(${accentRgb}, 0.3)`,
                  }
                : undefined
            }
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
