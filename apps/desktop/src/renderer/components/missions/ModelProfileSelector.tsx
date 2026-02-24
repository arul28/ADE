import React, { useMemo } from "react";
import type { MissionModelProfile } from "../../../shared/types";
import { BUILT_IN_PROFILES } from "../../../shared/modelProfiles";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";

type ModelProfileSelectorProps = {
  selectedProfileId: string | null;
  onSelect: (profile: MissionModelProfile | null) => void;
};

const PROFILE_ACTIVE_STYLES: Record<string, React.CSSProperties> = {
  standard: { background: "#A78BFA18", color: "#A78BFA", border: "1px solid #A78BFA30" },
  "fast-cheap": { background: "#22C55E18", color: "#22C55E", border: "1px solid #22C55E30" },
  "max-quality": { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" },
  "codex-only": { background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" },
  "claude-only": { background: "#06B6D418", color: "#06B6D4", border: "1px solid #06B6D430" },
};

const INACTIVE_STYLE: React.CSSProperties = {
  background: COLORS.cardBg,
  color: COLORS.textMuted,
  border: `1px solid ${COLORS.border}`,
};

const CUSTOM_ACTIVE_STYLE: React.CSSProperties = {
  background: "#71717A18",
  color: "#71717A",
  border: "1px solid #71717A30",
};

const PROFILE_DISPLAY_NAMES: Record<string, string> = {
  standard: "STANDARD",
  "fast-cheap": "FAST & CHEAP",
  "max-quality": "MAX QUALITY",
  "codex-only": "CODEX ONLY",
  "claude-only": "CLAUDE ONLY",
};

export function ModelProfileSelector({
  selectedProfileId,
  onSelect,
}: ModelProfileSelectorProps) {
  const isCustom = useMemo(
    () =>
      selectedProfileId === null ||
      !BUILT_IN_PROFILES.some((p) => p.id === selectedProfileId),
    [selectedProfileId]
  );

  return (
    <div className="flex flex-wrap gap-2">
      {BUILT_IN_PROFILES.map((profile) => {
        const isActive = selectedProfileId === profile.id;
        const activeStyle = PROFILE_ACTIVE_STYLES[profile.id] ?? INACTIVE_STYLE;
        return (
          <button
            key={profile.id}
            onClick={() => onSelect(profile)}
            title={profile.description}
            className="px-3 py-1.5 text-center transition-colors"
            style={{
              ...(isActive ? activeStyle : INACTIVE_STYLE),
              fontFamily: MONO_FONT,
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "1px",
              borderRadius: 0,
              cursor: "pointer",
            }}
          >
            {PROFILE_DISPLAY_NAMES[profile.id] ?? profile.name.toUpperCase()}
          </button>
        );
      })}

      {/* Custom button */}
      <button
        onClick={() => onSelect(null)}
        title="Custom model configuration"
        className="px-3 py-1.5 text-center transition-colors"
        style={{
          ...(isCustom ? CUSTOM_ACTIVE_STYLE : INACTIVE_STYLE),
          fontFamily: MONO_FONT,
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "1px",
          borderRadius: 0,
          cursor: "pointer",
        }}
      >
        CUSTOM
      </button>
    </div>
  );
}
