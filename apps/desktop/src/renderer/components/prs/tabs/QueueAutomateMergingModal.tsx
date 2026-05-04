import React from "react";
import { CheckCircle, CircleNotch, MagicWand, Warning, X } from "@phosphor-icons/react";
import type {
  ConvergenceRuntimeStatus,
  PipelineSettings,
  PrConvergenceState,
  PrAgentPermissionMode,
} from "../../../../shared/types";
import { DEFAULT_PIPELINE_SETTINGS } from "../../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton, primaryButton } from "../../lanes/laneDesignTokens";
import { LaneAccentDot } from "../../lanes/LaneAccentDot";
import { PrPipelineSettings } from "../shared/PrPipelineSettings";
import { SmartTooltip } from "../../ui/SmartTooltip";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueAutomateMergingMember = {
  prId: string;
  prNumber: number | null;
  laneId: string;
  laneName: string;
  laneColor: string | null;
  position: number;
};

export type QueueAutomateMergingModalProps = {
  open: boolean;
  queueLabel: string;
  queueTargetBranch: string;
  members: QueueAutomateMergingMember[];
  modelId: string;
  reasoningEffort: string;
  permissionMode: PrAgentPermissionMode;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionModeChange: (mode: PrAgentPermissionMode) => void;
  onClose: () => void;
};

type RunStatus =
  | { kind: "pending" }
  | { kind: "saving" }
  | { kind: "retargeting" }
  | { kind: "starting" }
  | { kind: "running"; runtimeStatus: ConvergenceRuntimeStatus | null; pauseReason: string | null; round: number }
  | { kind: "merged" }
  | { kind: "failed"; error: string }
  | { kind: "skipped"; reason: string };

type SequenceState =
  | { kind: "idle" }
  | { kind: "running"; activeIndex: number }
  | { kind: "halted"; failedIndex: number; error: string }
  | { kind: "complete" };

const POLL_INTERVAL_MS = 4000;

const TERMINAL_FAILED: ReadonlySet<ConvergenceRuntimeStatus> = new Set([
  "failed",
  "cancelled",
  "stopped",
]);

const TERMINAL_SUCCESS: ReadonlySet<ConvergenceRuntimeStatus> = new Set([
  "merged",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

function describeRuntimeStatus(status: ConvergenceRuntimeStatus | null): string {
  if (!status) return "Starting";
  switch (status) {
    case "idle":
      return "Idle";
    case "launching":
      return "Launching";
    case "running":
      return "Running fix iteration";
    case "polling":
      return "Polling for CI / review";
    case "paused":
      return "Paused";
    case "converged":
      return "Converged";
    case "merged":
      return "Merged";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "stopped":
      return "Stopped";
    default:
      return status;
  }
}

function describePauseReason(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === "force-finalize") return "Force-finalize next";
  return reason;
}

function statusBadgeColor(status: RunStatus): { color: string; label: string } {
  switch (status.kind) {
    case "pending":
      return { color: COLORS.textMuted, label: "Queued" };
    case "saving":
      return { color: COLORS.info, label: "Saving settings" };
    case "retargeting":
      return { color: COLORS.info, label: "Retargeting base" };
    case "starting":
      return { color: COLORS.info, label: "Starting" };
    case "running": {
      const reason = describePauseReason(status.pauseReason);
      const label = reason ?? describeRuntimeStatus(status.runtimeStatus);
      return { color: status.runtimeStatus === "paused" ? COLORS.warning : COLORS.info, label };
    }
    case "merged":
      return { color: COLORS.success, label: "Merged" };
    case "failed":
      return { color: COLORS.danger, label: "Failed" };
    case "skipped":
      return { color: COLORS.textMuted, label: "Skipped" };
    default:
      return { color: COLORS.textMuted, label: "Unknown" };
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function QueueAutomateMergingModal({
  open,
  queueLabel,
  queueTargetBranch,
  members,
  modelId,
  reasoningEffort,
  permissionMode,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
  onClose,
}: QueueAutomateMergingModalProps) {
  // Local pipeline settings — start from defaults each time the modal opens.
  // The modal applies a single config to every PR in the queue.
  const [pipelineSettings, setPipelineSettings] = React.useState<PipelineSettings>(
    () => DEFAULT_PIPELINE_SETTINGS,
  );
  const [statuses, setStatuses] = React.useState<Record<string, RunStatus>>({});
  const [sequence, setSequence] = React.useState<SequenceState>({ kind: "idle" });

  // Refs that persist for the lifetime of an automation run.
  const cancelledRef = React.useRef(false);

  // Reset state when the modal transitions from closed to open. Depending on
  // `members` directly would re-fire on every queue-state poll (the parent
  // memoizes a fresh array each time `landingState.entries` changes), wiping
  // the in-flight sequence. Instead, capture members lazily on open.
  const wasOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpenRef.current) {
      setPipelineSettings(DEFAULT_PIPELINE_SETTINGS);
      setStatuses(() => {
        const next: Record<string, RunStatus> = {};
        for (const member of members) next[member.prId] = { kind: "pending" };
        return next;
      });
      setSequence({ kind: "idle" });
      cancelledRef.current = false;
    }
    if (!open && wasOpenRef.current) {
      // Modal dismissed mid-sequence: stop dispatching new starts. Already-
      // launched orchestrators keep running (per spec).
      cancelledRef.current = true;
    }
    wasOpenRef.current = open;
  }, [open, members]);

  const handlePipelineSettingsChange = React.useCallback(
    (patch: Partial<PipelineSettings>) => {
      setPipelineSettings((prev) => ({ ...prev, ...patch }));
    },
    [],
  );

  const updateStatus = React.useCallback((prId: string, status: RunStatus) => {
    setStatuses((prev) => ({ ...prev, [prId]: status }));
  }, []);

  const pollUntilTerminal = React.useCallback(
    async (prId: string): Promise<{ outcome: "merged" | "failed"; runtime: PrConvergenceState | null; error?: string }> => {
      while (!cancelledRef.current) {
        let runtime: PrConvergenceState | null = null;
        try {
          runtime = await window.ade.prs.convergenceStateGet(prId);
        } catch (err) {
          return { outcome: "failed", runtime: null, error: formatError(err) };
        }
        if (cancelledRef.current) {
          return { outcome: "failed", runtime, error: "Cancelled by user" };
        }
        const status = runtime?.status ?? null;
        const round = runtime?.currentRound ?? 0;
        const pauseReason = runtime?.pauseReason ?? null;
        updateStatus(prId, { kind: "running", runtimeStatus: status, pauseReason, round });
        if (status && TERMINAL_SUCCESS.has(status)) {
          return { outcome: "merged", runtime };
        }
        if (status && TERMINAL_FAILED.has(status)) {
          const message = runtime?.errorMessage?.trim() || `Path to Merge ${status}`;
          return { outcome: "failed", runtime, error: message };
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      return { outcome: "failed", runtime: null, error: "Cancelled by user" };
    },
    [updateStatus],
  );

  const runAutomation = React.useCallback(async () => {
    if (members.length === 0) return;
    cancelledRef.current = false;
    setSequence({ kind: "running", activeIndex: 0 });

    for (let idx = 0; idx < members.length; idx += 1) {
      const member = members[idx];
      if (cancelledRef.current) {
        // Renderer-side dismissal: keep already-launched orchestrators running,
        // just stop dispatching new ones.
        return;
      }
      setSequence({ kind: "running", activeIndex: idx });

      // 1. Save the stack-wide pipeline settings to this PR.
      updateStatus(member.prId, { kind: "saving" });
      try {
        await window.ade.prs.pipelineSettingsSave(member.prId, pipelineSettings);
      } catch (err) {
        const message = formatError(err);
        updateStatus(member.prId, { kind: "failed", error: message });
        setSequence({ kind: "halted", failedIndex: idx, error: message });
        return;
      }

      // 2. If position > 0, retarget base to the queue target branch so the
      // PR's diff against `main` is what reviewers see while PtM drives it.
      if (idx > 0) {
        updateStatus(member.prId, { kind: "retargeting" });
        try {
          await window.ade.prs.retargetBase({
            prId: member.prId,
            baseBranch: queueTargetBranch,
          });
        } catch (err) {
          const message = formatError(err);
          updateStatus(member.prId, { kind: "failed", error: message });
          setSequence({ kind: "halted", failedIndex: idx, error: message });
          return;
        }
      }

      // 3. Start Path to Merge for this PR.
      updateStatus(member.prId, { kind: "starting" });
      try {
        const startResult = await window.ade.prs.pathToMergeStart({
          prId: member.prId,
          modelId,
          reasoning: reasoningEffort,
          permissionMode,
        });
        if (!startResult.scheduled) {
          const message = startResult.blockedBy?.message ?? "Path to Merge is blocked by another lane task.";
          updateStatus(member.prId, { kind: "failed", error: message });
          setSequence({ kind: "halted", failedIndex: idx, error: message });
          return;
        }
      } catch (err) {
        const message = formatError(err);
        updateStatus(member.prId, { kind: "failed", error: message });
        setSequence({ kind: "halted", failedIndex: idx, error: message });
        return;
      }

      // 4. Poll until the PR converges or fails terminally.
      const result = await pollUntilTerminal(member.prId);
      if (cancelledRef.current) return;

      if (result.outcome === "failed") {
        const message = result.error ?? "Path to Merge failed";
        updateStatus(member.prId, { kind: "failed", error: message });
        setSequence({ kind: "halted", failedIndex: idx, error: message });
        return;
      }

      updateStatus(member.prId, { kind: "merged" });
    }

    setSequence({ kind: "complete" });
  }, [members, modelId, permissionMode, pipelineSettings, pollUntilTerminal, queueTargetBranch, reasoningEffort, updateStatus]);

  const handleStart = React.useCallback(() => {
    void runAutomation();
  }, [runAutomation]);

  const handleClose = React.useCallback(() => {
    cancelledRef.current = true;
    onClose();
  }, [onClose]);

  if (!open) return null;

  const isRunning = sequence.kind === "running";
  const activeIndex = sequence.kind === "running" ? sequence.activeIndex : -1;
  const haltedError = sequence.kind === "halted" ? sequence.error : null;
  const haltedIndex = sequence.kind === "halted" ? sequence.failedIndex : -1;
  const startDisabled = isRunning || members.length === 0 || sequence.kind === "complete";

  return (
    <div
      role="presentation"
      onClick={handleClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(3, 4, 10, 0.76)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        zIndex: 140,
        overflowY: "auto",
        padding: "40px 24px",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Automate merging for queue"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(880px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 80px)",
          display: "flex",
          flexDirection: "column",
          background: COLORS.cardBgSolid,
          border: `1px solid ${COLORS.outlineBorder}`,
          borderRadius: 22,
          boxShadow: "0 30px 100px rgba(0,0,0,0.55)",
          overflow: "hidden",
        }}
      >
        {/* ── Header ── */}
        <div
          style={{
            padding: 20,
            borderBottom: `1px solid ${COLORS.border}`,
            background:
              "linear-gradient(180deg, rgba(24,20,35,0.98) 0%, rgba(24,20,35,0.96) 100%)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontFamily: SANS_FONT,
                fontSize: 20,
                fontWeight: 700,
                color: COLORS.textPrimary,
                letterSpacing: "-0.01em",
              }}
            >
              <MagicWand size={20} weight="duotone" style={{ color: COLORS.accent }} />
              Automate merging
            </div>
            <div
              style={{
                fontFamily: SANS_FONT,
                fontSize: 12,
                color: COLORS.textMuted,
                lineHeight: 1.4,
              }}
            >
              Drive every PR in <span style={{ color: COLORS.textSecondary, fontWeight: 600 }}>{queueLabel}</span> through Path to Merge until it lands on{" "}
              <span style={{ fontFamily: MONO_FONT, color: COLORS.textSecondary }}>{queueTargetBranch}</span>. The same configuration applies to each PR.
            </div>
          </div>
          <SmartTooltip
            forceEnabled
            side="bottom"
            content={{
              label: "Close",
              description:
                "Close this modal. Any orchestrator runs already started keep going — stop them from each PR's Path to Merge panel if needed.",
            }}
          >
            <button
              type="button"
              aria-label="Close"
              onClick={handleClose}
              style={{
                width: 32,
                height: 32,
                borderRadius: 999,
                border: `1px solid ${COLORS.border}`,
                background: COLORS.recessedBg,
                color: COLORS.textMuted,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <X size={16} />
            </button>
          </SmartTooltip>
        </div>

        {/* ── Body ── */}
        <div style={{ padding: 20, overflow: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* PR list */}
          <section>
            <div
              style={{
                fontFamily: SANS_FONT,
                fontSize: 10,
                fontWeight: 700,
                color: COLORS.textMuted,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: 8,
              }}
            >
              Stack ({members.length} PR{members.length === 1 ? "" : "s"})
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 10,
                padding: 8,
                background: COLORS.recessedBg,
              }}
            >
              {members.map((member, idx) => {
                const status = statuses[member.prId] ?? { kind: "pending" };
                const badge = statusBadgeColor(status);
                const isActive = idx === activeIndex && isRunning;
                const wasHalted = idx === haltedIndex;
                let rowBackground = "transparent";
                let rowBorderColor = "transparent";
                if (isActive) {
                  rowBackground = "color-mix(in srgb, var(--color-info) 8%, transparent)";
                  rowBorderColor = "color-mix(in srgb, var(--color-info) 32%, transparent)";
                } else if (wasHalted) {
                  rowBackground = "color-mix(in srgb, var(--color-error) 8%, transparent)";
                  rowBorderColor = "color-mix(in srgb, var(--color-error) 32%, transparent)";
                }
                return (
                  <div
                    key={member.prId}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 10px",
                      borderRadius: 6,
                      background: rowBackground,
                      border: `1px solid ${rowBorderColor}`,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: MONO_FONT,
                        fontSize: 11,
                        color: COLORS.textMuted,
                        width: 22,
                        textAlign: "right",
                      }}
                    >
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    {member.laneColor ? (
                      <LaneAccentDot lane={{ color: member.laneColor }} size={7} />
                    ) : null}
                    <span
                      style={{
                        fontFamily: SANS_FONT,
                        fontSize: 13,
                        fontWeight: 600,
                        color: member.laneColor ?? COLORS.textPrimary,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {member.laneName}
                    </span>
                    <span
                      style={{
                        fontFamily: MONO_FONT,
                        fontSize: 11,
                        color: COLORS.textMuted,
                      }}
                    >
                      {member.prNumber != null ? `#${member.prNumber}` : "no PR"}
                    </span>
                    <div style={{ flex: 1 }} />
                    {status.kind === "running" && status.round > 0 ? (
                      <span
                        style={{
                          fontFamily: MONO_FONT,
                          fontSize: 10,
                          color: COLORS.textMuted,
                        }}
                      >
                        round {status.round}/{pipelineSettings.maxRounds}
                      </span>
                    ) : null}
                    {status.kind === "saving" ||
                    status.kind === "retargeting" ||
                    status.kind === "starting" ||
                    (status.kind === "running" && status.runtimeStatus !== "paused") ? (
                      <CircleNotch size={12} className="animate-spin" style={{ color: badge.color }} />
                    ) : null}
                    {status.kind === "merged" ? (
                      <CheckCircle size={12} weight="fill" style={{ color: COLORS.success }} />
                    ) : null}
                    {status.kind === "failed" ? (
                      <Warning size={12} weight="fill" style={{ color: COLORS.danger }} />
                    ) : null}
                    <span
                      style={{
                        fontFamily: SANS_FONT,
                        fontSize: 11,
                        fontWeight: 600,
                        color: badge.color,
                        padding: "2px 8px",
                        borderRadius: 6,
                        background: `color-mix(in srgb, ${badge.color} 12%, transparent)`,
                        border: `1px solid color-mix(in srgb, ${badge.color} 26%, transparent)`,
                      }}
                    >
                      {badge.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Pipeline settings — reuse the per-PR editor for the stack-wide config. */}
          <section>
            <div
              style={{
                fontFamily: SANS_FONT,
                fontSize: 10,
                fontWeight: 700,
                color: COLORS.textMuted,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: 8,
              }}
            >
              Stack-wide pipeline settings
            </div>
            <div
              style={{
                fontFamily: SANS_FONT,
                fontSize: 11,
                color: COLORS.textMuted,
                marginBottom: 10,
                lineHeight: 1.5,
              }}
            >
              These settings apply to every PR in the queue. Each PR runs Path to Merge sequentially; once one merges, the next PR's base is dropped to{" "}
              <span style={{ fontFamily: MONO_FONT, color: COLORS.textSecondary }}>{queueTargetBranch}</span> before its run begins.
            </div>
            <PrPipelineSettings
              settings={pipelineSettings}
              onSettingsChange={handlePipelineSettingsChange}
              showAutoConvergeSettings
              modelId={modelId}
              reasoningEffort={reasoningEffort}
              permissionMode={permissionMode}
              onModelChange={onModelChange}
              onReasoningEffortChange={onReasoningEffortChange}
              onPermissionModeChange={onPermissionModeChange}
              disabled={isRunning}
            />
          </section>

          {/* Halted error surface */}
          {haltedError ? (
            <div
              style={{
                border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
                background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
                color: COLORS.danger,
                fontFamily: SANS_FONT,
                fontSize: 12,
                padding: 10,
                borderRadius: 8,
                lineHeight: 1.5,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                Stopped on {members[haltedIndex]?.laneName ?? "this PR"}
              </div>
              {haltedError}
              <div style={{ marginTop: 6, color: COLORS.textMuted }}>
                The remaining PRs were not started. Open the PR's Path to Merge panel to inspect or retry.
              </div>
            </div>
          ) : null}

          {sequence.kind === "complete" ? (
            <div
              style={{
                border: "1px solid color-mix(in srgb, var(--color-success) 30%, transparent)",
                background: "color-mix(in srgb, var(--color-success) 10%, transparent)",
                color: COLORS.success,
                fontFamily: SANS_FONT,
                fontSize: 12,
                padding: 10,
                borderRadius: 8,
                lineHeight: 1.5,
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <CheckCircle size={14} weight="fill" />
              All PRs merged. The queue is clean.
            </div>
          ) : null}
        </div>

        {/* ── Sticky footer ── */}
        <div
          style={{
            padding: 16,
            borderTop: `1px solid ${COLORS.border}`,
            background: COLORS.cardBgSolid,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 10,
          }}
        >
          <SmartTooltip
            forceEnabled
            side="top"
            content={{
              label: "Cancel",
              description: isRunning
                ? "Close the modal. Path to Merge runs that have already started keep running — stop them from each PR's panel."
                : "Close without starting.",
            }}
          >
            <button type="button" onClick={handleClose} style={outlineButton()}>
              Cancel
            </button>
          </SmartTooltip>
          <SmartTooltip
            forceEnabled
            side="top"
            content={{
              label: "Start Automation",
              description:
                "Save the settings to every PR, then drive each one through Path to Merge in order. The next PR only starts after the previous one merges.",
              warning:
                "If a PR fails, the sequence halts. Already-running orchestrators keep going.",
            }}
          >
            <button
              type="button"
              onClick={handleStart}
              disabled={startDisabled}
              style={primaryButton({
                opacity: startDisabled ? 0.55 : 1,
                cursor: startDisabled ? "not-allowed" : "pointer",
              })}
            >
              {isRunning ? (
                <>
                  <CircleNotch size={14} className="animate-spin" />
                  Running…
                </>
              ) : sequence.kind === "complete" ? (
                "All merged"
              ) : (
                <>
                  <MagicWand size={14} weight="duotone" />
                  Start Automation
                </>
              )}
            </button>
          </SmartTooltip>
        </div>
      </div>
    </div>
  );
}
