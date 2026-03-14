import React, { useCallback, useEffect, useState } from "react";
import type {
  AiFeatureKey,
  AiConfig,
  AiChatConfig,
  AiSettingsStatus,
  AiModelDescriptor,
} from "../../../shared/types";
import {
  COLORS,
  MONO_FONT,
  LABEL_STYLE,
  cardStyle,
} from "../lanes/laneDesignTokens";
import { deriveConfiguredModelOptions } from "../../lib/modelOptions";

type FeatureInfo = {
  key: AiFeatureKey;
  label: string;
  description: string;
  defaultModel?: string;
  requiresExplicitModel?: boolean;
};

const FEATURES: FeatureInfo[] = [
  { key: "terminal_summaries", label: "Chat & Terminal Summaries", description: "Summarize closed terminal sessions and keep chat session summaries updated", defaultModel: "anthropic/claude-haiku-4-5" },
  { key: "pr_descriptions", label: "PR Description Drafting", description: "Draft PR descriptions when you trigger the action in the PR flows", defaultModel: "anthropic/claude-haiku-4-5" },
  { key: "commit_messages", label: "Commit Messages", description: "Generate a brief git commit subject when the field is empty", requiresExplicitModel: true },
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

function buildDefaultFeatureModels(): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const feature of FEATURES) {
    defaults[feature.key] = feature.defaultModel ?? "";
  }
  return defaults;
}

function mergeFeatureModels(
  defaultFeatureModels: Record<string, string>,
  effectiveAi: AiConfig | null
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
    Object.entries(featureModels).filter(([, value]) => value.trim().length > 0)
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

  const loadStatus = useCallback(async () => {
    try {
      const [s, snapshot] = await Promise.all([
        window.ade.ai.getStatus(),
        window.ade.projectConfig.get(),
      ]);
      setStatus(s);
      const effectiveAiRaw = snapshot.effective?.ai;
      const effectiveAi = effectiveAiRaw && typeof effectiveAiRaw === "object" ? (effectiveAiRaw as AiConfig) : null;
      setFeatureModels(mergeFeatureModels(defaultFeatureModels, effectiveAi));
      setUnifiedPerm(effectiveAi?.chat?.unifiedPermissionMode ?? "plan");
      setClaudePerm(effectiveAi?.chat?.claudePermissionMode ?? "plan");
      setCodexSandbox(effectiveAi?.chat?.codexSandbox ?? "read-only");
    } finally {
      setLoading(false);
    }
  }, [defaultFeatureModels]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const allModels: AiModelDescriptor[] = React.useMemo(() => {
    return deriveConfiguredModelOptions(status);
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
  }, [saving, status, loadStatus]);

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

  // Permission mode defaults
  const [unifiedPerm, setUnifiedPerm] = useState<AiChatConfig["unifiedPermissionMode"]>("plan");
  const [claudePerm, setClaudePerm] = useState<AiChatConfig["claudePermissionMode"]>("plan");
  const [codexSandbox, setCodexSandbox] = useState<AiChatConfig["codexSandbox"]>("read-only");

  const handlePermChange = useCallback(async (
    field: "unifiedPermissionMode" | "claudePermissionMode" | "codexSandbox",
    value: string
  ) => {
    if (saving) return;
    setSaving(true);
    try {
      const chatPatch: Partial<AiChatConfig> = { [field]: value };
      await window.ade.ai.updateConfig({ chat: chatPatch as AiConfig["chat"] });
      if (field === "unifiedPermissionMode") setUnifiedPerm(value as AiChatConfig["unifiedPermissionMode"]);
      if (field === "claudePermissionMode") setClaudePerm(value as AiChatConfig["claudePermissionMode"]);
      if (field === "codexSandbox") setCodexSandbox(value as AiChatConfig["codexSandbox"]);
    } finally {
      setSaving(false);
    }
  }, [saving]);

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
      <div style={sectionLabelStyle}>AI DEFAULTS</div>
      <div style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: MONO_FONT, marginBottom: 8, lineHeight: 1.6 }}>
        These are the lightweight helpers ADE can apply automatically while you work. Mission orchestration and conflict-resolution models are configured in their own surfaces.
      </div>

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
          const selectedModel = featureModels[f.key] ?? f.defaultModel ?? "";
          const needsModelSelection = enabled && f.requiresExplicitModel && !selectedModel;

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
                {needsModelSelection ? (
                  <div
                    style={{
                      fontSize: 10,
                      fontFamily: MONO_FONT,
                      color: COLORS.warning,
                      marginTop: 4,
                    }}
                  >
                    Select a model before blank commit messages can be generated.
                  </div>
                ) : null}
              </div>

              <select
                style={{
                  ...selectStyle,
                  opacity: enabled ? 1 : 0.4,
                  pointerEvents: enabled ? "auto" : "none",
                }}
                value={selectedModel}
                disabled={!enabled}
                onChange={(e) => handleModelChange(f.key, e.target.value)}
              >
                {f.requiresExplicitModel ? <option value="">Select model...</option> : null}
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

      {/* ── Default Chat Permission Modes ── */}
      <div style={{ ...sectionLabelStyle, marginTop: 24 }}>DEFAULT CHAT PERMISSION MODES</div>
      <div style={{ fontSize: 11, color: COLORS.textMuted, fontFamily: MONO_FONT, marginBottom: 8 }}>
        Defaults for new chat sessions. Can be overridden per-session.
      </div>

      <div style={cardStyle({ padding: 16 })}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
          {/* Unified / API Models */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted, marginBottom: 6 }}>
              UNIFIED / API MODELS
            </div>
            <select
              style={{ ...selectStyle, width: "100%" }}
              value={unifiedPerm ?? "plan"}
              onChange={(e) => handlePermChange("unifiedPermissionMode", e.target.value)}
            >
              <option value="plan">Plan</option>
              <option value="edit">Edit</option>
              <option value="full-auto">Full Auto</option>
            </select>
          </div>

          {/* Claude CLI */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted, marginBottom: 6 }}>
              CLAUDE CLI
            </div>
            <select
              style={{ ...selectStyle, width: "100%" }}
              value={claudePerm ?? "plan"}
              onChange={(e) => handlePermChange("claudePermissionMode", e.target.value)}
            >
              <option value="plan">Plan</option>
              <option value="acceptEdits">Accept Edits</option>
              <option value="bypassPermissions">Bypass Permissions</option>
            </select>
          </div>

          {/* Codex CLI */}
          <div>
            <div style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase" as const, letterSpacing: "1px", color: COLORS.textMuted, marginBottom: 6 }}>
              CODEX CLI
            </div>
            <select
              style={{ ...selectStyle, width: "100%" }}
              value={codexSandbox ?? "read-only"}
              onChange={(e) => handlePermChange("codexSandbox", e.target.value)}
            >
              <option value="read-only">Default (Read-Only)</option>
              <option value="workspace-write">Workspace Write</option>
              <option value="danger-full-access">Full Access</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
