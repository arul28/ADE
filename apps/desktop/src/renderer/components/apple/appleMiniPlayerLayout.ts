/**
 * Where the floating device sits, and how big it is.
 *
 * The geometry is the shared floating player's (`floatingPlayerLayout`), which
 * the floating Mac Desktop uses too. The one Apple-specific rule here is the
 * stand-in shape before the first frame: a phone.
 */

import {
  FLOATING_PLAYER_CORNER_RADIUS,
  FLOATING_PLAYER_EDGE_GAP,
  clampFloatingPlayerPosition,
  floatingPlayerSourceSize,
  resizeFloatingPlayer,
  resolveFloatingPlayerFrame,
  type FloatingPlayerFrame,
  type FloatingPlayerPosition,
  type FloatingPlayerResizeDirection,
  type FloatingPlayerSize,
} from "../shared/floatingPlayerLayout";

export const APPLE_MINI_PLAYER_EDGE_GAP = FLOATING_PLAYER_EDGE_GAP;
export const APPLE_MINI_PLAYER_CORNER_RADIUS = FLOATING_PLAYER_CORNER_RADIUS;

export type AppleMiniPlayerSize = FloatingPlayerSize;
export type AppleMiniPlayerPosition = FloatingPlayerPosition;
export type AppleMiniPlayerFrame = FloatingPlayerFrame;
export type AppleMiniPlayerResizeDirection = FloatingPlayerResizeDirection;

/** The usual phone shape, until the first frame reports a size. */
const PHONE_FALLBACK: AppleMiniPlayerSize = { width: 1_000, height: 1_000 / (9 / 19.5) };

/** The device screen as the user sees it, so a rotated phone floats landscape. */
export function appleMiniPlayerSourceSize(
  screen: AppleMiniPlayerSize | null,
): AppleMiniPlayerSize {
  return floatingPlayerSourceSize(screen, PHONE_FALLBACK);
}

export const clampAppleMiniPlayerPosition = clampFloatingPlayerPosition;
export const resolveAppleMiniPlayerFrame = resolveFloatingPlayerFrame;
export const resizeAppleMiniPlayer = resizeFloatingPlayer;
