import React from "react";
import { LANE_CLASSIC_COLORS, LANE_RAINBOW_COLORS, type LaneColor } from "./laneColorPalette";

type Props = {
  value: string | null | undefined;
  onChange: (color: string | null) => void;
  usedColors?: Set<string>;
  usedColorOwners?: Map<string, string>;
  showClear?: boolean;
  swatchSize?: number;
};

export function LaneColorPicker({
  value,
  onChange,
  usedColors,
  usedColorOwners,
  showClear = true,
  swatchSize = 22,
}: Props) {
  const selected = value?.toLowerCase() ?? null;

  return (
    <div className="flex flex-col gap-2">
      <SwatchGroup
        label="Rainbow"
        colors={LANE_RAINBOW_COLORS}
        selected={selected}
        usedColors={usedColors}
        usedColorOwners={usedColorOwners}
        onChange={onChange}
        swatchSize={swatchSize}
      />
      <SwatchGroup
        label="Classic"
        colors={LANE_CLASSIC_COLORS}
        selected={selected}
        usedColors={usedColors}
        usedColorOwners={usedColorOwners}
        onChange={onChange}
        swatchSize={swatchSize}
        trailing={showClear ? (
          <ClearButton selected={selected === null} onClear={() => onChange(null)} swatchSize={swatchSize} />
        ) : null}
      />
    </div>
  );
}

function SwatchGroup({
  label,
  colors,
  selected,
  usedColors,
  usedColorOwners,
  onChange,
  swatchSize,
  trailing,
}: {
  label: string;
  colors: readonly LaneColor[];
  selected: string | null;
  usedColors?: Set<string>;
  usedColorOwners?: Map<string, string>;
  onChange: (color: string) => void;
  swatchSize: number;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "color-mix(in srgb, var(--color-fg) 55%, transparent)",
        }}
      >
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {colors.map((entry) => {
          const isSelected = selected === entry.hex.toLowerCase();
          const isTaken = !isSelected && (usedColors?.has(entry.hex.toLowerCase()) ?? false);
          const owner = isTaken ? usedColorOwners?.get(entry.hex.toLowerCase()) ?? null : null;
          return (
            <Swatch
              key={entry.hex}
              entry={entry}
              isSelected={isSelected}
              isTaken={isTaken}
              owner={owner}
              swatchSize={swatchSize}
              onClick={() => onChange(entry.hex)}
            />
          );
        })}
        {trailing}
      </div>
    </div>
  );
}

function Swatch({
  entry,
  isSelected,
  isTaken,
  owner,
  swatchSize,
  onClick,
}: {
  entry: LaneColor;
  isSelected: boolean;
  isTaken: boolean;
  owner: string | null;
  swatchSize: number;
  onClick: () => void;
}) {
  const title = isTaken
    ? owner
      ? `${entry.name} — used by ${owner}`
      : `${entry.name} — in use`
    : entry.name;
  return (
    <button
      type="button"
      title={title}
      disabled={isTaken}
      aria-label={title}
      aria-pressed={isSelected}
      onClick={onClick}
      style={{
        position: "relative",
        width: swatchSize,
        height: swatchSize,
        borderRadius: 9999,
        backgroundColor: entry.hex,
        opacity: isTaken ? 0.65 : 1,
        cursor: isTaken ? "not-allowed" : "pointer",
        outline: isSelected ? "2px solid var(--color-accent, #fff)" : "none",
        outlineOffset: 2,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.18)",
        border: "none",
        padding: 0,
        transition: "transform 80ms",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onMouseEnter={(e) => {
        if (!isTaken) e.currentTarget.style.transform = "scale(1.08)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "scale(1)";
      }}
    >
      {isTaken ? (
        <svg
          width={Math.max(10, Math.floor(swatchSize * 0.55))}
          height={Math.max(10, Math.floor(swatchSize * 0.55))}
          viewBox="0 0 16 16"
          fill="none"
          style={{ color: "rgba(255,255,255,0.95)", filter: "drop-shadow(0 1px 1px rgba(0,0,0,0.45))" }}
        >
          <path d="M3.5 8.5l3 3 6-6" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </button>
  );
}

function ClearButton({
  selected,
  onClear,
  swatchSize,
}: {
  selected: boolean;
  onClear: () => void;
  swatchSize: number;
}) {
  return (
    <button
      type="button"
      title="Clear color"
      aria-label="Clear color"
      aria-pressed={selected}
      onClick={onClear}
      style={{
        width: swatchSize,
        height: swatchSize,
        borderRadius: 9999,
        backgroundColor: "transparent",
        cursor: "pointer",
        outline: selected ? "2px solid var(--color-accent, #fff)" : "none",
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
  );
}
