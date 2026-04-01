import React from "react";
import type {
  AiPermissionMode,
  PipelineMergeMethod,
  PipelineSettings,
  RebasePolicy,
} from "../../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import { PrResolverLaunchControls } from "./PrResolverLaunchControls";

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

const REBASE_OPTIONS: Array<{ value: RebasePolicy; label: string }> = [
  { value: "pause", label: "Pause convergence" },
  { value: "auto_rebase", label: "Auto-rebase (conflicts pause)" },
];

const ACCENT_GREEN = "#22C55E";
const TRACK_BG = "rgba(255,255,255,0.08)";
const THUMB_SIZE = 14;
const TRACK_HEIGHT = 4;

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
    /* range thumb styling */
    input[type="range"].pipeline-range::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: ${THUMB_SIZE}px;
      height: ${THUMB_SIZE}px;
      border-radius: 999px;
      background: #FAFAFA;
      border: 2px solid ${COLORS.accent};
      box-shadow: 0 0 6px ${COLORS.accent}40;
      cursor: pointer;
      margin-top: -${(THUMB_SIZE - TRACK_HEIGHT) / 2}px;
      transition: box-shadow 0.15s ease;
    }
    input[type="range"].pipeline-range::-webkit-slider-thumb:hover {
      box-shadow: 0 0 10px ${COLORS.accent}70;
    }
    input[type="range"].pipeline-range::-webkit-slider-runnable-track {
      height: ${TRACK_HEIGHT}px;
      border-radius: 999px;
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
      border-color: ${COLORS.accent}60;
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
        marginTop: 10,
        marginBottom: 6,
      }}
    >
      <span
        style={{
          fontFamily: SANS_FONT,
          fontSize: 9,
          fontWeight: 600,
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

function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
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
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <select
      className="pipeline-select"
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
        maxWidth: 200,
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

  const { autoMerge, mergeMethod, maxRounds, onRebaseNeeded } = settings;
  const mergeDisabled = disabled || !autoMerge;
  const fillPct = ((maxRounds - 1) / 9) * 100;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {/* --- Auto-converge-only settings (hidden when off) --- */}
      {showAutoConvergeSettings && (
      <>
      {/* Auto-Merge Toggle */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "6px 0",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 12,
              fontWeight: 600,
              color: COLORS.textPrimary,
            }}
          >
            Auto-Merge
          </span>
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 10,
              color: COLORS.textMuted,
              lineHeight: 1.35,
            }}
          >
            Merge automatically when all issues resolved and checks pass
          </span>
        </div>
        <ToggleSwitch
          checked={autoMerge}
          onChange={(v) => onSettingsChange({ autoMerge: v })}
          disabled={disabled}
        />
      </div>

      {/* Merge Method */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "6px 0",
        }}
      >
        <span
          style={{
            fontFamily: SANS_FONT,
            fontSize: 11,
            fontWeight: 500,
            color: mergeDisabled ? COLORS.textDim : COLORS.textSecondary,
            whiteSpace: "nowrap",
          }}
        >
          Merge method
        </span>
        <StyledSelect
          value={mergeMethod}
          onChange={(v) => onSettingsChange({ mergeMethod: v as PipelineMergeMethod })}
          options={MERGE_METHOD_OPTIONS}
          disabled={mergeDisabled}
        />
      </div>

      {/* Max Rounds Slider */}
      <div style={{ padding: "6px 0" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 11,
              fontWeight: 500,
              color: disabled ? COLORS.textDim : COLORS.textSecondary,
            }}
          >
            Max rounds
          </span>
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: 11,
              fontWeight: 700,
              color: COLORS.accent,
              background: `${COLORS.accent}14`,
              padding: "2px 8px",
              borderRadius: 4,
              minWidth: 24,
              textAlign: "center",
            }}
          >
            {maxRounds}
          </span>
        </div>
        <div style={{ position: "relative" }}>
          {/* Base track */}
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: 0,
              right: 0,
              height: TRACK_HEIGHT,
              borderRadius: 999,
              background: TRACK_BG,
              transform: "translateY(-50%)",
              pointerEvents: "none",
              zIndex: 0,
            }}
          />
          {/* Filled track */}
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: 0,
              height: TRACK_HEIGHT,
              width: `${fillPct}%`,
              borderRadius: 999,
              background: `linear-gradient(90deg, ${COLORS.accent}80, ${COLORS.accent})`,
              transform: "translateY(-50%)",
              pointerEvents: "none",
              zIndex: 1,
            }}
          />
          <input
            type="range"
            className="pipeline-range"
            min={1}
            max={10}
            step={1}
            value={maxRounds}
            onChange={(e) => onSettingsChange({ maxRounds: Number(e.target.value) })}
            disabled={disabled}
            style={{
              width: "100%",
              height: THUMB_SIZE,
              background: "transparent",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.45 : 1,
              margin: 0,
              position: "relative",
              zIndex: 2,
              WebkitAppearance: "none",
            }}
          />
        </div>
      </div>

      {/* On Rebase Needed */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "6px 0",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span
            style={{
              fontFamily: SANS_FONT,
              fontSize: 11,
              fontWeight: 500,
              color: disabled ? COLORS.textDim : COLORS.textSecondary,
              whiteSpace: "nowrap",
            }}
          >
            On rebase needed
          </span>
          {!autoMerge ? (
            <span
              style={{
                fontFamily: SANS_FONT,
                fontSize: 9,
                color: COLORS.textDim,
                fontStyle: "italic",
              }}
            >
              Applies during auto-converge
            </span>
          ) : null}
        </div>
        <StyledSelect
          value={onRebaseNeeded}
          onChange={(v) => onSettingsChange({ onRebaseNeeded: v as RebasePolicy })}
          options={REBASE_OPTIONS}
          disabled={disabled}
        />
      </div>
      </>
      )}

      {/* Model & Permissions sub-section */}
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
