import React, { useCallback, useEffect, useState } from "react";
import type {
  AiFeatureKey,
  AiConfig,
  AiSettingsStatus,
} from "../../../shared/types";
import {
  COLORS,
  MONO_FONT,
  LABEL_STYLE,
  cardStyle,
} from "../lanes/laneDesignTokens";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { getModelById, resolveModelAlias } from "../../../shared/modelRegistry";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";

type FeatureInfo = {
  key: AiFeatureKey;
  label: string;
  description: string;
};

const FEATURES: FeatureInfo[] = [
  { key: "terminal_summaries", label: "Chat & terminal summaries", description: "Summarize closed terminal sessions and keep chat session summaries updated" },
  { key: "pr_descriptions", label: "PR description drafting", description: "Draft PR descriptions when you trigger the action in the PR flows" },
  { key: "commit_messages", label: "Commit messages", description: "Generate a brief git commit subject when the field is empty" },
];

const sectionLabelStyle: React.CSSProperties = {
  ...LABEL_STYLE,
  fontSize: 11,
  marginBottom: 10,
};


function normalizeModelSetting(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw.length) return "";
  return getModelById(raw)?.id ?? resolveModelAlias(raw)?.id ?? raw;
}

function buildDefaultFeatureModels(): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const feature of FEATURES) {
    defaults[feature.key] = "";
  }
  return defaults;
}

function mergeFeatureModels(
  defaultFeatureModels: Record<string, string>,
  effectiveAi: AiConfig | null,
): Record<string, string> {
  const persistedFeatureModels = effectiveAi?.featureModelOverrides ?? {};
  const nextFeatureModels: Record<string, string> = { ...defaultFeatureModels };

  for (const feature of FEATURES) {
    const persistedModel = typeof persistedFeatureModels[feature.key] === "string"
      ? persistedFeatureModels[feature.key]!.trim()
      : "";
    if (persistedModel.length > 0) {
      nextFeatureModels[feature.key] = persistedModel;
    }
  }

  const summaryModel = typeof effectiveAi?.sessionIntelligence?.summaries?.modelId === "string"
    ? effectiveAi.sessionIntelligence.summaries.modelId.trim()
    : "";
  if (summaryModel.length > 0) {
    nextFeatureModels.terminal_summaries = summaryModel;
  }

  return nextFeatureModels;
}

function toFeatureModelOverrides(featureModels: Record<string, string>): AiConfig["featureModelOverrides"] {
  return Object.fromEntries(
    Object.entries(featureModels).filter(([, value]) => value.trim().length > 0),
  ) as AiConfig["featureModelOverrides"];
}

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
  const defaultFeatureModels = React.useMemo(buildDefaultFeatureModels, []);
  const [featureModels, setFeatureModels] = useState<Record<string, string>>(defaultFeatureModels);
  const [featureReasoning, setFeatureReasoning] = useState<Record<string, string | null>>({});
  const [utilityModel, setUtilityModel] = useState("");
  const [chatAutoTitleEnabled, setChatAutoTitleEnabled] = useState(false);
  const [chatAutoTitleRefresh, setChatAutoTitleRefresh] = useState(true);
  const [chatAutoTitleReasoning, setChatAutoTitleReasoning] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const [nextStatus, snapshot] = await Promise.all([
        window.ade.ai.getStatus(),
        window.ade.projectConfig.get(),
      ]);
      setStatus(nextStatus);

      const effectiveAiRaw = snapshot.effective?.ai;
      const effectiveAi = effectiveAiRaw && typeof effectiveAiRaw === "object" ? (effectiveAiRaw as AiConfig) : null;
      setFeatureModels(mergeFeatureModels(defaultFeatureModels, effectiveAi));
      setUtilityModel(
        normalizeModelSetting(effectiveAi?.chat?.autoTitleModelId)
        || normalizeModelSetting(effectiveAi?.sessionIntelligence?.summaries?.modelId)
        || normalizeModelSetting(effectiveAi?.featureModelOverrides?.terminal_summaries)
        || "",
      );
      setChatAutoTitleEnabled(effectiveAi?.chat?.autoTitleEnabled === true);
      setChatAutoTitleRefresh(effectiveAi?.chat?.autoTitleRefreshOnComplete !== false);
      setChatAutoTitleReasoning(effectiveAi?.chat?.autoTitleReasoningEffort ?? null);

      const persistedReasoning = effectiveAi?.featureReasoningOverrides ?? {};
      const nextReasoning: Record<string, string | null> = {};
      for (const key of Object.keys(persistedReasoning)) {
        nextReasoning[key] = persistedReasoning[key as AiFeatureKey] ?? null;
      }
      setFeatureReasoning(nextReasoning);
    } finally {
      setLoading(false);
    }
  }, [defaultFeatureModels]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const availableModelIds = React.useMemo(() => deriveConfiguredModelIds(status), [status]);

  const saveChatTitleSettings = useCallback(async (patch: Partial<NonNullable<AiConfig["chat"]>>) => {
    const nextModelId =
      patch.autoTitleModelId !== undefined
        ? patch.autoTitleModelId
        : utilityModel || "";
    const nextEnabled =
      patch.autoTitleEnabled !== undefined ? patch.autoTitleEnabled : chatAutoTitleEnabled;
    const nextRefresh =
      patch.autoTitleRefreshOnComplete !== undefined
        ? patch.autoTitleRefreshOnComplete
        : chatAutoTitleRefresh;
    const nextReasoning =
      patch.autoTitleReasoningEffort !== undefined
        ? patch.autoTitleReasoningEffort
        : chatAutoTitleReasoning;

    await window.ade.ai.updateConfig({
      chat: {
        autoTitleEnabled: nextEnabled,
        autoTitleModelId: nextModelId || undefined,
        autoTitleRefreshOnComplete: nextRefresh,
        autoTitleReasoningEffort: nextReasoning,
      } as AiConfig["chat"],
    });

    setChatAutoTitleEnabled(nextEnabled);
    setChatAutoTitleRefresh(nextRefresh);
    if (patch.autoTitleReasoningEffort !== undefined) {
      setChatAutoTitleReasoning(patch.autoTitleReasoningEffort);
    }
  }, [chatAutoTitleEnabled, chatAutoTitleRefresh, chatAutoTitleReasoning, utilityModel]);

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
        ...(key === "terminal_summaries"
          ? {
              sessionIntelligence: {
                summaries: {
                  enabled,
                },
              } as AiConfig["sessionIntelligence"],
            }
          : {}),
      });
      await loadStatus();
    } finally {
      setSaving(false);
    }
  }, [loadStatus, saving, status]);

  const handleModelChange = useCallback(async (key: AiFeatureKey, modelId: string) => {
    if (saving) return;
    setSaving(true);
    try {
      const nextFeatureModels = { ...featureModels, [key]: modelId };
      setFeatureModels(nextFeatureModels);
      await window.ade.ai.updateConfig({
        featureModelOverrides: toFeatureModelOverrides(nextFeatureModels),
        ...(key === "terminal_summaries"
          ? {
              sessionIntelligence: {
                summaries: {
                  modelId: modelId || undefined,
                },
              } as AiConfig["sessionIntelligence"],
            }
          : {}),
      });
    } finally {
      setSaving(false);
    }
  }, [featureModels, saving]);

  const handleReasoningChange = useCallback(async (key: AiFeatureKey, effort: string | null) => {
    if (saving) return;
    setSaving(true);
    try {
      const nextReasoning = { ...featureReasoning, [key]: effort };
      setFeatureReasoning(nextReasoning);
      const overrides: Partial<Record<string, string | null>> = {};
      for (const [k, v] of Object.entries(nextReasoning)) {
        if (v != null) overrides[k] = v;
      }
      await window.ade.ai.updateConfig({
        featureReasoningOverrides: overrides as AiConfig["featureReasoningOverrides"],
      });
    } finally {
      setSaving(false);
    }
  }, [featureReasoning, saving]);

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
      <div style={sectionLabelStyle}>HELPER DEFAULTS</div>
      <div style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: MONO_FONT, marginBottom: 8, lineHeight: 1.6 }}>
        Configure the lightweight helpers ADE can run automatically while you work. Mission orchestration and conflict-resolution models are configured in their own surfaces.
      </div>

      <div style={cardStyle({ padding: 0 })}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "44px 1fr auto 60px",
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

        {FEATURES.map((feature, index) => {
          const row = status.features.find((entry) => entry.feature === feature.key);
          const enabled = row?.enabled ?? false;
          const dailyUsage = row?.dailyUsage ?? 0;
          const selectedModel = featureModels[feature.key] ?? "";
          const needsModelSelection = enabled && !selectedModel;

          return (
            <div
              key={feature.key}
              style={{
                display: "grid",
                gridTemplateColumns: "44px 1fr auto 60px",
                gap: 12,
                alignItems: "center",
                padding: "10px 16px",
                borderBottom: index < FEATURES.length - 1 ? `1px solid ${COLORS.border}` : undefined,
              }}
            >
              <Toggle checked={enabled} onChange={(value) => handleToggle(feature.key, value)} />

              <div>
                <div
                  style={{
                    fontSize: 12,
                    fontFamily: MONO_FONT,
                    fontWeight: 600,
                    color: enabled ? COLORS.textPrimary : COLORS.textMuted,
                  }}
                >
                  {feature.label}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: MONO_FONT,
                    color: COLORS.textDim,
                    marginTop: 2,
                  }}
                >
                  {feature.description}
                </div>
                {needsModelSelection ? (
                  <div
                    style={{
                      fontSize: 10,
                      fontFamily: MONO_FONT,
                      color: COLORS.warning,
                      marginTop: 4,
                    }}
                  >
                    Select a model to enable this feature.
                  </div>
                ) : null}
              </div>

              <div style={{ opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? "auto" : "none" }}>
                <UnifiedModelSelector
                  value={selectedModel}
                  onChange={(modelId) => void handleModelChange(feature.key, modelId)}
                  availableModelIds={availableModelIds}
                  disabled={!enabled}
                  showReasoning
                  reasoningEffort={featureReasoning[feature.key] ?? null}
                  onReasoningEffortChange={(effort) => void handleReasoningChange(feature.key, effort)}
                />
              </div>

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

        {/* Auto-name chat tabs */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "44px 1fr auto 60px",
            gap: 12,
            alignItems: "center",
            padding: "10px 16px",
            borderTop: `1px solid ${COLORS.border}`,
          }}
        >
          <Toggle
            checked={chatAutoTitleEnabled}
            onChange={(value) => void saveChatTitleSettings({ autoTitleEnabled: value })}
          />

          <div>
            <div
              style={{
                fontSize: 12,
                fontFamily: MONO_FONT,
                fontWeight: 600,
                color: chatAutoTitleEnabled ? COLORS.textPrimary : COLORS.textMuted,
              }}
            >
              Auto-name chat tabs
            </div>
            <div
              style={{
                fontSize: 11,
                fontFamily: MONO_FONT,
                color: COLORS.textDim,
                marginTop: 2,
              }}
            >
              Generate a title from chat content
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={chatAutoTitleRefresh}
                onChange={(e) => void saveChatTitleSettings({ autoTitleRefreshOnComplete: e.target.checked })}
                style={{ margin: 0 }}
              />
              <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Refresh when session closes
              </span>
            </label>
          </div>

          <div style={{ opacity: chatAutoTitleEnabled ? 1 : 0.4, pointerEvents: chatAutoTitleEnabled ? "auto" : "none" }}>
            <UnifiedModelSelector
              value={utilityModel}
              onChange={(modelId) => {
                setUtilityModel(modelId);
                void saveChatTitleSettings({ autoTitleModelId: modelId });
              }}
              availableModelIds={availableModelIds}
              disabled={!chatAutoTitleEnabled}
              showReasoning
              reasoningEffort={chatAutoTitleReasoning}
              onReasoningEffortChange={(effort) => {
                setChatAutoTitleReasoning(effort);
                void saveChatTitleSettings({ autoTitleReasoningEffort: effort });
              }}
            />
          </div>

          <div
            style={{
              fontSize: 12,
              fontFamily: MONO_FONT,
              fontWeight: 600,
              color: COLORS.textDim,
              textAlign: "right",
            }}
          >
            —
          </div>
        </div>
      </div>
    </div>
  );
}
