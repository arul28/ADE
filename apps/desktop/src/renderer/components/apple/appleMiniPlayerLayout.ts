/**
 * Where the floating device sits, and how big it is.
 *
 * Ported from t3's preview mini player: width is the only free dimension,
 * height always follows the device's aspect so the picture fills the frame
 * without letterboxing, and the clamp runs on every layout pass rather than
 * being written back to the store — so a temporarily narrow window can never
 * destroy the size the user chose.
 */

export const APPLE_MINI_PLAYER_EDGE_GAP = 12;
export const APPLE_MINI_PLAYER_CORNER_RADIUS = 12;
/** A fresh player is the largest box at the device aspect that fits in here. */
const DEFAULT_BOX = { width: 320, height: 320 } as const;
const MIN_SIZE = { width: 240, height: 150 } as const;

export type AppleMiniPlayerSize = { width: number; height: number };
export type AppleMiniPlayerPosition = { x: number; y: number };
export type AppleMiniPlayerFrame = AppleMiniPlayerPosition & AppleMiniPlayerSize;

export type AppleMiniPlayerResizeDirection =
  | "north"
  | "south"
  | "east"
  | "west"
  | "north-east"
  | "north-west"
  | "south-east"
  | "south-west";

/** The device screen as the user sees it, so a rotated phone floats landscape. */
export function appleMiniPlayerSourceSize(
  screen: AppleMiniPlayerSize | null,
): AppleMiniPlayerSize {
  if (!screen || screen.width <= 0 || screen.height <= 0) {
    // The usual phone shape stands in until the first frame reports a size.
    return { width: 1_000, height: 1_000 / (9 / 19.5) };
  }
  return screen;
}

function fitWidth(
  desiredWidth: number,
  source: AppleMiniPlayerSize,
  max: AppleMiniPlayerSize,
): AppleMiniPlayerSize {
  const aspect = source.width / source.height;
  const width = Math.min(
    Math.max(desiredWidth, MIN_SIZE.width, MIN_SIZE.height * aspect),
    Math.max(1, max.width),
    Math.max(1, max.height * aspect),
  );
  return { width: Math.round(width), height: Math.round(width / aspect) };
}

function defaultWidth(source: AppleMiniPlayerSize): number {
  return Math.min(DEFAULT_BOX.width, (DEFAULT_BOX.height * source.width) / source.height);
}

const availableArea = (container: AppleMiniPlayerSize): AppleMiniPlayerSize => ({
  width: container.width - APPLE_MINI_PLAYER_EDGE_GAP * 2,
  height: container.height - APPLE_MINI_PLAYER_EDGE_GAP * 2,
});

/** Keeps the player fully inside the container, gap included. */
export function clampAppleMiniPlayerPosition(
  position: AppleMiniPlayerPosition,
  container: AppleMiniPlayerSize,
  player: AppleMiniPlayerSize,
): AppleMiniPlayerPosition {
  const gap = APPLE_MINI_PLAYER_EDGE_GAP;
  return {
    x: Math.min(
      Math.max(position.x, gap),
      Math.max(gap, container.width - player.width - gap),
    ),
    y: Math.min(
      Math.max(position.y, gap),
      Math.max(gap, container.height - player.height - gap),
    ),
  };
}

/** The on-screen frame from the stored width and position. No position = top right. */
export function resolveAppleMiniPlayerFrame(input: {
  width: number | null;
  position: AppleMiniPlayerPosition | null;
  source: AppleMiniPlayerSize;
  container: AppleMiniPlayerSize;
}): AppleMiniPlayerFrame {
  const { width, position, source, container } = input;
  const size = fitWidth(width ?? defaultWidth(source), source, availableArea(container));
  const anchored = position ?? {
    x: container.width - APPLE_MINI_PLAYER_EDGE_GAP - size.width,
    y: APPLE_MINI_PLAYER_EDGE_GAP,
  };
  return { ...clampAppleMiniPlayerPosition(anchored, container, size), ...size };
}

/**
 * Resizes from any edge or corner while holding the aspect ratio. The edge
 * opposite the dragged one stays anchored, so the pointer keeps tracking the
 * edge it grabbed.
 */
export function resizeAppleMiniPlayer(input: {
  start: AppleMiniPlayerFrame;
  direction: AppleMiniPlayerResizeDirection;
  delta: AppleMiniPlayerPosition;
  source: AppleMiniPlayerSize;
  container: AppleMiniPlayerSize;
}): AppleMiniPlayerFrame {
  const { start, direction, delta, source, container } = input;
  const gap = APPLE_MINI_PLAYER_EDGE_GAP;
  const east = direction.includes("east");
  const west = direction.includes("west");
  const north = direction.includes("north");
  const south = direction.includes("south");
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const max = {
    width: west
      ? right - gap
      : east
        ? container.width - gap - start.x
        : container.width - gap * 2,
    height: north
      ? bottom - gap
      : south
        ? container.height - gap - start.y
        : container.height - gap * 2,
  };
  const desiredWidth = start.width + (east ? delta.x : west ? -delta.x : 0);
  const desiredHeight = start.height + (south ? delta.y : north ? -delta.y : 0);
  const horizontal = east || west;
  const vertical = north || south;
  const widthLeads = horizontal && !vertical
    ? true
    : vertical && !horizontal
      ? false
      : Math.abs(desiredWidth - start.width) / start.width
        >= Math.abs(desiredHeight - start.height) / start.height;
  const size = fitWidth(
    widthLeads ? desiredWidth : (desiredHeight * source.width) / source.height,
    source,
    max,
  );
  const position = clampAppleMiniPlayerPosition(
    { x: west ? right - size.width : start.x, y: north ? bottom - size.height : start.y },
    container,
    size,
  );
  return { ...position, ...size };
}
