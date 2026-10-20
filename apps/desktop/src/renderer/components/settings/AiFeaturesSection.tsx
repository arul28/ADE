import { useCallback, useEffect, useState } from "react";
import type {
  AiConfig,
  AgentChatScheduledWorkItem,
} from "../../../shared/types";
import { Clock } from "@phosphor-icons/react";
import { showToast } from "../app/toast/toastStore";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";

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
    <ModernSection group="Scheduled work" title="Scheduled work" hint="Jobs agents schedule, and what happens to chats after a restart.">
      <ModernRows>
        <ModernRow
          anchor="scheduled-work"
          title="Pause all scheduled work"
          hint={unavailable ?? "Wakeups, cron tasks, and loops stay armed. Overdue work runs once on resume."}
          control={
            <SettingsToggle
              label="Pause all scheduled work"
              checked={scheduledWorkPaused}
              disabled={unavailable != null || saving}
              onChange={(paused) => void handleScheduledWorkPaused(paused)}
            />
          }
        />
        <ModernRow
          anchor="continue-after-restart"
          title="Continue chats after restarts"
          hint={loading ? "Loading…" : configLoadFailed ? "Unavailable until the configuration loads." : "When ADE restarts mid-response — a crash, a force quit, a reboot — the chat picks up where it stopped, and the agent is told which background jobs were stopped. Settled chats stay asleep."}
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
          <ModernRow
            title="Scheduled work is unavailable"
            hint={<span style={{ color: "var(--color-warning)" }}>{scheduledWorkError}</span>}
          />
        ) : scheduledWork.length ? (
          scheduledWork.map((item) => (
            <ModernRow
              key={`${item.sessionId}:${item.id}`}
              title={(
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Clock size={14} style={{ color: "var(--kit-text-3)" }} />
                  {item.title}
                </span>
              )}
              hint={
                <span className="kit-num" style={{ fontSize: 11 }}>
                  {item.kind} · {item.status}
                  {item.nextRunAt ? ` · next ${new Date(item.nextRunAt).toLocaleString()}` : ""}
                </span>
              }
              control={
                <button
                  type="button"
                  className="ade-settings-section-action"
                  style={{ border: "1px solid color-mix(in srgb, var(--color-fg) 12%, transparent)", borderRadius: 7 }}
                  onClick={() => void handleCancelScheduledWork(item)}
                  disabled={!item.cancellable}
                >
                  Cancel
                </button>
              }
            />
          ))
        ) : (
          <ModernRow title="Nothing scheduled" hint="Jobs agents schedule show up here." />
        )}
      </ModernRows>
    </ModernSection>
  );
}
