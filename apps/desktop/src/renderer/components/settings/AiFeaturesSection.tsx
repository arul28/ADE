import { useCallback, useEffect, useState } from "react";
import type {
  AiConfig,
  AgentChatScheduledWorkItem,
} from "../../../shared/types";
import { ArrowClockwise, Clock, PauseCircle } from "@phosphor-icons/react";
import { COLORS, MONO_FONT } from "../lanes/laneDesignTokens";
import { showToast } from "../app/toast/toastStore";
import { SettingsPanel, SettingsRow, SettingsSection, SettingsToggle } from "./primitives";

/**
 * Scheduled work: the global pause, then the live job list in the same panel,
 * because inspecting a job and pausing every job are the same decision seen
 * from two distances.
 */
export function AiFeaturesSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configLoadFailed, setConfigLoadFailed] = useState(false);
  const [scheduledWorkPaused, setScheduledWorkPaused] = useState(false);
  const [continueAfterRestart, setContinueAfterRestart] = useState(true);
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
      setContinueAfterRestart(effectiveAi?.chat?.continueAfterRestart !== false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  /** Save one chat toggle optimistically; a failed save puts it back and says so. */
  const saveChatToggle = useCallback(async (
    key: "scheduledWorkPaused" | "continueAfterRestart",
    value: boolean,
    setLocal: (value: boolean) => void,
  ) => {
    if (saving) return;
    setSaving(true);
    setLocal(value);
    try {
      await window.ade.ai.updateConfig({ chat: { [key]: value } });
    } catch (error) {
      setLocal(!value);
      showToast({
        title: "Couldn't save the setting",
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  }, [saving]);
  const handleScheduledWorkPaused = (paused: boolean) =>
    saveChatToggle("scheduledWorkPaused", paused, setScheduledWorkPaused);
  const handleContinueAfterRestart = (enabled: boolean) =>
    saveChatToggle("continueAfterRestart", enabled, setContinueAfterRestart);

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

  const unavailable = loading
    ? "Loading…"
    : configLoadFailed
      ? "Couldn't load the configuration. The pause switch stays off until it loads."
      : null;

  return (
    <SettingsSection title="Scheduled work">
      <SettingsPanel>
        <SettingsRow
          anchor="scheduled-work"
          icon={<PauseCircle size={15} weight="duotone" />}
          tone="amber"
          title="Pause all scheduled work"
          description={unavailable ?? "Wakeups, cron tasks, and loops stay armed. Overdue work runs once on resume."}
          control={
            <SettingsToggle
              label="Pause all scheduled work"
              checked={scheduledWorkPaused}
              disabled={unavailable != null || saving}
              onChange={(paused) => void handleScheduledWorkPaused(paused)}
            />
          }
        />
        <SettingsRow
          anchor="continue-after-restart"
          icon={<ArrowClockwise size={15} weight="duotone" />}
          tone="blue"
          title="Continue chats after restarts"
          description={loading ? "Loading…" : configLoadFailed ? "Unavailable until the configuration loads." : "When ADE restarts mid-response — a crash, a force quit, a reboot — the chat picks up where it stopped, and the agent is told which background jobs were stopped. Settled chats stay asleep."}
          control={
            <SettingsToggle
              label="Continue chats after restarts"
              checked={continueAfterRestart}
              disabled={unavailable != null || saving}
              onChange={(enabled) => void handleContinueAfterRestart(enabled)}
            />
          }
        />
        {unavailable ? null : scheduledWorkError ? (
          <SettingsRow
            title="Scheduled work is unavailable"
            description={<span style={{ color: COLORS.warning }}>{scheduledWorkError}</span>}
          />
        ) : scheduledWork.length ? (
          <div className="ade-settings-row-group">
            {scheduledWork.map((item) => (
              <SettingsRow
                key={`${item.sessionId}:${item.id}`}
                icon={<Clock size={15} weight="duotone" />}
                tone="blue"
                title={item.title}
                description={
                  <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>
                    {item.kind} · {item.status}
                    {item.nextRunAt ? ` · next ${new Date(item.nextRunAt).toLocaleString()}` : ""}
                  </span>
                }
                control={
                  <button
                    type="button"
                    className="ade-settings-section-action"
                    style={{ border: `1px solid ${COLORS.outlineBorder}`, borderRadius: 7 }}
                    onClick={() => void handleCancelScheduledWork(item)}
                    disabled={!item.cancellable}
                  >
                    Cancel
                  </button>
                }
              />
            ))}
          </div>
        ) : (
          <SettingsRow title="Nothing scheduled" description="Jobs agents schedule show up here." />
        )}
      </SettingsPanel>
    </SettingsSection>
  );
}
