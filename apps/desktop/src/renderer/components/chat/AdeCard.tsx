import { useEffect, useState } from "react";
import {
  ArrowSquareOut,
  CaretRight,
  CheckCircle,
  Circle,
  DotsThree,
  File as FileIcon,
  Info,
  SpinnerGap,
  XCircle,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { formatSubagentDurationMs } from "../../lib/format";
import { navigateToAppTarget } from "../../lib/openExternal";
import { CHAT_TRANSCRIPT_GLASS_CARD_CLASS } from "./chatTranscriptChrome";
import { chatChipToneClass } from "./chatSurfaceTheme";
import {
  adeCardDeeplink,
  adeCardFallbackText,
  adeCardProgressTotal,
  isKnownAdeCardVariant,
  normalizeAdeCardTone,
  type AdeCardIcon,
  type AdeCardPayload,
  type AdeCardTone,
} from "../../../shared/adeCard";
import type { ChatSurfaceChipTone } from "../../../shared/types";

/**
 * The `ade_card` renderer.
 *
 * Structurally and stylistically a sibling of `SubagentActivityCards.tsx` — same
 * `max-w-[min(100%,70ch)]` shell, same `calc(var(--chat-radius-card)-6px)` radius,
 * same `--chat-font-size`-relative type scale, same one-line ` · `-joined status,
 * same whole-card-clickable-with-identical-inner-markup pattern. It also inherits
 * that file's tone policy: THERE IS NO RED HERE. A failed thing is amber, and the
 * detail lives in the row's `detail` column rather than a red error block.
 *
 * A variant this build does not recognize renders `fallbackText` + the deeplink
 * instead of nothing — that degradation is the reason one wire contract can ship
 * across three independent release trains.
 */

const TONE_TEXT_CLASS: Record<AdeCardTone, string> = {
  neutral: "text-fg/45",
  accent: "text-[color:var(--chat-accent)]",
  success: "text-emerald-300/80",
  warning: "text-amber-200/85",
};

const TONE_CHIP_TONE: Record<AdeCardTone, ChatSurfaceChipTone> = {
  neutral: "muted",
  accent: "accent",
  success: "success",
  warning: "warning",
};

/** Progress-bar segment fills. Failure is amber, per the house policy above. */
const PROGRESS_SEGMENT_CLASS: Record<"passed" | "failed" | "running" | "queued", string> = {
  passed: "bg-emerald-400/70",
  failed: "bg-amber-400/80",
  running: "bg-[color:var(--chat-accent)]",
  queued: "bg-white/12",
};

function RowGlyph({ icon, tone }: { icon: AdeCardIcon | undefined; tone: AdeCardTone }) {
  const className = cn("shrink-0", TONE_TEXT_CLASS[tone]);
  switch (icon) {
    case "pass":
      return <CheckCircle size={11} weight="bold" className="shrink-0 text-emerald-400/85" aria-hidden />;
    case "fail":
      return <XCircle size={11} weight="bold" className="shrink-0 text-amber-300/85" aria-hidden />;
    case "running":
      return <SpinnerGap size={11} weight="bold" className="shrink-0 motion-safe:animate-spin text-[color:var(--chat-accent)]" aria-hidden />;
    case "queued":
      return <Circle size={9} weight="regular" className="shrink-0 text-fg/30" aria-hidden />;
    case "skipped":
      return <DotsThree size={11} weight="bold" className="shrink-0 text-fg/30" aria-hidden />;
    case "file":
      return <FileIcon size={11} weight="regular" className={className} aria-hidden />;
    case "info":
    default:
      return <Info size={11} weight="regular" className={className} aria-hidden />;
  }
}

function liveElapsedText(startedAt: string | null | undefined, nowMs: number): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  return formatSubagentDurationMs(Math.max(0, nowMs - start));
}

export function AdeCard({
  card,
  onAction,
}: {
  card: AdeCardPayload;
  /** Host-specific dispatcher. The reserved `open` action is handled locally. */
  onAction?: (actionId: string) => void;
}) {
  const isLive = card.state === "live";

  // Elapsed ticks only while live; the interval is torn down the moment the card
  // goes terminal (mirrors SubagentSpawnCard).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!isLive) return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [isLive]);

  const known = isKnownAdeCardVariant(card.variant);
  const deeplink = adeCardDeeplink(card.navTarget);
  const navigable = Boolean(card.navTarget);

  const elapsed = isLive
    ? liveElapsedText(card.createdAt, nowMs)
    : formatSubagentDurationMs(
        card.createdAt && card.updatedAt
          ? Math.max(0, Date.parse(card.updatedAt) - Date.parse(card.createdAt))
          : null,
      );

  const metrics = card.metrics ?? [];
  const rows = card.rows ?? [];
  const actions = (card.actions ?? []).filter((action) => (
    (action.id === "open" && navigable) || onAction != null
  ));
  const progress = card.progress ?? null;
  const progressTotal = adeCardProgressTotal(progress);
  const hasWarning = metrics.some((metric) => normalizeAdeCardTone(metric.tone) === "warning")
    || rows.some((row) => normalizeAdeCardTone(row.tone) === "warning")
    || (progress?.failed ?? 0) > 0;

  const cardShell = cn(
    "w-full max-w-[min(100%,70ch)] overflow-hidden rounded-[calc(var(--chat-radius-card)-6px)] border transition-colors",
    hasWarning
      ? "border-amber-400/16 bg-amber-400/[0.05] hover:border-amber-300/26"
      : "border-[color:color-mix(in_srgb,var(--chat-accent)_16%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_6%,transparent)] hover:border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)]",
  );

  const statusParts = [
    isLive ? "running" : "done",
    card.subtitle?.trim() || null,
    elapsed,
  ].filter((part): part is string => Boolean(part));

  const openCard = () => {
    if (card.navTarget) navigateToAppTarget(card.navTarget);
  };

  // Unknown variant → fallbackText + deeplink. Never an empty row.
  if (!known) {
    const text = adeCardFallbackText(card);
    return (
      <div className={cn(CHAT_TRANSCRIPT_GLASS_CARD_CLASS, "w-full max-w-[min(100%,70ch)] px-3.5 py-2.5")}>
        <div className="font-sans text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/62">
          {text}
        </div>
        {navigable ? (
          <button
            type="button"
            onClick={openCard}
            title={deeplink ?? "Open"}
            className="mt-1 inline-flex items-center gap-1 font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-[color:var(--chat-accent)] transition-opacity hover:opacity-80"
          >
            <ArrowSquareOut size={11} weight="bold" aria-hidden />
            {deeplink ?? "Open"}
          </button>
        ) : null}
      </div>
    );
  }

  // Built ONCE and rendered byte-identically whether or not the card navigates —
  // the navigable/passive split must never change the layout it wraps.
  const inner = (
    <>
      {progress && progressTotal > 0 ? (
        <div className="flex h-[2px] w-full overflow-hidden" aria-hidden>
          {(["passed", "failed", "running", "queued"] as const).map((bucket) => {
            const value = Math.max(0, progress[bucket]);
            if (value <= 0) return null;
            return (
              <span
                key={bucket}
                className={PROGRESS_SEGMENT_CLASS[bucket]}
                style={{ flex: `${value} 0 0%` }}
              />
            );
          })}
        </div>
      ) : null}

      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center self-start pt-0.5">
          {isLive ? (
            <SpinnerGap size={13} weight="bold" className="motion-safe:animate-spin text-[color:var(--chat-accent)]" aria-hidden />
          ) : hasWarning ? (
            <XCircle size={13} weight="bold" className="text-amber-300/85" aria-hidden />
          ) : (
            <CheckCircle size={13} weight="bold" className="text-[color:var(--chat-accent)]" aria-hidden />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold text-fg/82">
              {card.title}
            </span>
            {navigable ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/40">
                open
                <CaretRight size={11} weight="bold" aria-hidden />
              </span>
            ) : null}
          </div>

          {statusParts.length ? (
            <div className="mt-1 min-w-0 truncate whitespace-nowrap font-mono text-[length:calc(var(--chat-font-size)*10/14)] tabular-nums text-fg/45">
              {statusParts.join(" · ")}
            </div>
          ) : null}

          {metrics.length ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {metrics.map((metric) => {
                const tone = normalizeAdeCardTone(metric.tone);
                return (
                  <span
                    key={`${metric.label}:${metric.value}`}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[length:calc(var(--chat-font-size)*9.5/14)] tabular-nums",
                      chatChipToneClass(TONE_CHIP_TONE[tone]),
                    )}
                  >
                    <span className="font-bold">{metric.value}</span>
                    <span className="opacity-70">{metric.label}</span>
                  </span>
                );
              })}
            </div>
          ) : null}

          {rows.length ? (
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {rows.map((row, index) => {
                const tone = normalizeAdeCardTone(row.tone);
                return (
                  <li
                    key={`${index}:${row.text}`}
                    className="flex min-w-0 items-center gap-1.5 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)]"
                  >
                    <RowGlyph icon={row.icon} tone={tone} />
                    <span className={cn("min-w-0 flex-1 truncate", TONE_TEXT_CLASS[tone])}>{row.text}</span>
                    {row.detail?.trim() ? (
                      <span
                        className="shrink-0 truncate font-mono text-[length:calc(var(--chat-font-size)*9.5/14)] tabular-nums text-fg/32"
                        title={row.detail}
                      >
                        {row.detail}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>

      {actions.length ? (
        <div
          className={cn(
            "flex flex-wrap items-center gap-1.5 border-t px-3.5 py-2",
            hasWarning ? "border-amber-300/10" : "border-white/[0.05]",
          )}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={(clickEvent) => {
                // The whole card is clickable; an action must not also navigate.
                clickEvent.stopPropagation();
                if (action.id === "open" && card.navTarget) {
                  openCard();
                  return;
                }
                onAction?.(action.id);
              }}
              className={cn(
                "inline-flex items-center rounded-md border px-2 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*10/14)] transition-colors",
                action.kind === "primary"
                  ? "border-[color:color-mix(in_srgb,var(--chat-accent)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-[color:var(--chat-accent)] hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)]"
                  : "border-white/[0.08] bg-white/[0.03] text-fg/55 hover:text-fg/75",
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );

  if (navigable) {
    // `div role="button"` rather than a real `<button>`: the actions row nests
    // buttons, and a button inside a button is invalid markup that React and
    // the browser both mishandle.
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={openCard}
        onKeyDown={(keyEvent) => {
          // Nested action buttons handle their own keyboard activation. Letting
          // their Enter/Space keydown bubble here would also navigate the whole
          // card after firing the action.
          if (keyEvent.target !== keyEvent.currentTarget) return;
          if (keyEvent.key === "Enter" || keyEvent.key === " ") {
            keyEvent.preventDefault();
            openCard();
          }
        }}
        title={deeplink ?? "Open"}
        className={cn(cardShell, "cursor-pointer text-left")}
      >
        {inner}
      </div>
    );
  }

  return <div className={cardShell}>{inner}</div>;
}
