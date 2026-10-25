import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Square } from "@phosphor-icons/react";
import type { TerminalWatchSummary } from "../../../shared/terminalWatch";
import type { OpenProjectBinding, TerminalSessionChangedEvent } from "../../../shared/types";

/**
 * A chat's live terminal watches (`ade terminal watch`), read from the chat's
 * own machine.
 *
 * Event driven: the brain announces a watch starting, waking, holding or
 * ending as a session change on the chat's id, so this re-reads only then —
 * no poll. Keyed on the pin's key, not the pin object, so a rebuilt pin with
 * the same machine does not re-read.
 */
export function useChatTerminalWatches(
  sessionId: string | null | undefined,
  pin: OpenProjectBinding | null,
  pinKey: string | null,
): { watches: TerminalWatchSummary[]; stop: (watch: TerminalWatchSummary) => void } {
  const [watches, setWatches] = useState<TerminalWatchSummary[]>([]);
  const pinRef = useRef(pin);
  pinRef.current = pin;

  useEffect(() => {
    const chatId = sessionId?.trim();
    setWatches([]);
    const list = window.ade?.terminal?.listWatches;
    // A host without terminal watches (the web client) shows none.
    if (!chatId || typeof list !== "function") return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await list({ chatSessionId: chatId }, pinRef.current);
        if (!cancelled) setWatches(Array.isArray(rows) ? rows.filter((row) => row.status === "active") : []);
      } catch (error) {
        // An older brain does not know the action: no watches to show.
        if (!cancelled) setWatches([]);
        console.warn("[ChatTerminalWatches] list failed", { chatId, error });
      }
    };
    void load();
    const subscribe = window.ade?.sessions?.onChanged;
    const unsubscribe = typeof subscribe === "function"
      ? subscribe((event: TerminalSessionChangedEvent) => {
        if (event?.sessionId === chatId) void load();
      }, pinRef.current ?? undefined)
      : () => {};
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId, pinKey]);

  const stop = useCallback((watch: TerminalWatchSummary) => {
    const unwatch = window.ade?.terminal?.unwatch;
    if (typeof unwatch !== "function") return;
    // Optimistic: the row goes now; the brain's change event confirms it.
    setWatches((current) => current.filter((row) => row.watchId !== watch.watchId));
    void unwatch({ watchId: watch.watchId }, pinRef.current).catch((error: unknown) => {
      console.error("[ChatTerminalWatches] stop failed", { watchId: watch.watchId, error });
    });
  }, []);

  return { watches, stop };
}

function remainingLabel(expiresAt: string, nowMs: number): string {
  const ms = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return "ending";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m left` : `${hours}h left`;
}

/** One watch: the terminal, its filter, wakes so far, and Stop. */
export function TerminalWatchRow({
  watch,
  onStop,
}: {
  watch: TerminalWatchSummary;
  onStop?: (watch: TerminalWatchSummary) => void;
}) {
  const parts = [
    watch.match ? `on ${watch.match}` : "any output",
    watch.holding ? "holding for the chat" : watch.wakeCount > 0 ? `${watch.wakeCount} wake${watch.wakeCount === 1 ? "" : "s"}` : null,
    remainingLabel(watch.expiresAt, Date.now()),
  ].filter(Boolean);
  return (
    <div
      className="group grid min-h-[34px] grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-fg/[0.035]"
      data-terminal-watch={watch.watchId}
      title={`Wakes this chat when "${watch.terminalTitle}" prints new output`}
    >
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-1.5">
        <Eye aria-hidden size={11} weight="bold" className="shrink-0 text-cyan-300/55" />
        <span className="min-w-0 truncate text-[12px] leading-5 text-fg/75">{watch.terminalTitle}</span>
        <span className="col-start-2 min-w-0 truncate font-sans text-[10.5px] leading-4 tabular-nums text-fg/40">{parts.join(" · ")}</span>
      </div>
      {onStop ? (
        <button
          type="button"
          aria-label="Stop watching this terminal"
          title="Stop watching"
          onClick={() => onStop(watch)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg/45 transition-colors hover:bg-rose-500/10 hover:text-rose-200/90"
        >
          <Square aria-hidden size={10} weight="fill" />
        </button>
      ) : null}
    </div>
  );
}
