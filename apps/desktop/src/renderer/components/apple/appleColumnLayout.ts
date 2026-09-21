/**
 * Geometry and presence rules for the Apple device column — the Work tab's
 * third pane.
 *
 * The device used to live inside the shared tools pane, which meant a black
 * stage, a floating toolbar and an edge-docked drawer all competing for the
 * same 280–600px the Git diff and the Files tree were sized for. The spec
 * (`docs/plans/apple-device-env.md` §2a) promotes it: an open device gets its
 * OWN full-height column beside the chat, with its own splitter and its own
 * persisted width, and the tools pane keeps only the empty/create state.
 *
 * Everything here is pure so the arithmetic can be tested without a layout
 * engine — the pane supplies its container's width, exactly as
 * `workSidebarSplitter.ts` does for the tools pane. The two modules are
 * deliberately separate: they defend different floors (200px of device versus
 * 280px of tool chrome) and a shared "clamp a pane" helper would have to take
 * both, which is how one pane's rule silently becomes the other's.
 */

import { APPLE_COLUMN_MIN_WIDTH } from "./AppleDeviceToolbar";
import type { AppleLaneDevice } from "../../../shared/types";
import {
  MIN_WORK_CONTENT_PANE_PX,
  WORK_SIDEBAR_SPLITTER_PX,
} from "../terminals/workSidebarSplitter";

/** Taste floor/ceiling for the column, as a percentage of the Work row. */
export const MIN_APPLE_COLUMN_WIDTH_PCT = 18;
export const MAX_APPLE_COLUMN_WIDTH_PCT = 60;

/** The width the column opens at the first time a lane has a device. */
export const DEFAULT_APPLE_COLUMN_WIDTH_PCT = 30;

/**
 * The spec's hard floor: "< 200px — column refuses to shrink further (min
 * width), the splitter stops". Re-exported from the toolbar's breakpoint table
 * so the splitter and the toolbar can never disagree about where 200 is.
 */
export const MIN_APPLE_COLUMN_PANE_PX = APPLE_COLUMN_MIN_WIDTH;

/** Same 5px hit area the tools pane's splitter uses. */
export const APPLE_COLUMN_SPLITTER_PX = WORK_SIDEBAR_SPLITTER_PX;

/** How much one arrow key moves the separator. */
export const APPLE_COLUMN_KEYBOARD_STEP_PCT = 2;

function clampPct(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamp a requested column width.
 *
 * `containerWidthPx` is the width of the row holding the chat column, the
 * Apple column, the tools pane and their splitters. `reservedPct` is whatever
 * the tools pane is already taking (0 when it is closed), so the chat column's
 * floor is measured against what is actually left rather than against a row
 * that pretends the tools pane is not there.
 *
 * With too little room to honour both pixel floors the DEVICE floor wins: a
 * 150px-wide device is not a device, while a tight chat column is merely
 * tight — the same call `workSidebarSplitter.ts` makes for its own chrome.
 */
export function clampAppleColumnWidthPct(
  widthPct: number,
  containerWidthPx?: number | null,
  reservedPct = 0,
): number {
  const requested = Number.isFinite(widthPct) ? widthPct : DEFAULT_APPLE_COLUMN_WIDTH_PCT;
  const byTaste = clampPct(requested, MIN_APPLE_COLUMN_WIDTH_PCT, MAX_APPLE_COLUMN_WIDTH_PCT);
  if (containerWidthPx == null || !Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
    return byTaste;
  }
  const reserved = Number.isFinite(reservedPct) ? Math.max(0, reservedPct) : 0;
  const usable = Math.max(containerWidthPx - APPLE_COLUMN_SPLITTER_PX, 1);
  const pixelFloorPct = (MIN_APPLE_COLUMN_PANE_PX / usable) * 100;
  const pixelCeilingPct = ((usable - MIN_WORK_CONTENT_PANE_PX) / usable) * 100 - reserved;
  const lower = Math.max(MIN_APPLE_COLUMN_WIDTH_PCT, pixelFloorPct);
  const upper = Math.min(MAX_APPLE_COLUMN_WIDTH_PCT, pixelCeilingPct);
  if (lower > upper) return Math.min(lower, 100 - reserved);
  return clampPct(requested, lower, upper);
}

/** Column width in pixels for a given percentage — what the clamp defends. */
export function appleColumnWidthPx(widthPct: number, containerWidthPx: number): number {
  const usable = Math.max(containerWidthPx - APPLE_COLUMN_SPLITTER_PX, 0);
  return (usable * widthPct) / 100;
}

/**
 * The next width for one keypress on the separator.
 *
 * ArrowLeft grows the column because the column is to the RIGHT of the chat:
 * the key moves the separator, which is the thing under the caret.
 */
export function nextAppleColumnWidthPctForKey(
  key: string,
  widthPct: number,
  containerWidthPx?: number | null,
  reservedPct = 0,
): number | null {
  switch (key) {
    case "ArrowLeft":
      return clampAppleColumnWidthPct(widthPct + APPLE_COLUMN_KEYBOARD_STEP_PCT, containerWidthPx, reservedPct);
    case "ArrowRight":
      return clampAppleColumnWidthPct(widthPct - APPLE_COLUMN_KEYBOARD_STEP_PCT, containerWidthPx, reservedPct);
    case "Home":
      return clampAppleColumnWidthPct(MIN_APPLE_COLUMN_WIDTH_PCT, containerWidthPx, reservedPct);
    case "End":
      return clampAppleColumnWidthPct(MAX_APPLE_COLUMN_WIDTH_PCT, containerWidthPx, reservedPct);
    default:
      return null;
  }
}

/**
 * Is the Apple column on screen for this lane?
 *
 * Presence is driven by the DEVICE, not by the tools picker: the column is the
 * device's home, so it appears when the lane has one and disappears when the
 * device is deleted. The header's `×` is a per-device dismissal rather than a
 * boolean — closing the column "does not shut the device down; it keeps running
 * and the corner card takes over" (spec §2a), and the next device the lane gets
 * is a new thing to look at, so a stale dismissal must not hide it.
 */
export function selectAppleColumnVisible(args: {
  device: AppleLaneDevice | null;
  /** The udid the user last closed the column for, in this lane. */
  closedUdid: string | null | undefined;
}): boolean {
  const udid = args.device?.udid?.trim();
  if (!udid) return false;
  return args.closedUdid !== udid;
}
