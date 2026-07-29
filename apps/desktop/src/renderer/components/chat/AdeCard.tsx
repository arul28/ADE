import { useEffect, useState } from "react";
import {
  ArrowSquareOut,
  CaretRight,
  Cube,
  GitMerge,
  Warning,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { formatSubagentDurationMs } from "../../lib/format";
import { navigateToAppTarget } from "../../lib/openExternal";
import { CHAT_TRANSCRIPT_GLASS_CARD_CLASS } from "./chatTranscriptChrome";
import {
  CHAT_CARD_MICRO_TEXT,
  CHAT_CARD_WIDTH_CLASS,
  ChatCard,
  ChatCardButton,
  ChatCardChip,
  ChatCardDetail,
  ChatCardDetailRow,
  ChatCardDiffStat,
  ChatCardMeter,
  ChatCardRow,
  ChatCardSub,
  ChatCardTitle,
  type ChatCardTone,
} from "./chatCardPrimitives";
import {
  adeCardDeeplink,
  adeCardFallbackText,
  adeCardProgressTotal,
  isKnownAdeCardVariant,
  normalizeAdeCardTone,
  type AdeCardIcon,
  type AdeCardPayload,
} from "../../../shared/adeCard";

/**
 * The `ade_card` renderer.
 *
 * Built entirely from `./chatCardPrimitives` — the `[glyph | content | meta]`
 * grid, `CHAT_CARD_WIDTH_CLASS`, and the shared tone vocabulary — so an
 * `ade_card` lines up column-for-column with every other transcript row rather
 * than inventing its own indent and its own width.
 *
 * Shape follows the state, not the variant name:
 *
 * - a green/quiet result is ONE line (no box, hairline rule);
 * - a failure gets an amber rail and lists only the rows that failed;
 * - a live card gets an inset box and a progress meter.
 *
 * Tone policy inherited from `shared/adeCard.ts`: THERE IS NO RED HERE. A failed
 * thing is amber, and its detail lives in the row's detail column rather than a
 * red error block. A variant this build does not recognize renders
 * `fallbackText` + the deeplink instead of nothing — that degradation is the
 * reason one wire contract can ship across three independent release trains.
 */

/** Semantic row glyph → the shared tone vocabulary. */
function rowToneForIcon(icon: AdeCardIcon | undefined, declared: ChatCardTone): ChatCardTone {
  switch (icon) {
    case "pass":
      return "ok";
    case "fail":
      return "warn";
    case "running":
      return "running";
    case "skipped":
      return "idle";
    case "queued":
    case "file":
    case "info":
    default:
      return declared;
  }
}

function toneOf(value: string | null | undefined): ChatCardTone {
  switch (normalizeAdeCardTone(value)) {
    case "success":
      return "ok";
    case "warning":
      return "warn";
    case "accent":
      return "running";
    default:
      return "neutral";
  }
}

/** Head glyph per variant family. Everything else falls back to the tone glyph. */
function variantIcon(variant: string): PhosphorIcon | undefined {
  if (variant === "pr_merged" || variant === "pr_merge_ready") return GitMerge;
  if (variant === "pr_conflict") return Warning;
  if (variant === "proof_artifact") return Cube;
  return undefined;
}

/**
 * `+23,574 / −912` when the emitter shipped additions/deletions metrics, so a PR
 * card can be one line with the diff in the meta column instead of two chips.
 */
function diffStatFromMetrics(card: AdeCardPayload): { additions: number; deletions: number } | null {
  const read = (label: string): number | null => {
    const metric = (card.metrics ?? []).find((entry) => entry.label === label);
    if (!metric) return null;
    const parsed = Number.parseInt(metric.value.replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const additions = read("additions");
  const deletions = read("deletions");
  if (additions == null && deletions == null) return null;
  return { additions: additions ?? 0, deletions: deletions ?? 0 };
}

function liveElapsedText(startedAt: string | null | undefined, nowMs: number): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  return formatSubagentDurationMs(Math.max(0, nowMs - start));
}

/**
 * The span between the card's first and last emit. NOT a run duration — a CI
 * card that is re-polled for three hours has a three-hour span and a three-
 * minute run. Labelled `tracked` wherever it appears so the two never read as
 * the same number.
 */
function trackedSpanText(card: AdeCardPayload): string | null {
  if (!card.createdAt || !card.updatedAt) return null;
  const span = Date.parse(card.updatedAt) - Date.parse(card.createdAt);
  if (!Number.isFinite(span) || span < 60_000) return null;
  const text = formatSubagentDurationMs(span);
  return text ? `tracked ${text}` : null;
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
  const openCard = () => {
    if (card.navTarget) navigateToAppTarget(card.navTarget);
  };

  // Unknown variant → fallbackText + deeplink. Never an empty row.
  if (!known) {
    const text = adeCardFallbackText(card);
    return (
      <div className={cn(CHAT_TRANSCRIPT_GLASS_CARD_CLASS, CHAT_CARD_WIDTH_CLASS, "px-3.5 py-2.5")}>
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

  const metrics = card.metrics ?? [];
  const rows = card.rows ?? [];
  const progress = card.progress ?? null;
  const progressTotal = adeCardProgressTotal(progress);
  const degradedReason = card.degradedReason?.trim() || null;
  const failedCount = Math.max(0, progress?.failed ?? 0);
  const warnRows = rows.filter((row) => normalizeAdeCardTone(row.tone) === "warning" || row.icon === "fail");
  const hasWarning = failedCount > 0
    || warnRows.length > 0
    || metrics.some((metric) => normalizeAdeCardTone(metric.tone) === "warning" && metric.value !== "0");

  // The two clocks are deliberately different numbers with different labels.
  const realDuration = formatSubagentDurationMs(card.durationMs ?? null);
  const elapsed = isLive ? liveElapsedText(card.createdAt, nowMs) : null;
  const tracked = !isLive && !realDuration ? trackedSpanText(card) : null;

  const headTone: ChatCardTone = isLive ? "running" : hasWarning ? "warn" : degradedReason ? "neutral" : "ok";
  const diff = diffStatFromMetrics(card);

  // A card only earns a box when it has something to put in one. A passing
  // result collapses to a single hairline row.
  const detailRows = hasWarning ? warnRows : rows;
  const showDetail = detailRows.length > 0 && (hasWarning || isLive || card.variant === "proof_artifact");
  const skin = hasWarning ? "rail" : showDetail || isLive || degradedReason ? "inset" : "line";

  const metaParts = [
    hasWarning && progress ? `${progress.passed} passed` : null,
    !hasWarning && !isLive && progressTotal > 0 ? `${progressTotal} job${progressTotal === 1 ? "" : "s"}` : null,
    realDuration ? `ran ${realDuration}` : null,
    elapsed,
    tracked,
  ].filter((part): part is string => Boolean(part));

  const actions = (card.actions ?? []).filter((action) => (
    (action.id === "open" && navigable) || onAction != null
  ));

  const inner = (
    <>
      <ChatCardRow
        tone={headTone}
        icon={variantIcon(card.variant)}
        align={card.subtitle || degradedReason ? "top" : "center"}
        meta={diff ? <ChatCardDiffStat additions={diff.additions} deletions={diff.deletions} /> : metaParts.join(" · ")}
        action={navigable && !actions.length ? (
          // A span, not a button: the whole card already navigates, and nesting
          // a second button here would make the card ambiguous to assistive
          // tech (and to `getByRole("button")`).
          <span className={cn("inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-fg/40", CHAT_CARD_MICRO_TEXT)}>
            open
            <CaretRight size={10} weight="bold" aria-hidden />
          </span>
        ) : null}
      >
        <div className="flex min-w-0 items-baseline gap-1.5">
          <ChatCardTitle className="shrink">{card.title}</ChatCardTitle>
          {card.stale ? <ChatCardChip tone="idle" title="Shown from the last successful update">stale</ChatCardChip> : null}
          {degradedReason ? <ChatCardChip tone="warn">detail unavailable</ChatCardChip> : null}
        </div>
        {card.subtitle?.trim() ? <ChatCardSub className="mt-0.5">{card.subtitle.trim()}</ChatCardSub> : null}
        {degradedReason ? <ChatCardSub className="mt-0.5 text-amber-100/60">{degradedReason}</ChatCardSub> : null}
      </ChatCardRow>

      {/* A meter only says something while work is still in flight. */}
      {isLive && progress && progressTotal > 0 ? (
        <ChatCardMeter progress={progress} className="ml-[26px] mt-2" />
      ) : null}

      {/* Chips are for counts the head line cannot carry (a diff already did). */}
      {!diff && metrics.length && (hasWarning || isLive || card.variant === "proof_artifact") ? (
        <div className="ml-[26px] mt-2 flex flex-wrap items-center gap-1.5">
          {metrics.map((metric) => (
            <ChatCardChip key={`${metric.label}:${metric.value}`} tone={toneOf(metric.tone)}>
              <span className="font-bold">{metric.value}</span> <span className="opacity-70">{metric.label}</span>
            </ChatCardChip>
          ))}
        </div>
      ) : null}

      {showDetail ? (
        <ChatCardDetail>
          {detailRows.map((row, index) => (
            <ChatCardDetailRow
              key={`${index}:${row.text}`}
              tone={rowToneForIcon(row.icon, toneOf(row.tone))}
              label={row.text}
              path={row.icon === "file"}
              title={row.detail ?? row.text}
              value={row.detail?.trim() || undefined}
            />
          ))}
          {card.rowsTruncated && card.rowsTruncated > 0 ? (
            <div className={cn("pl-5 pt-1 text-fg/35", CHAT_CARD_MICRO_TEXT)}>
              +{card.rowsTruncated} more
            </div>
          ) : null}
        </ChatCardDetail>
      ) : null}

      {actions.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-white/[0.06] pt-2">
          {actions.map((action) => (
            <ChatCardButton
              key={action.id}
              primary={action.kind === "primary"}
              onClick={() => {
                if (action.id === "open" && card.navTarget) {
                  openCard();
                  return;
                }
                onAction?.(action.id);
              }}
            >
              {action.label}
            </ChatCardButton>
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
      <ChatCard
        skin={skin}
        tone={headTone}
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
        className="cursor-pointer text-left transition-colors hover:bg-white/[0.045]"
      >
        {inner}
      </ChatCard>
    );
  }

  return <ChatCard skin={skin} tone={headTone}>{inner}</ChatCard>;
}
