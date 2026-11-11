import React from "react";
import { Check, Circle, Minus, Warning, X, type Icon } from "@phosphor-icons/react";
import type { ChatLaunchSnapshot, ChatLaunchStageStatus, LaneEnvInitStep } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { showToast } from "../../app/toast/toastStore";
import { copyTextToClipboard } from "../../../lib/launchPromptClipboard";
import { CHAT_CARD_WIDTH_CLASS } from "../chatCardPrimitives";

/**
 * The parts of a step card, shared by the lane setup card (`LaneSetupCard`)
 * and the ADE Cloud tier-change / move card (`CloudLaneJobCard`): the status
 * palette, the stage line with its tile and status mark, the error callout
 * under a failed step, the header, the small text actions and chips, and
 * Copy details.
 *
 * Colour carries status everywhere: running is ADE violet (the Night sky blue
 * on ADE Cloud), done is emerald, warning and failure are amber, never red
 * (house rule in `shared/adeCard.ts`).
 */

/* ── Status palette ─────────────────────────────────────────────────────── */

export type Status = ChatLaunchStageStatus | LaneEnvInitStep["status"];

export function normalizeStatus(status: Status): ChatLaunchStageStatus {
  return status === "completed" ? "done" : status;
}

/** Tile tones by status; the Launches slide-out indexes the same palette. */
export const TILE_TONE: Record<ChatLaunchStageStatus, string> = {
  running: "border-violet-400/25 bg-violet-400/[0.12] text-violet-200",
  done: "border-emerald-400/15 bg-emerald-400/[0.08] text-emerald-300/85",
  warning: "border-amber-400/20 bg-amber-400/[0.08] text-amber-300/90",
  failed: "border-amber-400/25 bg-amber-400/[0.10] text-amber-300",
  skipped: "border-fg/[0.05] bg-fg/[0.02] text-fg/25",
  pending: "border-fg/[0.06] bg-fg/[0.025] text-fg/30",
};

const LABEL_TONE: Record<ChatLaunchStageStatus, string> = {
  running: "text-fg/90",
  done: "text-fg/68",
  warning: "text-amber-100/90",
  failed: "text-amber-100/90",
  skipped: "text-fg/35",
  pending: "text-fg/40",
};

export const PHASE_TILE_TONE: Record<ChatLaunchSnapshot["phase"], string> = {
  running: TILE_TONE.running,
  "awaiting-client": TILE_TONE.running,
  completed: TILE_TONE.done,
  failed: TILE_TONE.failed,
  cancelled: TILE_TONE.skipped,
};

/* ── Glyphs ──────────────────────────────────────────────────────────────── */

function SpinnerRing({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      className="motion-safe:animate-spin"
      aria-hidden
      data-launch-glyph="running"
    >
      <circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.4" />
      <path d="M6 1.4 A4.6 4.6 0 0 1 10.6 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** The small status mark at the end of a row (and the slide-out row's leading mark). */
export function LaunchStageGlyph({
  status,
  size = 12,
}: {
  status: Status;
  size?: number;
}) {
  switch (normalizeStatus(status)) {
    case "done":
      return (
        <span className="grid place-items-center text-emerald-300/80" data-launch-glyph="done">
          <Check size={size - 1} weight="bold" aria-hidden />
        </span>
      );
    case "running":
      return <span className="grid place-items-center text-violet-300/90"><SpinnerRing size={size} /></span>;
    case "warning":
      return (
        <span className="grid place-items-center text-amber-300/85" data-launch-glyph="warning">
          <Warning size={size} weight="bold" aria-hidden />
        </span>
      );
    case "failed":
      return (
        <span className="grid place-items-center text-amber-300/90" data-launch-glyph="failed">
          <X size={size - 1} weight="bold" aria-hidden />
        </span>
      );
    case "skipped":
      return (
        <span className="grid place-items-center text-fg/25" data-launch-glyph="skipped">
          <Minus size={size - 1} weight="bold" aria-hidden />
        </span>
      );
    default:
      return (
        <span className="grid place-items-center text-fg/20" data-launch-glyph="pending">
          <Circle size={size - 1} weight="regular" aria-hidden />
        </span>
      );
  }
}

/** A status mark that fades in when the status changes (CSS, transform/opacity only). */
export function StatusMark({ status, size }: { status: Status; size: number }) {
  return (
    <span key={normalizeStatus(status)} className="ade-launch-glyph-in grid h-4 w-4 shrink-0 place-items-center">
      <LaunchStageGlyph status={status} size={size} />
    </span>
  );
}

function StageTile({ icon: IconComponent, status, compact, cloud = false }: { icon: Icon; status: Status; compact: boolean; cloud?: boolean }) {
  const normalized = normalizeStatus(status);
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-[6px] border transition-colors duration-300",
        compact ? "h-[18px] w-[18px]" : "h-5 w-5",
        // An ADE Cloud launch runs in the Night sky blue, not the violet.
        cloud && normalized === "running" ? "adec-tile" : TILE_TONE[normalized],
      )}
      aria-hidden
    >
      <IconComponent size={compact ? 10.5 : 11.5} weight={normalized === "running" ? "bold" : "regular"} />
    </span>
  );
}

/* ── Rows ──────────────────────────────────────────────────────────────── */

/** One stage line, shared by the live card, the transcript-payload fallback and the ADE Cloud tier-change card. */
export function StageLine({
  icon,
  status,
  label,
  detail,
  percent,
  trailing,
  compact,
  cloud = false,
}: {
  icon: Icon;
  status: ChatLaunchStageStatus;
  label: string;
  detail: string | null;
  percent?: number | null;
  trailing?: React.ReactNode;
  compact: boolean;
  /** An ADE Cloud launch: the running tone is the Night sky blue. */
  cloud?: boolean;
}) {
  const stackDetail = compact && Boolean(detail);
  return (
    <div className={cn("flex min-w-0 gap-2.5", stackDetail ? "items-start py-1" : "items-center", compact ? "min-h-[28px]" : "h-[32px]")}>
      <StageTile icon={icon} status={status} compact={compact} cloud={cloud} />
      <div className={cn("flex min-w-0 flex-1 gap-2", stackDetail ? "flex-col items-stretch gap-0" : "items-baseline")}>
        <span className={cn("shrink-0 transition-colors duration-200", LABEL_TONE[status])}>{label}</span>
        {detail ? <span className="min-w-0 truncate text-fg/35" title={detail}>{detail}</span> : null}
        {percent != null ? (
          <span className={cn("shrink-0 tabular-nums", cloud ? "adec-percent" : "text-violet-200/80")}>{`${percent}%`}</span>
        ) : null}
      </div>
      {trailing}
      <StatusMark status={status} size={compact ? 11 : 12} />
    </div>
  );
}

/** The full error a failed or warned stage shows under its row (live card and payload fallback). */
export function StageErrorCallout({ error, className }: { error: string; className?: string }) {
  return (
    <p
      className={cn(
        "mb-1.5 ml-[30px] rounded-md border border-amber-400/15 bg-amber-400/[0.06] px-2 py-1 leading-snug text-amber-200/85",
        className,
      )}
    >
      {error}
    </p>
  );
}

/* ── The card's frame and header ───────────────────────────────────────── */

/** The thread card's outer frame; a failed card wears the amber border. */
export function stepCardFrameClass(failed: boolean): string {
  return cn(
    CHAT_CARD_WIDTH_CLASS,
    "ade-launch-card-enter rounded-[calc(var(--chat-radius-card,16px)-6px)] border bg-fg/[0.022] px-3.5 pb-2 pt-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]",
    failed ? "border-amber-400/20" : "border-fg/[0.07]",
  );
}

/**
 * A step card's header: the phase tile, the title, whatever sits after the
 * title (the elapsed time, a fold button), and the chips under it.
 */
export function StepCardHeader({
  tileTone,
  tileIcon,
  title,
  failed,
  trailing,
  chips,
  metaSize,
  backdrop,
  titleTestId,
  titleRole,
}: {
  tileTone: string;
  tileIcon: React.ReactNode;
  title: React.ReactNode;
  failed: boolean;
  trailing?: React.ReactNode;
  /** Null hides the chip row. */
  chips: React.ReactNode | null;
  metaSize: string;
  /** Drawn behind the header (the ADE Cloud drift). */
  backdrop?: React.ReactNode;
  titleTestId?: string;
  titleRole?: string;
}) {
  return (
    <div className="relative flex min-w-0 items-start gap-2.5">
      {backdrop}
      <span
        className={cn("relative mt-px grid h-6 w-6 shrink-0 place-items-center rounded-[7px] border transition-colors duration-300", tileTone)}
        aria-hidden
      >
        {tileIcon}
      </span>
      <div className="relative min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn("min-w-0 truncate font-medium", failed ? "text-amber-200/90" : "text-fg/82")}
            data-testid={titleTestId}
            role={titleRole}
          >
            {title}
          </span>
          {trailing}
        </div>
        {chips ? <div className={cn("mt-1 flex min-w-0 flex-wrap items-center gap-1.5", metaSize)}>{chips}</div> : null}
      </div>
    </div>
  );
}

/* ── Actions and chips ─────────────────────────────────────────────────── */

export function TextAction({
  children,
  onClick,
  tone = "default",
  disabled,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "default" | "primary";
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors disabled:cursor-default disabled:opacity-40",
        tone === "primary"
          ? "text-violet-200/90 hover:bg-violet-400/[0.10] hover:text-violet-100"
          : "text-fg/45 hover:bg-fg/[0.04] hover:text-fg/80",
      )}
    >
      {children}
    </button>
  );
}

export function Chip({ children, title, mono }: { children: React.ReactNode; title?: string; mono?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-fg/[0.06] bg-fg/[0.03] px-1.5 py-px text-fg/55",
        mono && "font-mono",
      )}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * "Copy details" for a failed step card: puts the lines on the clipboard and
 * says whether it worked (`what` names the details, e.g. "launch details").
 */
export function copyStepCardDetails(lines: readonly (string | null | undefined)[], what = "details"): void {
  const text = lines.filter((line): line is string => Boolean(line)).join("\n");
  void copyTextToClipboard(text).then((copied) => {
    showToast(copied
      ? { title: `Copied the ${what}`, tone: "success" }
      : { title: `Couldn't copy the ${what}`, tone: "error" });
  });
}

/* ── ADE Cloud drift ───────────────────────────────────────────────────── */

/** Puffs of the drift behind an ADE Cloud card's header: place, size, how far each travels, when it starts. */
const CLOUD_DRIFT_PUFFS = [
  { left: -10, top: 8, width: 64, height: 30, dx: 150, delay: 0 },
  { left: 6, top: 22, width: 50, height: 24, dx: 190, delay: 0.2 },
  { left: -24, top: 20, width: 78, height: 34, dx: 230, delay: 0.4 },
  { left: 10, top: 0, width: 44, height: 22, dx: 170, delay: 0.62 },
  { left: -6, top: 30, width: 56, height: 24, dx: 260, delay: 0.85 },
] as const;

/**
 * A short drift of cloud behind the header while the computer is made. CSS
 * only: it plays once (about three seconds), ends hidden, and does not play
 * with reduced motion (cloudBrand.css). It mounts with the computer step, so
 * a card opened later, after that step, shows none.
 */
export function CloudDrift() {
  return (
    <span className="adec-drift" aria-hidden data-testid="lane-setup-cloud-drift">
      {CLOUD_DRIFT_PUFFS.map((puff, index) => (
        <span
          key={index}
          className="adec-puff"
          style={{
            left: puff.left,
            top: puff.top,
            width: puff.width,
            height: puff.height,
            animationDelay: `${puff.delay}s`,
            ["--adec-dx" as string]: `${puff.dx}px`,
          }}
        />
      ))}
    </span>
  );
}
