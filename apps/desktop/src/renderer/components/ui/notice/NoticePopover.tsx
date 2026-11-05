import type { ReactElement, ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { usePortalContainer } from "../portalContainer";
import { Z_LAYERS } from "../zLayers";

/**
 * The card a notice opens from a one-line trigger: the full error of an
 * `InlineErrorNotice`, a crash's stack on a device. Below the trigger, in the
 * popover layer, in the portal container of the surface.
 *
 *   <NoticePopover open={open} onOpenChange={setOpen} trigger={<button …/>} width={320}>…</NoticePopover>
 */
export function NoticePopover({
  open,
  onOpenChange,
  trigger,
  width,
  cardProps,
  unmask = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** One element: Radix gives it the open/close behavior. */
  trigger: ReactElement;
  /** The card's width in px; it never grows past the window less 24 px. */
  width: number;
  /** `data-*` hooks on the card. */
  cardProps?: Record<`data-${string}`, string>;
  /**
   * Shows the card's text in session recordings (`data-ph-unmask`). Only for
   * ADE's own words; never for content from the user's apps or files.
   */
  unmask?: boolean;
  children: ReactNode;
}): JSX.Element {
  const portalContainer = usePortalContainer();
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal container={portalContainer ?? undefined}>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          avoidCollisions
          className="outline-none"
          style={{ zIndex: Z_LAYERS.popover }}
        >
          <div
            {...cardProps}
            {...(unmask ? { "data-ph-unmask": "" } : {})}
            className="flex max-w-[calc(100vw-24px)] flex-col gap-2 rounded-xl border border-fg/[0.08] bg-(color:--work-popover-bg) p-3 shadow-[0_18px_48px_rgba(0,0,0,0.58)] backdrop-blur-md"
            style={{ width }}
          >
            {children}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
