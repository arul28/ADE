import { useCallback, useEffect, useState } from "react";
import type { BackgroundServiceActivity, BackgroundServiceSummary } from "../../../shared/types";
import { pluralCount } from "../../../shared/formatting";
import { agentsAre } from "../../../shared/quitPromptModel";
import { confirmDialog } from "../ui/dialog";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import { Banner } from "../ui/notice";
import { extractError } from "../../lib/format";

const OTHER_PROJECTS_NOTE = "Other work may also be running, such as agents in projects that aren't open in ADE.";

function statusLine(summary: BackgroundServiceSummary | null): string {
  if (!summary) return "Checking…";
  if (summary.runner === "desktop") return "Not running. ADE is running your agents itself until it is repaired.";
  const activity = summary.activity;
  let status = "Running. ADE couldn't check which agents are working.";
  if (activity) {
    const count = activity.runningChats.length;
    status = count > 0 ? `Running. ${agentsAre(count)} working.` : "Running. No agents are working in open projects.";
    if (activity.otherProjectsBusy) status = `${status} ${OTHER_PROJECTS_NOTE}`;
  }
  return summary.manageable ? status : `${status} This build of ADE can't stop it; the installed ADE can.`;
}

function stopWarning(activity: BackgroundServiceActivity): string {
  const count = activity.runningChats.length;
  const stops = count === 0
    ? "This stops any open terminals and test runs."
    : `This stops ${count === 1 ? "the working agent" : `all ${pluralCount(count, "working agent")}`} and any open terminals and test runs.`;
  return activity.otherProjectsBusy ? `${stops} ${OTHER_PROJECTS_NOTE}` : `${stops} Opening ADE starts the service again.`;
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

  const refresh = useCallback(async (): Promise<BackgroundServiceSummary | null> => {
    const next = (await api?.getBackgroundService?.().catch(() => null)) ?? null;
    setSummary(next);
    return next;
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
    const activity = (await refresh())?.activity;
    if (!activity) {
      setError("ADE couldn't check which agents are working, so it stopped nothing. Try again.");
      return;
    }
    const chats = activity.runningChats;
    const confirmed = await confirmDialog({
      title: "Stop the background service and quit ADE?",
      message: stopWarning(activity),
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
      const result = await api.stopBackgroundServiceAndQuit?.({
        confirmedSessionIds: chats.map((chat) => chat.sessionId),
        confirmedOtherProjectsBusy: activity.otherProjectsBusy,
      });
      if (result && !result.ok) {
        setError(result.message);
        void refresh();
      }
    } catch (cause) {
      setError(extractError(cause));
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
          hint={statusLine(summary)}
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
        >
          {error ? (
            <Banner
              layout="inline"
              model={{
                id: "background-service-stop-error",
                tone: "error",
                title: error,
                report: { surface: "background_service_stop" },
                dismiss: { onDismiss: () => setError(null) },
              }}
            />
          ) : null}
        </ModernRow>
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
