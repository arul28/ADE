import React, { useCallback, useEffect, useState } from "react";
import type {
  AiFeatureKey,
  AiConfig,
  AiSettingsStatus,
} from "../../../shared/types";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  LABEL_STYLE,
  cardStyle,
} from "../lanes/laneDesignTokens";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { getModelById, resolveModelAlias } from "../../../shared/modelRegistry";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { Alarm, ChatCircleDots, GitPullRequest, GitCommit, ChatText, type Icon } from "@phosphor-icons/react";
import { useOpenProviderSignIn } from "../shared/useOpenProviderSignIn";

type FeatureInfo = {
  key: AiFeatureKey;
  label: string;
  description: string;
  subtitle: string;
  icon: Icon;
};

type ChatTitleSettingsPatch = {
  enabled?: boolean;
  modelId?: string;
  refreshOnComplete?: boolean;
  reasoningEffort?: string | null;
};

const FEATURES: FeatureInfo[] = [
  { key: "terminal_summaries", label: "Summarize completed chats and terminals", description: "Replace raw last output with a concise session summary when work completes", subtitle: "Show what happened instead of the last terminal line", icon: ChatCircleDots },
  { key: "pr_descriptions", label: "PR description drafting", description: "Draft PR descriptions when you trigger the action in the PR flows", subtitle: "Get a head start on PR descriptions when you're ready to merge", icon: GitPullRequest },
  { key: "commit_messages", label: "Commit messages", description: "Generate a brief git commit subject when the field is empty", subtitle: "Meaningful commit messages generated from your staged changes", icon: GitCommit },
];

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
  const openProviderSignIn = useOpenProviderSignIn();
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
  const [scheduledWorkPaused, setScheduledWorkPaused] = useState(false);

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
        normalizeModelSetting(effectiveAi?.sessionIntelligence?.titles?.modelId)
        || normalizeModelSetting(effectiveAi?.sessionIntelligence?.summaries?.modelId)
        || normalizeModelSetting(effectiveAi?.featureModelOverrides?.terminal_summaries)
        || "",
      );
      setChatAutoTitleEnabled(effectiveAi?.sessionIntelligence?.titles?.enabled ?? true);
      setChatAutoTitleRefresh(effectiveAi?.sessionIntelligence?.titles?.refreshOnComplete ?? true);
      setChatAutoTitleReasoning(
        effectiveAi?.sessionIntelligence?.titles?.reasoningEffort
        ?? effectiveAi?.chat?.autoTitleReasoningEffort
        ?? null
      );
      setScheduledWorkPaused(effectiveAi?.chat?.scheduledWorkPaused === true);

      const persistedReasoning = effectiveAi?.featureReasoningOverrides ?? {};
      const nextReasoning: Record<string, string | null> = {};
      for (const key of Object.keys(persistedReasoning)) {
        nextReasoning[key] = persistedReasoning[key as AiFeatureKey] ?? null;
      }
      nextReasoning.terminal_summaries = effectiveAi?.sessionIntelligence?.summaries?.reasoningEffort
        ?? nextReasoning.terminal_summaries
        ?? null;
      setFeatureReasoning(nextReasoning);
    } finally {
      setLoading(false);
    }
  }, [defaultFeatureModels]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const availableModelIds = React.useMemo(() => deriveConfiguredModelIds(status), [status]);

  const featureRowHoverCss = `.ai-feature-row:hover { background: ${COLORS.hoverBg}; }`;

  const saveChatTitleSettings = useCallback(async (patch: ChatTitleSettingsPatch) => {
    if (saving) return;
    setSaving(true);
    try {
      const nextModelId =
        patch.modelId !== undefined
          ? patch.modelId
          : utilityModel || "";
      const nextEnabled =
        patch.enabled !== undefined ? patch.enabled : chatAutoTitleEnabled;
      const nextRefresh =
        patch.refreshOnComplete !== undefined
          ? patch.refreshOnComplete
          : chatAutoTitleRefresh;
      const nextReasoning =
        patch.reasoningEffort !== undefined
          ? patch.reasoningEffort
          : chatAutoTitleReasoning;

      await window.ade.ai.updateConfig({
        sessionIntelligence: {
          titles: {
            enabled: nextEnabled,
            modelId: nextModelId || null,
            reasoningEffort: nextReasoning,
            refreshOnComplete: nextRefresh,
          },
        },
      });

      setChatAutoTitleEnabled(nextEnabled);
      setChatAutoTitleRefresh(nextRefresh);
      if (patch.reasoningEffort !== undefined) {
        setChatAutoTitleReasoning(patch.reasoningEffort);
      }
    } catch (error) {
      console.error("[AiFeaturesSection] saveChatTitleSettings failed:", error);
    } finally {
      setSaving(false);
    }
  }, [chatAutoTitleEnabled, chatAutoTitleRefresh, chatAutoTitleReasoning, saving, utilityModel]);

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

  const handleScheduledWorkPaused = useCallback(async (paused: boolean) => {
    if (saving) return;
    setSaving(true);
    setScheduledWorkPaused(paused);
    try {
      await window.ade.ai.updateConfig({ chat: { scheduledWorkPaused: paused } });
    } catch (error) {
      setScheduledWorkPaused(!paused);
      console.error("[AiFeaturesSection] scheduled-work pause update failed:", error);
    } finally {
      setSaving(false);
    }
  }, [saving]);

  const handleModelChange = useCallback(async (key: AiFeatureKey, modelId: string) => {
    if (saving) return;
    setSaving(true);
    try {
      const nextFeatureModels = { ...featureModels, [key]: modelId };
      setFeatureModels(nextFeatureModels);
      const featureModelOverrides = toFeatureModelOverrides(nextFeatureModels) ?? {};
      if (!modelId) {
        featureModelOverrides[key] = null;
      }
      await window.ade.ai.updateConfig({
        featureModelOverrides,
        ...(key === "terminal_summaries"
          ? {
              sessionIntelligence: {
                summaries: {
                  modelId: modelId || null,
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
      if (effort == null) {
        overrides[key] = null;
      }
      await window.ade.ai.updateConfig({
        featureReasoningOverrides: overrides as AiConfig["featureReasoningOverrides"],
        ...(key === "terminal_summaries"
          ? {
              sessionIntelligence: {
                summaries: {
                  reasoningEffort: effort,
                },
              } as AiConfig["sessionIntelligence"],
            }
          : {}),
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
    <>
      <style>{featureRowHoverCss}</style>
      <div>
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: COLORS.textPrimary,
            fontFamily: SANS_FONT,
            marginBottom: 12,
            lineHeight: 1.4,
            whiteSpace: "nowrap",
          }}
        >
          ADE can handle routine tasks in the background while you focus on what matters. Enable the helpers you want and pick a model for each.
        </div>

        <div style={{ ...cardStyle({ padding: 0 }), marginBottom: 12 }}>
          <div className="ai-feature-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
            <Toggle checked={scheduledWorkPaused} onChange={(paused) => void handleScheduledWorkPaused(paused)} />
            <Alarm size={18} weight="duotone" style={{ color: scheduledWorkPaused ? COLORS.warning : COLORS.accent, flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontFamily: SANS_FONT, fontWeight: 600, color: COLORS.textPrimary }}>
                Pause all scheduled work
              </div>
              <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim, marginTop: 2, lineHeight: 1.4 }}>
                Wakeups, cron tasks, and loops stay armed. Overdue work fires once when you resume.
              </div>
            </div>
          </div>
        </div>

        <div style={cardStyle({ padding: 0 })}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "44px minmax(0, 1.2fr) minmax(130px, 1fr) 52px",
              gap: "10px 12px",
              alignItems: "center",
              padding: "10px 16px",
              borderBottom: `1px solid ${COLORS.border}`,
            }}
          >
            <div style={{ ...LABEL_STYLE, fontSize: 9, letterSpacing: "0.05em" }}>ON</div>
            <div style={{ ...LABEL_STYLE, fontSize: 9, letterSpacing: "0.05em" }}>FEATURE</div>
            <div style={{ ...LABEL_STYLE, fontSize: 9, letterSpacing: "0.05em" }}>MODEL</div>
            <div style={{ ...LABEL_STYLE, fontSize: 9, letterSpacing: "0.05em", textAlign: "right" }}>TODAY</div>
          </div>

          {FEATURES.map((feature, index) => {
            const row = status.features.find((entry) => entry.feature === feature.key);
            const enabled = row?.enabled ?? false;
            const dailyUsage = row?.dailyUsage ?? 0;
            const selectedModel = featureModels[feature.key] ?? "";
            const needsModelSelection = enabled && !selectedModel;
            const IconComponent = feature.icon;

            return (
              <div
                key={feature.key}
                className="ai-feature-row"
                style={{
                  display: "grid",
                  gridTemplateColumns: "44px minmax(0, 1.2fr) minmax(130px, 1fr) 52px",
                  gap: "10px 12px",
                  alignItems: "center",
                  padding: "12px 16px",
                  borderBottom: index < FEATURES.length - 1 ? `1px solid ${COLORS.border}` : undefined,
                  borderRadius: 8,
                  transition: "background 150ms ease",
                }}
              >
                <Toggle checked={enabled} onChange={(value) => void handleToggle(feature.key, value)} />

                <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 }}>
                  <IconComponent
                    size={18}
                    weight="duotone"
                    style={{
                      color: enabled ? COLORS.accent : COLORS.textDim,
                      flexShrink: 0,
                      marginTop: 1,
                    }}
                  />
                  <div style={{ minWidth: 0, overflow: "hidden" }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontFamily: SANS_FONT,
                        fontWeight: 600,
                        color: enabled ? COLORS.textPrimary : COLORS.textMuted,
                      }}
                    >
                      {feature.label}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        fontFamily: SANS_FONT,
                        color: COLORS.textDim,
                        marginTop: 2,
                        lineHeight: 1.4,
                        overflowWrap: "break-word",
                        wordBreak: "break-word",
                      }}
                    >
                      {feature.subtitle}
                    </div>
                    {needsModelSelection ? (
                      <div
                        style={{
                          fontSize: 10,
                          fontFamily: SANS_FONT,
                          color: COLORS.warning,
                          marginTop: 4,
                        }}
                      >
                        Select a model to enable this feature.
                      </div>
                    ) : null}
                  </div>
                </div>

                <div
                  style={{ opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? "auto" : "none" }}
                  className="inline-flex items-center gap-1.5"
                >
                  <ModelPicker
                    value={selectedModel}
                    onChange={(modelId) => void handleModelChange(feature.key, modelId)}
                    surfaceKey={`ai-feature-${feature.key}`}
                    availableModelIds={availableModelIds}
                    onOpenSignIn={openProviderSignIn}
                    disabled={!enabled}
                  />
                  <ReasoningEffortPicker
                    modelId={selectedModel}
                    reasoningEffort={featureReasoning[feature.key] ?? null}
                    onChange={(effort) => void handleReasoningChange(feature.key, effort)}
                    useFamilyDefaults={false}
                    disabled={!enabled}
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

          {/* Auto-name chats, CLI sessions, and lanes */}
          <div
            className="ai-feature-row"
            style={{
              display: "grid",
              gridTemplateColumns: "44px minmax(0, 1.2fr) minmax(130px, 1fr) 52px",
              gap: "10px 12px",
              alignItems: "center",
              padding: "12px 16px",
              borderTop: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              transition: "background 150ms ease",
            }}
          >
            <Toggle
              checked={chatAutoTitleEnabled}
              onChange={(value) => void saveChatTitleSettings({ enabled: value })}
            />

            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 }}>
              <ChatText
                size={18}
                weight="duotone"
                style={{
                  color: chatAutoTitleEnabled ? COLORS.accent : COLORS.textDim,
                  flexShrink: 0,
                  marginTop: 1,
                }}
              />
              <div style={{ minWidth: 0, overflow: "hidden" }}>
                <div>
                  <div
                    style={{
                      fontSize: 12,
                      fontFamily: SANS_FONT,
                      fontWeight: 600,
                      color: chatAutoTitleEnabled ? COLORS.textPrimary : COLORS.textMuted,
                    }}
                  >
                    Auto-name chats, CLI sessions, and lanes
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      fontFamily: SANS_FONT,
                      color: COLORS.textDim,
                      marginTop: 2,
                      lineHeight: 1.4,
                      overflowWrap: "break-word",
                      wordBreak: "break-word",
                    }}
                  >
                    Names come from the first prompt, with a deterministic fallback when the model is off or too slow
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={chatAutoTitleRefresh}
                      onChange={(e) => void saveChatTitleSettings({ refreshOnComplete: e.target.checked })}
                      style={{ margin: 0 }}
                    />
                    <span style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: SANS_FONT }}>
                      Refresh when session closes
                    </span>
                  </label>
                </div>
              </div>
            </div>

            <div
              style={{ opacity: chatAutoTitleEnabled ? 1 : 0.4, pointerEvents: chatAutoTitleEnabled ? "auto" : "none" }}
              className="inline-flex items-center gap-1.5"
            >
              <ModelPicker
                value={utilityModel}
                onChange={(modelId) => {
                  setUtilityModel(modelId);
                  void saveChatTitleSettings({ modelId });
                }}
                surfaceKey="ai-feature-chat-auto-title"
                availableModelIds={availableModelIds}
                onOpenSignIn={openProviderSignIn}
                disabled={!chatAutoTitleEnabled}
              />
              <ReasoningEffortPicker
                modelId={utilityModel}
                reasoningEffort={chatAutoTitleReasoning}
                onChange={(effort) => {
                  setChatAutoTitleReasoning(effort);
                  void saveChatTitleSettings({ reasoningEffort: effort });
                }}
                useFamilyDefaults={false}
                disabled={!chatAutoTitleEnabled}
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
    </>
  );
}
