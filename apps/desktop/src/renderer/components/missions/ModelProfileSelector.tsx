import React, { useEffect, useMemo, useState } from "react";
import type { MissionModelProfile, PhaseProfile, ModelConfig } from "../../../shared/types";
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

const USER_PROFILE_ACTIVE_STYLE: React.CSSProperties = {
  background: `${COLORS.accent}18`,
  color: COLORS.accent,
  border: `1px solid ${COLORS.accent}30`,
};

const PROFILE_DISPLAY_NAMES: Record<string, string> = {
  standard: "STANDARD",
  "fast-cheap": "FAST",
  "max-quality": "MAX",
  "codex-only": "CODEX",
  "claude-only": "CLAUDE",
};

const COST_TIER_LABEL: Record<string, string> = {
  standard: "$$",
  "fast-cheap": "$",
  "max-quality": "$$$$",
  "codex-only": "$$$",
  "claude-only": "$$$",
};

const DEFAULT_MODEL: ModelConfig = { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" };

/** Map PhaseProfile phase keys to MissionModelProfile phaseDefaults keys */
const PHASE_KEY_MAP: Record<string, keyof MissionModelProfile["phaseDefaults"]> = {
  planning: "planning",
  development: "implementation",
  testing: "testing",
  validation: "validation",
  prAndConflicts: "prReview",
  codeReview: "codeReview",
  testReview: "testReview",
};

/** Convert a PhaseProfile from the backend into a MissionModelProfile for the selector */
function phaseProfileToModelProfile(pp: PhaseProfile): MissionModelProfile {
  const phaseDefaults: MissionModelProfile["phaseDefaults"] = {
    planning: DEFAULT_MODEL,
    implementation: DEFAULT_MODEL,
    testing: DEFAULT_MODEL,
    validation: DEFAULT_MODEL,
    codeReview: DEFAULT_MODEL,
    testReview: DEFAULT_MODEL,
    prReview: DEFAULT_MODEL,
  };

  // Extract model configs from phase cards
  for (const card of pp.phases) {
    const mappedKey = PHASE_KEY_MAP[card.phaseKey];
    if (mappedKey && card.model) {
      phaseDefaults[mappedKey] = card.model;
    }
  }

  // Use the planning model as the orchestrator model (reasonable default)
  const orchestratorModel = phaseDefaults.planning;

  return {
    id: pp.id,
    name: pp.name,
    description: pp.description || `Custom profile with ${pp.phases.length} phases`,
    isBuiltIn: false,
    orchestratorModel,
    decisionTimeoutCapHours: 24,
    phaseDefaults,
    intelligenceConfig: {
      coordinator: orchestratorModel,
      chat_response: orchestratorModel,
    },
  };
}

/** Estimate cost tier from models used in a profile */
function estimateCostTier(profile: MissionModelProfile): string {
  const models = [
    profile.orchestratorModel?.modelId,
    profile.phaseDefaults?.planning?.modelId,
    profile.phaseDefaults?.implementation?.modelId,
  ].filter(Boolean);

  const hasExpensive = models.some(
    (m) => m?.includes("opus") || m?.includes("5.1-codex-max")
  );
  const hasCheap = models.every(
    (m) => m?.includes("haiku") || m?.includes("mini") || m?.includes("o4-mini")
  );

  if (hasExpensive) return "$$$$";
  if (hasCheap) return "$";
  return "$$";
}

/** Short summary of model choices for a profile */
function profileSummary(profile: MissionModelProfile): string {
  const orch = profile.orchestratorModel?.modelId ?? "auto";
  const planModel = profile.phaseDefaults?.planning?.modelId;
  const implModel = profile.phaseDefaults?.implementation?.modelId;
  const parts: string[] = [];
  if (planModel && planModel !== orch) parts.push(`Plan: ${shortModelName(planModel)}`);
  else parts.push(`Orch: ${shortModelName(orch)}`);
  if (implModel) parts.push(`Impl: ${shortModelName(implModel)}`);
  return parts.join(", ");
}

function shortModelName(modelId: string): string {
  if (modelId.includes("opus")) return "Opus";
  if (modelId.includes("sonnet")) return "Sonnet";
  if (modelId.includes("haiku")) return "Haiku";
  if (modelId.includes("5.3-codex-spark")) return "Codex Spark";
  if (modelId.includes("5.3-codex")) return "Codex 5.3";
  if (modelId.includes("5.2-codex")) return "Codex 5.2";
  if (modelId.includes("5.1-codex")) return "Codex Max";
  if (modelId.includes("codex-mini")) return "Codex Mini";
  if (modelId.includes("o4-mini")) return "O4 Mini";
  if (modelId.includes("o3")) return "O3";
  return modelId;
}

export function ModelProfileSelector({
  selectedProfileId,
  onSelect,
}: ModelProfileSelectorProps) {
  const [userProfiles, setUserProfiles] = useState<MissionModelProfile[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Load custom profiles from backend on mount
  useEffect(() => {
    let cancelled = false;
    void window.ade.missions
      .listPhaseProfiles({})
      .then((phaseProfiles: PhaseProfile[]) => {
        if (cancelled) return;
        const custom = phaseProfiles
          .filter((pp) => !pp.isBuiltIn)
          .map(phaseProfileToModelProfile);
        setUserProfiles(custom);
      })
      .catch(() => {
        // Silently ignore -- built-in profiles are always available
      });
    return () => { cancelled = true; };
  }, []);

  const allProfiles = useMemo(
    () => [...BUILT_IN_PROFILES, ...userProfiles],
    [userProfiles]
  );

  const isManualCustom = useMemo(
    () =>
      selectedProfileId === null ||
      selectedProfileId === "custom" ||
      !allProfiles.some((p) => p.id === selectedProfileId),
    [selectedProfileId, allProfiles]
  );

  const activeProfile = useMemo(
    () => allProfiles.find((p) => p.id === selectedProfileId) ?? null,
    [selectedProfileId, allProfiles]
  );

  /** Find any profile (built-in or user) by id */
  const findProfile = (id: string): MissionModelProfile | null =>
    allProfiles.find((p) => p.id === id) ?? null;

  return (
    <div>
      {/* Built-in profiles row */}
      <div className="flex gap-1 flex-wrap">
        {BUILT_IN_PROFILES.map((profile) => {
          const isActive = selectedProfileId === profile.id;
          const activeStyle = PROFILE_ACTIVE_STYLES[profile.id] ?? INACTIVE_STYLE;
          const costLabel = COST_TIER_LABEL[profile.id] ?? "";
          return (
            <button
              key={profile.id}
              onClick={() => onSelect(profile)}
              onMouseEnter={() => setHoveredId(profile.id)}
              onMouseLeave={() => setHoveredId(null)}
              title={profile.description}
              className="px-2 py-1 text-center transition-colors"
              style={{
                ...(isActive ? activeStyle : INACTIVE_STYLE),
                fontFamily: MONO_FONT,
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "1px",
                borderRadius: 0,
                cursor: "pointer",
              }}
            >
              <div>{PROFILE_DISPLAY_NAMES[profile.id] ?? profile.name.toUpperCase()}</div>
              {costLabel && (
                <div style={{ fontSize: 8, opacity: 0.7, marginTop: 1 }}>{costLabel}</div>
              )}
            </button>
          );
        })}

        {/* Custom (manual) button */}
        <button
          onClick={() => onSelect(null)}
          onMouseEnter={() => setHoveredId("custom")}
          onMouseLeave={() => setHoveredId(null)}
          title="Custom model configuration"
          className="px-2 py-1 text-center transition-colors"
          style={{
            ...(isManualCustom ? CUSTOM_ACTIVE_STYLE : INACTIVE_STYLE),
            fontFamily: MONO_FONT,
            fontSize: 10,
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

      {/* User-created profiles row */}
      {userProfiles.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div
            style={{
              fontSize: 9,
              fontWeight: 700,
              fontFamily: MONO_FONT,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: COLORS.textDim,
              marginBottom: 4,
            }}
          >
            SAVED PROFILES
          </div>
          <div className="flex gap-1 flex-wrap">
            {userProfiles.map((profile) => {
              const isActive = selectedProfileId === profile.id;
              const costLabel = estimateCostTier(profile);
              return (
                <button
                  key={profile.id}
                  onClick={() => onSelect(profile)}
                  onMouseEnter={() => setHoveredId(profile.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  title={profile.description}
                  className="px-2 py-1 text-center transition-colors"
                  style={{
                    ...(isActive ? USER_PROFILE_ACTIVE_STYLE : INACTIVE_STYLE),
                    fontFamily: MONO_FONT,
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "1px",
                    borderRadius: 0,
                    cursor: "pointer",
                    maxWidth: 120,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <div
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {profile.name.toUpperCase()}
                  </div>
                  {costLabel && (
                    <div style={{ fontSize: 8, opacity: 0.7, marginTop: 1 }}>{costLabel}</div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Description line for selected or hovered profile */}
      {(() => {
        const showProfile = hoveredId
          ? (hoveredId === "custom" ? null : findProfile(hoveredId))
          : activeProfile;
        const isHoverCustom = hoveredId === "custom";
        if (isHoverCustom) {
          return (
            <div className="mt-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              Manual model selection per phase
            </div>
          );
        }
        if (showProfile) {
          return (
            <div className="mt-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              {showProfile.description} ({profileSummary(showProfile)})
            </div>
          );
        }
        if (isManualCustom && !hoveredId) {
          return (
            <div className="mt-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              Manual model selection per phase
            </div>
          );
        }
        return null;
      })()}
    </div>
  );
}
