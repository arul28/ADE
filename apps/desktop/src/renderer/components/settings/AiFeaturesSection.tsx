import React, { useCallback, useEffect, useState } from "react";
import type {
  AiConfig,
  AgentChatScheduledWorkItem,
} from "../../../shared/types";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  cardStyle,
} from "../lanes/laneDesignTokens";
import { Alarm } from "@phosphor-icons/react";

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 36,
        height: 20,
        borderRadius: 10,
        border: "none",
        background: checked ? COLORS.accent : COLORS.outlineBorder,
        cursor: "pointer",
        padding: 0,
        flexShrink: 0,
        transition: "background 150ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: 8,
          background: COLORS.textPrimary,
          transition: "left 150ms ease",
        }}
      />
    </button>
  );
}

export function AiFeaturesSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scheduledWorkPaused, setScheduledWorkPaused] = useState(false);
  const [scheduledWork, setScheduledWork] = useState<AgentChatScheduledWorkItem[]>([]);
  const [scheduledWorkError, setScheduledWorkError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const [snapshot, scheduledWorkResult] = await Promise.all([
        window.ade.projectConfig.get(),
        window.ade.agentChat.listScheduledWork()
          .then((items) => ({ items, error: null as string | null }))
          .catch((error) => ({
            items: [] as AgentChatScheduledWorkItem[],
            error: error instanceof Error ? error.message : String(error),
          })),
      ]);
      setScheduledWork(scheduledWorkResult.items);
      setScheduledWorkError(scheduledWorkResult.error);

      const effectiveAiRaw = snapshot.effective?.ai;
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

  const featureRowHoverCss = `.ai-feature-row:hover { background: ${COLORS.hoverBg}; }`;

  return (
    <>
      <style>{featureRowHoverCss}</style>
      <div>
        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: COLORS.textPrimary,
            fontFamily: SANS_FONT,
            marginBottom: 12,
            lineHeight: 1.4,
          }}
        >
          Background naming, idle status lines, and commit suggestions follow the ADE provider of the session that needs them. Pause or inspect durable scheduled work here.
        </div>

        <div style={{ ...cardStyle({ padding: 0 }), marginBottom: 12 }}>
          <div className="ai-feature-row" style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px" }}>
            <Toggle checked={scheduledWorkPaused} onChange={(paused) => void handleScheduledWorkPaused(paused)} />
            <Alarm size={18} weight="duotone" style={{ color: scheduledWorkPaused ? COLORS.warning : COLORS.accent, flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontFamily: SANS_FONT, fontWeight: 600, color: COLORS.textPrimary }}>
                Pause all scheduled work
              </div>
              <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim, marginTop: 2, lineHeight: 1.4 }}>
                Wakeups, cron tasks, and loops stay armed. Overdue work fires once when you resume.
              </div>
            </div>
          </div>
        </div>

        <div style={{ ...cardStyle({ padding: 0 }), marginBottom: 12 }}>
          <div style={{ padding: "10px 16px", borderBottom: scheduledWork.length ? `1px solid ${COLORS.border}` : undefined }}>
            <div style={{ fontSize: 12, fontFamily: SANS_FONT, fontWeight: 600, color: COLORS.textPrimary }}>
              Active scheduled work
            </div>
            <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim, marginTop: 2 }}>
              Jobs normally manage themselves. Use this list only when you need to inspect or stop one directly.
            </div>
          </div>
          {scheduledWorkError ? (
            <div style={{ padding: "12px 16px", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.warning }}>
              Scheduled work is unavailable: {scheduledWorkError}
            </div>
          ) : scheduledWork.length ? scheduledWork.map((item) => (
            <div
              key={`${item.sessionId}:${item.id}`}
              className="ai-feature-row"
              style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center", padding: "10px 16px", borderBottom: `1px solid ${COLORS.border}` }}
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
            <div style={{ padding: "12px 16px", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
              No active durable jobs.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
