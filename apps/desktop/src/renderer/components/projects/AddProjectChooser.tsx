import React, { useState, type CSSProperties, type KeyboardEvent } from "react";
import { DesktopTower, FolderOpen, GithubLogo, Sparkle } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";

export type AddProjectChooserMode = "open" | "create" | "clone" | "remote";

export type AddProjectChooserProps = {
  onChoose: (mode: AddProjectChooserMode) => void;
};

type Tile = {
  mode: AddProjectChooserMode;
  label: string;
  tagline: string;
  Icon: typeof FolderOpen;
  iconWeight: "regular" | "fill" | "duotone" | "bold";
  iconSize: number;
  /** Hex used for the icon glow + accent border. */
  hue: string;
  /** Soft inner gradient pair. */
  bgFrom: string;
  bgTo: string;
};

const TILES: readonly Tile[] = [
  {
    mode: "open",
    label: "OPEN",
    tagline: "a folder you have",
    Icon: FolderOpen,
    iconWeight: "duotone",
    iconSize: 38,
    hue: "#60A5FA",
    bgFrom: "rgba(96,165,250,0.18)",
    bgTo: "rgba(96,165,250,0.04)",
  },
  {
    mode: "create",
    label: "CREATE",
    tagline: "a brand-new project",
    Icon: Sparkle,
    iconWeight: "fill",
    iconSize: 34,
    hue: "#A78BFA",
    bgFrom: "rgba(167,139,250,0.22)",
    bgTo: "rgba(167,139,250,0.05)",
  },
  {
    mode: "clone",
    label: "CLONE",
    tagline: "from GitHub",
    Icon: GithubLogo,
    iconWeight: "fill",
    iconSize: 38,
    hue: "#34D399",
    bgFrom: "rgba(52,211,153,0.18)",
    bgTo: "rgba(52,211,153,0.04)",
  },
  {
    mode: "remote",
    label: "REMOTE",
    tagline: "connect by SSH",
    Icon: DesktopTower,
    iconWeight: "duotone",
    iconSize: 38,
    hue: "#F59E0B",
    bgFrom: "rgba(245,158,11,0.18)",
    bgTo: "rgba(245,158,11,0.04)",
  },
] as const;

export function AddProjectChooser({ onChoose }: AddProjectChooserProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 16,
        width: "100%",
      }}
    >
      {TILES.map((tile) => (
        <ChooserTile key={tile.mode} tile={tile} onChoose={onChoose} />
      ))}
    </div>
  );
}

function ChooserTile({
  tile,
  onChoose,
}: {
  tile: Tile;
  onChoose: (mode: AddProjectChooserMode) => void;
}) {
  const [hover, setHover] = useState(false);
  const Icon = tile.Icon;

  const card: CSSProperties = {
    position: "relative",
    height: 200,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: 24,
    borderRadius: 16,
    cursor: "pointer",
    userSelect: "none",
    overflow: "hidden",
    background: `radial-gradient(120% 90% at 50% 0%, ${tile.bgFrom}, ${tile.bgTo} 60%, transparent 100%), color-mix(in srgb, var(--color-card) 92%, ${tile.hue})`,
    border: `1px solid ${
      hover
        ? `color-mix(in srgb, ${tile.hue} 65%, transparent)`
        : "color-mix(in srgb, var(--color-border) 80%, transparent)"
    }`,
    transition: "transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease, background 180ms ease",
    transform: hover ? "translateY(-3px)" : "translateY(0)",
    boxShadow: hover
      ? `0 22px 48px -18px color-mix(in srgb, ${tile.hue} 55%, transparent), 0 0 0 1px color-mix(in srgb, ${tile.hue} 35%, transparent), inset 0 1px 0 0 color-mix(in srgb, ${tile.hue} 30%, transparent)`
      : `0 6px 16px -10px rgba(0,0,0,0.4), inset 0 1px 0 0 color-mix(in srgb, ${tile.hue} 14%, transparent)`,
  };

  const iconRing: CSSProperties = {
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 64,
    height: 64,
    borderRadius: 18,
    background: `linear-gradient(140deg, color-mix(in srgb, ${tile.hue} 30%, transparent), color-mix(in srgb, ${tile.hue} 8%, transparent))`,
    boxShadow: hover
      ? `inset 0 0 0 1px color-mix(in srgb, ${tile.hue} 50%, transparent), 0 8px 24px -10px color-mix(in srgb, ${tile.hue} 60%, transparent)`
      : `inset 0 0 0 1px color-mix(in srgb, ${tile.hue} 25%, transparent)`,
    color: tile.hue,
    transition: "box-shadow 180ms ease",
  };

  const headline: CSSProperties = {
    fontFamily: MONO_FONT,
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: "0.22em",
    color: COLORS.textPrimary,
  };

  const tagline: CSSProperties = {
    fontFamily: SANS_FONT,
    fontSize: 12,
    color: COLORS.textMuted,
    textAlign: "center",
  };

  // Subtle ambient glow blob behind the icon for warmth.
  const glow: CSSProperties = {
    position: "absolute",
    top: -30,
    left: "50%",
    transform: "translateX(-50%)",
    width: 220,
    height: 160,
    borderRadius: "50%",
    background: `radial-gradient(closest-side, color-mix(in srgb, ${tile.hue} ${hover ? 22 : 12}%, transparent), transparent 70%)`,
    pointerEvents: "none",
    transition: "background 180ms ease",
  };

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onChoose(tile.mode);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${tile.label} — ${tile.tagline}`}
      style={card}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      onClick={() => onChoose(tile.mode)}
      onKeyDown={handleKey}
    >
      <span style={glow} aria-hidden />
      <span style={iconRing}>
        <Icon size={tile.iconSize} weight={tile.iconWeight} />
      </span>
      <span style={headline}>{tile.label}</span>
      <span style={tagline}>{tile.tagline}</span>
    </div>
  );
}
