import { useCallback, useEffect, useState } from "react";
import type {
  AiConfig,
  AgentChatScheduledWorkItem,
} from "../../../shared/types";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
} from "../lanes/laneDesignTokens";
import { SettingsCard, SettingsGroup, SettingsToggle } from "./primitives";

/**
 * Background work settings.
 *
 * One card — the global scheduled-work pause — with the live job list as its
 * children, because inspecting a job and pausing every job are the same
 * decision seen from two distances.
 */
export function AiFeaturesSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configLoadFailed, setConfigLoadFailed] = useState(false);
  const [scheduledWorkPaused, setScheduledWorkPaused] = useState(false);
  const [scheduledWork, setScheduledWork] = useState<AgentChatScheduledWorkItem[]>([]);
  const [scheduledWorkError, setScheduledWorkError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const [snapshotResult, scheduledWorkResult] = await Promise.all([
        window.ade.projectConfig.get()
          .then((snapshot) => ({ snapshot, error: null as string | null }))
          .catch((error) => ({
            snapshot: null,
            error: error instanceof Error ? error.message : String(error),
          })),
        window.ade.agentChat.listScheduledWork()
          .then((items) => ({ items, error: null as string | null }))
          .catch((error) => ({
            items: [] as AgentChatScheduledWorkItem[],
            error: error instanceof Error ? error.message : String(error),
          })),
      ]);
      setScheduledWork(scheduledWorkResult.items);
      setScheduledWorkError(scheduledWorkResult.error);
      if (!snapshotResult.snapshot) {
        setConfigLoadFailed(true);
        return;
      }
      setConfigLoadFailed(false);

      const effectiveAiRaw = snapshotResult.snapshot.effective?.ai;
      const effectiveAi = effectiveAiRaw && typeof effectiveAiRaw === "object" ? (effectiveAiRaw as AiConfig) : null;
      setScheduledWorkPaused(effectiveAi?.chat?.scheduledWorkPaused === true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleScheduledWorkPaused = useCallback(async (paused: boolean) => {
    if (saving) return;
    setSaving(true);
    setScheduledWorkPaused(paused);
    try {
      await window.ade.ai.updateConfig({ chat: { scheduledWorkPaused: paused } });
    } catch (error) {
      setScheduledWorkPaused(!paused);
      console.error("[AiFeaturesSection] scheduled-work pause update failed:", error);
    } finally {
      setSaving(false);
    }
  }, [saving]);

  const handleCancelScheduledWork = useCallback(async (item: AgentChatScheduledWorkItem) => {
    setScheduledWorkError(null);
    try {
      const result = await window.ade.agentChat.cancelScheduledWork({
        sessionId: item.sessionId,
        scheduleId: item.id,
      });
      if (result.schedule.status === "cancelled") {
        setScheduledWork((current) => current.filter((candidate) => candidate.id !== item.id));
      }
      await loadStatus();
    } catch (error) {
      console.error("[AiFeaturesSection] scheduled-work cancellation failed:", error);
      setScheduledWorkError(error instanceof Error ? error.message : String(error));
    }
  }, [loadStatus]);

  if (loading) {
    return (
      <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12, padding: 20 }}>
        Loading AI features...
      </div>
    );
  }

  if (configLoadFailed) {
    return (
      <div style={{ color: COLORS.textMuted, fontFamily: MONO_FONT, fontSize: 12, padding: 20 }}>
        Couldn't load AI features. The scheduled-work pause stays unavailable until configuration loads.
      </div>
    );
  }

  return (
    <SettingsGroup
      title="Background work"
      description="Background naming, idle status lines, and commit suggestions follow the ADE provider of the session that needs them. Pause or inspect durable scheduled work here."
    >
      <SettingsCard
        anchor="scheduled-work"
        title="Pause all scheduled work"
        description="Wakeups, cron tasks, and loops stay armed. Overdue work fires once when you resume."
        control={
          <SettingsToggle
            label="Pause all scheduled work"
            checked={scheduledWorkPaused}
            onChange={(paused) => void handleScheduledWorkPaused(paused)}
          />
        }
      >
        <div
          style={{
            border: `1px solid ${COLORS.borderMuted}`,
            borderRadius: 10,
            background: COLORS.recessedBg,
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "10px 12px", borderBottom: `1px solid ${COLORS.borderMuted}` }}>
            <div style={{ fontSize: 12, fontFamily: SANS_FONT, fontWeight: 600, color: COLORS.textPrimary }}>
              Active scheduled work
            </div>
            <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim, marginTop: 2 }}>
              Jobs normally manage themselves. Use this list only when you need to inspect or stop one directly.
            </div>
          </div>
          {scheduledWorkError ? (
            <div style={{ padding: "12px", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.warning }}>
              Scheduled work is unavailable: {scheduledWorkError}
            </div>
          ) : scheduledWork.length ? scheduledWork.map((item, index) => (
            <div
              key={`${item.sessionId}:${item.id}`}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto",
                gap: 12,
                alignItems: "center",
                padding: "10px 12px",
                borderTop: index === 0 ? undefined : `1px solid ${COLORS.borderMuted}`,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                  {item.title}
                </div>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
                  {item.kind} · {item.status} · session {item.sessionId.slice(0, 8)}{item.nextRunAt ? ` · ${new Date(item.nextRunAt).toLocaleString()}` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleCancelScheduledWork(item)}
                disabled={!item.cancellable}
                style={{
                  border: `1px solid ${COLORS.outlineBorder}`,
                  borderRadius: 6,
                  background: "transparent",
                  color: item.cancellable ? COLORS.warning : COLORS.textMuted,
                  padding: "5px 9px",
                  fontSize: 11,
                  fontFamily: SANS_FONT,
                  cursor: item.cancellable ? "pointer" : "not-allowed",
                  opacity: item.cancellable ? 1 : 0.5,
                }}
              >
                Cancel
              </button>
            </div>
          )) : (
            <div style={{ padding: "12px", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
              No active durable jobs.
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsGroup>
  );
}
