import React, { useState, useCallback } from "react";
import { CaretDown, CaretRight, Info } from "@phosphor-icons/react";
import type { ModelConfig, OrchestratorCallType, OrchestratorIntelligenceConfig } from "../../../shared/types";
import { ORCHESTRATOR_CALL_TYPES, findModel } from "../../../shared/modelProfiles";
import type { CallTypeInfo } from "../../../shared/modelProfiles";
import { ModelSelector } from "./ModelSelector";
import { COLORS, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";

type OrchestratorIntelligencePanelProps = {
  value: OrchestratorIntelligenceConfig;
  orchestratorModel: ModelConfig;
  onChange: (config: OrchestratorIntelligenceConfig) => void;
  defaultExpanded?: boolean;
};

function formatModelSummary(config: ModelConfig): string {
  const model = findModel(config.modelId);
  const modelLabel = model?.displayName ?? config.modelId;
  const providerLabel = config.provider === "claude" ? "Claude" : "Codex";
  return `${providerLabel} | ${modelLabel} | ${(config.thinkingLevel ?? "medium").toUpperCase()}`;
}

function CallTypeRow({
  info,
  overrideConfig,
  inheritedConfig,
  onToggleOverride,
  onChangeOverride,
}: {
  info: CallTypeInfo;
  overrideConfig: ModelConfig | undefined;
  inheritedConfig: ModelConfig;
  onToggleOverride: (enabled: boolean) => void;
  onChangeOverride: (config: ModelConfig) => void;
}) {
  const recommendedModel = findModel(info.recommended);
  const recommendedLabel = recommendedModel
    ? recommendedModel.displayName
    : info.recommended;
  const hasOverride = Boolean(overrideConfig);
  const effectiveConfig = overrideConfig ?? inheritedConfig;

  return (
    <div className="flex items-start gap-2 py-1.5">
      {/* Label column */}
      <div className="w-36 shrink-0 pt-1">
        <div className="flex items-center gap-1">
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 10,
              fontWeight: 700,
              color: COLORS.textMuted,
              textTransform: "uppercase",
              letterSpacing: "1px",
            }}
          >
            {info.label}
          </span>
          <span title={info.description} className="cursor-help">
            <Info size={12} weight="bold" color={COLORS.textDim} />
          </span>
        </div>
        <div
          style={{
            fontFamily: MONO_FONT,
            fontSize: 9,
            color: COLORS.textDim,
            marginTop: 2,
          }}
        >
          Recommended: {recommendedLabel}
        </div>
      </div>

      {/* Model selector */}
      <div className="flex-1">
        <div className="space-y-1.5">
          <label
            className="flex items-center gap-1.5 text-[10px]"
            style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}
          >
            <input
              type="checkbox"
              checked={hasOverride}
              onChange={(e) => onToggleOverride(e.target.checked)}
            />
            OVERRIDE MODEL
          </label>
          {hasOverride ? (
            <ModelSelector
              value={effectiveConfig}
              onChange={onChangeOverride}
              compact
              showRecommendedBadge
            />
          ) : (
            <div
              className="text-[10px] px-2 py-1"
              style={{
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.border}`,
                color: COLORS.textMuted,
                fontFamily: MONO_FONT,
              }}
            >
              INHERITING ORCHESTRATOR: {formatModelSummary(effectiveConfig)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function OrchestratorIntelligencePanel({
  value,
  orchestratorModel,
  onChange,
  defaultExpanded = false,
}: OrchestratorIntelligencePanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const handleCallTypeChange = useCallback(
    (callType: OrchestratorCallType, config: ModelConfig) => {
      onChange({ ...value, [callType]: config });
    },
    [value, onChange]
  );

  const handleToggleOverride = useCallback(
    (callType: OrchestratorCallType, enabled: boolean) => {
      if (enabled) {
        onChange({
          ...value,
          [callType]: value[callType] ?? { ...orchestratorModel }
        });
        return;
      }
      const next: OrchestratorIntelligenceConfig = { ...value };
      delete next[callType];
      onChange(next);
    },
    [value, onChange, orchestratorModel]
  );

  return (
    <div
      style={{
        background: COLORS.cardBg,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 0,
      }}
    >
      {/* Header */}
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-left"
        style={{ background: "transparent", border: "none", cursor: "pointer" }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        {expanded ? (
          <CaretDown size={12} weight="bold" color={COLORS.accent} />
        ) : (
          <CaretRight size={12} weight="bold" color={COLORS.textMuted} />
        )}
        <span
          style={{
            ...LABEL_STYLE,
            color: expanded ? COLORS.accent : COLORS.textMuted,
          }}
        >
          ORCHESTRATOR INTELLIGENCE
        </span>
        <span
          style={{
            fontFamily: MONO_FONT,
            fontSize: 10,
            color: COLORS.textDim,
            fontWeight: 400,
          }}
        >
          {ORCHESTRATOR_CALL_TYPES.length} call types
        </span>
      </button>

      {/* Body */}
      {expanded && (
        <div
          className="px-3 pb-3"
          style={{ borderTop: `1px solid ${COLORS.border}` }}
        >
          {/* Column headers */}
          <div
            className="flex items-center gap-2 pt-2 pb-1 mb-1"
            style={{ borderBottom: `1px solid ${COLORS.border}` }}
          >
            <span className="w-36 shrink-0" style={LABEL_STYLE}>
              CALL TYPE
            </span>
            <span className="flex-1" style={LABEL_STYLE}>
              MODEL
            </span>
          </div>

          {/* Rows */}
          {ORCHESTRATOR_CALL_TYPES.map((info) => (
            <CallTypeRow
              key={info.key}
              info={info}
              overrideConfig={value[info.key]}
              inheritedConfig={orchestratorModel}
              onToggleOverride={(enabled) => handleToggleOverride(info.key, enabled)}
              onChangeOverride={(config) => handleCallTypeChange(info.key, config)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
