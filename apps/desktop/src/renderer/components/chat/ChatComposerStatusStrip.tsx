import React from "react";
import { cn } from "../ui/cn";

/**
 * One row of small status chips on the composer's top edge (settled, snoozed,
 * branch drift). Chips sit side by side and the row scrolls sideways when it
 * runs out of width, so status never stacks into the thread. Renders nothing
 * when every child renders nothing.
 */
export function ChatComposerStatusStrip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
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

/** The chip shell every strip entry uses: 22px tall, hairline, thread-scaled type. */
export const COMPOSER_STATUS_CHIP_CLASS =
  "pointer-events-auto inline-flex h-[22px] max-w-full shrink-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] pl-2 pr-1 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/60";

/** A text action inside a chip (`Un-settle`, `Switch back`). */
export const COMPOSER_STATUS_CHIP_ACTION_CLASS =
  "inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 font-medium text-fg/70 transition-colors hover:bg-white/[0.08] hover:text-fg focus-visible:bg-white/[0.08] focus-visible:text-fg focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40";
