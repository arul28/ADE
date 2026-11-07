import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check } from "@phosphor-icons/react";
import type { DeviceOrientation } from "../../../shared/types/deviceOrientation";
import { MENU_ITEM_CLASS } from "../ui/paneMenuTokens";

/* ── Orientation control (round 5 §V2) ────────────────────────────────────── */

/**
 * What the rail's orientation control calls each value.
 *
 * Round 4 had one "Rotate device" button that cycled blind: nothing on screen
 * said which way up the device was, and the owner could not find the control
 * at all. §V2 replaces it with a menu that NAMES the current orientation, so
 * these strings are the control's whole vocabulary — they are what the button
 * announces and what each menu item reads.
 */
export function deviceOrientationLabel(orientation: DeviceOrientation): string {
  switch (orientation) {
    case "portrait":
      return "Portrait";
    case "portrait-upside-down":
      return "Portrait upside down";
    case "landscape-left":
      return "Landscape left";
    case "landscape-right":
      return "Landscape right";
    default: {
      const _exhaustive: never = orientation;
      return _exhaustive;
    }
  }
}

/** The menu's order: the two portraits, then the two landscapes. */
export const DEVICE_ORIENTATION_CHOICES = [
  "portrait",
  "portrait-upside-down",
  "landscape-left",
  "landscape-right",
] as const satisfies readonly DeviceOrientation[];

/**
 * How far to turn the control's own glyph so it reads as the device's pose.
 *
 * The same sign convention as the picture (`screenRotationFor`): positive is
 * clockwise, so a device in `landscape-left` shows an icon turned the way the
 * device itself is turned.
 */
export function deviceOrientationIconDegrees(orientation: DeviceOrientation): number {
  switch (orientation) {
    case "portrait":
      return 0;
    case "portrait-upside-down":
      return 180;
    case "landscape-left":
      return 90;
    case "landscape-right":
      return -90;
    default: {
      const _exhaustive: never = orientation;
      return _exhaustive;
    }
  }
}

/**
 * The four orientations as rail menu items, the current one checked. The
 * Apple and Android rails both use it. No `onOrientation` shows them disabled.
 */
export function OrientationMenuItems({
  orientation,
  onOrientation,
}: {
  orientation: DeviceOrientation;
  onOrientation: ((orientation: DeviceOrientation) => void) | undefined;
}) {
  return <>{DEVICE_ORIENTATION_CHOICES.map((choice) => (
    <DropdownMenu.Item
      key={choice}
      className={MENU_ITEM_CLASS}
      disabled={!onOrientation}
      aria-checked={choice === orientation}
      onSelect={() => onOrientation?.(choice)}
    >
      {choice === orientation ? <Check size={14} weight="bold" /> : <span className="w-[14px]" aria-hidden="true" />}
      {deviceOrientationLabel(choice)}
    </DropdownMenu.Item>
  ))}</>;
}
