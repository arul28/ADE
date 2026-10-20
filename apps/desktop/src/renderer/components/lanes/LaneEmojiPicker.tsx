import React from "react";
import * as Popover from "@radix-ui/react-popover";
import { usePortalContainer } from "../ui/portalContainer";
import { Z_LAYERS } from "../ui/zLayers";

const LaneEmojiPickerContent = React.lazy(() => import("./LaneEmojiPickerContent"));

export function LaneEmojiPicker({
  value,
  onChange,
  disabled = false,
  label = "Lane emoji",
  overlayLayer = Z_LAYERS.dialogPopover,
  trigger,
}: {
  value: string | null | undefined;
  onChange: (emoji: string | null) => void;
  disabled?: boolean;
  label?: string;
  overlayLayer?: number;
  /** Optional custom trigger, for using the picker as a name-field slot. */
  trigger?: React.ReactElement;
}) {
  const [open, setOpen] = React.useState(false);
  const portalContainer = usePortalContainer();

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        {trigger ?? (
          <button
            type="button"
            className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-fg/[0.1] bg-fg/[0.035] px-2 text-sm text-fg/85 hover:bg-fg/[0.07] disabled:opacity-45"
            aria-label={value ? `Change lane emoji, current ${value}` : "Set lane emoji"}
            title={label}
            disabled={disabled}
          >
            {value || <span className="text-xs text-muted-fg">＋</span>}
          </button>
        )}
      </Popover.Trigger>
      {open ? (
        <Popover.Portal container={portalContainer ?? undefined}>
          <Popover.Content
            side="bottom"
            align="start"
            sideOffset={5}
            collisionPadding={10}
            className="w-72 rounded-xl border border-fg/[0.12] bg-background p-2 shadow-xl"
            style={{ zIndex: overlayLayer }}
            onOpenAutoFocus={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.stopPropagation();
            }}
          >
            <React.Suspense fallback={<div className="px-2 py-4 text-center text-xs text-muted-fg">Loading emoji picker…</div>}>
              <LaneEmojiPickerContent
                value={value}
                onChange={onChange}
                onClose={() => setOpen(false)}
                disabled={disabled}
                label={label}
              />
            </React.Suspense>
          </Popover.Content>
        </Popover.Portal>
      ) : null}
    </Popover.Root>
  );
}
