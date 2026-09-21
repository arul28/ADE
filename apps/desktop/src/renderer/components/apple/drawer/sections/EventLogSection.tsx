import { useEffect, useRef, useState } from "react";
import { CaretDown } from "@phosphor-icons/react";
import type { IosSimulatorLogRow } from "../../../../../shared/types/iosSimulator";
import { cn } from "../../../ui/cn";
import type { AppleDrawerContext } from "../drawerContext";

export const APPLE_EVENT_LOG_LIMIT = 100;
const POLL_MS = 1000;

/** `HH:MM:SS` from an ISO timestamp; the raw text when it is not one. */
export function eventLogClock(at: string): string {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return at.slice(11, 19) || at;
  return time.toLocaleTimeString([], { hour12: false });
}

/** Append and cap at the newest hundred. */
export function appendEventLogRows(current: readonly IosSimulatorLogRow[], incoming: readonly IosSimulatorLogRow[]): IosSimulatorLogRow[] {
  if (!incoming.length) return [...current];
  const merged = [...current, ...incoming];
  return merged.length > APPLE_EVENT_LOG_LIMIT ? merged.slice(-APPLE_EVENT_LOG_LIMIT) : merged;
}

/**
 * §8.9 — collapsible, mono 11px, HH:MM:SS + summary, max 100 rows. Subscribes
 * only while open: the log follows the foreground app (`log stream` needs a
 * subsystem to scope to), starts on expand, stops on collapse.
 */
export function EventLogSection({ ctx }: { ctx: AppleDrawerContext }) {
  const { scope, pinRef, visible, actions, foregroundApp } = ctx;
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<IosSimulatorLogRow[]>([]);
  const [running, setRunning] = useState(false);
  const cursor = useRef(0);
  const reportError = actions.reportError;

  useEffect(() => {
    if (!open || !visible || !foregroundApp) {
      setRows([]);
      setRunning(false);
      return undefined;
    }
    let cancelled = false;
    let timer: number | null = null;
    cursor.current = 0;
    const api = window.ade.iosSimulator;
    // The pin this subscription was opened with; the stop goes to the same machine.
    const pin = pinRef.current;
    const absorb = (page: { rows: IosSimulatorLogRow[]; cursor: number; running: boolean }) => {
      if (cancelled) return;
      cursor.current = page.cursor;
      setRunning(page.running);
      if (page.rows.length) setRows((current) => appendEventLogRows(current, page.rows));
    };
    const poll = async () => {
      try {
        absorb(await api.getEventLog({ ...scope, sinceId: cursor.current, limit: APPLE_EVENT_LOG_LIMIT }, pin));
      } catch (cause: unknown) {
        if (!cancelled) reportError(cause);
      }
      if (!cancelled) timer = window.setTimeout(() => { void poll(); }, POLL_MS);
    };
    void api.startEventLog({ ...scope, bundleId: foregroundApp }, pin)
      .then((page) => {
        absorb(page);
        if (!cancelled) timer = window.setTimeout(() => { void poll(); }, POLL_MS);
      })
      .catch((cause: unknown) => { if (!cancelled) reportError(cause); });
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      void api.stopEventLog({}, pin).catch(() => {});
    };
  }, [foregroundApp, open, pinRef, reportError, scope, visible]);

  return (
    <section className="border-b border-border last:border-b-0" aria-label="Event log" data-testid="apple-drawer-event-log">
      <button
        type="button"
        className="flex min-h-9 w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-fg hover:text-fg"
        aria-expanded={open}
        aria-label="Event log"
        onClick={() => setOpen((value) => !value)}
      >
        <h3 className="text-xs font-medium">Event log</h3>
        {running ? <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" title="Streaming" aria-hidden="true" /> : null}
        <CaretDown size={12} className={cn("ml-auto transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <div className="px-3 pb-2.5">
          {!foregroundApp ? (
            <p className="text-[11px] text-muted-fg/70">Open an app first.</p>
          ) : (
            <ol className="max-h-64 overflow-y-auto font-mono text-[11px] leading-relaxed" aria-label="Event log rows">
              {rows.length === 0 ? (
                <li className="text-muted-fg">No events yet.</li>
              ) : rows.map((row) => (
                <li key={row.id} className="flex gap-2">
                  <span className="shrink-0 text-muted-fg">{eventLogClock(row.at)}</span>
                  <span className={cn("truncate", (row.level === "error" || row.level === "fault") && "text-[var(--color-error)]")}>
                    {row.message}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}
