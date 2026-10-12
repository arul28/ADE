import { useCallback, useEffect, useState } from "react";
import type { BackgroundServiceSummary } from "../../../shared/types";
import { agentsAre } from "../../../shared/quitPromptModel";
import { confirmDialog } from "../ui/dialog";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";

function statusLine(summary: BackgroundServiceSummary | null): string {
  if (!summary) return "Checking…";
  if (summary.runner === "desktop") return "Not running. ADE is running your agents itself until it is repaired.";
  const count = summary.runningChats.length;
  const status = count > 0 ? `Running. ${agentsAre(count)} working.` : "Running. No agents are working right now.";
  return summary.manageable ? status : `${status} This build of ADE can't stop it; the installed ADE can.`;
}

function stopWarning(count: number): string {
  const stops = count === 0
    ? "No agents are working right now. Open terminals and test runs stop too."
    : `This stops ${count === 1 ? "1 working agent" : `all ${count} working agents`}, and any open terminals and test runs.`;
  return `${stops} Opening ADE starts the service again.`;
}

/**
 * Settings → Background service: what runs agents on this computer, the off
 * switch, and whether ADE asks before quitting.
 *
 * Quitting the app leaves agents running in the login service, which is the
 * point, but people also need an off switch that is not `ade brain stop` in a
 * terminal. Stopping removes the service and quits, because the app cannot
 * run without it; opening ADE again starts it back up. "Ask before quitting"
 * is the way back from the quit prompt's "Don't ask again".
 */
export function BackgroundServiceSection() {
  const api = window.ade?.app;
  const [summary, setSummary] = useState<BackgroundServiceSummary | null>(null);
  const [ask, setAsk] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSummary((await api?.getBackgroundService?.()) ?? null);
    } catch {
      setSummary(null);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    let cancelled = false;
    void api?.getAskBeforeQuit?.()
      .then((value) => {
        if (!cancelled) setAsk(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, refresh]);

  if (!api?.getBackgroundService) return null;

  const changeAsk = (next: boolean) => {
    setAsk(next);
    void api.setAskBeforeQuit?.(next)
      .then(setAsk)
      .catch(() => setAsk(!next));
  };

  const stop = async () => {
    setError(null);
    // Re-read so the warning names what is running now, not at page load.
    const latest = (await api.getBackgroundService?.().catch(() => null)) ?? summary;
    const chats = latest?.runningChats ?? [];
    const confirmed = await confirmDialog({
      title: "Stop the background service and quit ADE?",
      message: stopWarning(chats.length),
      children: chats.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
          {chats.map((chat) => (
            <li key={chat.sessionId}>
              {chat.title}
              <span style={{ opacity: 0.6 }}> · {chat.projectName}</span>
            </li>
          ))}
        </ul>
      ) : undefined,
      confirmLabel: "Stop and quit",
      cancelLabel: "Keep running",
      destructive: true,
    });
    if (!confirmed) return;
    setStopping(true);
    try {
      const result = await api.stopBackgroundServiceAndQuit?.();
      if (result && !result.ok) setError(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopping(false);
    }
  };

  return (
    <ModernSection
      group="Background service"
      anchor="background-service"
      title="Background service"
      hint="Runs your agents, terminals and tests, so they keep going after you quit ADE."
    >
      <ModernRows>
        <ModernRow
          title="Status"
          hint={error ? <span style={{ color: "var(--color-error)" }}>{error}</span> : statusLine(summary)}
          control={summary?.manageable ? (
            <button
              type="button"
              className="ade-modern-btn ade-modern-btn-danger"
              disabled={stopping}
              onClick={() => void stop()}
            >
              {stopping ? "Stopping…" : "Stop and quit ADE"}
            </button>
          ) : null}
        />
        {api.setAskBeforeQuit ? (
          <ModernRow
            anchor="quit-confirmation"
            title="Ask before quitting"
            hint="ADE always warns you when quitting would stop agents."
            control={<SettingsToggle checked={ask} onChange={changeAsk} label="Ask before quitting" />}
          />
        ) : null}
      </ModernRows>
    </ModernSection>
  );
}
