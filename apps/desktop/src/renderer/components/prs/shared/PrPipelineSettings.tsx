import React from "react";
import type {
  AiPermissionMode,
  AutoConflictAgentProvider,
  AutoConflictAgentSettings,
  ConflictResolverPermissionMode,
  ConflictStrategy,
  ForceFinalizeMode,
  PipelineMergeMethod,
  PipelineSettings,
} from "../../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import { PrResolverLaunchControls } from "./PrResolverLaunchControls";
import { SmartTooltip, type SmartTooltipContent } from "../../ui/SmartTooltip";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PrPipelineSettingsProps = {
  settings: PipelineSettings;
  onSettingsChange: (settings: Partial<PipelineSettings>) => void;
  showAutoConvergeSettings?: boolean;
  modelId: string;
  reasoningEffort: string;
  permissionMode: AiPermissionMode;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionModeChange: (mode: AiPermissionMode) => void;
  disabled?: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MERGE_METHOD_OPTIONS: Array<{ value: PipelineMergeMethod; label: string }> = [
  { value: "repo_default", label: "Repo default" },
  { value: "merge", label: "Merge commit" },
  { value: "squash", label: "Squash and merge" },
  { value: "rebase", label: "Rebase and merge" },
];

type ConflictStrategyOption = {
  value: ConflictStrategy;
  label: string;
  tooltip: SmartTooltipContent;
};

const CONFLICT_STRATEGY_OPTIONS: ConflictStrategyOption[] = [
  {
    value: "pause",
    label: "Pause and wait for me",
    tooltip: {
      label: "Pause on conflict",
      description:
        "When the base branch advances or a merge conflict appears, stop the loop and surface it so you can resolve it by hand.",
    },
  },
  {
    value: "rebase",
    label: "Rebase the PR onto the new base",
    tooltip: {
      label: "Auto-rebase",
      description:
        "Run git rebase onto the latest base and force-push (with --force-with-lease). Fast and clean — but rewrites history.",
    },
  },
  {
    value: "merge",
    label: "Merge the new base into the PR branch",
    tooltip: {
      label: "Auto-merge base",
      description:
        "Merge the latest base commit into the PR branch. Preserves history and avoids force-push, but adds a merge commit.",
    },
  },
  {
    value: "auto",
    label: "Let an agent decide and resolve",
    tooltip: {
      label: "Agent-resolved conflicts",
      description:
        "An agent picks rebase vs merge and resolves any conflict markers itself. Configure the agent in the section below.",
    },
  },
];

type ForceFinalizeOption = {
  value: ForceFinalizeMode;
  label: string;
  tooltip: SmartTooltipContent;
};

const FORCE_FINALIZE_OPTIONS: ForceFinalizeOption[] = [
  {
    value: "off",
    label: "Don't force-merge",
    tooltip: {
      label: "Force-finalize off",
      description:
        "If iterations run out without converging, stop and leave the PR alone. Safest — you'll come back and finish by hand.",
    },
  },
  {
    value: "unconditional",
    label: "Force-merge once iterations are exhausted",
    tooltip: {
      label: "Always force-finalize",
      description:
        "After the last iteration, run one more pass that lands the merge no matter what.",
      warning: "Bypasses unresolved review comments and ignores most checks.",
    },
  },
  {
    value: "conditional",
    label: "Force-merge only if conditions hold",
    tooltip: {
      label: "Conditional force-finalize",
      description:
        "Run the bonus merge pass only when guardrails below pass — e.g. no CI checks are currently failing.",
    },
  },
];

const AUTO_AGENT_PROVIDER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "__inherit", label: "Inherit default" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

const AUTO_AGENT_REASONING_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "__unspecified", label: "Unspecified" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const AUTO_AGENT_PERMISSION_OPTIONS: Array<{
  value: ConflictResolverPermissionMode;
  label: string;
  tooltip: SmartTooltipContent;
}> = [
  {
    value: "read_only",
    label: "Read only",
    tooltip: {
      label: "Read-only resolver",
      description:
        "The agent can plan but not write to disk. Use when you want to inspect what it would do without touching files.",
    },
  },
  {
    value: "guarded_edit",
    label: "Guarded edit",
    tooltip: {
      label: "Guarded edits",
      description:
        "The agent edits files but is restricted from destructive shell commands. Sensible default for most repos.",
    },
  },
  {
    value: "full_edit",
    label: "Full edit",
    tooltip: {
      label: "Full edit access",
      description:
        "Unrestricted edits and shell access. Fastest at resolving messy conflicts; most risky if the agent misjudges.",
    },
  },
];

const ACCENT_GREEN = "#22C55E";
const WARNING_AMBER = "#F59E0B";

// ---------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------

const STYLE_ID = "pr-pipeline-settings-keyframes";

function ensureKeyframes() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes pipelineToggleOn {
      from { background-position: 0% 50%; }
      to { background-position: 100% 50%; }
    }
    /* select arrow override */
    select.pipeline-select {
      -webkit-appearance: none;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235A5670'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      padding-right: 24px;
    }
    select.pipeline-select:focus {
      outline: none;
      border-color: color-mix(in srgb, var(--color-accent) 60%, transparent);
    }
    input.pipeline-number::-webkit-inner-spin-button,
    input.pipeline-number::-webkit-outer-spin-button {
      opacity: 1;
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionDivider({ label }: { label: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 14,
        marginBottom: 8,
      }}
    >
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 9,
          fontWeight: 700,
          color: COLORS.textDim,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <div
        style={{
          flex: 1,
          height: 1,
          background: COLORS.border,
        }}
      />
    </div>
  );
}

function SettingCard({
  children,
  muted,
}: {
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      style={{
        borderRadius: 8,
        border: `1px solid ${COLORS.border}`,
        background: muted ? "rgba(255,255,255,0.008)" : "rgba(255,255,255,0.02)",
        padding: 12,
        opacity: muted ? 0.55 : 1,
        transition: "opacity 0.2s ease",
      }}
    >
      {children}
    </div>
  );
}

function FieldLabel({
  text,
  tooltip,
  disabled,
}: {
  text: string;
  tooltip: SmartTooltipContent;
  disabled?: boolean;
}) {
  return (
    <SmartTooltip content={tooltip} forceEnabled side="top">
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 12,
          fontWeight: 600,
          color: disabled ? COLORS.textDim : COLORS.textPrimary,
          borderBottom: `1px dotted ${disabled ? "transparent" : COLORS.border}`,
          cursor: "help",
          paddingBottom: 1,
        }}
      >
        {text}
      </span>
    </SmartTooltip>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 40,
        height: 22,
        borderRadius: 999,
        border: checked ? `1px solid ${ACCENT_GREEN}50` : `1px solid rgba(255,255,255,0.12)`,
        background: checked
          ? `linear-gradient(135deg, ${ACCENT_GREEN}CC, ${ACCENT_GREEN})`
          : "rgba(255,255,255,0.06)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        padding: 0,
        transition: "all 0.2s ease",
        flexShrink: 0,
        boxShadow: checked ? `0 0 8px ${ACCENT_GREEN}30` : "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 20 : 2,
          width: 16,
          height: 16,
          borderRadius: 999,
          background: "#FAFAFA",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          transition: "left 0.2s ease",
        }}
      />
    </button>
  );
}

function StyledSelect({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <select
      className="pipeline-select"
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={{
        fontFamily: SANS_FONT,
        fontSize: 11,
        fontWeight: 500,
        color: disabled ? COLORS.textDim : COLORS.textSecondary,
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 6,
        padding: "5px 8px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: "all 0.15s ease",
        minWidth: 0,
        flex: 1,
        maxWidth: 220,
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function RadioRow<T extends string>({
  value,
  selected,
  onSelect,
  label,
  tooltip,
  disabled,
  accent,
}: {
  value: T;
  selected: boolean;
  onSelect: (v: T) => void;
  label: string;
  tooltip: SmartTooltipContent;
  disabled?: boolean;
  accent?: string;
}) {
  const ringColor = accent ?? COLORS.accent;
  return (
    <SmartTooltip content={tooltip} forceEnabled side="top" wrapperStyle={{ width: "100%" }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "7px 9px",
          borderRadius: 6,
          cursor: disabled ? "not-allowed" : "pointer",
          background: selected ? "rgba(255,255,255,0.035)" : "transparent",
          border: `1px solid ${selected ? `${ringColor}55` : "transparent"}`,
          transition: "background 0.15s ease, border-color 0.15s ease",
          opacity: disabled ? 0.55 : 1,
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        <span
          style={{
            position: "relative",
            width: 14,
            height: 14,
            borderRadius: 999,
            border: `1.5px solid ${selected ? ringColor : "rgba(255,255,255,0.22)"}`,
            background: "rgba(0,0,0,0.2)",
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "border-color 0.15s ease",
          }}
        >
          {selected ? (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: ringColor,
              }}
            />
          ) : null}
        </span>
        <input
          type="radio"
          checked={selected}
          disabled={disabled}
          onChange={() => onSelect(value)}
          style={{
            position: "absolute",
            opacity: 0,
            width: 0,
            height: 0,
            pointerEvents: "none",
          }}
        />
        <span
          style={{
            fontFamily: SANS_FONT,
            fontSize: 12,
            fontWeight: selected ? 600 : 500,
            color: disabled ? COLORS.textDim : selected ? COLORS.textPrimary : COLORS.textSecondary,
            lineHeight: 1.4,
          }}
        >
          {label}
        </span>
      </label>
    </SmartTooltip>
  );
}

function NumericInput({
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  ariaLabel,
  width = 70,
}: {
  value: number | null;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  ariaLabel?: string;
  width?: number;
}) {
  return (
    <input
      type="number"
      className="pipeline-number"
      aria-label={ariaLabel}
      value={value ?? ""}
      min={min}
      max={max}
      step={step ?? 1}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") {
          onChange(null);
          return;
        }
        const parsed = Number(raw);
        if (Number.isNaN(parsed)) return;
        const clamped = Math.min(max, Math.max(min, parsed));
        onChange(clamped);
      }}
      disabled={disabled}
      style={{
        fontFamily: MONO_FONT,
        fontSize: 12,
        fontWeight: 600,
        color: disabled ? COLORS.textDim : COLORS.textPrimary,
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 6,
        padding: "5px 8px",
        width,
        textAlign: "right",
        opacity: disabled ? 0.45 : 1,
        outline: "none",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PrPipelineSettings({
  settings,
  onSettingsChange,
  showAutoConvergeSettings = true,
  modelId,
  reasoningEffort,
  permissionMode,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
  disabled = false,
}: PrPipelineSettingsProps) {
  React.useEffect(() => {
    ensureKeyframes();
  }, []);

  const {
    autoMerge,
    mergeMethod,
    maxRounds,
    conflictStrategy,
    autoAgentSettings,
    forceFinalizeMode,
    forceFinalizeRequireNoCiFailures,
    earlyMergeOnGreen,
  } = settings;

  const mergeDisabled = disabled || !autoMerge;
  const showsForcePushWarning = conflictStrategy === "rebase" || conflictStrategy === "auto";
  const autoAgentDisabled = disabled || conflictStrategy !== "auto";

  const updateAutoAgent = (partial: Partial<AutoConflictAgentSettings>) => {
    onSettingsChange({
      autoAgentSettings: { ...autoAgentSettings, ...partial },
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* --- Auto-converge-only settings (hidden in manual mode) --- */}
      {showAutoConvergeSettings && (
      <>
      {/* ── Auto-merge card ── */}
      <SettingCard>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <FieldLabel
              text="Auto-merge when ready"
              tooltip={{
                label: "Auto-merge",
                description:
                  "Once iterations finish (or early-merge fires), land the PR on GitHub without waiting for you to click merge.",
              }}
            />
            <span
              style={{
                fontFamily: SANS_FONT,
                fontSize: 11,
                color: COLORS.textMuted,
                lineHeight: 1.4,
              }}
            >
              Merge automatically as soon as convergence is satisfied.
            </span>
          </div>
          <ToggleSwitch
            checked={autoMerge}
            onChange={(v) => onSettingsChange({ autoMerge: v })}
            disabled={disabled}
            ariaLabel="Auto-merge"
          />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginTop: 10,
            paddingTop: 10,
            borderTop: `1px solid ${COLORS.border}`,
          }}
        >
          <FieldLabel
            text="Merge method"
            tooltip={{
              label: "Merge method",
              description:
                "How GitHub combines the PR — repo default uses whatever the repository allows. Only applies when auto-merge is on.",
            }}
            disabled={mergeDisabled}
          />
          <StyledSelect
            value={mergeMethod}
            onChange={(v) => onSettingsChange({ mergeMethod: v as PipelineMergeMethod })}
            options={MERGE_METHOD_OPTIONS}
            disabled={mergeDisabled}
            ariaLabel="Merge method"
          />
        </div>
      </SettingCard>

      {/* ── Conflict strategy + auto-agent ── */}
      <SettingCard>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <FieldLabel
            text="When the base branch advances or a merge conflict appears"
            tooltip={{
              label: "Conflict strategy",
              description:
                "How the convergence loop reacts when the base moves or a conflict surfaces between iterations.",
            }}
          />
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 11,
              color: COLORS.textMuted,
              lineHeight: 1.4,
            }}
          >
            Pick one. Hover any option for details.
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 8 }}>
          {CONFLICT_STRATEGY_OPTIONS.map((opt) => (
            <RadioRow
              key={opt.value}
              value={opt.value}
              selected={conflictStrategy === opt.value}
              onSelect={(v) => onSettingsChange({ conflictStrategy: v })}
              label={opt.label}
              tooltip={opt.tooltip}
              disabled={disabled}
            />
          ))}
        </div>

        {showsForcePushWarning ? (
          <div
            style={{
              marginTop: 8,
              padding: "7px 10px",
              borderRadius: 6,
              background: "rgba(245,158,11,0.08)",
              border: `1px solid rgba(245,158,11,0.25)`,
              color: WARNING_AMBER,
              fontFamily: SANS_FONT,
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            Selected strategies may force-push your branch.
          </div>
        ) : null}

        {/* Auto-agent sub-section — visually muted when not in `auto` */}
        <div style={{ marginTop: 12 }}>
          <SectionDivider label="Auto-agent settings" />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              opacity: autoAgentDisabled ? 0.55 : 1,
              transition: "opacity 0.2s ease",
              pointerEvents: autoAgentDisabled ? "none" : "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <FieldLabel
                text="Provider"
                tooltip={{
                  label: "Resolver provider",
                  description:
                    "Which agent runtime resolves the conflict. Inherit-default falls back to your project-wide resolver provider.",
                }}
                disabled={autoAgentDisabled}
              />
              <StyledSelect
                value={autoAgentSettings.provider ?? "__inherit"}
                onChange={(v) =>
                  updateAutoAgent({
                    provider: v === "__inherit" ? null : (v as AutoConflictAgentProvider),
                  })
                }
                options={AUTO_AGENT_PROVIDER_OPTIONS}
                disabled={autoAgentDisabled}
                ariaLabel="Auto-agent provider"
              />
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <FieldLabel
                text="Model"
                tooltip={{
                  label: "Resolver model",
                  description:
                    "Override the model the resolver uses (e.g. anthropic/claude-3-5-sonnet). Leave blank to use the provider's default.",
                }}
                disabled={autoAgentDisabled}
              />
              <input
                type="text"
                aria-label="Auto-agent model"
                value={autoAgentSettings.model ?? ""}
                placeholder="Provider default"
                onChange={(e) => {
                  const next = e.target.value.trim();
                  updateAutoAgent({ model: next === "" ? null : next });
                }}
                disabled={autoAgentDisabled}
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: 11,
                  color: autoAgentDisabled ? COLORS.textDim : COLORS.textPrimary,
                  background: "rgba(255,255,255,0.03)",
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 6,
                  padding: "5px 8px",
                  width: 220,
                  outline: "none",
                  opacity: autoAgentDisabled ? 0.45 : 1,
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <FieldLabel
                text="Reasoning effort"
                tooltip={{
                  label: "Reasoning effort",
                  description:
                    "How hard the model thinks before answering. Higher costs more tokens — useful for gnarly conflicts, overkill for trivial ones.",
                }}
                disabled={autoAgentDisabled}
              />
              <StyledSelect
                value={autoAgentSettings.reasoningEffort ?? "__unspecified"}
                onChange={(v) =>
                  updateAutoAgent({ reasoningEffort: v === "__unspecified" ? null : v })
                }
                options={AUTO_AGENT_REASONING_OPTIONS}
                disabled={autoAgentDisabled}
                ariaLabel="Auto-agent reasoning effort"
              />
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <FieldLabel
                text="Permission mode"
                tooltip={{
                  label: "Resolver permissions",
                  description:
                    "How much access the resolver agent has. Lower trust = safer but may stall on tricky conflicts that need shell or write access.",
                }}
                disabled={autoAgentDisabled}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {AUTO_AGENT_PERMISSION_OPTIONS.map((opt) => (
                  <RadioRow
                    key={opt.value}
                    value={opt.value}
                    selected={autoAgentSettings.permissionMode === opt.value}
                    onSelect={(v) => updateAutoAgent({ permissionMode: v })}
                    label={opt.label}
                    tooltip={opt.tooltip}
                    disabled={autoAgentDisabled}
                  />
                ))}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <FieldLabel
                text="Confidence threshold"
                tooltip={{
                  label: "Confidence threshold",
                  description:
                    "Minimum confidence (0–1) the resolver must report before its fix is accepted. Leave blank to accept any fix the agent produces.",
                }}
                disabled={autoAgentDisabled}
              />
              <NumericInput
                value={autoAgentSettings.confidenceThreshold}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => updateAutoAgent({ confidenceThreshold: v })}
                disabled={autoAgentDisabled}
                ariaLabel="Confidence threshold"
                width={80}
              />
            </div>
          </div>
        </div>
      </SettingCard>

      {/* ── Iteration cap ── */}
      <SettingCard>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <FieldLabel
              text="Iterations before stopping"
              tooltip={{
                label: "Hard cap on iterations",
                description:
                  "Maximum normal fix-and-poll iterations before the loop gives up — or runs the optional force-finalize bonus iteration below.",
              }}
            />
            <span
              style={{
                fontFamily: SANS_FONT,
                fontSize: 11,
                color: COLORS.textMuted,
                lineHeight: 1.4,
              }}
            >
              1–20 iterations. Lower is safer; higher is more persistent.
            </span>
          </div>
          <NumericInput
            value={maxRounds}
            min={1}
            max={20}
            step={1}
            onChange={(v) => {
              if (v == null) return;
              onSettingsChange({ maxRounds: v });
            }}
            disabled={disabled}
            ariaLabel="Iterations before stopping"
            width={70}
          />
        </div>
      </SettingCard>

      {/* ── Force-finalize ── */}
      <SettingCard>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <FieldLabel
            text="If iterations run out without converging"
            tooltip={{
              label: "Force-finalize policy",
              description:
                "Decides whether the loop runs one final, more aggressive merge attempt after the iteration cap is hit.",
            }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 8 }}>
          {FORCE_FINALIZE_OPTIONS.map((opt) => (
            <RadioRow
              key={opt.value}
              value={opt.value}
              selected={forceFinalizeMode === opt.value}
              onSelect={(v) => onSettingsChange({ forceFinalizeMode: v })}
              label={opt.label}
              tooltip={opt.tooltip}
              disabled={disabled}
              accent={opt.value === "unconditional" ? WARNING_AMBER : undefined}
            />
          ))}
        </div>

        {forceFinalizeMode === "conditional" ? (
          <div
            style={{
              marginTop: 8,
              padding: "8px 10px",
              borderRadius: 6,
              background: "rgba(255,255,255,0.02)",
              border: `1px solid ${COLORS.border}`,
            }}
          >
            <SmartTooltip
              forceEnabled
              side="top"
              wrapperStyle={{ width: "100%" }}
              content={{
                label: "No-failing-CI guardrail",
                description:
                  "Block the bonus force-merge if any required check is currently red. Recommended — keeps you from landing a known-broken PR.",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  cursor: disabled ? "not-allowed" : "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={forceFinalizeRequireNoCiFailures}
                  disabled={disabled}
                  onChange={(e) =>
                    onSettingsChange({ forceFinalizeRequireNoCiFailures: e.target.checked })
                  }
                  style={{
                    width: 14,
                    height: 14,
                    accentColor: COLORS.accent,
                    cursor: disabled ? "not-allowed" : "pointer",
                  }}
                />
                <span
                  style={{
                    fontFamily: SANS_FONT,
                    fontSize: 12,
                    fontWeight: 500,
                    color: disabled ? COLORS.textDim : COLORS.textPrimary,
                  }}
                >
                  Only force-merge if no CI checks are failing
                </span>
              </label>
            </SmartTooltip>
          </div>
        ) : null}
      </SettingCard>

      {/* ── Early merge on green ── */}
      <SettingCard>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <FieldLabel
              text="Merge as soon as checks pass and reviews are clean"
              tooltip={{
                label: "Early merge on green",
                description:
                  "Skip queued fix iterations whenever the PR is already mergeable. Fast path — useful when reviewers approve mid-loop.",
              }}
            />
            <span
              style={{
                fontFamily: SANS_FONT,
                fontSize: 11,
                color: COLORS.textMuted,
                lineHeight: 1.4,
              }}
            >
              Don't wait for the iteration cap when the PR is already ready.
            </span>
          </div>
          <ToggleSwitch
            checked={earlyMergeOnGreen}
            onChange={(v) => onSettingsChange({ earlyMergeOnGreen: v })}
            disabled={disabled}
            ariaLabel="Early merge on green"
          />
        </div>
      </SettingCard>
      </>
      )}

      {/* Model & Permissions sub-section (resolver launch controls — kept as-is) */}
      <SectionDivider label="Model & Permissions" />
      <PrResolverLaunchControls
        modelId={modelId}
        reasoningEffort={reasoningEffort}
        permissionMode={permissionMode}
        onModelChange={onModelChange}
        onReasoningEffortChange={onReasoningEffortChange}
        onPermissionModeChange={onPermissionModeChange}
        disabled={disabled}
      />
    </div>
  );
}
