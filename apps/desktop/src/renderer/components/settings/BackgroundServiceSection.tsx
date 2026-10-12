import { useCallback, useEffect, useState } from "react";
import type { BackgroundServiceSummary } from "../../../shared/types";
import { agentsAre } from "../../../shared/quitPromptCopy";
import { confirmDialog } from "../ui/dialog";
import { ModernRow, ModernRows, ModernSection } from "./primitives";

/**
 * Settings → Background service: the one place to stop ADE's agents for good.
 *
 * Quitting the app leaves agents running in the login service, which is the
 * point, but people also need an off switch that is not `ade brain stop` in a
 * terminal. Stopping removes the service and quits, because the app cannot
 * run without it; opening ADE again starts it back up.
 */
export function BackgroundServiceSection() {
  const api = window.ade?.app;
  const [summary, setSummary] = useState<BackgroundServiceSummary | null>(null);
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
  }, [refresh]);

  if (!api?.getBackgroundService) return null;

  const count = summary?.runningChats.length ?? 0;
  const status = !summary
    ? "Checking…"
    : summary.runner === "desktop"
      ? "Not running. ADE is running your agents itself until it is repaired."
      : count > 0
        ? `Running. ${agentsAre(count)} working.`
        : "Running. No agents are working right now.";
  const hint = summary && !summary.manageable
    ? `${status} This build of ADE can't stop it; the installed ADE can.`
    : status;

  const stop = async () => {
    setError(null);
    // Re-read so the warning names what is running now, not at page load.
    const latest = (await api.getBackgroundService?.().catch(() => null)) ?? summary;
    const chats = latest?.runningChats ?? [];
    const confirmed = await confirmDialog({
      title: "Stop the background service and quit ADE?",
      message: chats.length > 0
        ? `This stops ${chats.length === 1 ? "1 working agent" : `all ${chats.length} working agents`}. Opening ADE starts the service again.`
        : "No agents are working right now. Opening ADE starts the service again.",
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
          hint={error ? <span style={{ color: "var(--color-error)" }}>{error}</span> : hint}
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
      </ModernRows>
    </ModernSection>
  );
}
