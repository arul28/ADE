import React from "react";
import { LANE_COLOR_PALETTE } from "./laneColorPalette";

type Props = {
  value: string | null | undefined;
  onChange: (color: string | null) => void;
  usedColors?: Set<string>;
  showClear?: boolean;
  swatchSize?: number;
};

export function LaneColorPicker({
  value,
  onChange,
  usedColors,
  showClear = true,
  swatchSize = 22,
}: Props) {
  const selected = value?.toLowerCase() ?? null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {LANE_COLOR_PALETTE.map((entry) => {
        const isSelected = selected === entry.hex.toLowerCase();
        const isTaken = !isSelected && (usedColors?.has(entry.hex.toLowerCase()) ?? false);
        return (
          <button
            key={entry.hex}
            type="button"
            title={isTaken ? `${entry.name} — in use` : entry.name}
            disabled={isTaken}
            aria-label={entry.name}
            aria-pressed={isSelected}
            onClick={() => onChange(entry.hex)}
            style={{
              width: swatchSize,
              height: swatchSize,
              borderRadius: 9999,
              backgroundColor: entry.hex,
              opacity: isTaken ? 0.25 : 1,
              cursor: isTaken ? "not-allowed" : "pointer",
              outline: isSelected ? "2px solid var(--color-accent, #fff)" : "none",
              outlineOffset: 2,
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)",
              border: "none",
              padding: 0,
              transition: "transform 80ms",
            }}
            onMouseEnter={(e) => {
              if (!isTaken) e.currentTarget.style.transform = "scale(1.08)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "scale(1)";
            }}
          />
        );
      })}
      {showClear ? (
        <button
          type="button"
          title="Clear color"
          aria-label="Clear color"
          aria-pressed={selected === null}
          onClick={() => onChange(null)}
          style={{
            width: swatchSize,
            height: swatchSize,
            borderRadius: 9999,
            backgroundColor: "transparent",
            cursor: "pointer",
            outline: selected === null ? "2px solid var(--color-accent, #fff)" : "none",
            outlineOffset: 2,
            border: "1px dashed rgba(255,255,255,0.35)",
            padding: 0,
            color: "rgba(255,255,255,0.55)",
            fontSize: 11,
            lineHeight: `${swatchSize}px`,
          }}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
