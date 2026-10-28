import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Square } from "@phosphor-icons/react";
import type { TerminalWatchSummary } from "../../../shared/terminalWatch";
import type { OpenProjectBinding, TerminalSessionChangedEvent } from "../../../shared/types";
import { isUnsupportedAdeActionError } from "../../../shared/codedError";
import { isAdeAvailable } from "../../lib/adeAvailability";
import { showToast } from "../app/toast/toastStore";

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
): {
  watches: TerminalWatchSummary[];
  /** The read failed: the section says so instead of showing no watches. */
  loadError: boolean;
  retry: () => void;
  stop: (watch: TerminalWatchSummary) => void;
} {
  const [watches, setWatches] = useState<TerminalWatchSummary[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  // The chat and machine on screen now: a late Stop failure restores its row only here.
  const scopeKey = `${sessionId?.trim() ?? ""}|${pinKey ?? ""}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;

  useEffect(() => {
    const chatId = sessionId?.trim();
    setWatches([]);
    setLoadError(false);
    const list = window.ade?.terminal?.listWatches;
    // A host without terminal watches (the web client) shows none.
    if (!chatId || !isAdeAvailable(list)) return undefined;
    let cancelled = false;
    // Session changes can start overlapping reads: only the newest one lands.
    let latest = 0;
    const load = async () => {
      const request = ++latest;
      try {
        const rows = await list({ chatSessionId: chatId }, pinRef.current);
        if (cancelled || request !== latest) return;
        setWatches(Array.isArray(rows) ? rows.filter((row) => row.status === "active") : []);
        setLoadError(false);
      } catch (error) {
        if (cancelled || request !== latest) return;
        // An older brain does not know the action: it has no watches to show.
        // Any other failure is said, not shown as an empty list.
        const unsupported = isUnsupportedAdeActionError(error);
        setLoadError(!unsupported);
        if (unsupported) setWatches([]);
        console.warn("[ChatTerminalWatches] list failed", { chatId, error });
      }
    };
    void load();
    const subscribe = window.ade?.sessions?.onChanged;
    const unsubscribe = isAdeAvailable(subscribe)
      ? subscribe((event: TerminalSessionChangedEvent) => {
        if (event?.sessionId === chatId) void load();
      }, pinRef.current ?? undefined)
      : () => {};
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // `reloadNonce` is the Retry action.
  }, [sessionId, pinKey, reloadNonce]);

  const stop = useCallback((watch: TerminalWatchSummary) => {
    const unwatch = window.ade?.terminal?.unwatch;
    if (!isAdeAvailable(unwatch)) return;
    const scope = scopeRef.current;
    // Optimistic: the row goes now; the brain's change event confirms it.
    setWatches((current) => current.filter((row) => row.watchId !== watch.watchId));
    void unwatch({ watchId: watch.watchId, chatSessionId: watch.chatSessionId }, pinRef.current).catch((error: unknown) => {
      console.error("[ChatTerminalWatches] stop failed", { watchId: watch.watchId, error });
      // It may still be waking the chat: put the row back so Stop can be tried
      // again, unless another chat is on screen by now.
      if (scopeRef.current === scope) {
        setWatches((current) => (current.some((row) => row.watchId === watch.watchId) ? current : [watch, ...current]));
      }
      showToast({
        tone: "error",
        // Not the terminal's title: a `--command` watch is titled with its
        // command, which may hold a secret, and error toasts reach telemetry.
        title: "Couldn't stop the terminal watch",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, []);

  const retry = useCallback(() => setReloadNonce((value) => value + 1), []);

  return { watches, loadError, retry, stop };
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
function wakeStatusLabel(watch: TerminalWatchSummary): string | null {
  if (watch.holding) return "holding for the chat";
  if (watch.wakeCount === 0) return null;
  return `${watch.wakeCount} wake${watch.wakeCount === 1 ? "" : "s"}`;
}

export function TerminalWatchRow({
  watch,
  onStop,
}: {
  watch: TerminalWatchSummary;
  onStop?: (watch: TerminalWatchSummary) => void;
}) {
  const parts = [
    watch.match ? `on ${watch.match}` : "any output",
    wakeStatusLabel(watch),
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
