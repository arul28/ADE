import React from "react";
import {
  CircleNotch,
  CheckCircle,
  Warning,
  ArrowSquareOut,
  Play,
  Stop,
  PauseCircle,
} from "@phosphor-icons/react";
import type {
  ConvergenceRuntimeState,
  ConvergenceRuntimeStatus,
  PrAgentPermissionMode,
} from "../../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { formatTimeAgoCompact } from "./prFormatters";
import { PrResolverLaunchControls } from "./PrResolverLaunchControls";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PathToMergeGating = "checks" | "comments" | "both";

export type PathToMergeLaunchConfig = {
  gating: PathToMergeGating;
  additionalInstructions: string;
  pollIntervalSeconds: number;
};

export type PrConvergencePanelProps = {
  prNumber: number;
  prTitle: string;
  modelId: string;
  reasoningEffort: string;
  permissionMode: PrAgentPermissionMode;
  runtime: ConvergenceRuntimeState | null;
  busy: boolean;
  terminalState?: "merged" | "closed" | null;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionModeChange: (mode: PrAgentPermissionMode) => void;
  onStart: (config: PathToMergeLaunchConfig) => Promise<void>;
  onStop: () => Promise<void>;
  onOpenChat: (href: string) => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_POLL_MINUTES = 1;
const MAX_POLL_MINUTES = 60;
const DEFAULT_POLL_MINUTES = 10;

const GATING_OPTIONS: { value: PathToMergeGating; label: string; hint: string }[] = [
  { value: "both", label: "CI + comments", hint: "Wait for green checks and resolved review comments before merging." },
  { value: "checks", label: "CI only", hint: "Merge once required checks pass; ignore unresolved review comments." },
  { value: "comments", label: "Comments only", hint: "Merge once review comments are resolved; ignore check status." },
];

const STATUS_META: Record<
  ConvergenceRuntimeStatus,
  { label: string; color: string; spin: boolean }
> = {
  idle: { label: "Idle", color: COLORS.textMuted, spin: false },
  launching: { label: "Launching", color: COLORS.info, spin: true },
  running: { label: "Watching", color: COLORS.accent, spin: true },
  polling: { label: "Watching", color: COLORS.accent, spin: true },
  paused: { label: "Paused", color: COLORS.warning, spin: false },
  converged: { label: "Converged", color: COLORS.success, spin: false },
  merged: { label: "Merged", color: COLORS.success, spin: false },
  failed: { label: "Failed", color: COLORS.danger, spin: false },
  cancelled: { label: "Cancelled", color: COLORS.textMuted, spin: false },
  stopped: { label: "Stopped", color: COLORS.textMuted, spin: false },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PrConvergencePanel({
  prNumber,
  prTitle,
  modelId,
  reasoningEffort,
  permissionMode,
  runtime,
  busy,
  terminalState,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
  onStart,
  onStop,
  onOpenChat,
}: PrConvergencePanelProps) {
  const [gating, setGating] = React.useState<PathToMergeGating>("both");
  const [additionalInstructions, setAdditionalInstructions] = React.useState("");
  const [pollMinutes, setPollMinutes] = React.useState(DEFAULT_POLL_MINUTES);
  const [actionBusy, setActionBusy] = React.useState(false);

  const active = runtime?.pathToMergeActive === true;
  const isTerminal = terminalState === "merged" || terminalState === "closed";

  const handleStart = React.useCallback(async () => {
    setActionBusy(true);
    try {
      const clampedMinutes = Math.min(MAX_POLL_MINUTES, Math.max(MIN_POLL_MINUTES, Math.round(pollMinutes) || DEFAULT_POLL_MINUTES));
      await onStart({
        gating,
        additionalInstructions: additionalInstructions.trim(),
        pollIntervalSeconds: clampedMinutes * 60,
      });
    } finally {
      setActionBusy(false);
    }
  }, [gating, additionalInstructions, pollMinutes, onStart]);

  const handleStop = React.useCallback(async () => {
    setActionBusy(true);
    try {
      await onStop();
    } finally {
      setActionBusy(false);
    }
  }, [onStop]);

  const disabled = busy || actionBusy;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, fontFamily: SANS_FONT }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>Path to Merge</span>
          <span style={{ fontSize: 11, color: COLORS.textMuted }}>
            A visible agent watches #{prNumber} and drives it to merge.
          </span>
        </div>
        {active && runtime ? <StatusBadge runtime={runtime} /> : null}
      </div>

      {active && runtime ? (
        <ActiveView
          runtime={runtime}
          disabled={disabled}
          onOpenChat={onOpenChat}
          onStop={handleStop}
        />
      ) : (
        <LaunchView
          prTitle={prTitle}
          gating={gating}
          setGating={setGating}
          additionalInstructions={additionalInstructions}
          setAdditionalInstructions={setAdditionalInstructions}
          pollMinutes={pollMinutes}
          setPollMinutes={setPollMinutes}
          modelId={modelId}
          reasoningEffort={reasoningEffort}
          permissionMode={permissionMode}
          onModelChange={onModelChange}
          onReasoningEffortChange={onReasoningEffortChange}
          onPermissionModeChange={onPermissionModeChange}
          onStart={handleStart}
          disabled={disabled}
          isTerminal={isTerminal}
          terminalState={terminalState ?? null}
          lastError={runtime?.errorMessage ?? null}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ runtime }: { runtime: ConvergenceRuntimeState }) {
  const meta = STATUS_META[runtime.status] ?? STATUS_META.idle;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: MONO_FONT,
        color: meta.color,
        background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${meta.color} 30%, transparent)`,
      }}
    >
      {meta.spin ? (
        <CircleNotch size={11} weight="bold" style={{ animation: "spin 1s linear infinite" }} />
      ) : runtime.status === "merged" || runtime.status === "converged" ? (
        <CheckCircle size={11} weight="fill" />
      ) : runtime.status === "paused" ? (
        <PauseCircle size={11} weight="fill" />
      ) : runtime.status === "failed" ? (
        <Warning size={11} weight="fill" />
      ) : null}
      {meta.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Active (running) view
// ---------------------------------------------------------------------------

function ActiveView({
  runtime,
  disabled,
  onOpenChat,
  onStop,
}: {
  runtime: ConvergenceRuntimeState;
  disabled: boolean;
  onOpenChat: (href: string) => void;
  onStop: () => void;
}) {
  const href = runtime.activeHref;
  const startedAgo = runtime.lastStartedAt ? formatTimeAgoCompact(runtime.lastStartedAt) : null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 14,
        borderRadius: 10,
        background: COLORS.recessedBg,
        border: `1px solid ${COLORS.borderMuted}`,
      }}
    >
      <div style={{ fontSize: 11, color: COLORS.textSecondary, lineHeight: 1.5 }}>
        {runtime.status === "paused" && runtime.pauseReason
          ? runtime.pauseReason
          : "The watcher agent is running in its own chat. Open it to follow along or steer it."}
        {startedAgo ? (
          <span style={{ color: COLORS.textMuted }}> · started {startedAgo}</span>
        ) : null}
      </div>
      {runtime.errorMessage ? (
        <div style={{ fontSize: 11, color: COLORS.danger, fontFamily: MONO_FONT }}>{runtime.errorMessage}</div>
      ) : null}
      <div style={{ display: "flex", gap: 8 }}>
        {href ? (
          <button
            type="button"
            onClick={() => onOpenChat(href)}
            style={primaryButton({ height: 30, fontSize: 12, padding: "0 14px" })}
          >
            <ArrowSquareOut size={13} weight="bold" />
            Open chat
          </button>
        ) : null}
        <button
          type="button"
          onClick={onStop}
          disabled={disabled}
          style={outlineButton({
            height: 30,
            fontSize: 12,
            padding: "0 14px",
            color: COLORS.danger,
            opacity: disabled ? 0.6 : 1,
          })}
        >
          <Stop size={13} weight="bold" />
          Stop
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Launch (config) view
// ---------------------------------------------------------------------------

function LaunchView({
  prTitle,
  gating,
  setGating,
  additionalInstructions,
  setAdditionalInstructions,
  pollMinutes,
  setPollMinutes,
  modelId,
  reasoningEffort,
  permissionMode,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
  onStart,
  disabled,
  isTerminal,
  terminalState,
  lastError,
}: {
  prTitle: string;
  gating: PathToMergeGating;
  setGating: (g: PathToMergeGating) => void;
  additionalInstructions: string;
  setAdditionalInstructions: (v: string) => void;
  pollMinutes: number;
  setPollMinutes: (v: number) => void;
  modelId: string;
  reasoningEffort: string;
  permissionMode: PrAgentPermissionMode;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionModeChange: (mode: PrAgentPermissionMode) => void;
  onStart: () => void;
  disabled: boolean;
  isTerminal: boolean;
  terminalState: "merged" | "closed" | null;
  lastError: string | null;
}) {
  if (isTerminal) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: 14,
          borderRadius: 10,
          background: COLORS.recessedBg,
          border: `1px solid ${COLORS.borderMuted}`,
          fontSize: 12,
          color: COLORS.textSecondary,
        }}
      >
        <CheckCircle size={15} weight="fill" style={{ color: terminalState === "merged" ? COLORS.success : COLORS.textMuted }} />
        This PR is {terminalState === "merged" ? "merged" : "closed"}. Nothing to do.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Field label="What must be clear before merging">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {GATING_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 8,
                cursor: disabled ? "default" : "pointer",
                background: gating === opt.value ? COLORS.accentSubtle : COLORS.recessedBg,
                border: `1px solid ${gating === opt.value ? COLORS.accentBorder : COLORS.borderMuted}`,
              }}
            >
              <input
                type="radio"
                name="ptm-gating"
                checked={gating === opt.value}
                onChange={() => setGating(opt.value)}
                disabled={disabled}
                style={{ marginTop: 2, accentColor: COLORS.accent }}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{opt.label}</span>
                <span style={{ fontSize: 11, color: COLORS.textMuted, lineHeight: 1.4 }}>{opt.hint}</span>
              </div>
            </label>
          ))}
        </div>
      </Field>

      <Field label="Additional instructions (optional)">
        <textarea
          value={additionalInstructions}
          onChange={(e) => setAdditionalInstructions(e.target.value)}
          disabled={disabled}
          placeholder={`Anything specific for the agent driving "${prTitle}" — e.g. "don't touch the migration", "ping @teammate before merging".`}
          rows={3}
          style={{
            width: "100%",
            resize: "vertical",
            padding: "8px 10px",
            borderRadius: 8,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.borderMuted}`,
            color: COLORS.textPrimary,
            fontSize: 12,
            fontFamily: SANS_FONT,
            lineHeight: 1.5,
            outline: "none",
          }}
        />
      </Field>

      <Field label="Check the PR every">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="number"
            min={MIN_POLL_MINUTES}
            max={MAX_POLL_MINUTES}
            value={pollMinutes}
            onChange={(e) => setPollMinutes(Number(e.target.value))}
            disabled={disabled}
            style={{
              width: 72,
              padding: "6px 8px",
              borderRadius: 8,
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.borderMuted}`,
              color: COLORS.textPrimary,
              fontSize: 12,
              fontFamily: MONO_FONT,
              outline: "none",
            }}
          />
          <span style={{ fontSize: 11, color: COLORS.textMuted }}>
            minutes ({MIN_POLL_MINUTES}–{MAX_POLL_MINUTES})
          </span>
        </div>
      </Field>

      <Field label="Agent">
        <PrResolverLaunchControls
          modelId={modelId}
          reasoningEffort={reasoningEffort}
          permissionMode={permissionMode}
          onModelChange={onModelChange}
          onReasoningEffortChange={onReasoningEffortChange}
          onPermissionModeChange={onPermissionModeChange}
          disabled={disabled}
        />
      </Field>

      {lastError ? (
        <div style={{ fontSize: 11, color: COLORS.danger, fontFamily: MONO_FONT }}>{lastError}</div>
      ) : null}

      <button
        type="button"
        onClick={onStart}
        disabled={disabled}
        style={primaryButton({ height: 34, fontSize: 13, padding: "0 16px", alignSelf: "flex-start", opacity: disabled ? 0.6 : 1 })}
      >
        <Play size={14} weight="fill" />
        Start Path to Merge
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 500, color: COLORS.textMuted }}>{label}</span>
      {children}
    </div>
  );
}

export default PrConvergencePanel;
