import type { ReactNode } from "react";
import { cn } from "../../ui/cn";

export type PickerEmptyAction = { label: string; onClick: () => void };

/**
 * The model picker's centered empty page: an optional mark, a title, a line,
 * optional extra content (a progress bar), and up to two buttons. The
 * provider pages and the Free page share it.
 */
export function PickerEmptyMessage({
  dataAttributes,
  icon,
  title,
  body,
  primary,
  secondary,
  live,
  children,
}: {
  dataAttributes?: Record<`data-${string}`, string>;
  icon?: ReactNode;
  title: string;
  body?: string;
  primary?: PickerEmptyAction;
  secondary?: PickerEmptyAction;
  /** Announce changes to the title and line (a running download). */
  live?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      {...dataAttributes}
      {...(live ? { role: "status", "aria-live": "polite" as const } : {})}
      className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 px-6 py-6 text-center"
    >
      {icon}
      <span className="text-[12px] font-semibold text-fg/90">{title}</span>
      {body ? <span className="max-w-[280px] text-[11px] leading-relaxed text-muted-fg/65">{body}</span> : null}
      {children}
      {primary || secondary ? (
        <div className="mt-2 flex items-center gap-1.5">
          {primary ? (
            <button
              type="button"
              onClick={primary.onClick}
              className={cn(
                "inline-flex h-6 items-center rounded-md border border-violet-400/30 bg-violet-500/[0.12] px-2.5",
                "text-[10px] font-semibold uppercase tracking-wide text-violet-100",
                "transition-colors hover:border-violet-400/45 hover:bg-violet-500/[0.18]",
              )}
            >
              {primary.label}
            </button>
          ) : null}
          {secondary ? (
            <button
              type="button"
              onClick={secondary.onClick}
              className={cn(
                "inline-flex h-6 items-center rounded-md border border-fg/[0.08] bg-fg/[0.03] px-2.5",
                "text-[10px] font-semibold uppercase tracking-wide text-fg/75",
                "transition-colors hover:border-fg/[0.14] hover:bg-fg/[0.06] hover:text-fg/90",
              )}
            >
              {secondary.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
