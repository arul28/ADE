import type { CSSProperties, ReactNode } from "react";
import { X } from "@phosphor-icons/react";
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
  onDismiss?: () => void;
  testId?: string;
  dataAttributes?: Record<`data-${string}`, string>;
}) {
  const tokens = noticeTone(tone);
  const style: CSSProperties & Record<"--status-chip-hover", string> = {
    borderColor: tokens.edge,
    background: tone === "neutral" || tone === "success" ? undefined : tokens.soft,
    "--status-chip-hover": tokens.softHover,
  };
  return (
    <div
      data-testid={testId}
      data-notice-tone={tone}
      {...dataAttributes}
      role="status"
      aria-label={tooltip}
      title={tooltip}
      style={style}
      className="pointer-events-auto inline-flex h-[22px] max-w-full shrink-0 items-center gap-1.5 rounded-full border bg-white/[0.03] pl-2 pr-1 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/60"
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
