import React, { useCallback, useEffect, useState } from "react";
import type {
  AiFeatureKey,
  AiConfig,
  AiSettingsStatus,
  AiModelDescriptor,
} from "../../../shared/types";
import {
  COLORS,
  MONO_FONT,
  LABEL_STYLE,
  cardStyle,
} from "../lanes/laneDesignTokens";

type FeatureInfo = {
  key: AiFeatureKey;
  label: string;
  description: string;
  defaultModel: string;
};

const FEATURES: FeatureInfo[] = [
  { key: "terminal_summaries", label: "Terminal Summaries", description: "Summarize terminal sessions when they close", defaultModel: "haiku" },
  { key: "pr_descriptions", label: "PR Descriptions", description: "Auto-draft PR descriptions from lane changes", defaultModel: "haiku" },
  { key: "narratives", label: "Narratives", description: "Generate work narratives for completed tasks", defaultModel: "haiku" },
  { key: "conflict_proposals", label: "Conflict Proposals", description: "Suggest resolutions for merge conflicts", defaultModel: "sonnet" },
  { key: "mission_planning", label: "Mission Planning", description: "AI-powered mission planning", defaultModel: "sonnet" },
  { key: "orchestrator", label: "Orchestrator", description: "AI orchestrator for mission execution", defaultModel: "sonnet" },
  { key: "initial_context", label: "Initial Context", description: "Generate initial project context", defaultModel: "sonnet" },
];

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 10,
};

const selectStyle: React.CSSProperties = {
  height: 28,
  padding: "0 6px",
  fontSize: 11,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  borderRadius: 0,
  outline: "none",
  appearance: "none",
  WebkitAppearance: "none",
  cursor: "pointer",
  minWidth: 100,
};

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 36,
        height: 20,
        borderRadius: 10,
        border: "none",
        background: checked ? COLORS.accent : COLORS.outlineBorder,
        cursor: "pointer",
        padding: 0,
        flexShrink: 0,
        transition: "background 150ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: 8,
          background: COLORS.textPrimary,
          transition: "left 150ms ease",
        }}
      />
    </button>
  );
}

export function AiFeaturesSection() {
  const [status, setStatus] = useState<AiSettingsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const s = await window.ade.ai.getStatus();
      setStatus(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const allModels: AiModelDescriptor[] = React.useMemo(() => {
    if (!status) return [];
    const seen = new Set<string>();
    const result: AiModelDescriptor[] = [];
    for (const list of Object.values(status.models)) {
      for (const m of list) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          result.push(m);
        }
      }
    }
    return result;
  }, [status]);

  const handleToggle = useCallback(async (key: AiFeatureKey, enabled: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const currentFeatures: Record<string, boolean> = {};
      if (status?.features) {
        for (const f of status.features) {
          currentFeatures[f.feature] = f.enabled;
        }
      }
      currentFeatures[key] = enabled;
      await window.ade.ai.updateConfig({
        features: currentFeatures as AiConfig["features"],
      });
      await loadStatus();
    } finally {
      setSaving(false);
    }
  }, [saving, status, loadStatus]);

  if (loading) {
    return (
      <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12, padding: 20 }}>
        Loading AI features...
      </div>
    );
  }

  if (!status) {
    return (
      <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12, padding: 20 }}>
        Unable to load AI status.
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={sectionLabelStyle}>AI FEATURES</div>

      <div style={cardStyle({ padding: 0 })}>
        {/* Header row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "44px 1fr 120px 60px",
            gap: 12,
            alignItems: "center",
            padding: "10px 16px",
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <div style={{ ...LABEL_STYLE, fontSize: 9 }}>ON</div>
          <div style={{ ...LABEL_STYLE, fontSize: 9 }}>FEATURE</div>
          <div style={{ ...LABEL_STYLE, fontSize: 9 }}>MODEL</div>
          <div style={{ ...LABEL_STYLE, fontSize: 9, textAlign: "right" }}>TODAY</div>
        </div>

        {FEATURES.map((f, i) => {
          const row = status.features.find((r) => r.feature === f.key);
          const enabled = row?.enabled ?? false;
          const dailyUsage = row?.dailyUsage ?? 0;

          return (
            <div
              key={f.key}
              style={{
                display: "grid",
                gridTemplateColumns: "44px 1fr 120px 60px",
                gap: 12,
                alignItems: "center",
                padding: "10px 16px",
                borderBottom: i < FEATURES.length - 1 ? `1px solid ${COLORS.border}` : undefined,
              }}
            >
              <Toggle checked={enabled} onChange={(v) => handleToggle(f.key, v)} />

              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontFamily: MONO_FONT,
                    fontWeight: 600,
                    color: enabled ? COLORS.textPrimary : COLORS.textMuted,
                  }}
                >
                  {f.label}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: MONO_FONT,
                    color: COLORS.textDim,
                    marginTop: 2,
                  }}
                >
                  {f.description}
                </div>
              </div>

              <select
                style={{
                  ...selectStyle,
                  opacity: enabled ? 1 : 0.4,
                  pointerEvents: enabled ? "auto" : "none",
                }}
                value={f.defaultModel}
                disabled={!enabled}
                onChange={() => {/* model routing is read-only for now */}}
              >
                {allModels.length > 0 ? (
                  allModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))
                ) : (
                  <>
                    <option value="haiku">Haiku</option>
                    <option value="sonnet">Sonnet</option>
                    <option value="opus">Opus</option>
                  </>
                )}
              </select>

              <div
                style={{
                  fontSize: 12,
                  fontFamily: MONO_FONT,
                  fontWeight: 600,
                  color: dailyUsage > 0 ? COLORS.textSecondary : COLORS.textDim,
                  textAlign: "right",
                }}
              >
                {dailyUsage}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
