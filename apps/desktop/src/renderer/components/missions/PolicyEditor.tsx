import React, { useCallback } from "react";
import type {
  MissionExecutionPolicy,
  PlanningPhaseMode,
  TestingPhaseMode,
  GatePhaseMode,
  PhaseModelChoice,
  TeamRuntimeConfig,
} from "../../../shared/types";
import { MODEL_REGISTRY, MODEL_FAMILIES, getModelById, type ProviderFamily } from "../../../shared/modelRegistry";
import { COLORS, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";

type PolicyEditorProps = {
  value: MissionExecutionPolicy;
  onChange: (policy: MissionExecutionPolicy) => void;
};

const PRESET_QUICK: MissionExecutionPolicy = {
  planning: { mode: "off" },
  implementation: { model: "openai/gpt-5.3-codex" },
  testing: { mode: "none" },
  validation: { mode: "off" },
  codeReview: { mode: "off" },
  testReview: { mode: "off" },
  prReview: { mode: "off" },
  merge: { mode: "off" },
  completion: { allowCompletionWithRisk: true },
  prStrategy: { kind: "manual" }
};

const PRESET_STANDARD: MissionExecutionPolicy = {
  planning: { mode: "auto", model: "openai/gpt-5.3-codex" },
  implementation: { model: "openai/gpt-5.3-codex" },
  testing: { mode: "post_implementation", model: "openai/gpt-5.3-codex" },
  validation: { mode: "optional", model: "openai/gpt-5.3-codex" },
  codeReview: { mode: "off" },
  testReview: { mode: "optional", model: "openai/gpt-5.3-codex" },
  prReview: { mode: "off" },
  merge: { mode: "off" },
  completion: { allowCompletionWithRisk: true },
  prStrategy: { kind: "queue", targetBranch: "main", draft: true, autoRebase: true, ciGating: false }
};

const selectStyle: React.CSSProperties = {
  height: 28,
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  color: COLORS.textPrimary,
  fontFamily: MONO_FONT,
  fontSize: 12,
  padding: "0 6px",
  outline: "none",
  borderRadius: 0
};

function getReasoningTiers(modelId?: string): Array<{ value: string; label: string }> {
  if (!modelId) return [{ value: "medium", label: "Medium" }];
  const descriptor = getModelById(modelId);
  if (!descriptor?.reasoningTiers?.length) return [{ value: "medium", label: "Medium" }];
  return descriptor.reasoningTiers.map((t) => ({
    value: t,
    label: t.charAt(0).toUpperCase() + t.slice(1).replace("_", " "),
  }));
}

// ─────────────────────────────────────────────────────
// Toggle switch (matches SmartBudgetPanel style)
// ─────────────────────────────────────────────────────

function ToggleSwitch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      onClick={() => !disabled && onChange(!on)}
      className="relative shrink-0"
      style={{
        width: 28,
        height: 14,
        background: on ? "#22C55E" : COLORS.border,
        border: "none",
        borderRadius: 0,
        cursor: disabled ? "default" : "pointer",
        transition: "background 0.2s ease",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 2,
          left: on ? 14 : 2,
          width: 10,
          height: 10,
          background: on ? COLORS.textPrimary : COLORS.textDim,
          borderRadius: 0,
          transition: "left 0.2s ease",
        }}
      />
    </button>
  );
}

// ─────────────────────────────────────────────────────
// Agent Row
// ─────────────────────────────────────────────────────

function AgentRow({
  label,
  on,
  onToggle,
  alwaysOn,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
}: {
  label: string;
  on: boolean;
  onToggle?: (enabled: boolean) => void;
  alwaysOn?: boolean;
  model?: PhaseModelChoice;
  onModelChange?: (value: PhaseModelChoice) => void;
  reasoningEffort?: string;
  onReasoningEffortChange?: (value: string) => void;
}) {
  const thinkingLevels = getReasoningTiers(model);
  const showModel = on && onModelChange;
  const labelColor = on ? "#22C55E" : COLORS.textDim;

  return (
    <div className="flex items-center gap-2 py-1">
      {/* Toggle */}
      <div className="w-7 shrink-0 flex justify-center">
        {alwaysOn ? (
          <div
            style={{
              width: 8,
              height: 8,
              background: "#22C55E",
              borderRadius: 0,
            }}
          />
        ) : (
          <ToggleSwitch on={on} onChange={onToggle ?? (() => {})} />
        )}
      </div>

      {/* Agent label */}
      <span
        className="w-32 shrink-0"
        style={{
          fontFamily: MONO_FONT,
          fontSize: 10,
          fontWeight: 700,
          color: labelColor,
          textTransform: "uppercase",
          letterSpacing: "1px",
          transition: "color 0.2s ease",
        }}
      >
        {label}
      </span>

      {/* Model selector */}
      {showModel ? (
        <select
          className="w-36"
          style={selectStyle}
          value={model ?? "openai/gpt-5.3-codex"}
          onChange={(e) => onModelChange(e.target.value as PhaseModelChoice)}
        >
          {([...new Set(MODEL_REGISTRY.map((m) => m.family))] as ProviderFamily[]).map((family) => {
            const familyModels = MODEL_REGISTRY.filter((m) => m.family === family && !m.deprecated);
            if (!familyModels.length) return null;
            return (
              <optgroup key={family} label={MODEL_FAMILIES[family]?.displayName ?? family}>
                {familyModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}</option>
                ))}
              </optgroup>
            );
          })}
        </select>
      ) : (
        <div className="w-36" />
      )}

      {/* Reasoning effort */}
      {showModel && onReasoningEffortChange ? (
        <select
          className="w-20"
          style={selectStyle}
          value={reasoningEffort ?? "medium"}
          onChange={(e) => onReasoningEffortChange(e.target.value)}
        >
          {thinkingLevels.map((lvl) => (
            <option key={lvl.value} value={lvl.value}>{lvl.label}</option>
          ))}
        </select>
      ) : (
        <div className="w-20" />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────
// PolicyEditor
// ─────────────────────────────────────────────────────

export function PolicyEditor({ value, onChange }: PolicyEditorProps) {
  const updatePhase = useCallback(<K extends keyof MissionExecutionPolicy>(
    phase: K,
    update: Partial<MissionExecutionPolicy[K] & Record<string, unknown>>
  ) => {
    const prev = value[phase];
    onChange({ ...value, [phase]: typeof prev === "object" && prev !== null ? { ...prev, ...update } : update });
  }, [value, onChange]);

  // Derive on/off state for each agent
  const planningOn = value.planning.mode !== "off";
  const testingOn = value.testing.mode !== "none";
  const validationOn = value.validation.mode !== "off";
  const codeReviewOn = value.codeReview.mode !== "off";
  const testReviewOn = value.testReview.mode !== "off";
  const prReviewOn = (value.prReview?.mode ?? "off") !== "off";

  const teamRuntime = value.teamRuntime;
  const teamEnabled = teamRuntime?.enabled ?? false;

  const updateTeamRuntime = useCallback((update: Partial<TeamRuntimeConfig>) => {
    const current: TeamRuntimeConfig = value.teamRuntime ?? { enabled: false, targetProvider: "auto", teammateCount: 2 };
    onChange({ ...value, teamRuntime: { ...current, ...update } });
  }, [value, onChange]);

  return (
    <div className="space-y-2">
      <div className="p-2 space-y-0.5" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, borderRadius: 0 }}>
        {/* Column headers */}
        <div className="flex items-center gap-2 pb-1 mb-1" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
          <span className="w-7 shrink-0" />
          <span className="w-32 shrink-0" style={LABEL_STYLE}>AGENT</span>
          <span className="w-36" style={LABEL_STYLE}>MODEL</span>
          <span className="w-20" style={LABEL_STYLE}>THINKING</span>
        </div>

        {/* Planning Agent */}
        <AgentRow
          label="Planning Agent"
          on={planningOn}
          onToggle={(enabled) => updatePhase("planning", { mode: (enabled ? "auto" : "off") as PlanningPhaseMode })}
          model={value.planning.model}
          onModelChange={(v) => updatePhase("planning", { model: v })}
          reasoningEffort={value.planning.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("planning", { reasoningEffort: v })}
        />

        {/* Implementation Agent — always on */}
        <AgentRow
          label="Impl Agent"
          on
          alwaysOn
          model={value.implementation.model}
          onModelChange={(v) => updatePhase("implementation", { model: v })}
          reasoningEffort={value.implementation.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("implementation", { reasoningEffort: v })}
        />

        {/* Testing Agent */}
        <AgentRow
          label="Testing Agent"
          on={testingOn}
          onToggle={(enabled) => updatePhase("testing", { mode: (enabled ? "post_implementation" : "none") as TestingPhaseMode })}
          model={value.testing.model}
          onModelChange={(v) => updatePhase("testing", { model: v })}
          reasoningEffort={value.testing.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("testing", { reasoningEffort: v })}
        />

        {/* Validation Agent */}
        <AgentRow
          label="Validation Agent"
          on={validationOn}
          onToggle={(enabled) => updatePhase("validation", { mode: (enabled ? "required" : "off") as GatePhaseMode })}
          model={value.validation.model}
          onModelChange={(v) => updatePhase("validation", { model: v })}
          reasoningEffort={value.validation.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("validation", { reasoningEffort: v })}
        />

        {/* Code Review Agent */}
        <AgentRow
          label="Code Review Agent"
          on={codeReviewOn}
          onToggle={(enabled) => updatePhase("codeReview", { mode: (enabled ? "required" : "off") as GatePhaseMode })}
          model={value.codeReview.model}
          onModelChange={(v) => updatePhase("codeReview", { model: v })}
          reasoningEffort={value.codeReview.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("codeReview", { reasoningEffort: v })}
        />

        {/* Test Review Agent */}
        <AgentRow
          label="Test Review Agent"
          on={testReviewOn}
          onToggle={(enabled) => updatePhase("testReview", { mode: (enabled ? "required" : "off") as GatePhaseMode })}
          model={value.testReview.model}
          onModelChange={(v) => updatePhase("testReview", { model: v })}
          reasoningEffort={value.testReview.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("testReview", { reasoningEffort: v })}
        />

        {/* PR Review Agent */}
        <AgentRow
          label="PR Review Agent"
          on={prReviewOn}
          onToggle={(enabled) => updatePhase("prReview", { mode: enabled ? "auto" : "off" })}
          model={value.prReview?.model}
          onModelChange={(v) => updatePhase("prReview", { model: v })}
          reasoningEffort={value.prReview?.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("prReview", { reasoningEffort: v })}
        />
      </div>

      {/* Team Runtime */}
      <div className="p-2 space-y-1" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, borderRadius: 0 }}>
        <div className="flex items-center gap-2 pb-1 mb-1" style={{ borderBottom: `1px solid ${COLORS.border}` }}>
          <span style={LABEL_STYLE}>TEAM RUNTIME</span>
        </div>
        <div className="flex items-center gap-2 py-1">
          <div className="w-7 shrink-0 flex justify-center">
            <ToggleSwitch on={teamEnabled} onChange={(v) => updateTeamRuntime({ enabled: v })} />
          </div>
          <span
            className="w-32 shrink-0"
            style={{
              fontFamily: MONO_FONT,
              fontSize: 10,
              fontWeight: 700,
              color: teamEnabled ? "#22C55E" : COLORS.textDim,
              textTransform: "uppercase",
              letterSpacing: "1px",
              transition: "color 0.2s ease",
            }}
          >
            Team Mode
          </span>
          {teamEnabled && (
            <>
              <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                <span>COUNT</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={teamRuntime?.teammateCount ?? 2}
                  onChange={(e) => updateTeamRuntime({ teammateCount: Math.max(1, Math.min(8, Number(e.target.value) || 2)) })}
                  className="h-6 w-10 px-1 text-xs text-center outline-none"
                  style={selectStyle}
                />
              </label>
              <label className="flex items-center gap-1 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                <span>PROVIDER</span>
                <select
                  value={teamRuntime?.targetProvider ?? "auto"}
                  onChange={(e) => updateTeamRuntime({ targetProvider: e.target.value as "claude" | "codex" | "auto" })}
                  style={selectStyle}
                >
                  <option value="auto">Auto</option>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export { PRESET_QUICK, PRESET_STANDARD };
