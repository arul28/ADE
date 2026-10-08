import { useEffect, useMemo, useState } from "react";
import { ClipboardText, Copy, Pause, Play, ShieldCheck, Trash, X } from "@phosphor-icons/react";
import type { HomeClipboardState } from "../../../../shared/types/homeWidgets";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { showToast } from "../../app/toast/toastStore";
import { useHomeLayoutStore } from "../homeLayout";
import { useWidgetPreview } from "../HomeWidgetGrid";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import { relativeTimeShort } from "./widgetHooks";
import "../homeWidgets.css";

/**
 * Clipboard history. The desktop main process watches the clipboard while
 * this widget is on the home page (one cheap read a second) and keeps the
 * last 50 copies in memory; "Keep after restart" also writes them to this
 * computer's ADE user data. Copies that look like secrets (tokens, private
 * keys, generated passwords) or that a password manager marks as concealed
 * are never kept. Removing the widget stops the watch.
 */

function useClipboardState(paused: boolean): { state: HomeClipboardState | null; error: string | null } {
  const [state, setState] = useState<HomeClipboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const bridge = window.ade?.home?.clipboard;
    if (!bridge) return undefined;
    let cancelled = false;
    const unsubscribe = bridge.onChanged((next) => {
      if (!cancelled) setState(next);
    });
    void bridge.getState()
      .then(async (current) => {
        // Being on the page is the opt-in: the widget turns the watch on unless
        // the user paused it here.
        const next = current.enabled || paused ? current : await bridge.configure({ enabled: true });
        if (!cancelled) setState(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // Mount-time decision only; the pause button talks to main directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { state, error };
}

export default function ClipboardWidget({ item }: HomeWidgetProps) {
  // A gallery preview shows the history but never switches the watch on.
  const preview = useWidgetPreview();
  const paused = item.settings?.paused === true || preview;
  const { state, error } = useClipboardState(paused);
  const bridge = window.ade?.home?.clipboard;
  const updateSettings = useHomeLayoutStore((s) => s.updateSettings);
  const [filter, setFilter] = useState("");
  const [, setTick] = useState(0);
  // Relative times ("3m") refresh once a minute.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const entries = useMemo(() => {
    const all = state?.entries ?? [];
    const query = filter.trim().toLowerCase();
    return query ? all.filter((entry) => entry.text.toLowerCase().includes(query)) : all;
  }, [filter, state?.entries]);
  const roomy = item.size !== "s";

  return (
    <section className="kit-card ade-home-card ade-clip" aria-label="Clipboard history" data-size={item.size}>
      <WelcomeCardHead icon={ClipboardText} title="Clipboard" count={state && state.entries.length > 0 ? state.entries.length : null}>
        {state ? (
          <div className="ade-clip-tools">
            <button
              type="button"
              className="kit-icon-btn"
              title={state.enabled ? "Pause watching the clipboard" : "Resume watching"}
              aria-label={state.enabled ? "Pause clipboard history" : "Resume clipboard history"}
              onClick={() => {
                updateSettings(item.id, { paused: state.enabled });
                void bridge?.configure({ enabled: !state.enabled });
              }}
            >
              {state.enabled ? <Pause size={13} /> : <Play size={13} />}
            </button>
            <button
              type="button"
              className="kit-icon-btn"
              title="Clear history"
              aria-label="Clear clipboard history"
              disabled={state.entries.length === 0}
              onClick={() => void bridge?.clear()}
            >
              <Trash size={13} />
            </button>
          </div>
        ) : null}
      </WelcomeCardHead>
      <div className="kit-card-body ade-clip-body" data-flush="true">
        {error ? (
          <div className="ade-home-empty" role="alert"><span>Clipboard history is unavailable: {error}</span></div>
        ) : !state ? (
          <div className="ade-home-empty"><span>Reading clipboard history…</span></div>
        ) : (
          <>
            {roomy && state.entries.length > 4 ? (
              <input className="ade-hw-input ade-clip-filter" placeholder="Filter" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter clipboard history" />
            ) : null}
            {entries.length === 0 ? (
              <div className="ade-home-empty">
                <ClipboardText size={18} aria-hidden />
                <span>
                  {!state.enabled ? "Paused. Copies are not being recorded." : filter ? "Nothing matches." : "Copy something and it shows up here."}
                </span>
              </div>
            ) : (
              <div className="ade-home-scroll" role="list">
                {entries.map((entry) => (
                  <div key={entry.id} role="listitem" className="ade-clip-row">
                    <button
                      type="button"
                      className="ade-clip-main"
                      title="Copy again"
                      onClick={() => {
                        void bridge?.copy(entry.id).then((ok) => {
                          if (ok) showToast({ id: "home-clipboard-copied", tone: "success", title: "Copied", durationMs: 1_800 });
                        });
                      }}
                    >
                      <span className="ade-clip-text">{entry.text.length > 400 ? `${entry.text.slice(0, 400)}…` : entry.text}</span>
                      <span className="ade-clip-meta kit-num">
                        {relativeTimeShort(entry.copiedAt)}
                        {entry.length > 120 ? ` · ${entry.length.toLocaleString()} chars` : ""}
                      </span>
                    </button>
                    <div className="ade-clip-actions">
                      <button type="button" className="kit-icon-btn" aria-label="Copy again" onClick={() => void bridge?.copy(entry.id)}>
                        <Copy size={12} />
                      </button>
                      <button type="button" className="kit-icon-btn" aria-label="Remove from history" onClick={() => void bridge?.remove(entry.id)}>
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="ade-clip-foot">
              <label className="ade-clip-keep">
                <input type="checkbox" checked={state.persist} onChange={(event) => void bridge?.configure({ persist: event.target.checked })} />
                Keep after restart
              </label>
              {state.skippedSecrets > 0 ? (
                <span className="ade-clip-skipped" title="Copies that looked like a password, token or key were not kept.">
                  <ShieldCheck size={12} aria-hidden /> {state.skippedSecrets} secret{state.skippedSecrets === 1 ? "" : "s"} left out
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
