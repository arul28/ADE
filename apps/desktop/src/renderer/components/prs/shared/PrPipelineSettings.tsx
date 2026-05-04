import React from "react";
import type {
  AtCapPolicy,
  AutoConflictAgentProvider,
  AutoConflictAgentSettings,
  ConflictStrategy,
  ForceFinalizeMode,
  PipelineMergeMethod,
  PipelineSettings,
  PrAgentPermissionMode,
} from "../../../../shared/types";
import { getModelById } from "../../../../shared/modelRegistry";
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
  permissionMode: PrAgentPermissionMode;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionModeChange: (mode: PrAgentPermissionMode) => void;
  disabled?: boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Order matters: history-preserving methods first, squash last (it rewrites
// SHAs and breaks future stacked branches with add/add conflicts).
const MERGE_METHOD_OPTIONS: Array<{ value: PipelineMergeMethod; label: string }> = [
  { value: "repo_default", label: "Repo default" },
  { value: "merge", label: "Merge commit" },
  { value: "rebase", label: "Rebase and merge" },
  { value: "squash", label: "Squash and merge (rewrites history)" },
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
        "An agent picks rebase vs merge and resolves any conflict markers itself. Configure the resolver agent below.",
    },
  },
];

type AtCapPolicyOption = {
  value: AtCapPolicy;
  label: string;
  description: string;
  tooltip: SmartTooltipContent;
};

const AT_CAP_POLICY_OPTIONS: AtCapPolicyOption[] = [
  {
    value: "stop",
    label: "Stop and wait for me",
    description: "Pause the loop. The PR stays as-is.",
    tooltip: {
      label: "Stop at iteration cap",
      description:
        "Don't try anything more — leave the PR for you to finish by hand. Safest option.",
    },
  },
  {
    value: "wait_for_ci",
    label: "Wait for CI to finish, then merge if green",
    description:
      "Stop running the agent. Keep polling CI for up to the wait window; merge if it goes green, otherwise stop.",
    tooltip: {
      label: "Wait for CI",
      description:
        "If iterations exhausted but CI is still running, sit and watch CI. If it goes green within the wait window, merge. If it fails or times out, pause.",
    },
  },
  {
    value: "ci_retry_once",
    label: "One more CI-only iteration, then merge if green",
    description:
      "Run the agent one extra time targeting CI failures only. Merge if CI is green afterward; otherwise stop.",
    tooltip: {
      label: "One CI retry",
      description:
        "Skip review comments and dispatch one bonus agent iteration scoped to CI fixes. If CI ends up green after that round, attempt the merge ladder. If it doesn't, pause.",
    },
  },
  {
    value: "ci_retry_loop",
    label: "Keep iterating on CI failures (bounded)",
    description:
      "Keep dispatching CI-only fix iterations until CI is green or the retry budget is used up.",
    tooltip: {
      label: "Bounded CI retry loop",
      description:
        "Like the one-shot CI retry, but allow up to N bonus iterations (configured below). No more iterations on review comments — purely fixing CI. Merge as soon as CI goes green.",
    },
  },
  {
    value: "force_merge",
    label: "Force-merge regardless (dangerous)",
    description:
      "Skip retries. Run the merge ladder immediately, ignoring CI and review.",
    tooltip: {
      label: "Force-merge",
      description:
        "Bypass CI status and unresolved review comments. Uses gh's --admin merge if the normal merge is blocked. Reserved for emergencies.",
      warning: "Use with care — lands the PR even if CI is red or reviewers haven't signed off.",
    },
  },
];

const ACCENT_GREEN = "#22C55E";
const WARNING_AMBER = "#F59E0B";

// Map a chosen modelId to the autoAgentSettings.provider value the orchestrator
// requires (pathToMergeOrchestrator.ts:495–498 fails if provider is null when
// strategy is "auto"). Mirrors the legacy mapping at prs.ts:876.
function deriveAutoAgentProvider(modelId: string): AutoConflictAgentProvider | null {
  if (!modelId) return null;
  const descriptor = getModelById(modelId);
  if (!descriptor) return null;
  if (descriptor.family === "anthropic") return "claude";
  if (descriptor.family === "openai") return "codex";
  return null;
}

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
    input.pipeline-slider {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 4px;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      outline: none;
      cursor: pointer;
    }
    input.pipeline-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: #FAFAFA;
      border: 2px solid color-mix(in srgb, var(--color-accent) 70%, transparent);
      box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      cursor: pointer;
      transition: transform 0.12s ease;
    }
    input.pipeline-slider::-webkit-slider-thumb:hover {
      transform: scale(1.15);
    }
    input.pipeline-slider:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    input.pipeline-slider:disabled::-webkit-slider-thumb {
      cursor: not-allowed;
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
        maxWidth: 240,
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
    atCapPolicy,
    atCapWaitMinutes,
    atCapCiRetryMax,
    forceMergeRequiresConfirmation,
  } = settings;

  const showsForcePushWarning = conflictStrategy === "rebase" || conflictStrategy === "auto";
  const showsSquashWarning = mergeMethod === "squash";

  const updateAutoAgent = (partial: Partial<AutoConflictAgentSettings>) => {
    onSettingsChange({
      autoAgentSettings: { ...autoAgentSettings, ...partial },
    });
  };

  // When the user picks a model in the resolver section, also derive and
  // persist the provider — the orchestrator rejects strategy="auto" with a
  // null provider (pathToMergeOrchestrator.ts:495–498).
  const handleResolverModelChange = (nextModelId: string) => {
    updateAutoAgent({
      model: nextModelId || null,
      provider: deriveAutoAgentProvider(nextModelId),
    });
  };

  const handleConflictStrategyChange = (next: ConflictStrategy) => {
    if (next !== "auto") {
      onSettingsChange({ conflictStrategy: next });
      return;
    }

    const fallbackModel = autoAgentSettings.model || modelId || null;
    onSettingsChange({
      conflictStrategy: next,
      autoAgentSettings: {
        ...autoAgentSettings,
        model: fallbackModel,
        provider: autoAgentSettings.provider ?? deriveAutoAgentProvider(fallbackModel ?? ""),
        reasoningEffort: autoAgentSettings.reasoningEffort || reasoningEffort || null,
        permissionMode: autoAgentSettings.permissionMode ?? permissionMode,
      },
    });
  };

  React.useEffect(() => {
    if (conflictStrategy !== "auto") return;
    const fallbackModel = autoAgentSettings.model || modelId || null;
    const fallbackProvider = autoAgentSettings.provider ?? deriveAutoAgentProvider(fallbackModel ?? "");
    const patch: Partial<AutoConflictAgentSettings> = {};
    if (!autoAgentSettings.model && fallbackModel) patch.model = fallbackModel;
    if (!autoAgentSettings.provider && fallbackProvider) patch.provider = fallbackProvider;
    if (!autoAgentSettings.reasoningEffort && reasoningEffort) patch.reasoningEffort = reasoningEffort;
    if (!autoAgentSettings.permissionMode) patch.permissionMode = permissionMode;
    if (Object.keys(patch).length === 0) return;
    onSettingsChange({
      autoAgentSettings: { ...autoAgentSettings, ...patch },
    });
  }, [
    autoAgentSettings,
    conflictStrategy,
    modelId,
    onSettingsChange,
    permissionMode,
    reasoningEffort,
  ]);

  // Master "Auto-merge this PR" toggle is on iff both fields are on. Treat
  // earlyMergeOnGreen as an implicit corollary of autoMerge — the UI no longer
  // exposes it as a separate switch.
  const handleAutoMergeToggle = (on: boolean) => {
    onSettingsChange({
      autoMerge: on,
      earlyMergeOnGreen: on,
      // When turning auto-merge off, reset the at-cap policy to "stop" so it
      // re-arms safely next time the user opts in.
      ...(on ? {} : { atCapPolicy: "stop" as AtCapPolicy, forceFinalizeMode: "off" as ForceFinalizeMode }),
    });
  };

  // Keep the legacy forceFinalizeMode in sync so older callers that read it
  // (sync layer, queue runtime back-compat) see a coherent state. The
  // orchestrator itself reads `atCapPolicy` directly.
  const policyToLegacyForceFinalize = (policy: AtCapPolicy): ForceFinalizeMode => {
    if (policy === "stop") return "off";
    if (policy === "force_merge") return "unconditional";
    return "conditional";
  };

  const handleAtCapPolicyChange = (next: AtCapPolicy) => {
    if (next === "force_merge" && forceMergeRequiresConfirmation && atCapPolicy !== "force_merge") {
      const ok = typeof window !== "undefined"
        ? window.confirm(
            "Force-merge will land this PR even if CI is failing or reviews are unresolved. Continue?",
          )
        : true;
      if (!ok) return;
    }
    onSettingsChange({
      atCapPolicy: next,
      forceFinalizeMode: policyToLegacyForceFinalize(next),
      // Mirror the conditional guardrail for legacy readers when retry policies
      // are picked.
      ...(next === "ci_retry_once" || next === "ci_retry_loop"
        ? { forceFinalizeRequireNoCiFailures: true }
        : {}),
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* ── Model & Permissions (always visible, top of panel) ── */}
      <SettingCard>
        <SectionDivider label="Model & permissions" />
        <PrResolverLaunchControls
          modelId={modelId}
          reasoningEffort={reasoningEffort}
          permissionMode={permissionMode}
          onModelChange={onModelChange}
          onReasoningEffortChange={onReasoningEffortChange}
          onPermissionModeChange={onPermissionModeChange}
          disabled={disabled}
        />
      </SettingCard>

      {showAutoConvergeSettings && (
        <>
          {/* ── Iteration cap ── */}
          <SettingCard>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <FieldLabel
                  text="Max number of iterations"
                  tooltip={{
                    label: "Iteration cap",
                    description:
                      "Maximum fix-and-poll iterations before the loop gives up — or runs the at-cap policy below if auto-merge is on.",
                  }}
                />
                <span
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: 12,
                    fontWeight: 700,
                    color: disabled ? COLORS.textDim : COLORS.textPrimary,
                    background: "rgba(255,255,255,0.04)",
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 6,
                    padding: "3px 10px",
                    minWidth: 32,
                    textAlign: "center",
                  }}
                >
                  {maxRounds}
                </span>
              </div>
              <input
                type="range"
                className="pipeline-slider"
                aria-label="Max number of iterations"
                min={1}
                max={20}
                step={1}
                value={maxRounds}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  if (Number.isNaN(next)) return;
                  onSettingsChange({ maxRounds: next });
                }}
                disabled={disabled}
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
          </SettingCard>

          {/* ── Auto-merge master + at-cap policy ── */}
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
                  text="Auto-merge this PR"
                  tooltip={{
                    label: "Auto-merge",
                    description:
                      "When on, the loop lands the PR the moment checks are green and reviews are clean — mid-loop or after iterations finish.",
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
                  Land it the moment checks are green and reviews are clean.
                </span>
              </div>
              <ToggleSwitch
                checked={autoMerge}
                onChange={handleAutoMergeToggle}
                disabled={disabled}
                ariaLabel="Auto-merge this PR"
              />
            </div>

            {autoMerge ? (
              <>
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
                        "How GitHub combines the PR. 'Repo default' uses whatever the repository allows.",
                    }}
                  />
                  <StyledSelect
                    value={mergeMethod}
                    onChange={(v) => onSettingsChange({ mergeMethod: v as PipelineMergeMethod })}
                    options={MERGE_METHOD_OPTIONS}
                    disabled={disabled}
                    ariaLabel="Merge method"
                  />
                </div>

                {showsSquashWarning ? (
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
                      lineHeight: 1.45,
                    }}
                  >
                    Squash rewrites the PR's commits into a new SHA on the base
                    branch. Branches cut from a squash-merged PR will hit add/add
                    conflicts on their next merge — prefer "Merge commit" or
                    "Rebase and merge" if you stack work.
                  </div>
                ) : null}

                <div style={{ marginTop: 12 }}>
                  <SectionDivider label="If iterations run out before it's mergeable" />
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {AT_CAP_POLICY_OPTIONS.map((opt) => (
                      <div key={opt.value} style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                        <RadioRow
                          value={opt.value}
                          selected={atCapPolicy === opt.value}
                          onSelect={(v) => handleAtCapPolicyChange(v)}
                          label={opt.label}
                          tooltip={opt.tooltip}
                          disabled={disabled}
                          accent={opt.value === "force_merge" ? WARNING_AMBER : undefined}
                        />
                        {atCapPolicy === opt.value ? (
                          <div
                            style={{
                              fontFamily: SANS_FONT,
                              fontSize: 11,
                              color: COLORS.textMuted,
                              lineHeight: 1.45,
                              padding: "0 9px 6px 35px",
                            }}
                          >
                            {opt.description}
                          </div>
                        ) : null}
                        {atCapPolicy === opt.value && opt.value === "wait_for_ci" ? (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 12,
                              margin: "2px 0 8px 35px",
                              padding: "8px 10px",
                              borderRadius: 6,
                              border: `1px solid ${COLORS.border}`,
                              background: "rgba(255,255,255,0.02)",
                            }}
                          >
                            <FieldLabel
                              text="Wait window (minutes)"
                              tooltip={{
                                label: "Wait window",
                                description:
                                  "How long to keep polling CI before giving up and pausing. CI flakes that take longer than this will cause a pause; raise this for slow pipelines.",
                              }}
                            />
                            <NumericInput
                              value={atCapWaitMinutes}
                              min={1}
                              max={240}
                              step={5}
                              onChange={(v) => {
                                if (v == null) return;
                                onSettingsChange({ atCapWaitMinutes: v });
                              }}
                              disabled={disabled}
                              ariaLabel="Wait window minutes"
                              width={70}
                            />
                          </div>
                        ) : null}
                        {atCapPolicy === opt.value && opt.value === "ci_retry_loop" ? (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 12,
                              margin: "2px 0 8px 35px",
                              padding: "8px 10px",
                              borderRadius: 6,
                              border: `1px solid ${COLORS.border}`,
                              background: "rgba(255,255,255,0.02)",
                            }}
                          >
                            <FieldLabel
                              text="Max bonus iterations"
                              tooltip={{
                                label: "Max bonus iterations",
                                description:
                                  "Cap on how many CI-only fix iterations the loop can run after the main iteration cap is exhausted. Each iteration dispatches the agent again with scope limited to CI failures.",
                              }}
                            />
                            <NumericInput
                              value={atCapCiRetryMax}
                              min={1}
                              max={10}
                              step={1}
                              onChange={(v) => {
                                if (v == null) return;
                                onSettingsChange({ atCapCiRetryMax: v });
                              }}
                              disabled={disabled}
                              ariaLabel="Max bonus CI retries"
                              width={70}
                            />
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
          </SettingCard>

          {/* ── Conflict handling ── */}
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
                  onSelect={(v) => handleConflictStrategyChange(v)}
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

            {conflictStrategy === "auto" ? (
              <div style={{ marginTop: 12 }}>
                <SectionDivider label="Resolver agent" />
                <PrResolverLaunchControls
                  modelId={autoAgentSettings.model || modelId}
                  reasoningEffort={autoAgentSettings.reasoningEffort || reasoningEffort}
                  permissionMode={autoAgentSettings.permissionMode ?? permissionMode}
                  onModelChange={handleResolverModelChange}
                  onReasoningEffortChange={(effort) =>
                    updateAutoAgent({ reasoningEffort: effort || null })
                  }
                  onPermissionModeChange={(mode) =>
                    updateAutoAgent({ permissionMode: mode })
                  }
                  disabled={disabled}
                />
              </div>
            ) : null}
          </SettingCard>
        </>
      )}
    </div>
  );
}
