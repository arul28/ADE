import React, { useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, Check, Eye, EyeSlash, RocketLaunch } from "@phosphor-icons/react";
import type { PrChatWatchSummary, PrWatchMode } from "../../../shared/prWatch";
import type { OpenProjectBinding, PrSummary } from "../../../shared/types";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { cn } from "../ui/cn";
import { Z_LAYERS } from "../ui/zLayers";
import { MENU_ITEM_CLASS, MENU_LABEL_CLASS, MENU_SEPARATOR_CLASS, MENU_SURFACE_CLASS } from "../ui/paneMenuTokens";

type Choice = { mode: PrWatchMode | null; label: string; hint: string };

const CHOICES: readonly Choice[] = [
  { mode: null, label: "Off", hint: "Cards only" },
  { mode: "watch", label: "Watch", hint: "Wake on changes" },
  { mode: "ship", label: "Ship", hint: "Fix and merge" },
];

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One short line under the choices, only while a watch is on. */
function statusLine(watch: PrChatWatchSummary | null): string | null {
  if (!watch || watch.status === "stopped") return null;
  if (watch.holding) return "Holding for CI and reviews";
  const told = relativeTime(watch.lastToldAt);
  const by = watch.armedBy === "agent" ? " · on by agent" : "";
  if (watch.lastToldSummary && told) return `Told ${told}: ${watch.lastToldSummary}${by}`;
  return `No changes yet${by}`;
}

function modeIcon(mode: PrWatchMode | null) {
  return mode === "ship" ? RocketLaunch : mode === "watch" ? Eye : EyeSlash;
}

/**
 * Off / Watch / Ship for the chat's pull request, beside the header PR pill.
 * Watch wakes the agent with PR news; Ship adds standing orders to land it.
 */
export function PrWatchPill({
  sessionId,
  pr,
  runtimePin = null,
}: {
  sessionId: string;
  pr: PrSummary;
  runtimePin?: OpenProjectBinding | null;
}) {
  const [watch, setWatch] = useState<PrChatWatchSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const runtimePinRef = useRef(runtimePin);
  runtimePinRef.current = runtimePin;
  const runtimePinKey = runtimePin?.key ?? null;
  const prId = pr.id;
  const terminal = pr.state === "merged" || pr.state === "closed";

  const load = useCallback(async () => {
    if (typeof window.ade.prs.getChatWatches !== "function") return;
    try {
      const watches = await window.ade.prs.getChatWatches({ sessionId }, runtimePinRef.current);
      setWatch(watches.find((entry) => entry.prId === prId) ?? null);
    } catch {
      // An older host has no watch; the pill reads Off.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prId, sessionId, runtimePinKey]);

  useEffect(() => {
    setWatch(null);
    void load();
  }, [load]);

  useEffect(() => {
    const unsubscribe = window.ade.prs.onEvent((event) => {
      if (event.type !== "pr-chat-watch-changed") return;
      if (event.sessionId !== sessionId || event.prId !== prId) return;
      setWatch(event.watch && event.watch.status !== "stopped" ? event.watch : null);
    }, runtimePinRef.current);
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prId, sessionId, runtimePinKey]);

  const choose = useCallback(async (mode: PrWatchMode | null) => {
    setOpen(false);
    const current = watch && watch.status !== "stopped" ? watch.mode : null;
    if (mode === current) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.ade.prs.setChatWatch({ prId, sessionId, mode }, runtimePinRef.current);
      setWatch(next && next.status !== "stopped" ? next : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [prId, sessionId, watch]);

  if (terminal || typeof window.ade.prs.setChatWatch !== "function") return null;

  const active = watch && watch.status !== "stopped" ? watch : null;
  const mode = active?.mode ?? null;
  const Icon = modeIcon(mode);
  const status = statusLine(active);
  const label = mode === "ship" ? "Shipping" : mode === "watch" ? "Watching" : "Watch";

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="chat-header-pr-watch"
        className={cn(
          "relative inline-flex h-6 items-center gap-0.5 rounded-md px-1.5 transition-colors disabled:opacity-40",
          open ? "bg-white/[0.08]" : "hover:bg-white/[0.06]",
          mode === "ship" ? "text-amber-300" : mode === "watch" ? "text-sky-300" : "text-fg/40 hover:text-fg/70",
        )}
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} PR #${pr.githubPrNumber}`}
        title={error ?? (status ? `${label} · ${status}` : `${label} #${pr.githubPrNumber}`)}
      >
        <Icon size={13} weight={mode ? "fill" : "regular"} aria-hidden />
        <CaretDown size={8} weight="bold" className="opacity-50" aria-hidden />
        {active?.holding ? (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" aria-hidden />
        ) : null}
      </button>
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        zIndex={Z_LAYERS.popover}
        role="menu"
        aria-label={`Watch PR #${pr.githubPrNumber}`}
        className={cn(MENU_SURFACE_CLASS, "w-[208px]")}
      >
        <div className={MENU_LABEL_CLASS}>PR #{pr.githubPrNumber}</div>
        {CHOICES.map((choice) => {
          const selected = choice.mode === mode;
          const ChoiceIcon = modeIcon(choice.mode);
          return (
            <button
              key={choice.label}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              className={cn(MENU_ITEM_CLASS, "w-full text-left hover:bg-white/[0.07]", selected && "text-fg")}
              onClick={() => void choose(choice.mode)}
            >
              <ChoiceIcon
                size={13}
                weight={selected ? "fill" : "regular"}
                className={cn(
                  "shrink-0",
                  choice.mode === "ship" ? "text-amber-300/90" : choice.mode === "watch" ? "text-sky-300/90" : "text-fg/45",
                )}
                aria-hidden
              />
              <span className="font-medium">{choice.label}</span>
              <span className="ml-auto text-[10.5px] text-muted-fg/55">{choice.hint}</span>
              <Check size={10} weight="bold" className={cn("shrink-0 text-fg/70", !selected && "invisible")} aria-hidden />
            </button>
          );
        })}
        {status || error ? (
          <>
            <div className={MENU_SEPARATOR_CLASS} />
            <div className={cn("px-2 pb-1 pt-0.5 text-[10.5px] leading-snug", error ? "text-amber-200/80" : "text-muted-fg/55")}>
              {error ?? status}
            </div>
          </>
        ) : null}
      </AnchoredMenu>
    </>
  );
}
