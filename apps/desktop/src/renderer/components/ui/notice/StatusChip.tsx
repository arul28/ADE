import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { AnchoredTooltip } from "../AnchoredTooltip";
import { cn } from "../cn";
import { noticeTone, type NoticeTone } from "./noticeTones";

/**
 * One row of small status chips on a composer's top edge (a chat is settled, a
 * lane is on another branch). Chips sit side by side and the row scrolls
 * sideways when it runs out of width, so status never stacks over the thread.
 * Renders nothing visible when every child renders nothing.
 */
export function StatusStrip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-testid="chat-composer-status-strip"
      data-status-strip=""
      className={cn(
        "flex min-w-0 flex-nowrap items-center gap-1.5 overflow-x-auto px-1 pb-1.5 [scrollbar-width:none] empty:hidden [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

export type StatusChipAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  testId?: string;
};

/**
 * A 22px status chip: tone icon, a short label, an optional detail, at most a
 * couple of text actions, and an optional dismiss. The explanation belongs in
 * `tooltip`, not in the chip. Colours come from the shared notice tones.
 */
export function StatusChip({
  tone,
  icon,
  label,
  detail,
  detailMono = false,
  tooltip,
  actions = [],
  help,
  onDismiss,
  testId,
  dataAttributes,
}: {
  tone: NoticeTone;
  icon: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  /** Draw the detail in mono (a branch name). */
  detailMono?: boolean;
  tooltip?: string;
  actions?: StatusChipAction[];
  /** A small "?" after the actions whose hover explains what they do. */
  help?: string;
  onDismiss?: () => void;
  testId?: string;
  dataAttributes?: Record<`data-${string}`, string>;
}) {
  const tokens = noticeTone(tone);
  const style: CSSProperties & Record<"--status-chip-fill" | "--status-chip-hover", string> = {
    borderColor: tokens.edge,
    "--status-chip-fill": tone === "neutral" || tone === "success" ? "rgb(255 255 255 / 0.03)" : tokens.soft,
    "--status-chip-hover": tokens.softHover,
  };
  return (
    <div
      data-testid={testId}
      data-notice-tone={tone}
      // A host that floats chips over content backs them with an opaque plate
      // under `--status-chip-fill` (index.css, composer overlay).
      data-overlay-plate=""
      {...dataAttributes}
      role="status"
      aria-label={tooltip}
      title={tooltip}
      style={style}
      className={cn("pointer-events-auto inline-flex h-[22px] max-w-full shrink-0 items-center gap-1.5 rounded-full border bg-[var(--status-chip-fill)] pl-2 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/60", actions.length > 0 || help || onDismiss ? "pr-1" : "pr-2")}
    >
      <span className="inline-flex shrink-0" style={{ color: tokens.color }} aria-hidden>{icon}</span>
      <span className="shrink-0 font-medium" style={{ color: tokens.text }}>{label}</span>
      {detail != null ? (
        <span className={cn("min-w-0 truncate", detailMono ? "font-mono text-fg/80" : "text-fg/45")}>{detail}</span>
      ) : null}
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          data-testid={action.testId}
          title={action.title}
          disabled={action.disabled}
          onClick={action.onClick}
          className="inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 font-medium text-fg/70 transition-colors hover:bg-[var(--status-chip-hover)] hover:text-fg focus-visible:bg-[var(--status-chip-hover)] focus-visible:text-fg focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
        >
          {action.label}
        </button>
      ))}
      {help ? <ChipHelp text={help} /> : null}
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-fg/40 transition-colors hover:bg-[var(--status-chip-hover)] hover:text-fg/80"
        >
          <X size={9} weight="bold" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The chip's "?": its explanation on hover or focus. A native `title` showed
 * nothing in the composer's status row, so it is an anchored tooltip, which
 * no clipping parent can cut off.
 */
function ChipHelp({ text }: { text: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="What is this?"
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        className={cn(
          "grid h-[16px] w-[16px] shrink-0 cursor-help place-items-center rounded-full text-[9px] font-semibold leading-none shadow-[inset_0_0_0_1px_currentColor] transition-colors hover:text-fg/80 focus-visible:text-fg/80 focus-visible:outline-none",
          open ? "text-fg/80" : "text-fg/45",
        )}
      >
        ?
      </button>
      {open ? (
        <AnchoredTooltip
          open
          triggerRef={triggerRef}
          side="top"
          remeasureKey={text}
          onDismiss={() => setOpen(false)}
          id={id}
          className="pointer-events-none w-[260px] rounded-lg border border-[var(--color-border)] bg-[var(--color-popup-bg,var(--color-card))] px-2.5 py-2 font-sans text-[11px] leading-[1.5] text-fg/75 shadow-[0_8px_24px_rgba(0,0,0,0.32)]"
        >
          {text}
        </AnchoredTooltip>
      ) : null}
    </>
  );
}
