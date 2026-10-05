import React, { useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, Check, Eye, EyeSlash, RocketLaunch } from "@phosphor-icons/react";
import type { PrChatWatchSummary, PrWatchMode } from "../../../shared/prWatch";
import type { OpenProjectBinding, PrSummary } from "../../../shared/types";
import { relativeWhen } from "../../lib/format";
import { showToast } from "../app/toast/toastStore";
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

/** One short line under the choices, only while a watch is on. */
function statusLine(watch: PrChatWatchSummary | null): string | null {
  if (!watch || watch.status === "stopped") return null;
  if (watch.holding) return "Holding for CI and reviews";
  const told = watch.lastToldAt ? relativeWhen(watch.lastToldAt) : null;
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
  // The watch could not be read: the pill cannot claim Off, so Off still sends.
  const [unknown, setUnknown] = useState(false);
  // Bumped by every read and write; an older read that lands late is dropped.
  const requestSeqRef = useRef(0);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const runtimePinRef = useRef(runtimePin);
  runtimePinRef.current = runtimePin;
  const runtimePinKey = runtimePin?.key ?? null;
  const prId = pr.id;
  const terminal = pr.state === "merged" || pr.state === "closed";

  const load = useCallback(async () => {
    if (typeof window.ade.prs.getChatWatches !== "function") return;
    const seq = ++requestSeqRef.current;
    try {
      const watches = await window.ade.prs.getChatWatches({ sessionId }, runtimePinRef.current);
      if (seq !== requestSeqRef.current) return;
      setWatch(watches.find((entry) => entry.prId === prId) ?? null);
      setUnknown(false);
    } catch {
      if (seq === requestSeqRef.current) setUnknown(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prId, sessionId, runtimePinKey]);

  useEffect(() => {
    setWatch(null);
    setUnknown(false);
    void load();
  }, [load]);

  useEffect(() => {
    const unsubscribe = window.ade.prs.onEvent((event) => {
      if (event.type !== "pr-chat-watch-changed") return;
      if (event.sessionId !== sessionId || event.prId !== prId) return;
      requestSeqRef.current += 1;
      setUnknown(false);
      setWatch(event.watch && event.watch.status !== "stopped" ? event.watch : null);
    }, runtimePinRef.current);
    return () => unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prId, sessionId, runtimePinKey]);

  const choose = useCallback(async (mode: PrWatchMode | null) => {
    setOpen(false);
    const current = watch && watch.status !== "stopped" ? watch.mode : null;
    if (mode === current && !unknown) return;
    setBusy(true);
    const seq = ++requestSeqRef.current;
    try {
      const next = await window.ade.prs.setChatWatch({ prId, sessionId, mode }, runtimePinRef.current);
      if (seq === requestSeqRef.current) {
        setWatch(next && next.status !== "stopped" ? next : null);
        setUnknown(false);
      }
    } catch (cause) {
      showToast({
        title: `Couldn't change PR #${pr.githubPrNumber} watch`,
        message: cause instanceof Error ? cause.message : String(cause),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }, [pr.githubPrNumber, prId, sessionId, unknown, watch]);

  if (terminal || typeof window.ade.prs.setChatWatch !== "function") return null;

  const active = watch && watch.status !== "stopped" ? watch : null;
  const mode = active?.mode ?? null;
  const Icon = modeIcon(mode);
  const status = unknown ? "Couldn't read the watch. Pick one to set it." : statusLine(active);
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
        title={status ? `${label} · ${status}` : `${label} #${pr.githubPrNumber}`}
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
          const selected = !unknown && choice.mode === mode;
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
        {status ? (
          <>
            <div className={MENU_SEPARATOR_CLASS} />
            <div className="px-2 pb-1 pt-0.5 text-[10.5px] leading-snug text-muted-fg/55">{status}</div>
          </>
        ) : null}
      </AnchoredMenu>
    </>
  );
}
