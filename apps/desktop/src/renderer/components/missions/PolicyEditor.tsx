import React, { useCallback } from "react";
import type {
  MissionExecutionPolicy,
  PlanningPhaseMode,
  TestingPhaseMode,
  GatePhaseMode,
  IntegrationPhaseMode,
  PhaseModelChoice,
  PrStrategy
} from "../../../shared/types";
import { CLAUDE_MODELS, CODEX_MODELS } from "../../../shared/modelProfiles";
type PolicyEditorProps = {
  value: MissionExecutionPolicy;
  onChange: (policy: MissionExecutionPolicy) => void;
  compact?: boolean;
};

const PRESET_QUICK: MissionExecutionPolicy = {
  planning: { mode: "off" },
  implementation: { model: "codex" },
  testing: { mode: "none" },
  validation: { mode: "off" },
  codeReview: { mode: "off" },
  testReview: { mode: "off" },
  integration: { mode: "off" },
  merge: { mode: "off" },
  completion: { allowCompletionWithRisk: true },
  prStrategy: { kind: "manual" }
};

const PRESET_STANDARD: MissionExecutionPolicy = {
  planning: { mode: "auto", model: "codex" },
  implementation: { model: "codex" },
  testing: { mode: "post_implementation", model: "codex" },
  validation: { mode: "optional", model: "codex" },
  codeReview: { mode: "off" },
  testReview: { mode: "optional", model: "codex" },
  integration: { mode: "auto", model: "codex" },
  merge: { mode: "off" },
  completion: { allowCompletionWithRisk: true },
  prStrategy: { kind: "queue", targetBranch: "main", draft: true, autoRebase: true, ciGating: false }
};

const PRESET_THOROUGH: MissionExecutionPolicy = {
  planning: { mode: "manual_review", model: "claude" },
  implementation: { model: "codex" },
  testing: { mode: "post_implementation", model: "codex" },
  validation: { mode: "required", model: "claude" },
  codeReview: { mode: "required", model: "claude" },
  testReview: { mode: "required", model: "codex" },
  integration: { mode: "auto", model: "codex" },
  merge: { mode: "off" },
  completion: { allowCompletionWithRisk: false },
  prStrategy: { kind: "integration", targetBranch: "main", draft: false }
};

type PresetKey = "quick" | "standard" | "thorough" | "custom";

const PRESET_LABELS: Record<PresetKey, { label: string; desc: string }> = {
  quick: { label: "QUICK", desc: "Minimal steps, no testing" },
  standard: { label: "STANDARD", desc: "Balanced with testing" },
  thorough: { label: "THOROUGH", desc: "Full pipeline with review" },
  custom: { label: "CUSTOM", desc: "Phase-level configuration" }
};

const PRESET_ACTIVE_STYLES: Record<string, React.CSSProperties> = {
  quick: { background: "#3B82F618", color: "#3B82F6", border: "1px solid #3B82F630" },
  standard: { background: "#A78BFA18", color: "#A78BFA", border: "1px solid #A78BFA30" },
  thorough: { background: "#F59E0B18", color: "#F59E0B", border: "1px solid #F59E0B30" }
};

const PRESET_INACTIVE_STYLE: React.CSSProperties = {
  background: "#13101A",
  color: "#71717A",
  border: "1px solid #1E1B26"
};

function detectPreset(policy: MissionExecutionPolicy): PresetKey {
  if (
    policy.planning.mode === "off" &&
    policy.testing.mode === "none" &&
    policy.validation.mode === "off" &&
    policy.codeReview.mode === "off" &&
    policy.testReview.mode === "off"
  ) return "quick";
  if (
    policy.planning.mode === "auto" &&
    policy.testing.mode === "post_implementation" &&
    policy.validation.mode === "optional" &&
    policy.codeReview.mode === "off" &&
    (policy.testReview.mode === "optional" || policy.testReview.mode === "off")
  ) return "standard";
  if (
    policy.planning.mode === "manual_review" &&
    policy.testing.mode === "post_implementation" &&
    policy.validation.mode === "required" &&
    policy.codeReview.mode === "required" &&
    policy.testReview.mode === "required"
  ) return "thorough";
  return "custom";
}

const selectStyle: React.CSSProperties = {
  height: 28,
  background: "#0C0A10",
  border: "1px solid #27272A",
  color: "#FAFAFA",
  fontFamily: "JetBrains Mono, monospace",
  fontSize: 12,
  padding: "0 6px",
  outline: "none",
  borderRadius: 0
};

const CODEX_MODEL_IDS = CODEX_MODELS.map((m) => m.modelId);

function isCodexModel(m?: string): boolean {
  if (!m) return false;
  return m === "codex" || CODEX_MODEL_IDS.includes(m);
}

function PhaseRow({
  label,
  mode,
  modeOptions,
  onModeChange,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  showModel
}: {
  label: string;
  mode: string;
  modeOptions: Array<{ value: string; label: string }>;
  onModeChange: (value: string) => void;
  model?: PhaseModelChoice;
  onModelChange?: (value: PhaseModelChoice) => void;
  reasoningEffort?: string;
  onReasoningEffortChange?: (value: string) => void;
  showModel: boolean;
}) {
  const codex = isCodexModel(model);
  const thinkingLevels = codex
    ? [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "extra_high", label: "Extra High" }
      ]
    : [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "max", label: "Max" }
      ];

  return (
    <div className="flex items-center gap-2 py-1">
      <span
        className="w-24 shrink-0"
        style={{
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 10,
          fontWeight: 700,
          color: "#71717A",
          textTransform: "uppercase",
          letterSpacing: "1px"
        }}
      >
        {label}
      </span>
      <select
        className="flex-1"
        style={selectStyle}
        value={mode}
        onChange={(e) => onModeChange(e.target.value)}
      >
        {modeOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {showModel && onModelChange ? (
        <select
          className="w-28"
          style={selectStyle}
          value={model ?? "codex"}
          onChange={(e) => onModelChange(e.target.value as PhaseModelChoice)}
        >
          <optgroup label="Claude">
            {CLAUDE_MODELS.map((m) => (
              <option key={m.modelId} value={m.modelId}>{m.displayName}{m.recommended ? " *" : ""}</option>
            ))}
          </optgroup>
          <optgroup label="Codex">
            {CODEX_MODELS.map((m) => (
              <option key={m.modelId} value={m.modelId}>{m.displayName}{m.recommended ? " *" : ""}</option>
            ))}
          </optgroup>
        </select>
      ) : (
        <div className="w-28" />
      )}
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

export function PolicyEditor({ value, onChange, compact }: PolicyEditorProps) {
  const preset = detectPreset(value);

  const applyPreset = useCallback((key: PresetKey) => {
    if (key === "quick") onChange(PRESET_QUICK);
    else if (key === "standard") onChange(PRESET_STANDARD);
    else if (key === "thorough") onChange(PRESET_THOROUGH);
  }, [onChange]);

  const updatePhase = useCallback(<K extends keyof MissionExecutionPolicy>(
    phase: K,
    update: Partial<MissionExecutionPolicy[K] & Record<string, unknown>>
  ) => {
    const prev = value[phase];
    onChange({ ...value, [phase]: typeof prev === "object" && prev !== null ? { ...prev, ...update } : update });
  }, [value, onChange]);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {(["quick", "standard", "thorough"] as const).map((key) => (
          <button
            key={key}
            onClick={() => applyPreset(key)}
            className="flex-1 px-2 py-1.5 text-center transition-colors"
            style={{
              ...(preset === key ? PRESET_ACTIVE_STYLES[key] : PRESET_INACTIVE_STYLE),
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "1px",
              borderRadius: 0
            }}
          >
            <div>{PRESET_LABELS[key].label}</div>
            {!compact && (
              <div style={{ fontSize: 9, opacity: 0.7, fontWeight: 400, textTransform: "none", letterSpacing: "0px" }}>
                {PRESET_LABELS[key].desc}
              </div>
            )}
          </button>
        ))}
      </div>

      <div className="p-2 space-y-0.5" style={{ background: "#13101A", border: "1px solid #1E1B26", borderRadius: 0 }}>
        <div className="flex items-center gap-2 pb-1 mb-1" style={{ borderBottom: "1px solid #1E1B26" }}>
          <span
            className="w-24"
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              fontWeight: 700,
              color: "#71717A",
              textTransform: "uppercase",
              letterSpacing: "1px"
            }}
          >
            PHASE
          </span>
          <span
            className="flex-1"
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              fontWeight: 700,
              color: "#71717A",
              textTransform: "uppercase",
              letterSpacing: "1px"
            }}
          >
            MODE
          </span>
          <span
            className="w-28"
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              fontWeight: 700,
              color: "#71717A",
              textTransform: "uppercase",
              letterSpacing: "1px"
            }}
          >
            MODEL
          </span>
          <span
            className="w-20"
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              fontWeight: 700,
              color: "#71717A",
              textTransform: "uppercase",
              letterSpacing: "1px"
            }}
          >
            THINKING
          </span>
        </div>

        <PhaseRow
          label="Planning"
          mode={value.planning.mode}
          modeOptions={[
            { value: "off", label: "Off" },
            { value: "auto", label: "Auto" },
            { value: "manual_review", label: "Manual Review" }
          ]}
          onModeChange={(v) => updatePhase("planning", { mode: v as PlanningPhaseMode })}
          model={value.planning.model}
          onModelChange={(v) => updatePhase("planning", { model: v })}
          reasoningEffort={value.planning.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("planning", { reasoningEffort: v })}
          showModel={value.planning.mode !== "off"}
        />

        <PhaseRow
          label="Implementation"
          mode="active"
          modeOptions={[{ value: "active", label: "Active" }]}
          onModeChange={() => {}}
          model={value.implementation.model}
          onModelChange={(v) => updatePhase("implementation", { model: v })}
          reasoningEffort={value.implementation.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("implementation", { reasoningEffort: v })}
          showModel
        />

        <PhaseRow
          label="Testing"
          mode={value.testing.mode}
          modeOptions={[
            { value: "none", label: "None" },
            { value: "post_implementation", label: "Post-Implementation" },
            { value: "tdd", label: "TDD" }
          ]}
          onModeChange={(v) => updatePhase("testing", { mode: v as TestingPhaseMode })}
          model={value.testing.model}
          onModelChange={(v) => updatePhase("testing", { model: v })}
          reasoningEffort={value.testing.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("testing", { reasoningEffort: v })}
          showModel={value.testing.mode !== "none"}
        />

        <PhaseRow
          label="Validation"
          mode={value.validation.mode}
          modeOptions={[
            { value: "off", label: "Off" },
            { value: "optional", label: "Optional" },
            { value: "required", label: "Required" }
          ]}
          onModeChange={(v) => updatePhase("validation", { mode: v as GatePhaseMode })}
          model={value.validation.model}
          onModelChange={(v) => updatePhase("validation", { model: v })}
          reasoningEffort={value.validation.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("validation", { reasoningEffort: v })}
          showModel={value.validation.mode !== "off"}
        />

        <PhaseRow
          label="Code Review"
          mode={value.codeReview.mode}
          modeOptions={[
            { value: "off", label: "Off" },
            { value: "optional", label: "Optional" },
            { value: "required", label: "Required" }
          ]}
          onModeChange={(v) => updatePhase("codeReview", { mode: v as GatePhaseMode })}
          model={value.codeReview.model}
          onModelChange={(v) => updatePhase("codeReview", { model: v })}
          reasoningEffort={value.codeReview.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("codeReview", { reasoningEffort: v })}
          showModel={value.codeReview.mode !== "off"}
        />

        <PhaseRow
          label="Test Review"
          mode={value.testReview.mode}
          modeOptions={[
            { value: "off", label: "Off" },
            { value: "optional", label: "Optional" },
            { value: "required", label: "Required" }
          ]}
          onModeChange={(v) => updatePhase("testReview", { mode: v as GatePhaseMode })}
          model={value.testReview.model}
          onModelChange={(v) => updatePhase("testReview", { model: v })}
          reasoningEffort={value.testReview.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("testReview", { reasoningEffort: v })}
          showModel={value.testReview.mode !== "off"}
        />

        <PhaseRow
          label="Integration"
          mode={value.integration.mode}
          modeOptions={[
            { value: "off", label: "Off" },
            { value: "auto", label: "Auto" }
          ]}
          onModeChange={(v) => updatePhase("integration", { mode: v as IntegrationPhaseMode })}
          model={value.integration.model}
          onModelChange={(v) => updatePhase("integration", { model: v })}
          reasoningEffort={value.integration.reasoningEffort}
          onReasoningEffortChange={(v) => updatePhase("integration", { reasoningEffort: v })}
          showModel={value.integration.mode !== "off"}
        />

        <div className="pt-2 mt-1 space-y-2" style={{ borderTop: "1px solid #1E1B26" }}>
          <div
            style={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              fontWeight: 700,
              color: "#71717A",
              textTransform: "uppercase",
              letterSpacing: "1px"
            }}
          >
            PR STRATEGY
          </div>
          <div className="flex items-center gap-2">
            <select
              className="flex-1"
              style={selectStyle}
              value={value.prStrategy?.kind ?? "manual"}
              onChange={(e) => {
                const kind = e.target.value as PrStrategy["kind"];
                if (kind === "manual") {
                  onChange({ ...value, prStrategy: { kind: "manual" } });
                } else {
                  const prev = value.prStrategy;
                  const targetBranch = (prev && "targetBranch" in prev ? prev.targetBranch : undefined) ?? "main";
                  const draft = prev && "draft" in prev ? prev.draft : true;
                  if (kind === "queue") {
                    const autoRebase = prev && "autoRebase" in prev ? prev.autoRebase : true;
                    const ciGating = prev && "ciGating" in prev ? prev.ciGating : false;
                    onChange({ ...value, prStrategy: { kind, targetBranch, draft, autoRebase, ciGating } });
                  } else {
                    onChange({ ...value, prStrategy: { kind, targetBranch, draft } });
                  }
                }
              }}
            >
              <option value="integration">Integration PR</option>
              <option value="per-lane">Per-Lane PRs</option>
              <option value="queue">Queue (ordered merge)</option>
              <option value="manual">Manual (no auto-PR)</option>
            </select>
          </div>
          {value.prStrategy?.kind !== "manual" && (
            <div className="flex items-center gap-2">
              <input
                className="flex-1"
                style={{
                  height: 28,
                  background: "#0C0A10",
                  border: "1px solid #27272A",
                  color: "#FAFAFA",
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 12,
                  padding: "0 6px",
                  outline: "none",
                  borderRadius: 0
                }}
                placeholder="Target branch"
                value={(value.prStrategy && "targetBranch" in value.prStrategy ? value.prStrategy.targetBranch : undefined) ?? "main"}
                onChange={(e) => {
                  const prev = value.prStrategy as Exclude<PrStrategy, { kind: "manual" }>;
                  onChange({ ...value, prStrategy: { ...prev, targetBranch: e.target.value } });
                }}
              />
              <label
                className="flex items-center gap-1 cursor-pointer whitespace-nowrap"
                style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#71717A" }}
              >
                <input
                  type="checkbox"
                  checked={(value.prStrategy && "draft" in value.prStrategy ? value.prStrategy.draft : true) ?? true}
                  onChange={(e) => {
                    const prev = value.prStrategy as Exclude<PrStrategy, { kind: "manual" }>;
                    onChange({ ...value, prStrategy: { ...prev, draft: e.target.checked } });
                  }}
                />
                Draft PR
              </label>
            </div>
          )}
          {value.prStrategy?.kind === "queue" && (
            <div className="flex items-center gap-3">
              <label
                className="flex items-center gap-1 cursor-pointer whitespace-nowrap"
                style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#71717A" }}
              >
                <input
                  type="checkbox"
                  checked={(value.prStrategy && "autoRebase" in value.prStrategy ? value.prStrategy.autoRebase : true) ?? true}
                  onChange={(e) => {
                    const prev = value.prStrategy as Extract<PrStrategy, { kind: "queue" }>;
                    onChange({ ...value, prStrategy: { ...prev, autoRebase: e.target.checked } });
                  }}
                />
                Auto-rebase
              </label>
              <label
                className="flex items-center gap-1 cursor-pointer whitespace-nowrap"
                style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#71717A" }}
              >
                <input
                  type="checkbox"
                  checked={(value.prStrategy && "ciGating" in value.prStrategy ? value.prStrategy.ciGating : false) ?? false}
                  onChange={(e) => {
                    const prev = value.prStrategy as Extract<PrStrategy, { kind: "queue" }>;
                    onChange({ ...value, prStrategy: { ...prev, ciGating: e.target.checked } });
                  }}
                />
                CI gating
              </label>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1 mt-1" style={{ borderTop: "1px solid #1E1B26" }}>
          <label
            className="flex items-center gap-1.5 cursor-pointer"
            style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#71717A" }}
          >
            <input
              type="checkbox"
              checked={value.completion.allowCompletionWithRisk}
              onChange={(e) => updatePhase("completion", { allowCompletionWithRisk: e.target.checked })}
            />
            Allow completion with risk
          </label>
        </div>

        <div className="flex items-center gap-2 pt-1 mt-1" style={{ borderTop: "1px solid #1E1B26" }}>
          <label
            className="flex items-center gap-1.5 cursor-pointer"
            style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12, color: "#71717A" }}
          >
            <input
              type="checkbox"
              checked={value.useAgentTeams ?? false}
              onChange={(e) => onChange({ ...value, useAgentTeams: e.target.checked })}
            />
            Agent Teams
          </label>
          <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11, color: "#52525B" }}>
            Enable multiple AI agents working in parallel
          </span>
        </div>
      </div>
    </div>
  );
}

export { PRESET_QUICK, PRESET_STANDARD, PRESET_THOROUGH, detectPreset };
