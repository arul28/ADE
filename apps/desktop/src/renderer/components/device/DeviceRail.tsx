import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import { PaneTooltip } from "../ui/PaneTooltip";
import { MENU_CONTENT_CLASS } from "../ui/paneMenuTokens";
import type { DeviceToolId } from "./deviceTool";

/** Below this a device rail keeps only its first controls and More. */
export const DEVICE_RAIL_COMPACT_WIDTH = 360;

/** The rail's width in CSS pixels (`w-14`): what the device screen keeps clear of. */
export const DEVICE_RAIL_WIDTH = 56;

/**
 * The pill on the right edge of a device picture. The Apple and Android
 * rails share its place, size and classes, so moving between the two tools
 * is easy. `tool` names the rail's own `data-{tool}-rail` marker.
 */
export function DeviceRail({
  tool,
  compact,
  children,
}: {
  tool: DeviceToolId;
  compact: boolean;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label="Device controls"
      {...{ [`data-${tool}-rail`]: compact ? "compact" : "full" }}
      className="pointer-events-none absolute inset-y-0 right-0 z-10 flex w-14 flex-col items-center justify-center py-3 pr-2"
    >
      <div
        /*
         * §B3: an OPAQUE pill. Round 2 used `bg-bg/80` with a backdrop blur,
         * which over a live device is twelve icons read through a frosted
         * smear of whatever the app happens to be showing — the blur changed
         * every frame, so the icons flickered.
         */
        className={cn(
          "pointer-events-auto flex shrink-0 flex-col items-center gap-1 overflow-y-auto",
          "rounded-full border border-border bg-surface p-1 shadow-md",
          "[scrollbar-width:none]",
        )}
      >
        {children}
      </div>
    </aside>
  );
}

export function RailDivider() {
  return <div aria-hidden="true" className="my-1 h-px w-5 shrink-0 bg-border" />;
}

/**
 * Every rail control is the shared `Button` (§B6) trimmed to a 28px circle:
 * same focus ring, same disabled rule, same press feedback as every other
 * button in ADE. The size and the radius are the only things overridden.
 */
const RAIL_BUTTON_CLASS = cn(
  "h-7 w-7 shrink-0 gap-0 rounded-full p-0",
  "text-muted-fg hover:bg-fg/[0.07] hover:text-fg",
  "disabled:cursor-not-allowed disabled:opacity-40",
);

export function RailButton({
  label,
  description,
  disabled,
  pressed,
  className,
  onClick,
  children,
}: {
  label: string;
  description?: string | null;
  disabled?: boolean;
  pressed?: boolean;
  className?: string | undefined;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <PaneTooltip label={description ?? label} side="left">
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={cn(RAIL_BUTTON_CLASS, pressed && "bg-secondary text-fg", className)}
      >
        {children}
      </Button>
    </PaneTooltip>
  );
}

export function RailMenu({
  label,
  icon,
  disabled,
  children,
}: {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Root>
      <PaneTooltip label={label} side="left">
        <DropdownMenu.Trigger asChild>
          <Button variant="ghost" size="sm" aria-label={label} disabled={disabled} className={RAIL_BUTTON_CLASS}>
            {icon}
          </Button>
        </DropdownMenu.Trigger>
      </PaneTooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={MENU_CONTENT_CLASS} side="left" align="center" sideOffset={6}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
