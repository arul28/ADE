import type { AppleWindowFrame, AppleWindowLayoutAction } from "../../../shared/types/iosSimulator";

/**
 * Where iPadOS puts a window for each layout of its window menu, and whether
 * a window that was read back sits there.
 *
 * Measured on an iPad Pro 11-inch (M5), iPadOS 27.0, both ways up:
 *
 * | layout   | portrait 834x1210        | landscape 1210x834       |
 * |----------|--------------------------|--------------------------|
 * | left     | 412x1087 at 0,0          | 600x711 at 0,0           |
 * | right    | 412x1087 at 422,0        | 600x711 at 610,0         |
 * | top      | 834x600 at 0,0           | 1210x486 at 0,0          |
 * | bottom   | 834x600 at 0,610         | 1210x486 at 0,385        |
 * | split    | 412x1210 at 0,0          | (a left or right slot)   |
 * | thirds   | 375x1210 at 0,0          | 396x834 at 0,0           |
 * | quarters | 412x600 at 0,0           | 600x486 at 0,0           |
 *
 * Slots are the screen's halves, thirds or quarters with a 10-point gap
 * between them. A full-height slot stops above the Dock when it shows (123
 * points), so its height is only checked to be most of the screen. A window
 * cannot shrink below its app's minimum size: in landscape the test app's
 * 486-point minimum height overflows a 412-point half, and the bottom half
 * then hangs 37 points past the screen's bottom edge; in portrait its
 * 375-point minimum width overflows a 271-point third. So along an axis
 * where the window is larger than its slot, it lands when it is centred on
 * the slot or flush with the screen edge the slot touches, and only there
 * may it run off the screen (a left third centred on its slot hangs past the
 * left edge, controls and all; the verdict's note says so).
 */

export type AppleWindowSlot = AppleWindowFrame & { fullHeight: boolean };

const GAP = 10;
const SLACK = 24;

/** The slots a layout can put the front window in, in screen points for this orientation. */
export function appleWindowSlots(action: AppleWindowLayoutAction, screen: { width: number; height: number }): AppleWindowSlot[] {
  const W = screen.width;
  const H = screen.height;
  const halfW = (W - GAP) / 2;
  const halfH = (H - GAP) / 2;
  const third = (W - 2 * GAP) / 3;
  const left = { x: 0, y: 0, width: halfW, height: H, fullHeight: true };
  const right = { x: halfW + GAP, y: 0, width: halfW, height: H, fullHeight: true };
  const top = { x: 0, y: 0, width: W, height: halfH, fullHeight: false };
  const bottom = { x: 0, y: halfH + GAP, width: W, height: halfH, fullHeight: false };
  switch (action) {
    case "fill": return [{ x: 0, y: 0, width: W, height: H, fullHeight: false }];
    case "left": return [left];
    case "right": return [right];
    case "top": return [top];
    case "bottom": return [bottom];
    case "split": return [left, right];
    case "thirds": return [0, 1, 2].map((index) => ({ x: index * (third + GAP), y: 0, width: third, height: H, fullHeight: true }));
    case "quarters": return [left, right].flatMap((column) => [top, bottom].map((row) => ({
      x: column.x, y: row.y, width: column.width, height: row.height, fullHeight: false,
    })));
    default: return [];
  }
}

type AxisVerdict = { ok: boolean; oversized: boolean };

/** One axis of a window against one axis of its slot. */
function axisFits(position: number, size: number, slotPosition: number, slotSize: number, loose: boolean, screenSize: number): AxisVerdict {
  if (size <= slotSize + SLACK) {
    const sizeOk = loose ? size >= slotSize * 0.8 : Math.abs(size - slotSize) <= SLACK;
    return { ok: Math.abs(position - slotPosition) <= SLACK && sizeOk, oversized: false };
  }
  // Larger than the slot (the app's minimum size): iPadOS centres it on the
  // slot (the landscape bottom half: 486 points on a 412-point slot at 422
  // lands at 385), or keeps it flush with the screen edge the slot touches
  // (the portrait left third: 375 points at 0). Either way it is still
  // clearly a part of the screen, not all of it (a filled window is no half).
  const centred = Math.abs(position + size / 2 - (slotPosition + slotSize / 2)) <= SLACK;
  const flush = (Math.abs(slotPosition) <= 1 && Math.abs(position) <= 1)
    || (Math.abs(slotPosition + slotSize - screenSize) <= 1 && Math.abs(position + size - screenSize) <= 1);
  return { ok: size < screenSize * 0.75 && (centred || flush), oversized: true };
}

export type AppleWindowVerdict = {
  landed: boolean;
  /** Set when the window landed larger than its slot along an axis (the app's minimum size), and how. */
  note: string | null;
  /** The window is past a screen edge along an axis where it is not larger than its slot. */
  strayOffScreen: boolean;
};

/**
 * Did the window land where `action` puts it? Slide Over has no slot: it
 * lands as a narrow window, wholly on the screen, that changed.
 */
export function judgeAppleWindowLayout(
  action: AppleWindowLayoutAction,
  frame: AppleWindowFrame,
  screen: { width: number; height: number },
  before: AppleWindowFrame | null,
): AppleWindowVerdict {
  const off = {
    left: Math.max(0, -frame.x),
    top: Math.max(0, -frame.y),
    right: Math.max(0, frame.x + frame.width - screen.width),
    bottom: Math.max(0, frame.y + frame.height - screen.height),
  };
  const offX = off.left > 1 || off.right > 1;
  const offY = off.top > 1 || off.bottom > 1;
  if (action === "slide-over") {
    const changed = !before || before.x !== frame.x || before.y !== frame.y || before.width !== frame.width || before.height !== frame.height;
    return { landed: frame.width < screen.width / 2 + SLACK && !offX && !offY && changed, note: null, strayOffScreen: offX || offY };
  }
  let strayOnly = offX || offY;
  for (const slot of appleWindowSlots(action, screen)) {
    const x = axisFits(frame.x, frame.width, slot.x, slot.width, false, screen.width);
    const y = axisFits(frame.y, frame.height, slot.y, slot.height, slot.fullHeight, screen.height);
    if (!x.ok || !y.ok) continue;
    // Off the screen only where the window outgrew its slot.
    const stray = (offX && !x.oversized) || (offY && !y.oversized);
    if (stray) {
      strayOnly = true;
      continue;
    }
    const grown = [
      x.oversized ? `its width (${Math.round(frame.width)}) is larger than the ${Math.round(slot.width)}-point slot` : null,
      y.oversized ? `its height (${Math.round(frame.height)}) is larger than the ${Math.round(slot.height)}-point slot` : null,
    ].filter(Boolean);
    const past = Object.entries(off).filter(([, value]) => value > 1).map(([side, value]) => `${Math.round(value)} pt past the ${side} edge`);
    return {
      landed: true,
      note: grown.length
        ? `The app's minimum size: ${grown.join(" and ")}${past.length ? `, so it runs ${past.join(", ")}` : ""}.`
        : null,
      strayOffScreen: false,
    };
  }
  return { landed: false, note: null, strayOffScreen: strayOnly };
}
