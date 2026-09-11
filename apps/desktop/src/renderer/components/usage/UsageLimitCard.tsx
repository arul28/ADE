/**
 * One limit window, read as headroom.
 *
 * The card answers three questions in the order they are asked: how much is
 * left, when does more arrive, and which account is spending it. The big number
 * is the pooled headroom across accounts; the line beneath is the next reset
 * that actually returns something; the right-hand row is one segment per
 * account, each with its own chip, fill, and countdown.
 *
 * Colour semantics are unchanged — `usagePressureColor` still decides whether a
 * number is calm, warm, or hot, and it is fed consumption (100 − left) so a
 * nearly-empty account reads hot exactly as it did on the old pace bars.
 */
import { useCallback, useEffect, useId, useState } from "react";
import type React from "react";
import { ArrowClockwise, ArrowSquareOut } from "@phosphor-icons/react";
import type { ThemeId } from "../../state/appStore";
import { openExternalUrl } from "../../lib/openExternal";
import { cn } from "../ui/cn";
import { accountAccentColor } from "./providerColors";
import { PacePill } from "./UsagePaceBar";
import type { LimitCard, LimitSegment } from "./usageLimitModel";
import {
  USAGE_NUMERIC_CLASS,
  USAGE_OVERLAY_CLASS,
  USAGE_TEXT,
  usagePressureColor,
} from "./usageDesign";
import {
  formatCountdown,
  formatResetClock,
  paceVisual,
  trendSentence,
} from "./usageWindowFormat";

/**
 * Where a segment's details panel hangs.
 *
 * The panel is 248px wide inside a 420px popover, so a centred panel on the
 * rightmost segment overhung the popover's edge: the text was clipped and the
 * whole popover gained a horizontal scrollbar. Edge segments anchor to their
 * own edge instead.
 */
type PopoverAlign = "left" | "center" | "right";

const POPOVER_ALIGN_CLASS: Record<PopoverAlign, string> = {
  left: "left-0",
  center: "left-1/2 -translate-x-1/2",
  right: "right-0",
};

/**
 * The unused remainder of a segment, drawn as a hatch rather than a flat tint.
 *
 * A flat second tone reads as a second value; the hatch reads as "nothing here
 * yet", which is what the empty part of a headroom bar means.
 */
const HATCH_STYLE = {
  backgroundImage:
    "repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-muted-fg) 26%, transparent) 0 1px, transparent 1px 6px)",
} as const;

export function UsageLimitCard({
  card,
  theme,
  fallbackAccountUrl,
  nowMs,
  reducedMotion,
}: {
  card: LimitCard;
  theme: ThemeId;
  /** Provider limits page for a host that sends no account directory. */
  fallbackAccountUrl?: string;
  nowMs: number;
  reducedMotion: boolean;
}) {
  const [openSegment, setOpenSegment] = useState<string | null>(null);
  // The pill sits beside the *pooled* number, so it has to describe the account
  // that actually governs it — the one with the least headroom, which is what
  // runs out first. Reading `segments[0]` instead put whichever account the
  // provider happened to list first next to a number it does not explain.
  const pace = paceVisual(
    card.segments.reduce<LimitSegment | null>(
      (worst, segment) => (!worst || segment.percentLeft < worst.percentLeft ? segment : worst),
      null,
    )?.window.pacing,
  );
  const left = Math.round(card.percentLeft);
  // Neutral until it is worth worrying about. The provider brand is already on
  // the group heading, and repeating it here put a third colour on a card that
  // is trying to say "this account, this much left" in one accent per account.
  const tone = usagePressureColor(card.percentUsed, "var(--color-fg)");

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className={cn(USAGE_TEXT.detail, "font-medium text-fg")}>{card.label}</span>
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(USAGE_TEXT.title, USAGE_NUMERIC_CLASS, "font-semibold")}
            style={{ color: tone }}
          >
            {left}%
          </span>
          <span className={cn(USAGE_TEXT.detail, "text-muted-fg")}>left</span>
          {pace ? <PacePill pace={pace} /> : null}
        </div>
        {card.forecast ? (
          <span className={cn(USAGE_TEXT.micro, USAGE_NUMERIC_CLASS, "text-muted-fg")}>
            <ArrowClockwise size={10} className="mr-1 inline align-[-1px]" aria-hidden />
            +{Math.round(card.forecast.percent)}% in {formatCountdown(card.forecast.resetsInMs)}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 items-stretch gap-1.5">
        {card.segments.map((segment, index) => {
          // One identity per segment: the React key and the open/close state
          // were three separate spellings of the same question.
          const segmentId = segment.account?.id ?? String(index);
          return (
          <AccountSegment
            key={segmentId}
            card={card}
            segment={segment}
            theme={theme}
            fallbackAccountUrl={fallbackAccountUrl}
            nowMs={nowMs}
            reducedMotion={reducedMotion}
            align={
              card.segments.length === 1 || index === 0
                ? "left"
                : index === card.segments.length - 1
                  ? "right"
                  : "center"
            }
            open={openSegment === segmentId}
            onOpenChange={(next) => setOpenSegment(next ? segmentId : null)}
          />
          );
        })}
      </div>
    </div>
  );
}

function AccountSegment({
  card,
  segment,
  theme,
  fallbackAccountUrl,
  nowMs,
  reducedMotion,
  align,
  open,
  onOpenChange,
}: {
  card: LimitCard;
  segment: LimitSegment;
  theme: ThemeId;
  fallbackAccountUrl?: string;
  nowMs: number;
  reducedMotion: boolean;
  align: PopoverAlign;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const panelId = useId();
  const accent = accountAccentColor(segment.account?.id ?? card.key, theme);
  const left = Math.round(segment.percentLeft);
  const fill = usagePressureColor(100 - segment.percentLeft, accent);
  const initials = segment.account?.initials ?? "··";
  const label = segment.account?.email ?? "this machine";

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  /**
   * Focus leaves the SEGMENT, not the button.
   *
   * The popover renders after the button in DOM order, so tabbing forward from
   * the segment moves focus INTO the popover — and a `blur` handler on the
   * button would unmount it mid-tab, making "Open limits" and the whole details
   * panel reachable by mouse only. Closing on the container's `focusout`, and
   * only when the next focus target is outside it, keeps the popover alive for
   * exactly as long as a keyboard user is inside it.
   */
  const onFocusOut = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const next = event.relatedTarget as Node | null;
      if (next && event.currentTarget.contains(next)) return;
      close();
    },
    [close],
  );
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <div
      className="relative min-w-0 flex-1"
      onMouseEnter={() => onOpenChange(true)}
      onMouseLeave={close}
      onFocus={() => onOpenChange(true)}
      onBlur={onFocusOut}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${card.label} · ${label}: ${left}% left`}
        onClick={() => onOpenChange(!open)}
        className={cn(
          "relative flex h-7 w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-left",
          "focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-fg/40",
        )}
        style={HATCH_STYLE}
      >
        {/* Left-anchored, and only rounded on the right once it reaches the end.
            A fill narrower than the initials chip — an account with 7% left —
            was drawn as a fully rounded lozenge, which peeked out on both sides
            of the chip and read as a stray graphic rather than a short bar. */}
        <span
          className={cn(
            "absolute inset-y-0 left-0 rounded-l-md",
            segment.percentLeft >= 99 && "rounded-r-md",
          )}
          style={{
            width: `${segment.percentLeft}%`,
            background: `color-mix(in srgb, ${fill} 30%, transparent)`,
            transition: reducedMotion ? undefined : "width 420ms cubic-bezier(0.22,1,0.36,1)",
          }}
          aria-hidden
        />
        <span
          className={cn(
            USAGE_TEXT.micro,
            "relative z-[1] flex h-4 shrink-0 items-center rounded px-1 font-semibold leading-none",
          )}
          style={{ color: accent, background: `color-mix(in srgb, ${accent} 18%, transparent)` }}
          aria-hidden
        >
          {initials}
        </span>
        <span className={cn(USAGE_TEXT.micro, USAGE_NUMERIC_CLASS, "relative z-[1] font-medium text-fg")}>
          {left}%
        </span>
        {/* The countdown lands wherever the fill happens to end, so it carries
            its own plate — without one it straddles the fill/hatch seam and
            half of it is unreadable at any interesting percentage. */}
        <span
          className="relative z-[1] ml-auto flex shrink-0 items-center gap-1 rounded px-1 py-[1px] text-muted-fg"
          style={{
            background:
              "color-mix(in srgb, var(--ade-shell-surface, var(--color-surface-raised)) 88%, transparent)",
          }}
        >
          <ArrowClockwise size={10} aria-hidden />
          <span className={cn(USAGE_TEXT.micro, USAGE_NUMERIC_CLASS)}>
            {formatCountdown(segment.resetsInMs)}
          </span>
        </span>
      </button>

      {open ? (
        <SegmentPopover
          id={panelId}
          card={card}
          segment={segment}
          accountUrl={segment.account?.url ?? fallbackAccountUrl}
          nowMs={nowMs}
          align={align}
        />
      ) : null}
    </div>
  );
}

function SegmentPopover({
  id,
  card,
  segment,
  accountUrl,
  nowMs,
  align,
}: {
  id: string;
  card: LimitCard;
  segment: LimitSegment;
  accountUrl?: string;
  nowMs: number;
  align: PopoverAlign;
}) {
  const account = segment.account;
  const resetClock = formatResetClock(segment.window.resetsAt);
  // The projection the old pace bar printed under every bar. It belongs to one
  // account's window, so it lives where that account's details are.
  const trend = trendSentence(segment.window.pacing, nowMs);
  const via = account?.machines
    .map((machine) => machine.label)
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      id={id}
      role="dialog"
      aria-label={`${card.label} details`}
      className={cn(
        // `bg-surface-raised` is translucent on the light theme, and this panel
        // floats over the rows beneath it — they read straight through. The
        // overlay token is the one every other floating usage readout uses.
        "absolute top-[calc(100%+6px)] z-20 w-[248px] p-3",
        USAGE_OVERLAY_CLASS,
        POPOVER_ALIGN_CLASS[align],
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5 pb-2">
        <span className={cn(USAGE_TEXT.detail, "font-semibold text-fg")}>{card.label}</span>
        <span className={cn(USAGE_TEXT.micro, "truncate text-muted-fg")}>
          {account?.email ?? "This machine"}
        </span>
      </div>
      <dl className="flex flex-col gap-1 border-t border-separator pt-2">
        {account?.plan ? <PopoverRow label="Plan" value={account.plan} /> : null}
        {via ? <PopoverRow label="Via" value={via} /> : null}
        <PopoverRow label="Left" value={`${Math.round(segment.percentLeft)}%`} numeric />
        <PopoverRow
          label="Resets"
          value={
            resetClock
              ? `${resetClock} · in ${formatCountdown(segment.resetsInMs)}`
              : `in ${formatCountdown(segment.resetsInMs)}`
          }
          numeric
        />
        {trend ? <PopoverRow label="Pace" value={trend} /> : null}
        {segment.restoresPercentOfPool >= 0.5 ? (
          <PopoverRow
            label="Restores"
            value={`+${Math.round(segment.restoresPercentOfPool)}% of pool`}
            numeric
          />
        ) : null}
      </dl>
      {accountUrl ? (
        <button
          type="button"
          onClick={() => openExternalUrl(accountUrl)}
          className={cn(
            USAGE_TEXT.micro,
            "mt-2 inline-flex w-full items-center justify-center gap-1 rounded-md border border-separator px-2 py-1 text-muted-fg hover:bg-muted hover:text-fg",
          )}
        >
          <ArrowSquareOut size={11} aria-hidden />
          Open limits
        </button>
      ) : null}
    </div>
  );
}

/**
 * A label/value row. The value wraps rather than truncates: every non-numeric
 * value here is a sentence or a machine list, and an ellipsis in the middle of
 * "runs dry ~Sun 3pm" hides the only part worth reading.
 */
function PopoverRow({ label, value, numeric }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cn(USAGE_TEXT.micro, "shrink-0 text-muted-fg")}>{label}</dt>
      <dd
        className={cn(
          USAGE_TEXT.micro,
          numeric && USAGE_NUMERIC_CLASS,
          "min-w-0 break-words text-right text-fg",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
