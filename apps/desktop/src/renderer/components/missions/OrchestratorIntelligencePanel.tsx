import React, { useState, useCallback } from "react";
import { CaretDown, CaretRight, Info } from "@phosphor-icons/react";
import type { ModelConfig, OrchestratorCallType, OrchestratorIntelligenceConfig } from "../../../shared/types";
import { ORCHESTRATOR_CALL_TYPES, findModel } from "../../../shared/modelProfiles";
import type { CallTypeInfo } from "../../../shared/modelProfiles";
import { ModelSelector } from "./ModelSelector";
import { COLORS, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";

type OrchestratorIntelligencePanelProps = {
  value: OrchestratorIntelligenceConfig;
  onChange: (config: OrchestratorIntelligenceConfig) => void;
  defaultExpanded?: boolean;
};

function CallTypeRow({
  info,
  config,
  onChange,
}: {
  info: CallTypeInfo;
  config: ModelConfig | undefined;
  onChange: (config: ModelConfig) => void;
}) {
  const recommendedModel = findModel(info.recommended);
  const recommendedLabel = recommendedModel
    ? recommendedModel.displayName
    : info.recommended;

  const defaultConfig: ModelConfig = config ?? {
    provider: info.defaultProvider,
    modelId: info.recommended,
    thinkingLevel: "medium",
  };

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
        <ModelSelector
          value={defaultConfig}
          onChange={onChange}
          compact
          showRecommendedBadge
        />
      </div>
    </div>
  );
}

export function OrchestratorIntelligencePanel({
  value,
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
              config={value[info.key]}
              onChange={(config) => handleCallTypeChange(info.key, config)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
