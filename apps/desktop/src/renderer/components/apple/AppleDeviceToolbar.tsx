import { Fragment } from "react";
import type { Icon } from "@phosphor-icons/react";
import {
  ArrowClockwise,
  ArrowsClockwise,
  Camera,
  Cube,
  DeviceMobile,
  DotsThree,
  House,
  MagnifyingGlass,
  Moon,
  PictureInPicture,
  Record,
  Rectangle,
  SlidersHorizontal,
  Stop,
  Sun,
  TextAa,
  Vibrate,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";

/**
 * The floating rail beside the device, and its narrow-column fallback.
 *
 * The rail OVERLAYS the stage — `pointer-events-none` on the rail,
 * `pointer-events-auto` on the pill — so it never reserves a gutter and the
 * device never shrinks when the toolbar grows. Below 420px of column that
 * overlay would cover more than a third of the screen, so the same buttons move
 * into the header as one scrollable row instead. The swap is a layout change
 * and nothing else: the stream is never torn down by it.
 */

export type AppleToolbarPlacement = "rail" | "header" | "hidden";

export type AppleDeviceToolbarLayout = {
  toolbar: AppleToolbarPlacement;
  /** Docked drawer sits beside the stage; overlay floats over it with a scrim. */
  drawer: "docked" | "overlay";
  /** The four-button strip under the stage. */
  quickStrip: boolean;
  /** The 3D / Flat pair collapses to a single "switch to the other mode" button. */
  collapseViewToggle: boolean;
  /** 3D is refused below this width — the body has nowhere to be. */
  allows3d: boolean;
};

/** Measured on the COLUMN, never the window. */
export const APPLE_COLUMN_MIN_WIDTH = 200;
export const APPLE_COLUMN_DOCK_DRAWER_WIDTH = 700;
export const APPLE_COLUMN_HEADER_TOOLBAR_WIDTH = 420;
export const APPLE_COLUMN_QUICK_STRIP_WIDTH = 280;

/**
 * Pure, and the whole breakpoint table in one place, because the alternative —
 * four independent `width < N` reads spread across the column — is how one of
 * them drifts.
 */
export function resolveAppleDeviceToolbarLayout(
  width: number,
  options: { hasDevice?: boolean } = {},
): AppleDeviceToolbarLayout {
  const hasDevice = options.hasDevice ?? true;
  const wide = width >= APPLE_COLUMN_DOCK_DRAWER_WIDTH;
  const narrow = width < APPLE_COLUMN_HEADER_TOOLBAR_WIDTH;
  return {
    toolbar: !hasDevice ? "hidden" : narrow ? "header" : "rail",
    drawer: wide ? "docked" : "overlay",
    quickStrip: hasDevice && width >= APPLE_COLUMN_QUICK_STRIP_WIDTH,
    collapseViewToggle: narrow,
    allows3d: !narrow,
  };
}

export type AppleToolbarActionId =
  | "home"
  | "rotate"
  | "shake"
  | "record"
  | "appearance"
  | "text-size"
  | "drawer"
  | "screenshot"
  | "inspect"
  | "float"
  | "overflow"
  | "view-3d"
  | "view-flat"
  | "reset-view";

export type AppleToolbarAction = {
  id: AppleToolbarActionId;
  label: string;
  icon: Icon;
  /** Pressed state, for the toggles (Inspect, Record, 3D/Flat). */
  active?: boolean;
  /**
   * Why the button is off. A disabled button shows this INSTEAD of its name —
   * "3D view needs WebGL" tells the user what to do; a greyed "3D" does not.
   */
  disabledReason?: string | null;
  tone?: "default" | "danger";
  onSelect: () => void;
};

export type AppleDeviceToolbarProps = {
  placement: Exclude<AppleToolbarPlacement, "hidden">;
  /** Groups are rendered in order, separated by a divider. */
  groups: AppleToolbarAction[][];
  className?: string;
};

const BUTTON = cn(
  "ade-shell-control inline-flex h-7 w-7 shrink-0 items-center justify-center",
  "disabled:cursor-not-allowed disabled:opacity-40",
);

const ACTIVE = "!border-cyan-300/35 !bg-cyan-400/18 text-cyan-50/95";
const DANGER_ACTIVE = "!border-rose-300/40 !bg-rose-400/20 text-rose-50/95";

export const APPLE_TOOLBAR_ICONS = {
  home: House,
  rotate: ArrowsClockwise,
  shake: Vibrate,
  record: Record,
  stop: Stop,
  appearanceLight: Sun,
  appearanceDark: Moon,
  textSize: TextAa,
  drawer: SlidersHorizontal,
  screenshot: Camera,
  inspect: MagnifyingGlass,
  float: PictureInPicture,
  overflow: DotsThree,
  view3d: Cube,
  viewFlat: Rectangle,
  resetView: ArrowClockwise,
  device: DeviceMobile,
} as const;

function ToolbarButton({ action }: { action: AppleToolbarAction }) {
  const Icon = action.icon;
  const disabled = Boolean(action.disabledReason);
  return (
    <PaneTooltip label={action.disabledReason ?? action.label}>
      <button
        type="button"
        data-apple-toolbar-action={action.id}
        data-active={action.active ? "true" : undefined}
        aria-label={action.label}
        aria-pressed={action.active ?? undefined}
        disabled={disabled}
        className={cn(
          BUTTON,
          action.active ? (action.tone === "danger" ? DANGER_ACTIVE : ACTIVE) : null,
        )}
        onClick={action.onSelect}
      >
        <Icon size={14} weight={action.active ? "fill" : "regular"} />
      </button>
    </PaneTooltip>
  );
}

export function AppleDeviceToolbar({ placement, groups, className }: AppleDeviceToolbarProps) {
  const populated = groups.filter((group) => group.length > 0);
  if (populated.length === 0) return null;

  if (placement === "header") {
    return (
      <div
        data-apple-toolbar="header"
        className={cn(
          "flex h-8 w-full min-w-0 items-center gap-1 overflow-x-auto px-2",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          className,
        )}
      >
        {populated.map((group, index) => (
          <Fragment key={group[0]?.id ?? index}>
            {index > 0 ? <span className="h-4 w-px shrink-0 bg-white/[0.10]" /> : null}
            {group.map((action) => <ToolbarButton key={action.id} action={action} />)}
          </Fragment>
        ))}
      </div>
    );
  }

  return (
    <div
      data-apple-toolbar="rail"
      className={cn(
        "pointer-events-none absolute inset-y-0 right-0 z-20 flex w-14 items-center justify-center",
        className,
      )}
    >
      <div
        className={cn(
          "pointer-events-auto flex max-h-full flex-col items-center gap-1 overflow-y-auto",
          "rounded-lg border border-white/[0.08] bg-black/62 p-1 shadow-lg backdrop-blur",
          "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {populated.map((group, index) => (
          <Fragment key={group[0]?.id ?? index}>
            {index > 0 ? <span className="my-0.5 h-px w-5 shrink-0 bg-white/[0.10]" /> : null}
            {group.map((action) => <ToolbarButton key={action.id} action={action} />)}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
