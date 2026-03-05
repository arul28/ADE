import React from "react";
import { X, Warning } from "@phosphor-icons/react";
import type { PhaseCard, MissionPhaseValidationTier, ModelConfig } from "../../../shared/types";
import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { ModelSelector } from "./ModelSelector";

export type PhaseCardEditorProps = {
  phase: PhaseCard;
  index: number;
  totalCount: number;
  expanded: boolean;
  readOnly: boolean;
  onToggleExpand: () => void;
  onUpdate: (updated: PhaseCard) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove?: () => void;
  availableModelIds?: string[];
  /** When true, show enable/disable toggle (used in CreateMissionDialog) */
  showToggle?: boolean;
  disabled?: boolean;
  onToggleDisabled?: () => void;
  labelStyle?: React.CSSProperties;
  inputStyle?: React.CSSProperties;
};

const DEFAULT_LABEL_STYLE: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  textTransform: "uppercase" as const,
  letterSpacing: "1px",
  color: COLORS.textMuted,
};

const DEFAULT_INPUT_STYLE: React.CSSProperties = {
  height: 28,
  width: "100%",
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  padding: "0 8px",
  fontSize: 11,
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  borderRadius: 0,
  outline: "none",
};

export function PhaseCardEditor({
  phase,
  index,
  totalCount,
  expanded,
  readOnly,
  onToggleExpand,
  onUpdate,
  onMoveUp,
  onMoveDown,
  onRemove,
  availableModelIds,
  showToggle,
  disabled: isDisabled,
  onToggleDisabled,
  labelStyle: lblStyle,
  inputStyle: inpStyle,
}: PhaseCardEditorProps) {
  const labelStyle = lblStyle ?? DEFAULT_LABEL_STYLE;
  const inputStyle = inpStyle ?? DEFAULT_INPUT_STYLE;

  const updateField = <K extends keyof PhaseCard>(key: K, value: PhaseCard[K]) => {
    onUpdate({ ...phase, [key]: value });
  };

  return (
    <div
      className="p-2"
      style={{
        background: isDisabled ? `${COLORS.recessedBg}80` : COLORS.recessedBg,
        border: `1px solid ${isDisabled ? COLORS.border + "60" : COLORS.border}`,
        opacity: isDisabled ? 0.5 : 1,
        transition: "opacity 0.15s ease",
      }}
    >
      <div className="flex items-center gap-2">
        {/* Enable/disable toggle */}
        {showToggle && onToggleDisabled && (
          <button
            type="button"
            onClick={onToggleDisabled}
            title={isDisabled ? "Enable phase" : "Disable phase"}
            style={{
              width: 28,
              height: 14,
              background: isDisabled ? COLORS.border : "#22C55E",
              border: "none",
              borderRadius: 0,
              cursor: "pointer",
              position: "relative",
              flexShrink: 0,
              transition: "background 0.2s ease",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 2,
                left: isDisabled ? 2 : 14,
                width: 10,
                height: 10,
                background: isDisabled ? COLORS.textDim : COLORS.textPrimary,
                borderRadius: 0,
                transition: "left 0.2s ease",
              }}
            />
          </button>
        )}

        {/* Phase index */}
        <span className="text-[10px] font-bold" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          {index + 1}.
        </span>

        {/* Phase info */}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-semibold" style={{ color: isDisabled ? COLORS.textDim : COLORS.textPrimary }}>
            {phase.name}
            {phase.isCustom ? (
              <span style={{ fontSize: 9, fontWeight: 600, color: "#F59E0B", marginLeft: 4, fontFamily: MONO_FONT }}>CUSTOM</span>
            ) : null}
            {isDisabled ? <span style={{ color: COLORS.textDim, fontWeight: 400 }}> (disabled)</span> : null}
          </div>
          {phase.description ? (
            <div className="truncate text-[10px]" style={{ color: COLORS.textDim }}>
              {phase.description}
            </div>
          ) : null}
          <div className="text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            {phase.model.modelId} · {phase.validationGate.tier}
          </div>
        </div>

        {/* Reorder buttons */}
        {!readOnly && (
          <>
            <button
              type="button"
              className="px-1 text-[10px]"
              style={{ color: COLORS.textMuted }}
              disabled={index === 0}
              onClick={onMoveUp}
              title="Move up"
            >
              {"\u2191"}
            </button>
            <button
              type="button"
              className="px-1 text-[10px]"
              style={{ color: COLORS.textMuted }}
              disabled={index === totalCount - 1}
              onClick={onMoveDown}
              title="Move down"
            >
              {"\u2193"}
            </button>
          </>
        )}

        {/* Expand/collapse button */}
        <button
          type="button"
          className="px-2 text-[10px] font-bold uppercase tracking-[1px]"
          style={outlineButton()}
          onClick={onToggleExpand}
          disabled={isDisabled && !readOnly}
        >
          {expanded ? "HIDE" : readOnly ? "VIEW" : "CONFIGURE"}
        </button>

        {/* Remove button (custom phases only, not readOnly) */}
        {!readOnly && onRemove && phase.isCustom ? (
          <button
            type="button"
            className="px-1"
            style={{ color: COLORS.danger, background: "none", border: "none", cursor: "pointer" }}
            onClick={onRemove}
            title="Remove custom phase"
          >
            <X size={12} weight="bold" />
          </button>
        ) : null}
      </div>

      {/* Expanded detail panel */}
      {expanded && !isDisabled ? (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <label className="space-y-1 text-[10px]">
              <span style={labelStyle}>PHASE NAME</span>
              <input
                value={phase.name}
                onChange={(e) => updateField("name", e.target.value)}
                className="h-7 w-full px-2 outline-none"
                style={inputStyle}
                disabled={readOnly}
              />
            </label>
            <div className="space-y-1 text-[10px]">
              <span style={labelStyle}>WORKER MODEL</span>
              {readOnly ? (
                <div className="h-7 flex items-center px-2" style={{ ...inputStyle, opacity: 0.7 }}>
                  {phase.model.modelId}
                  {phase.model.thinkingLevel ? ` · ${phase.model.thinkingLevel}` : ""}
                </div>
              ) : (
                <ModelSelector
                  value={phase.model}
                  onChange={(config) => updateField("model", config)}
                  compact
                  availableModelIds={availableModelIds}
                />
              )}
            </div>
          </div>

          <label className="space-y-1 text-[10px]">
            <span style={labelStyle}>DESCRIPTION</span>
            <input
              value={phase.description}
              onChange={(e) => updateField("description", e.target.value)}
              placeholder="Brief description of what this phase does"
              className="h-7 w-full px-2 outline-none"
              style={inputStyle}
              disabled={readOnly}
            />
          </label>

          <label className="space-y-1 text-[10px]">
            <span style={labelStyle}>INSTRUCTIONS</span>
            <textarea
              value={phase.instructions}
              onChange={(e) => updateField("instructions", e.target.value)}
              className="w-full px-2 py-1.5 outline-none"
              rows={3}
              style={inputStyle}
              disabled={readOnly}
            />
          </label>

          {/* Validation gate */}
          <div className="space-y-1">
            <span style={labelStyle}>VALIDATION GATE</span>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                <span style={{ fontSize: 9 }}>Tier</span>
                <select
                  value={phase.validationGate.tier}
                  onChange={(e) => {
                    const tier = e.target.value as MissionPhaseValidationTier;
                    updateField("validationGate", { ...phase.validationGate, tier });
                  }}
                  className="h-6 px-1 outline-none"
                  style={{ ...inputStyle, width: "auto", minWidth: 90 }}
                  disabled={readOnly}
                >
                  <option value="none">None</option>
                  <option value="self">Self</option>
                  <option value="dedicated">Dedicated</option>
                </select>
              </label>
              <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                <input
                  type="checkbox"
                  checked={phase.validationGate.required}
                  onChange={(e) => {
                    updateField("validationGate", { ...phase.validationGate, required: e.target.checked });
                  }}
                  disabled={readOnly}
                />
                Required
              </label>
            </div>
            {phase.validationGate.tier !== "none" && (
              <input
                value={phase.validationGate.criteria ?? ""}
                onChange={(e) => {
                  updateField("validationGate", { ...phase.validationGate, criteria: e.target.value || undefined });
                }}
                placeholder="Validation criteria (e.g. all tests pass, no lint errors)"
                className="h-6 w-full px-2 outline-none text-[10px]"
                style={inputStyle}
                disabled={readOnly}
              />
            )}
          </div>

          {/* Clarification / askQuestions */}
          <div className="space-y-1">
            <span style={labelStyle} title={phase.orderingConstraints.mustBeFirst
              ? "When enabled, the coordinator must ask clarifying questions before starting this phase"
              : "When enabled, the coordinator may ask clarifying questions when uncertain"
            }>USER CLARIFICATIONS</span>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }} title={phase.orderingConstraints.mustBeFirst
                ? "Planning phase: coordinator MUST ask before proceeding"
                : "Other phases: coordinator MAY ask when genuinely uncertain"
              }>
                <input
                  type="checkbox"
                  checked={phase.askQuestions.enabled}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    updateField("askQuestions", {
                      ...phase.askQuestions,
                      enabled,
                      mode: enabled
                        ? (phase.askQuestions.mode === "never" ? "auto_if_uncertain" : phase.askQuestions.mode)
                        : "never",
                    });
                  }}
                  disabled={readOnly}
                />
                Enabled
              </label>
              <label className="flex items-center gap-1.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                <span style={{ fontSize: 9 }}>Mode</span>
                <select
                  value={phase.askQuestions.mode}
                  onChange={(e) => {
                    const mode = e.target.value as "always" | "auto_if_uncertain" | "never";
                    updateField("askQuestions", {
                      ...phase.askQuestions,
                      mode,
                      enabled: mode === "never" ? false : phase.askQuestions.enabled,
                    });
                  }}
                  className="h-6 px-1 outline-none"
                  style={{ ...inputStyle, width: "auto", minWidth: 130 }}
                  disabled={readOnly}
                >
                  <option value="auto_if_uncertain">Auto (if uncertain)</option>
                  <option value="always">Always</option>
                  <option value="never">Never</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                <span style={{ fontSize: 9 }}>Max questions</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={Math.max(1, Math.min(10, Number(phase.askQuestions.maxQuestions ?? 5) || 5))}
                  onChange={(e) => {
                    const maxQuestions = Math.max(1, Math.min(10, Number(e.target.value) || 5));
                    updateField("askQuestions", { ...phase.askQuestions, maxQuestions });
                  }}
                  className="h-6 w-16 px-1 text-[10px] text-center outline-none"
                  style={inputStyle}
                  disabled={readOnly}
                />
              </label>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
