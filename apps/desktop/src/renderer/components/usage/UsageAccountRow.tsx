/**
 * One account, one row: its email, then its windows as stacked bars.
 *
 * The row used to open with the provider name, the account's nickname and the
 * plan — "Claude · Work jo.martin@example.com · Claude Pro" — which is four
 * identifiers for one login on a 420px popover. The provider is already the
 * box this row sits in, and a nickname is a thing you chose, not a thing you
 * can be billed as. The email is the account.
 *
 * The windows stack rather than sit side by side. Two meters across a 400px
 * popover left each one narrower than the words inside it, and the third
 * (Claude's OAuth-apps allowance) wrapped to its own line anyway — so the row
 * was already one-and-a-half rows tall and pretending to be one.
 *
 * Colour: the bar follows its headroom (`usageHeadroomColor` — green, yellow,
 * red as it runs out), the same rule as the header rings, for every provider.
 * Accounts get no colour of their own — hashing an account id into a palette
 * is what drew a Claude window in Gemini's blue.
 *
 * The tinted fill is the HEADROOM and the number says the same thing in words.
 * What has been spent is left plain: it was drawn as a diagonal hatch, which at
 * 20px tall read as a rendering artefact rather than as emptiness.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ViewportOverlayHost } from "../ui/ViewportOverlayHost";
import type React from "react";
import { ArrowClockwise, ArrowSquareOut } from "@phosphor-icons/react";
import type { UsageProvider } from "../../../shared/types";
import { openExternalUrl } from "../../lib/openExternal";
import {
  RESET_CREDIT_OUTCOME_TEXT,
  resetCreditOutcomeText,
} from "../../../shared/usageResetCredit";
import { cn } from "../ui/cn";
import { usageProviderLogo } from "../terminals/ToolLogos";
import { PacePill } from "./UsagePaceBar";
import type { AccountLimitRow, AccountWindowCell } from "./usageLimitModel";
import {
  USAGE_NUMERIC_CLASS,
  USAGE_OVERLAY_CLASS,
  USAGE_TEXT,
  usageHeadroomColor,
} from "./usageDesign";
import {
  formatCountdown,
  formatResetClock,
  paceOutlook,
  paceVisual,
  shortWindowLabel,
} from "./usageWindowFormat";

/**
 * Where a meter's details panel hangs.
 *
 * The panel is wider than half the popover, so it always hangs from its bar's
 * left edge and is clamped to the viewport — a centred panel overhung the
 * popover's edge and gave the whole thing a horizontal scrollbar.
 */
type PopoverAlign = "left" | "center" | "right";

/** The panel's own width, in px. Fixed, so its placement can be computed. */
const POPOVER_WIDTH = 300;
/** Breathing room kept between the panel and the window edges. */
const POPOVER_MARGIN = 8;
/** Gap between the meter and the panel. */
const POPOVER_OFFSET = 6;
/**
 * How long the panel stays open while the pointer crosses that gap.
 *
 * The panel is portalled to `document.body`, so leaving the meter fires
 * `mouseleave` before the pointer arrives. Closing in that instant is why the
 * link could not be hovered.
 */
const POPOVER_POINTER_GRACE_MS = 180;

/**
 * Where the panel goes, in viewport coordinates.
 *
 * It is rendered in a portal on `document.body` because this row also lives
 * inside the header usage popup, which is a ~400px tall scroll container: an
 * absolutely positioned panel taller than that container was simply cut off,
 * taking "Open limits" with it. Fixed coordinates computed from the meter keep
 * the same visual anchoring without inheriting anyone's clipping.
 */
function popoverPosition(
  anchor: DOMRect,
  align: PopoverAlign,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const panelHeight = panel.height;
  const panelWidth = panel.width;
  const rawLeft = align === "left"
    ? anchor.left
    : align === "right"
      ? anchor.right - panelWidth
      : anchor.left + anchor.width / 2 - panelWidth / 2;
  const left = Math.min(
    Math.max(POPOVER_MARGIN, rawLeft),
    Math.max(POPOVER_MARGIN, viewport.width - panelWidth - POPOVER_MARGIN),
  );
  const below = anchor.bottom + POPOVER_OFFSET;
  // Flip above when the panel would run off the bottom and there is more room
  // up there; otherwise clamp, so a viewport shorter than the panel still shows
  // its top rather than nothing.
  const fitsBelow = below + panelHeight + POPOVER_MARGIN <= viewport.height;
  const above = anchor.top - POPOVER_OFFSET - panelHeight;
  const top = fitsBelow || above < POPOVER_MARGIN
    ? Math.min(below, Math.max(POPOVER_MARGIN, viewport.height - panelHeight - POPOVER_MARGIN))
    : above;
  return { top, left };
}

/** What spending a reset credit did, in the user's words. */
/**
 * The meter's colour, as a custom property.
 *
 * The bar tint and the percentage are the same colour at two opacities; naming
 * it once on the button is what keeps them in step, and what lets a test read
 * the resolved brand colour back out of the DOM.
 */
const FILL_VAR = "--usage-fill";

/** How long the outcome sits on the row before the row goes quiet again. */
const RESET_OUTCOME_MS = 4_000;

export function ProviderMark({
  provider,
  size = 14,
  dim,
}: {
  provider: UsageProvider;
  size?: number;
  dim?: boolean;
}) {
  const Logo = usageProviderLogo(provider);
  return <Logo size={size} className={cn("shrink-0 text-fg", dim && "opacity-55")} />;
}

export function UsageAccountRow({
  row,
  providerTitle,
  fallbackAccountUrl,
  fallbackEmail,
  nowMs,
  reducedMotion,
  dim,
}: {
  row: AccountLimitRow;
  /** "OAuth · 2m ago" — where this reading came from, on the account's title. */
  providerTitle?: string;
  /** Limits page for a host that sends no account directory. */
  fallbackAccountUrl?: string;
  /**
   * The login the host says it polled last, for a host that sends no account
   * directory at all. It is the only name available there, and it is the right
   * one: with no directory there is exactly one account per provider.
   */
  fallbackEmail?: string | null;
  nowMs: number;
  reducedMotion: boolean;
  dim?: boolean;
}) {
  const account = row.account;
  const [openCell, setOpenCell] = useState<string | null>(null);
  const [spending, setSpending] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!outcome) return;
    const timer = window.setTimeout(() => {
      if (mountedRef.current) setOutcome(null);
    }, RESET_OUTCOME_MS);
    return () => window.clearTimeout(timer);
  }, [outcome]);

  const accountId = account?.id;
  const spendResetCredit = useCallback(async () => {
    if (!accountId) return;
    setSpending(true);
    setOutcome(null);
    try {
      // Read the bridge at click time: the web client and older preloads do not
      // expose it, and the button is only offered when they do.
      const consume = window.ade?.usage?.consumeResetCredit;
      const result = consume ? await consume({ accountId }) : null;
      if (mountedRef.current) setOutcome(resetCreditOutcomeText(result));
    } catch {
      if (mountedRef.current) setOutcome(RESET_CREDIT_OUTCOME_TEXT.failure);
    } finally {
      if (mountedRef.current) setSpending(false);
    }
  }, [accountId]);

  const email = account?.email ?? fallbackEmail ?? undefined;
  const identity = email ?? account?.label ?? "This machine";
  const hasCredit = (account?.resetCredits?.availableCount ?? 0) > 0
    && typeof window.ade?.usage?.consumeResetCredit === "function";

  /**
   * The pacing pill, read off the window with the LEAST headroom.
   *
   * It describes the account, so it has to describe the window that will run
   * out first — the one that decides when this login stops working. Reading
   * `cells[0]` put the 5-hour window's pacing next to a weekly bar that was
   * nowhere near it.
   */
  const tightest = row.cells.reduce<AccountWindowCell | null>(
    (worst, cell) => (!worst || cell.segment.percentLeft < worst.segment.percentLeft ? cell : worst),
    null,
  );
  const pace = paceVisual(tightest?.segment.window.pacing);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* Only the email. See the note at the top of this file. */}
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(USAGE_TEXT.detail, "min-w-0 flex-1 truncate font-medium text-fg", dim && "opacity-70")}
          title={providerTitle ? `${identity} · ${providerTitle}` : identity}
        >
          {identity}
        </span>
        {/* The pace line, back outside the details panel where it was legible
            without hovering anything. */}
        {pace ? <PacePill pace={pace} /> : null}
        {hasCredit ? (
          <button
            type="button"
            onClick={() => void spendResetCredit()}
            disabled={spending}
            title={
              account?.resetCredits?.nextExpiresAt
                ? `Clears this account's windows now. Next credit expires ${formatResetClock(account.resetCredits.nextExpiresAt) ?? "later"}.`
                : "Clears this account's windows now."
            }
            className={cn(
              USAGE_TEXT.micro,
              "inline-flex shrink-0 items-center gap-1 rounded border border-separator px-1.5 py-[1px]",
              "font-medium text-muted-fg hover:bg-muted hover:text-fg disabled:opacity-50",
            )}
          >
            <ArrowClockwise size={10} aria-hidden className={spending ? "animate-spin motion-reduce:animate-none" : undefined} />
            Use reset
          </button>
        ) : null}
      </div>

      {/* Stacked, full width. Each bar carries its own name, its headroom and
          its reset clock, so none of them has to be read against a header. */}
      {row.cells.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1">
          {row.cells.map((cell) => (
            <WindowMeter
              key={cell.card.key}
              cell={cell}
              provider={row.provider}
              accountLabel={email ?? "this machine"}
              accountUrl={account?.url ?? fallbackAccountUrl}
              nowMs={nowMs}
              reducedMotion={reducedMotion}
              open={openCell === cell.card.key}
              onOpenChange={(next) => setOpenCell(next ? cell.card.key : null)}
            />
          ))}
        </div>
      ) : account ? (
        <span className={cn(USAGE_TEXT.micro, "text-muted-fg")}>No usage yet</span>
      ) : null}

      {outcome ? (
        <span role="status" className={cn(USAGE_TEXT.micro, "text-muted-fg")}>
          {outcome}
        </span>
      ) : null}
    </div>
  );
}

function WindowMeter({
  cell,
  provider,
  accountLabel,
  accountUrl,
  nowMs,
  reducedMotion,
  open,
  onOpenChange,
}: {
  cell: AccountWindowCell;
  provider: UsageProvider;
  accountLabel: string;
  accountUrl?: string;
  nowMs: number;
  reducedMotion: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const panelId = useId();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const { segment, card } = cell;
  const left = Math.round(segment.percentLeft);
  const fill = usageHeadroomColor(segment.percentLeft);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const closeTimerRef = useRef<number | null>(null);
  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current == null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  useEffect(() => clearCloseTimer, [clearCloseTimer]);
  const holdOpen = useCallback(() => {
    clearCloseTimer();
    onOpenChange(true);
  }, [clearCloseTimer, onOpenChange]);
  const releaseOpen = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => onOpenChange(false), POPOVER_POINTER_GRACE_MS);
  }, [clearCloseTimer, onOpenChange]);
  /**
   * Focus leaves the METER, not the button.
   *
   * The popover renders after the button in DOM order, so tabbing forward from
   * the meter moves focus INTO the popover — and a `blur` handler on the button
   * would unmount it mid-tab, making "Open limits" and the whole details panel
   * reachable by mouse only. Closing on the container's `focusout`, and only
   * when the next focus target is outside it, keeps the popover alive for
   * exactly as long as a keyboard user is inside it.
   */
  const onFocusOut = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const next = event.relatedTarget as Node | null;
      if (next && event.currentTarget.contains(next)) {
        clearCloseTimer();
        return;
      }
      // The panel is portalled to `document.body` so the header popup's scroll
      // container cannot clip it, which puts it outside this element in the
      // DOM even though it is inside it in the React tree. Tabbing into it is
      // still "staying in the meter", so it is checked by id.
      if (next && document.getElementById(panelId)?.contains(next)) {
        clearCloseTimer();
        return;
      }
      clearCloseTimer();
      close();
    },
    [clearCloseTimer, close, panelId],
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
      ref={anchorRef}
      className="relative w-full"
      onMouseEnter={holdOpen}
      onMouseLeave={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && document.getElementById(panelId)?.contains(next)) return;
        releaseOpen();
      }}
      onFocus={holdOpen}
      onBlur={onFocusOut}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${card.label} · ${accountLabel}: ${left}% left`}
        onClick={() => onOpenChange(!open)}
        /* `isolate` puts the fill in this button's own stacking context, so the
           absolutely positioned fill cannot paint past the clip — the corners
           that "escaped the radius" were the fill rendering over an ancestor
           that had the rounding but not the clip. */
        className={cn(
          "relative isolate flex h-[22px] w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md px-2 text-left",
          "bg-fg/[0.05]",
          "focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-fg/40",
        )}
        // One colour, named once: the bar tint and the number read the same
        // custom property, so they cannot drift apart.
        style={{ [FILL_VAR]: fill } as React.CSSProperties}
      >
        {/* The fill IS the headroom: it is the same quantity the number names,
            so a row reading "85% left" shows a bar that is 85% full. What is
            spent is simply the empty part of the track. */}
        <span
          className="absolute inset-y-0 left-0 rounded-md"
          style={{
            width: `${segment.percentLeft}%`,
            background: `color-mix(in srgb, var(${FILL_VAR}) 30%, transparent)`,
            transition: reducedMotion ? undefined : "width 420ms cubic-bezier(0.22,1,0.36,1)",
          }}
          aria-hidden
        />
        <span
          className={cn(USAGE_TEXT.micro, "relative z-[1] shrink-0 font-medium text-fg/75")}
          aria-hidden
        >
          {shortWindowLabel(segment.window)}
        </span>
        <span
          className={cn(USAGE_TEXT.micro, USAGE_NUMERIC_CLASS, "relative z-[1] font-semibold")}
          style={{ color: `var(${FILL_VAR})` }}
          aria-hidden
        >
          {left}%
        </span>
        <span className={cn(USAGE_TEXT.micro, "relative z-[1] shrink-0 text-muted-fg")} aria-hidden>
          left
        </span>
        {segment.window.resetsAt ? (
          <span
            className="relative z-[1] ml-auto flex shrink-0 items-center gap-0.5 text-muted-fg"
            aria-hidden
          >
            <ArrowClockwise size={9} />
            <span className={cn(USAGE_TEXT.micro, USAGE_NUMERIC_CLASS)}>
              {formatCountdown(segment.resetsInMs)}
            </span>
          </span>
        ) : null}
      </button>

      {open ? (
        <WindowPopover
          id={panelId}
          cell={cell}
          tone={fill}
          accountUrl={accountUrl}
          nowMs={nowMs}
          anchorRef={anchorRef}
          onPointerEnter={holdOpen}
          onPointerLeave={close}
        />
      ) : null}
    </div>
  );
}

function WindowPopover({
  id,
  cell,
  tone,
  accountUrl,
  nowMs,
  anchorRef,
  onPointerEnter,
  onPointerLeave,
}: {
  id: string;
  cell: AccountWindowCell;
  /** The meter's own resolved colour, so the panel matches the bar it came from. */
  tone: string;
  accountUrl?: string;
  nowMs: number;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const place = () => {
      const panelRect = panel.getBoundingClientRect();
      /* ADE's zoom control is a CSS `zoom` on <body>, and this panel is
         portalled INTO that body: rects come back in visual pixels while the
         `left`/`top` we write are interpreted in the zoomed space. Reading the
         factor off the panel's own known width converts between the two, so a
         zoomed window does not push the panel off screen. */
      const scale = panelRect.width > 0 ? panelRect.width / POPOVER_WIDTH : 1;
      const placed = popoverPosition(
        anchor.getBoundingClientRect(),
        // The meters are full-width now, so there is no rightmost meter to
        // flip for: every panel hangs from its bar's left edge.
        "left",
        { width: panelRect.width || POPOVER_WIDTH, height: panelRect.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPosition({ top: placed.top / scale, left: placed.left / scale });
    };
    place();
    window.addEventListener("resize", place);
    // The row can scroll under the panel inside the header popup; re-placing on
    // any scroll keeps the panel on its meter instead of floating away.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef]);
  const { segment, card } = cell;
  const account = segment.account;
  const resetClock = formatResetClock(segment.window.resetsAt);
  // The projection is one window's pacing, so it lives where that window's
  // details are rather than competing with the number on the bar.
  const pace = paceVisual(segment.window.pacing);
  const outlook = paceOutlook(segment.window.pacing, nowMs);
  const via = account?.machines
    .map((machine) => machine.label)
    .filter(Boolean)
    .join(" · ");
  const models = Object.entries(segment.window.modelBreakdown ?? {})
    .filter(([, percent]) => percent > 0)
    .map(([model, percent]) => `${model} ${Math.round(percent)}%`)
    .join(" · ");
  return createPortal(
    <ViewportOverlayHost layer="tooltip">
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-label={`${card.label} details`}
        style={{
          position: "absolute",
          top: position?.top ?? 0,
          left: position?.left ?? 0,
          width: POPOVER_WIDTH,
          pointerEvents: "auto",
          // Measured before it is placed: showing it at 0,0 for one frame would
          // be a visible jump in the corner of the screen.
          visibility: position ? "visible" : "hidden",
        }}
        className={cn(
          // `bg-surface-raised` is translucent on the light theme, and this panel
          // floats over the rows beneath it — they read straight through. The
          // overlay token is the one every other floating usage readout uses.
          "p-3",
          USAGE_OVERLAY_CLASS,
        )}
        onMouseEnter={onPointerEnter}
        onMouseLeave={onPointerLeave}
      >
      {/* The window's own colour runs down the header, so a panel that has
          floated away from its bar still says which bar it came from. */}
      <div
        className="-mx-3 -mt-3 mb-2 flex min-w-0 items-center justify-between gap-2 rounded-t-lg border-b border-separator px-3 py-2"
        style={{ background: `color-mix(in srgb, ${tone} 12%, transparent)` }}
      >
        <span className={cn(USAGE_TEXT.detail, "min-w-0 truncate font-semibold text-fg")}>{card.label}</span>
        <span
          className={cn(USAGE_TEXT.detail, USAGE_NUMERIC_CLASS, "shrink-0 font-semibold")}
          style={{ color: tone }}
        >
          {Math.round(segment.percentLeft)}% left
        </span>
      </div>
      {/* Every row is one line. The values are short enough to fit at 248px —
          the machine list and the model split are joined with "·" and
          truncated with a title rather than wrapped, because a two-line value
          pushed "Open limits" off the bottom of the panel. */}
      <dl className="flex flex-col gap-1">
        <PopoverRow label="Account" value={account?.email ?? "This machine"} />
        {account?.plan ? <PopoverRow label="Plan" value={account.plan} /> : null}
        {via ? <PopoverRow label="Via" value={via} /> : null}
        {resetClock || segment.resetsInMs > 0 ? (
          <PopoverRow
            label="Resets"
            value={
              resetClock
                ? `${resetClock} · in ${formatCountdown(segment.resetsInMs)}`
                : `in ${formatCountdown(segment.resetsInMs)}`
            }
            numeric
          />
        ) : null}
        {pace ? (
          <div className="flex min-w-0 items-center justify-between gap-3">
            <dt className={cn(USAGE_TEXT.micro, "shrink-0 text-muted-fg")}>Pace</dt>
            <dd className="m-0 flex min-w-0 shrink-0 justify-end">
              <PacePill pace={pace} />
            </dd>
          </div>
        ) : null}
        {outlook ? <PopoverRow label="Trending" value={outlook.projected} numeric /> : null}
        {outlook?.outcome ? <PopoverRow label="Outlook" value={outlook.outcome} /> : null}
        {models ? <PopoverRow label="Models" value={models} /> : null}
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
    </ViewportOverlayHost>,
    document.body,
  );
}

/**
 * A label/value row, on exactly one line.
 *
 * It used to wrap, on the theory that an ellipsis in the middle of "runs dry
 * ~Sun 3pm" hides the only part worth reading. In a 248px panel that theory
 * produced a panel where half the rows were two lines tall and nothing lined
 * up. One line each, with the full text on the `title`.
 */
function PopoverRow({ label, value, numeric }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <dt className={cn(USAGE_TEXT.micro, "shrink-0 text-muted-fg")}>{label}</dt>
      <dd
        title={value}
        className={cn(
          USAGE_TEXT.micro,
          numeric && USAGE_NUMERIC_CLASS,
          "m-0 min-w-0 truncate text-right text-fg",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
