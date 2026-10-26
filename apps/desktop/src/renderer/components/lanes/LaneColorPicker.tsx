import React from "react";
import { LANE_CLASSIC_COLORS, LANE_RAINBOW_COLORS, laneColorName, type LaneColor } from "./laneColorPalette";
import { fgTint } from "./laneDesignTokens";

type Props = {
  value: string | null | undefined;
  onChange: (color: string) => void;
  usedColors?: Set<string>;
  usedColorOwners?: Map<string, string>;
  swatchSize?: number;
  /** Wrap the swatches after this many per row (narrow surfaces like a menu). */
  maxPerRow?: number;
};

export function LaneColorPicker({
  value,
  onChange,
  usedColors,
  usedColorOwners,
  swatchSize = 22,
  maxPerRow,
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
        maxPerRow={maxPerRow}
      />
      <SwatchGroup
        label="Classic"
        colors={LANE_CLASSIC_COLORS}
        selected={selected}
        usedColors={usedColors}
        usedColorOwners={usedColorOwners}
        onChange={onChange}
        swatchSize={swatchSize}
        maxPerRow={maxPerRow}
        trailing={<CustomSwatch value={value ?? null} onChange={onChange} swatchSize={swatchSize} />}
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
  maxPerRow,
}: {
  label: string;
  colors: readonly LaneColor[];
  selected: string | null;
  usedColors?: Set<string>;
  usedColorOwners?: Map<string, string>;
  onChange: (color: string) => void;
  swatchSize: number;
  trailing?: React.ReactNode;
  maxPerRow?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: fgTint(55),
        }}
      >
        {label}
      </span>
      <div
        className="flex flex-wrap items-center gap-1.5"
        // gap-1.5 is 6px between swatches.
        style={maxPerRow ? { maxWidth: maxPerRow * swatchSize + (maxPerRow - 1) * 6 } : undefined}
      >
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

/**
 * Any colour at all, through the system colour panel. Filled with the lane's
 * colour when that colour is not one of the named swatches. The pick is saved
 * once, on the panel's `change`, not on every step of a drag.
 */
function CustomSwatch({
  value,
  onChange,
  swatchSize,
}: {
  value: string | null;
  onChange: (color: string) => void;
  swatchSize: number;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const custom = value && /^#[0-9a-f]{6}$/i.test(value) && !laneColorName(value) ? value : null;
  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const commit = () => onChangeRef.current(input.value);
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, []);
  return (
    <label
      title={custom ? `Custom colour ${custom}` : "Custom colour"}
      style={{
        position: "relative",
        width: swatchSize,
        height: swatchSize,
        borderRadius: 9999,
        cursor: "pointer",
        background: custom ?? "conic-gradient(#ef4444, #facc15, #22c55e, #22d3ee, #2563eb, #e879f9, #ef4444)",
        outline: custom ? "2px solid var(--color-accent, #fff)" : "none",
        outlineOffset: 2,
        boxShadow: `inset 0 0 0 1px ${fgTint(18)}`,
        display: "inline-flex",
        overflow: "hidden",
      }}
    >
      <input
        ref={inputRef}
        type="color"
        aria-label="Custom colour"
        defaultValue={custom ?? "#7dd3fc"}
        style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", border: "none", padding: 0 }}
      />
    </label>
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
        boxShadow: `inset 0 0 0 1px ${fgTint(18)}`,
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
