import React from "react";
import {
  CaretRight,
  CheckCircle,
  Circle,
  Cube,
  Prohibit,
  SpinnerGap,
  XCircle,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";

/**
 * The chat transcript's card primitives.
 *
 * One layout idea holds the whole transcript together: every card row is a
 * `[16px glyph] [flexible content] [auto meta]` grid, so titles, durations and
 * counts line up in columns down the entire thread instead of each card
 * inventing its own indent. Cards compose `CardRow` + one of the `CARD_SKIN`
 * shells; nothing here reaches for a bespoke flex arrangement.
 *
 * Two house rules are enforced here rather than restated per card:
 *
 * 1. **Width.** `CHAT_CARD_WIDTH_CLASS` is the ONLY max-width a transcript row
 *    may use. It resolves `--chat-content-width` (see `chatAppearance.ts`), the
 *    single viewport-scaling token every row — prose, cards, pills, plan,
 *    files-changed — shares. Card-local clamps are what made cards stop ~26%
 *    short of the prose they sat under.
 * 2. **No red.** A failure is amber (`warn`), never a red error block — the same
 *    policy stated at the top of `../../../shared/adeCard.ts` and
 *    `./SubagentActivityCards.tsx`.
 */

/** The single transcript content width. Never re-clamp a row on top of this. */
export const CHAT_CARD_WIDTH_CLASS = "w-full max-w-[var(--chat-content-width,52rem)]";

/** Type scale, `--chat-font-size`-relative so the appearance setting still drives it. */
export const CHAT_CARD_TITLE_TEXT = "text-[length:calc(var(--chat-font-size)*12/14)]";
export const CHAT_CARD_BODY_TEXT = "text-[length:calc(var(--chat-font-size)*10.5/14)]";
export const CHAT_CARD_META_TEXT = "text-[length:calc(var(--chat-font-size)*10/14)]";
export const CHAT_CARD_MICRO_TEXT = "text-[length:calc(var(--chat-font-size)*9.5/14)]";

/** Radius 10px at the default 16px card radius — the house `-6px` idiom. */
const CARD_RADIUS = "rounded-[calc(var(--chat-radius-card)-6px)]";

export type ChatCardTone = "ok" | "warn" | "running" | "idle" | "neutral";

/** Status tone → glyph + colour. One vocabulary for every card. */
export const CHAT_CARD_TONE: Record<ChatCardTone, { cls: string; Icon: PhosphorIcon }> = {
  ok: { cls: "text-emerald-300/85", Icon: CheckCircle },
  warn: { cls: "text-amber-300/85", Icon: XCircle },
  running: { cls: "text-[color:var(--chat-accent)]", Icon: SpinnerGap },
  idle: { cls: "text-fg/32", Icon: Prohibit },
  neutral: { cls: "text-fg/45", Icon: Circle },
};

export type ChatCardSkin = "line" | "inset" | "bordered" | "rail" | "plain";

/** Card shells. `line` is the default — no box, just a hairline rule. */
export const CHAT_CARD_SKIN: Record<ChatCardSkin, string> = {
  line: "px-0.5 py-2 border-b border-fg/[0.06] last:border-b-0",
  inset: `px-3 py-2.5 bg-fg/[0.03] ${CARD_RADIUS}`,
  bordered: `px-3 py-2.5 bg-fg/[0.025] border border-fg/[0.07] ${CARD_RADIUS}`,
  rail: `px-3 py-2.5 bg-fg/[0.03] border-l-2 rounded-r-[calc(var(--chat-radius-card)-6px)]`,
  plain: "py-1",
};

const RAIL_BORDER_COLOR: Record<ChatCardTone, string> = {
  ok: "rgb(110 231 183 / 0.5)",
  warn: "rgb(252 211 77 / 0.5)",
  running: "var(--chat-accent)",
  idle: "rgb(255 255 255 / 0.12)",
  neutral: "rgb(255 255 255 / 0.12)",
};

export function ChatCard({
  skin = "line",
  tone = "neutral",
  className,
  children,
  ...rest
}: {
  skin?: ChatCardSkin;
  tone?: ChatCardTone;
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "className">) {
  return (
    <div
      {...rest}
      className={cn(CHAT_CARD_SKIN[skin], CHAT_CARD_WIDTH_CLASS, className)}
      style={skin === "rail" ? { borderLeftColor: RAIL_BORDER_COLOR[tone], ...rest.style } : rest.style}
    >
      {children}
    </div>
  );
}

/**
 * The single layout primitive every card uses:
 * `[16px glyph] [flexible content] [auto meta]`. Keeping this grid identical
 * everywhere is what makes a scrolled transcript read as columns instead of a
 * ragged stack.
 */
export function ChatCardRow({
  tone = "neutral",
  icon,
  children,
  meta,
  action,
  align = "center",
  className,
}: {
  tone?: ChatCardTone;
  /** Overrides the tone's default glyph (e.g. a merge or clock icon). */
  icon?: PhosphorIcon;
  children?: React.ReactNode;
  meta?: React.ReactNode;
  action?: React.ReactNode;
  align?: "center" | "top";
  className?: string;
}) {
  const toneSpec = CHAT_CARD_TONE[tone] ?? CHAT_CARD_TONE.neutral;
  const Icon = icon ?? toneSpec.Icon;
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-[16px_minmax(0,1fr)_auto] gap-2.5",
        align === "top" ? "items-start" : "items-center",
        className,
      )}
    >
      <span className={cn("grid h-4 w-4 place-items-center", toneSpec.cls, align === "top" && "mt-px")}>
        <Icon size={12} weight="bold" className={cn(tone === "running" && "motion-safe:animate-spin")} aria-hidden />
      </span>
      <div className="min-w-0">{children}</div>
      <div className="flex shrink-0 items-center gap-2.5">
        {meta != null && meta !== "" ? (
          <span className={cn("whitespace-nowrap font-mono tabular-nums text-fg/40", CHAT_CARD_MICRO_TEXT)}>{meta}</span>
        ) : null}
        {action}
      </div>
    </div>
  );
}

export function ChatCardTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("truncate font-sans font-semibold tracking-[-0.005em] text-fg/85", CHAT_CARD_TITLE_TEXT, className)}>
      {children}
    </div>
  );
}

export function ChatCardSub({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("truncate text-fg/50", CHAT_CARD_BODY_TEXT, className)}>{children}</div>;
}

export function ChatCardChip({
  tone = "neutral",
  title,
  children,
}: {
  tone?: ChatCardTone;
  title?: string;
  children: React.ReactNode;
}) {
  const cls = {
    ok: "text-emerald-300/85 border-emerald-300/25",
    warn: "text-amber-300/85 border-amber-300/25",
    running: "text-[color:var(--chat-accent)] border-[color:color-mix(in_srgb,var(--chat-accent)_30%,transparent)]",
    idle: "text-fg/40 border-fg/[0.07]",
    neutral: "text-fg/48 border-fg/[0.07]",
  }[tone];
  return (
    <span
      title={title}
      className={cn("rounded-[5px] border px-1.5 py-px font-mono tabular-nums", CHAT_CARD_MICRO_TEXT, cls)}
    >
      {children}
    </span>
  );
}

export function ChatCardButton({
  primary,
  children,
  onClick,
  title,
}: {
  primary?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onClick?.();
      }}
      className={cn(
        "inline-flex items-center rounded-[7px] border px-2.5 py-1 font-sans font-semibold transition-colors",
        CHAT_CARD_MICRO_TEXT,
        primary
          ? "border-[color:color-mix(in_srgb,var(--chat-accent)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-[color:var(--chat-accent)] hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)]"
          : "border-fg/[0.08] bg-fg/[0.03] text-fg/60 hover:text-fg/85",
      )}
    >
      {children}
    </button>
  );
}

export type ChatCardProgress = { passed: number; failed: number; running: number; queued: number };

/** Segmented progress hairline — passed / failed / running / queued. */
export function ChatCardMeter({ progress, className }: { progress: ChatCardProgress; className?: string }) {
  const segments: Array<[keyof ChatCardProgress, string]> = [
    ["passed", "bg-emerald-400/70"],
    ["failed", "bg-amber-400/80"],
    ["running", "bg-[color:var(--chat-accent)]"],
    ["queued", "bg-fg/12"],
  ];
  const total = segments.reduce((sum, [bucket]) => sum + Math.max(0, progress[bucket]), 0);
  if (total <= 0) return null;
  return (
    <div className={cn("flex h-[3px] overflow-hidden rounded-full bg-fg/[0.05]", className)} aria-hidden>
      {segments.map(([bucket, fill]) => {
        const value = Math.max(0, progress[bucket]);
        if (value <= 0) return null;
        return <span key={bucket} className={fill} style={{ flex: `${value} 0 0%` }} />;
      })}
    </div>
  );
}

/**
 * Detail rows hang under a card head, separated by a hairline. `path` flips the
 * text direction so a truncated file path keeps its filename visible.
 */
export function ChatCardDetail({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mt-2 flex flex-col border-t border-fg/[0.06] pt-2", className)}>{children}</div>;
}

export function ChatCardDetailRow({
  tone = "neutral",
  label,
  value,
  strike,
  path,
  title,
  onClick,
}: {
  tone?: ChatCardTone;
  label: React.ReactNode;
  value?: React.ReactNode;
  strike?: boolean;
  /** RTL truncation — keeps the tail (the filename) of a long path readable. */
  path?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const toneSpec = CHAT_CARD_TONE[tone] ?? CHAT_CARD_TONE.neutral;
  const Icon = toneSpec.Icon;
  const body = (
    <>
      <span className={cn("grid place-items-center", toneSpec.cls)}>
        <Icon size={9} weight="bold" className={cn(tone === "running" && "motion-safe:animate-spin")} aria-hidden />
      </span>
      <span
        className={cn(
          "truncate text-left text-fg/70",
          path && "[direction:rtl]",
          strike && "text-fg/35 line-through",
        )}
      >
        {label}
      </span>
      <span className={cn("shrink-0 font-mono tabular-nums text-fg/35", CHAT_CARD_MICRO_TEXT)}>{value}</span>
    </>
  );
  const className = cn(
    "grid grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2 py-[3px]",
    CHAT_CARD_BODY_TEXT,
  );
  if (!onClick) {
    return (
      <div className={className} title={title}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      title={title}
      onClick={(clickEvent) => {
        clickEvent.stopPropagation();
        onClick();
      }}
      className={cn(className, "w-full rounded-sm text-left transition-colors hover:bg-fg/[0.03]")}
    >
      {body}
    </button>
  );
}

export function ChatCardDiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-mono tabular-nums", CHAT_CARD_MICRO_TEXT)}>
      <span className="text-emerald-300/85">+{additions.toLocaleString()}</span>
      <span className="text-amber-300/85">−{deletions.toLocaleString()}</span>
    </span>
  );
}

/**
 * A centred hairline rule with a mono cutout — the transcript's turn separator
 * (`10:04 · ran 3m 32s`).
 */
export function ChatTurnRule({ label, children }: { label?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="h-px flex-1 bg-fg/[0.06]" />
      <span className={cn("shrink-0 font-mono tabular-nums text-fg/40", CHAT_CARD_META_TEXT)}>{label}</span>
      {children}
      <span className="h-px flex-1 bg-fg/[0.06]" />
    </div>
  );
}

/* ── Proof ──────────────────────────────────────────────────────────────── */

/**
 * Proof in the thread is a count, not a strip of pictures: "3 proof filed ›".
 * The pictures live on the rows that filed them and in the proof drawer, which
 * this opens narrowed to the same records. `compact` drops the word for a line
 * that has little room (the turn fold), so the count never wraps.
 */
export function ChatProofCount({
  count,
  onOpen,
  compact = false,
}: {
  count: number;
  onOpen?: () => void;
  compact?: boolean;
}) {
  if (count <= 0) return null;
  const label = compact ? `${count} proof` : `${count} proof filed`;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!onOpen}
      title="Show this proof in the proof drawer"
      aria-label={`${count} proof filed. Show in the proof drawer`}
      data-chat-proof-count=""
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] tabular-nums text-fg/50 transition-colors hover:text-fg/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/35 disabled:cursor-default disabled:hover:text-fg/50"
    >
      <Cube size={10} weight="bold" className="shrink-0 text-fg/40" aria-hidden />
      {label}
      {onOpen ? <CaretRight size={9} weight="bold" className="shrink-0" aria-hidden /> : null}
    </button>
  );
}

/* ── Text helpers ───────────────────────────────────────────────────────── */

/** Codex filler that must never be printed where a real result belongs. */
const PLACEHOLDER_SUMMARIES = new Set([
  "agent completed",
  "agent received input",
  "agent active",
  "agent started",
  "agent running",
  "agent finished",
  "agent stopped",
]);

/**
 * OpenCode's child-session summary is a diff stat (`+0 −0 · 0 files`). With
 * every count at zero it says only that nothing changed, so it is not shown.
 */
const EMPTY_DIFF_STAT_SUMMARY = /^\+0\s*[−-]\s*0(?:\s*·\s*0\s+files?)?$/;

/** True for a diff-stat summary whose counts are all zero. */
export function isEmptyDiffStatSummary(value: string | null | undefined): boolean {
  return EMPTY_DIFF_STAT_SUMMARY.test((value ?? "").trim());
}

export function isPlaceholderSummary(value: string | null | undefined): boolean {
  const text = (value ?? "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (!text) return true;
  return PLACEHOLDER_SUMMARIES.has(text) || isEmptyDiffStatSummary(text);
}

/**
 * First non-placeholder candidate, or null. Callers fall back to the status
 * word rather than printing "Agent completed" where a result should be.
 */
export function firstMeaningfulSummary(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (text && !isPlaceholderSummary(text)) return text;
  }
  return null;
}

// Lives in shared so the TUI and other surfaces derive the same agent names.
export { humanizeAgentIdentity, type AgentIdentityLabel } from "../../../shared/chatSubagents";
