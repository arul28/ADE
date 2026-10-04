import React, { useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, Check, Eye, EyeSlash, RocketLaunch } from "@phosphor-icons/react";
import type { PrChatWatchSummary, PrWatchMode } from "../../../shared/prWatch";
import type { OpenProjectBinding, PrSummary } from "../../../shared/types";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { cn } from "../ui/cn";
import { Z_LAYERS } from "../ui/zLayers";

type Choice = { mode: PrWatchMode | null; label: string; description: string };

const CHOICES: readonly Choice[] = [
  {
    mode: null,
    label: "Off",
    description: "PR events show as cards. The agent is not woken.",
  },
  {
    mode: "watch",
    label: "Watch",
    description: "Wake the agent once per change: a failed check, checks passing, new comments, a conflict, a merge.",
  },
  {
    mode: "ship",
    label: "Ship",
    description: "Watch, plus standing orders to land it: fix CI and review in one push, rebase only on a conflict, merge when green. Waits for CI and review bots to finish.",
  },
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

function statusLine(watch: PrChatWatchSummary | null): string | null {
  if (!watch || watch.status === "stopped") return null;
  if (watch.holding) return "Holding news until CI and the review bots finish";
  const told = relativeTime(watch.lastToldAt);
  if (watch.lastToldSummary && told) return `Last told the agent: ${watch.lastToldSummary} · ${told}`;
  return "Nothing new since it started";
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
  const Icon = mode === "ship" ? RocketLaunch : mode === "watch" ? Eye : EyeSlash;
  const label = mode === "ship" ? "Shipping" : mode === "watch" ? "Watching" : "Watch";
  const status = statusLine(active);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="chat-header-pr-watch"
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-sans text-[10px] font-medium transition-all disabled:opacity-40",
          mode === "ship"
            ? "border-amber-400/30 bg-amber-500/[0.08] text-amber-100/90 hover:bg-amber-500/[0.12]"
            : mode === "watch"
              ? "border-sky-400/30 bg-sky-500/[0.08] text-sky-100/90 hover:bg-sky-500/[0.12]"
              : "border-white/[0.06] bg-white/[0.02] text-fg/50 hover:border-violet-400/15 hover:bg-violet-500/[0.04] hover:text-fg/80",
        )}
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title={error ?? status ?? `Have the agent woken when PR #${pr.githubPrNumber} changes`}
      >
        <Icon size={11} weight={mode ? "fill" : "regular"} aria-hidden />
        <span>{label}</span>
        {active?.holding ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300/80" aria-label="holding" /> : null}
        <CaretDown size={8} weight="bold" className="opacity-60" aria-hidden />
      </button>
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        zIndex={Z_LAYERS.popover}
        role="menu"
        aria-label={`Watch PR #${pr.githubPrNumber}`}
        className="w-[300px] rounded-lg border border-white/[0.10] bg-[#17171b] p-1.5 shadow-2xl shadow-black/30"
      >
        <div className="px-2 pb-1.5 pt-1 text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-fg/50">
          PR #{pr.githubPrNumber} · tell the agent when it changes
        </div>
        {CHOICES.map((choice) => {
          const selected = choice.mode === mode;
          const ChoiceIcon = choice.mode === "ship" ? RocketLaunch : choice.mode === "watch" ? Eye : EyeSlash;
          return (
            <button
              key={choice.label}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]",
                selected && "bg-white/[0.04]",
              )}
              onClick={() => void choose(choice.mode)}
            >
              <ChoiceIcon size={13} weight={selected ? "fill" : "regular"} className="mt-0.5 shrink-0 text-fg/70" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-semibold text-fg/85">{choice.label}</span>
                <span className="block text-[10px] leading-snug text-muted-fg/60">{choice.description}</span>
              </span>
              {selected ? <Check size={11} weight="bold" className="mt-0.5 shrink-0 text-emerald-300/80" aria-hidden /> : null}
            </button>
          );
        })}
        {status || active?.armedBy === "agent" || error ? (
          <div className="mt-1 border-t border-white/[0.06] px-2 pb-0.5 pt-1.5 text-[10px] leading-snug text-muted-fg/55">
            {error ? <div className="text-amber-200/80">{error}</div> : null}
            {status ? <div>{status}</div> : null}
            {active?.armedBy === "agent" ? <div>Turned on by the agent.</div> : null}
          </div>
        ) : null}
      </AnchoredMenu>
    </>
  );
}
