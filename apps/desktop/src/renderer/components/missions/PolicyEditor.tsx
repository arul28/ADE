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
import { cn } from "../ui/cn";

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
  completion: { allowCompletionWithRisk: true }
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
  prStrategy: { kind: "integration", targetBranch: "main", draft: true }
};

const PRESET_THOROUGH: MissionExecutionPolicy = {
  planning: { mode: "manual_review", model: "claude" },
  implementation: { model: "codex" },
  testing: { mode: "post_implementation", model: "codex" },
  validation: { mode: "required", model: "codex" },
  codeReview: { mode: "required", model: "claude" },
  testReview: { mode: "required", model: "codex" },
  integration: { mode: "auto", model: "codex" },
  merge: { mode: "off" },
  completion: { allowCompletionWithRisk: false },
  prStrategy: { kind: "integration", targetBranch: "main", draft: false }
};

type PresetKey = "quick" | "standard" | "thorough" | "custom";

const PRESET_LABELS: Record<PresetKey, { label: string; desc: string; color: string }> = {
  quick: { label: "Quick", desc: "Minimal steps, no testing", color: "border-sky-500/40 bg-sky-500/10 text-sky-300" },
  standard: { label: "Standard", desc: "Balanced with testing", color: "border-violet-500/40 bg-violet-500/10 text-violet-300" },
  thorough: { label: "Thorough", desc: "Full pipeline with review", color: "border-orange-500/40 bg-orange-500/10 text-orange-300" },
  custom: { label: "Custom", desc: "Phase-level configuration", color: "border-border/40 bg-muted/20 text-muted-fg" }
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

const selectClass = "h-7 rounded border border-border/30 bg-card px-1.5 text-xs text-fg outline-none focus:border-accent/40";

const CODEX_MODELS = ["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex-max", "codex-mini-latest", "o4-mini", "o3"];

function isCodexModel(m?: string): boolean {
  if (!m) return false;
  return m === "codex" || CODEX_MODELS.includes(m);
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
      <span className="w-24 shrink-0 text-xs text-muted-fg">{label}</span>
      <select
        className={cn(selectClass, "flex-1")}
        value={mode}
        onChange={(e) => onModeChange(e.target.value)}
      >
        {modeOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {showModel && onModelChange ? (
        <select
          className={cn(selectClass, "w-28")}
          value={model ?? "codex"}
          onChange={(e) => onModelChange(e.target.value as PhaseModelChoice)}
        >
          <optgroup label="Claude">
            <option value="opus-4-6">Claude Opus 4.6</option>
            <option value="sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="sonnet-4-5">Claude Sonnet 4.5</option>
            <option value="haiku-4-5">Claude Haiku 4.5</option>
          </optgroup>
          <optgroup label="Codex">
            <option value="gpt-5.3-codex">GPT 5.3 Codex</option>
            <option value="gpt-5.2-codex">GPT 5.2 Codex</option>
            <option value="gpt-5.1-codex-max">GPT 5.1 Codex Max</option>
            <option value="codex-mini-latest">Codex Mini</option>
            <option value="o4-mini">O4 Mini</option>
            <option value="o3">O3</option>
          </optgroup>
        </select>
      ) : (
        <div className="w-28" />
      )}
      {showModel && onReasoningEffortChange ? (
        <select
          className={cn(selectClass, "w-20")}
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
            className={cn(
              "flex-1 rounded-lg border px-2 py-1.5 text-center text-xs font-medium transition-colors",
              preset === key
                ? PRESET_LABELS[key].color
                : "border-border/20 bg-card/60 text-muted-fg hover:border-border/40"
            )}
          >
            <div>{PRESET_LABELS[key].label}</div>
            {!compact && <div className="text-[9px] opacity-70">{PRESET_LABELS[key].desc}</div>}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-border/20 bg-card/60 p-2 space-y-0.5">
        <div className="flex items-center gap-2 pb-1 border-b border-border/10 mb-1">
          <span className="w-24 text-[11px] text-muted-fg font-medium">Phase</span>
          <span className="flex-1 text-[11px] text-muted-fg font-medium">Mode</span>
          <span className="w-28 text-[11px] text-muted-fg font-medium">Model</span>
          <span className="w-20 text-[11px] text-muted-fg font-medium">Thinking</span>
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

        <div className="pt-2 border-t border-border/10 mt-1 space-y-2">
          <div className="text-[11px] text-muted-fg font-medium">PR Strategy</div>
          <div className="flex items-center gap-2">
            <select
              className={cn(selectClass, "flex-1")}
              value={value.prStrategy?.kind ?? "manual"}
              onChange={(e) => {
                const kind = e.target.value as PrStrategy["kind"];
                if (kind === "manual") {
                  onChange({ ...value, prStrategy: { kind: "manual" } });
                } else {
                  const prev = value.prStrategy;
                  const targetBranch = (prev && "targetBranch" in prev ? prev.targetBranch : undefined) ?? "main";
                  const draft = prev && "draft" in prev ? prev.draft : true;
                  onChange({ ...value, prStrategy: { kind, targetBranch, draft } });
                }
              }}
            >
              <option value="integration">Integration PR</option>
              <option value="per-lane">Per-Lane PRs</option>
              <option value="manual">Manual (no auto-PR)</option>
            </select>
          </div>
          {value.prStrategy?.kind !== "manual" && (
            <div className="flex items-center gap-2">
              <input
                className="h-7 flex-1 rounded border border-border/30 bg-card px-1.5 text-xs text-fg outline-none focus:border-accent/40"
                placeholder="Target branch"
                value={(value.prStrategy && "targetBranch" in value.prStrategy ? value.prStrategy.targetBranch : undefined) ?? "main"}
                onChange={(e) => {
                  const prev = value.prStrategy as Exclude<PrStrategy, { kind: "manual" }>;
                  onChange({ ...value, prStrategy: { ...prev, targetBranch: e.target.value } });
                }}
              />
              <label className="flex items-center gap-1 text-xs text-muted-fg cursor-pointer whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={(value.prStrategy && "draft" in value.prStrategy ? value.prStrategy.draft : true) ?? true}
                  onChange={(e) => {
                    const prev = value.prStrategy as Exclude<PrStrategy, { kind: "manual" }>;
                    onChange({ ...value, prStrategy: { ...prev, draft: e.target.checked } });
                  }}
                  className="rounded"
                />
                Draft PR
              </label>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1 border-t border-border/10 mt-1">
          <label className="flex items-center gap-1.5 text-xs text-muted-fg cursor-pointer">
            <input
              type="checkbox"
              checked={value.completion.allowCompletionWithRisk}
              onChange={(e) => updatePhase("completion", { allowCompletionWithRisk: e.target.checked })}
              className="rounded"
            />
            Allow completion with risk
          </label>
        </div>

        <div className="flex items-center gap-2 pt-1 border-t border-border/10 mt-1">
          <label className="flex items-center gap-1.5 text-xs text-muted-fg cursor-pointer">
            <input
              type="checkbox"
              checked={value.useAgentTeams ?? false}
              onChange={(e) => onChange({ ...value, useAgentTeams: e.target.checked })}
              className="rounded"
            />
            Agent Teams
          </label>
          <span className="text-[11px] text-muted-fg/70">
            Enable multiple AI agents working in parallel
          </span>
        </div>
      </div>
    </div>
  );
}

export { PRESET_QUICK, PRESET_STANDARD, PRESET_THOROUGH, detectPreset };
