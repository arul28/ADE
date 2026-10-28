import type {
  AppleWindowFrame,
  AppleWindowLayoutAction,
  AppleWindowLayoutArgs,
  AppleWindowLayoutResult,
  IosScreenElement,
  IosScreenSnapshot,
  IosScreenSnapshotArgs,
} from "../../../shared/types/iosSimulator";
import {
  APPLE_NAMED_KEY_USAGES,
  APPLE_WINDOW_LAYOUT_ACTIONS,
  APPLE_WINDOWING_UNAVAILABLE_CODE,
} from "../../../shared/types/iosSimulator";
import { AdeExpectedError } from "../../../shared/expectedError";
import { appleWindowOffScreen, appleWindowSlots, describeAppleWindowOffScreen, judgeAppleWindowLayout } from "./appleWindowLayout";
import { APPLE_HELPER_UNAVAILABLE_CODE, SimHelperError, type SimHelperTransport } from "./simHelperClient";

/**
 * `ade apple window`: an iPad's front window, read and laid out the way a
 * person does it (the top strip to move it, the corner grabber to size it,
 * the green Zoom button's menu for the tiled layouts). Every gesture runs in
 * the Apple service's control queue, through its helper, in screen points.
 */

/** Points measured on what a screenshot and the accessibility tree show, or on the raw framebuffer a viewer draws. */
type PointSpace = "frame" | "screen";

export type AppleWindowControlDeps = {
  readAccessibilityElements: (deviceUdid: string) => Promise<{ elements: IosScreenElement[] }>;
  /** The elements under one point, or null when nothing answers there. */
  readAccessibilityElementAt: (deviceUdid: string, x: number, y: number) => Promise<IosScreenElement[] | null>;
  enqueueControl: <T>(action: string, runControl: () => Promise<T>, timeoutMs?: number) => Promise<T>;
  helperGesture: <T>(gesture: (send: SimHelperTransport["send"]) => Promise<T>) => Promise<T>;
  helperTap: (deviceUdid: string, x: number, y: number, space: PointSpace) => Promise<void>;
  helperSwipe: (
    deviceUdid: string,
    input: { startX: number; startY: number; endX: number; endY: number; durationMs?: number | null },
    space: PointSpace,
  ) => Promise<void>;
  /** A finger held down at one point for `durationMs`, then lifted. */
  helperHold: (deviceUdid: string, x: number, y: number, durationMs: number, space: PointSpace) => Promise<void>;
  getScreenSnapshot: (snapshotArgs: IosScreenSnapshotArgs) => Promise<IosScreenSnapshot>;
  /** The device is in use: the idle power-off clock starts again. */
  touchDevice: (deviceUdid: string) => void;
  logger: { debug: (event: string, data?: Record<string, unknown>) => void };
};

/** The iPad Dock's height in points (iPad Pro 11-inch, iPadOS 27, both orientations): a full-height tile and a moved window stop above it. */
const APPLE_IPAD_DOCK_HEIGHT = 123;

/** SpringBoard's "Window Controls, <app>" button: `window-controls:<bundle id>`. */
const WINDOW_CONTROLS_PREFIX = "window-controls:";

const ESCAPE_USAGE = APPLE_NAMED_KEY_USAGES.escape;

function isWindowControlsElement(element: IosScreenElement): boolean {
  return Boolean(element.identifier?.startsWith(WINDOW_CONTROLS_PREFIX));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAppleWindowControl(deps: AppleWindowControlDeps) {
  /**
   * The elements at one point. A point that cannot be read is a miss (the
   * searches below try many), but a helper that is gone fails the whole read
   * rather than turning into "no window".
   */
  const readPoint = async (deviceUdid: string, x: number, y: number): Promise<IosScreenElement[] | null> => {
    try {
      return await deps.readAccessibilityElementAt(deviceUdid, Math.round(x), Math.round(y));
    } catch (error) {
      if (error instanceof SimHelperError && error.code === APPLE_HELPER_UNAVAILABLE_CODE) throw error;
      return null;
    }
  };

  /** The front window each device had at the last read: where to look first next time. */
  const lastWindowFrames = new Map<string, AppleWindowFrame>();

  /**
   * The front app's window, read from the accessibility tree.
   *
   * The helper places a windowed app on the screen (`WindowPlacement.swift`):
   * its Application element's frame IS the window's screen frame, off-screen
   * parts included (x below 0 for a window hanging off the left edge). That
   * frame is the answer whenever the helper placed it. When it could not
   * (the element carries `ADEUnplaced`: a sparse app gives the search too
   * little to hit), the frame is inferred from SpringBoard's own elements,
   * which are always in screen points: the "Window Controls, <app>" button
   * (`window-controls:<bundle id>`) about 21 points in from the window's top
   * left, and the "Resize <app>" grabber (`resize-grabber`, its value naming
   * the corner, "Bottom Right" or "Bottom Left") on a bottom corner. The grid
   * walk misses those small elements easily, so they are hit-tested where
   * they can be. `placed` says which way the frame was read.
   */
  const readAppWindow = async (
    deviceUdid: string,
    screen: { width: number; height: number } | null = null,
    hints: Array<{ x: number; y: number }> = [],
  ): Promise<{
    windowed: boolean;
    placed: boolean;
    /** The app is in a window ADE could not find (the helper could not place it, and its grabber and controls did not answer). */
    lost?: boolean;
    bundleId: string | null;
    appName: string | null;
    frame: AppleWindowFrame | null;
    zoom: IosScreenElement | null;
    controls: IosScreenElement | null;
  }> => {
    const { elements } = await deps.readAccessibilityElements(deviceUdid);
    let controls = elements.find(isWindowControlsElement) ?? null;
    const app = elements.find((element) => (element.elementType ?? element.role) === "Application") ?? null;
    const zoom = elements.find((element) => element.identifier === "Zoom-button") ?? null;
    const appLabel = app?.label ?? null;
    const appName = appLabel ?? (controls?.label?.replace(/^Window Controls,\s*/u, "") || null);
    // Another window's grabber ("Resize Safari" beside "Resize VLD") is not this one.
    const isOurGrabber = (element: IosScreenElement) => element.identifier === "resize-grabber"
      && (!appLabel || !element.label || element.label === `Resize ${appLabel}`);
    const tried = new Set<string>();
    // Every point read is bounded as a whole: while the helper cannot place
    // a window, each of its point reads searches too, and can take seconds.
    const readDeadline = Date.now() + 30_000;
    const hitFind = async (x: number, y: number, match: (element: IosScreenElement) => boolean): Promise<IosScreenElement | null> => {
      const key = `${Math.round(x)},${Math.round(y)}`;
      if (Date.now() > readDeadline) return null;
      if (tried.has(key) || x < 0 || y < 0 || (screen && (x > screen.width || y > screen.height))) return null;
      tried.add(key);
      const hit = await readPoint(deviceUdid, x, y);
      return hit?.find(match) ?? null;
    };
    const findControls = async (frame: AppleWindowFrame): Promise<IosScreenElement | null> => {
      for (const y of [frame.y + 32, frame.y + 54]) {
        const found = await hitFind(frame.x + 41, y, isWindowControlsElement);
        if (found) return found;
      }
      return null;
    };
    const finish = (frame: AppleWindowFrame | null, windowed: boolean, placed: boolean) => {
      if (frame) lastWindowFrames.set(deviceUdid, frame);
      return {
        windowed,
        placed,
        bundleId: controls?.identifier?.slice(WINDOW_CONTROLS_PREFIX.length) || null,
        appName,
        frame,
        zoom,
        controls,
      };
    };
    if (!app) return finish(null, false, false);

    const placed = app.metadata.ADEUnplaced !== true;
    if (placed) {
      const frame = { x: app.frame.x, y: app.frame.y, width: app.frame.width, height: app.frame.height };
      // Placed, the frame is known; windowed mode is what the window's own
      // controls or grabber say (a filled window shows only the grabber).
      let grabber = elements.find(isOurGrabber) ?? null;
      if (!controls) controls = await findControls(frame);
      if (!controls && !grabber) {
        grabber = await hitFind(frame.x + frame.width - 8, frame.y + frame.height - 8, isOurGrabber)
          ?? await hitFind(frame.x + 8, frame.y + frame.height - 8, isOurGrabber);
      }
      // A placed frame that does not fill the screen is a window even when its
      // controls and grabber are off the screen.
      const fills = Boolean(screen && Math.abs(frame.x) <= 2 && Math.abs(frame.y) <= 2
        && Math.abs(frame.width - screen.width) <= 2 && Math.abs(frame.height - screen.height) <= 2);
      return finish(frame, Boolean(controls || grabber || (screen && !fills)), true);
    }

    // Not placed: infer the frame from SpringBoard's elements.
    let grabber = elements.find(isOurGrabber) ?? null;
    const width = app.frame.width;
    const height = app.frame.height;
    if (!grabber) {
      const origins: Array<{ x: number; y: number }> = [];
      if (controls) for (const inset of [21, 43]) origins.push({ x: controls.frame.x - 21, y: controls.frame.y - inset });
      const known = lastWindowFrames.get(deviceUdid);
      if (known && known.width === width && known.height === height) origins.push({ x: known.x, y: known.y });
      origins.push(...hints);
      if (screen) {
        const slots = (span: number, size: number) => {
          const values = new Set<number>([0, Math.max(0, span - size), Math.max(0, (span - size) / 2)]);
          for (let step = size; step + size <= span + 2; step += size) values.add(step);
          return [...values];
        };
        for (const y of slots(screen.height, height)) for (const x of slots(screen.width, width)) origins.push({ x, y });
      }
      for (const origin of origins) {
        // The grabber answers a little inside its corner, not on it.
        grabber = await hitFind(origin.x + width - 8, origin.y + height - 8, isOurGrabber)
          ?? await hitFind(origin.x + 8, origin.y + height - 8, isOurGrabber);
        if (grabber) break;
      }
      // Last: sweep every place a bottom corner can be, 20 points apart (the
      // grabber answers over about 20 points inside its corner).
      if (!grabber && screen) {
        sweep: for (let y = Math.min(screen.height, height) - 6; y <= screen.height; y += 20) {
          for (let x = 6; x <= screen.width; x += 20) {
            grabber = await hitFind(x, y, isOurGrabber);
            if (grabber) break sweep;
          }
        }
      }
    }
    if (!grabber && !controls) {
      // A window whose grabber is off the screen (hanging past the right or
      // bottom edge) is found by its controls: look near where it was last
      // seen or sent, 16 points apart.
      const near = [...hints, ...(lastWindowFrames.get(deviceUdid) ? [lastWindowFrames.get(deviceUdid)!] : [])];
      search: for (const origin of near) {
        for (let dy = -48; dy <= 48; dy += 16) {
          for (let dx = -48; dx <= 48; dx += 16) {
            for (const inset of [32, 54]) {
              controls = await hitFind(origin.x + 41 + dx, origin.y + inset + dy, isWindowControlsElement);
              if (controls) break search;
            }
          }
        }
      }
    }
    if (!grabber && !controls && screen && (width < screen.width - 2 || height < screen.height - 2)) {
      // Last: the app is in a window ADE has not seen yet (moved by hand, or
      // tiled off an edge). Sweep the screen for its controls, 30 by 18
      // points apart (the button is 41 by 22), for at most 25 seconds.
      const deadline = Date.now() + 25_000;
      sweep: for (let y = 30; y <= screen.height - 20; y += 18) {
        for (let x = 20; x <= screen.width - 10; x += 30) {
          if (Date.now() > deadline) break sweep;
          controls = await hitFind(x, y, isWindowControlsElement);
          if (controls) break sweep;
        }
      }
    }
    if (!grabber) {
      // The controls alone still place it: 21 points in from the top left,
      // 43 from the top when the window starts under the status bar.
      if (!controls) {
        // The app's own frame is smaller than the screen: it IS in a window,
        // just not one ADE could find.
        const lost = Boolean(screen && (width < screen.width - 2 || height < screen.height - 2));
        return { ...finish(null, false, false), ...(lost ? { lost: true } : {}) };
      }
      const top = controls.frame.y - 43 >= -2 && controls.frame.y - 43 <= 2 ? 0 : controls.frame.y - 21;
      return finish({ x: controls.frame.x - 21, y: top, width, height }, true, false);
    }
    const corner = (grabber.value ?? "").toLowerCase();
    const cx = grabber.frame.x + grabber.frame.width / 2;
    const cy = grabber.frame.y + grabber.frame.height / 2;
    const frame = {
      x: corner.includes("left") ? cx : cx - width,
      y: corner.includes("top") ? cy : cy - height,
      width,
      height,
    };
    if (!controls) controls = await findControls(frame);
    return finish(frame, true, false);
  };

  /**
   * Move the window by dragging its top strip (14 points under its top edge,
   * clear of the controls at its left): what a person does. Measured on
   * iPadOS 27: a drag there moves a free window point for point; a drag on
   * the controls or the content does not. Returns the frame read afterwards.
   */
  const moveAppWindow = async (
    deviceUdid: string,
    screen: { width: number; height: number },
    frame: AppleWindowFrame,
    to: { x: number; y: number },
  ): Promise<AppleWindowFrame | null> => {
    // Grab the visible middle of the top strip: part of the window may be off screen.
    const left = Math.max(frame.x + 80, 8);
    const right = Math.min(frame.x + frame.width - 16, screen.width - 8);
    const grabX = left <= right ? (left + right) / 2 : Math.min(Math.max(frame.x + frame.width / 2, 8), screen.width - 8);
    const grabY = Math.max(frame.y, 0) + 14;
    await deps.enqueueControl("window-move", () => deps.helperGesture(async (send) => {
      await send({ type: "touch", udid: deviceUdid, phase: "begin", x: grabX, y: grabY, space: "screen" });
      try {
        await delay(300);
        const steps = 16;
        for (let step = 1; step <= steps; step += 1) {
          await send({
            type: "touch",
            udid: deviceUdid,
            phase: "move",
            x: grabX + ((to.x - frame.x) * step) / steps,
            y: grabY + ((to.y - frame.y) * step) / steps,
            space: "screen",
          });
          await delay(30);
        }
        await delay(150);
      } finally {
        await send({ type: "touch", udid: deviceUdid, phase: "end", x: grabX + (to.x - frame.x), y: grabY + (to.y - frame.y), space: "screen" });
      }
    }), 30_000);
    await delay(1_000);
    const first = (await readAppWindow(deviceUdid, screen, [to])).frame;
    if (first) return first;
    // A window that just left a tile can still be settling (and the helper
    // placing it): read once more.
    await delay(1_000);
    return (await readAppWindow(deviceUdid, screen, [to])).frame;
  };

  /**
   * The window's green Zoom button. It shows only while the window controls
   * are open (a tap on "Window Controls" opens them), and the grid walk can
   * miss all three buttons, so they are hit-tested where they sit: the
   * controls at the window's top left, Zoom about 71 points right of Close.
   */
  const findWindowZoomButton = async (
    deviceUdid: string,
    frame: AppleWindowFrame,
    controls: IosScreenElement | null,
  ): Promise<IosScreenElement | null> => {
    const at = async (x: number, y: number) => (await readPoint(deviceUdid, x, y)) ?? [];
    const zoomBesideClose = async (close: IosScreenElement) => {
      const hit = await at(close.frame.x + close.frame.width / 2 + 71, close.frame.y + close.frame.height / 2);
      return hit.find((element) => element.identifier === "Zoom-button") ?? null;
    };
    let opener = controls;
    for (const y of [frame.y + 32, frame.y + 54]) {
      if (opener) break;
      const hit = await at(frame.x + 41, y);
      const zoom = hit.find((element) => element.identifier === "Zoom-button");
      if (zoom) return zoom;
      const close = hit.find((element) => element.identifier === "Close-button");
      // Already open.
      if (close) return zoomBesideClose(close);
      opener = hit.find(isWindowControlsElement) ?? null;
    }
    if (!opener) return null;
    const openerX = opener.frame.x + opener.frame.width / 2;
    const openerY = opener.frame.y + opener.frame.height / 2;
    await deps.enqueueControl("window-controls", () => deps.helperTap(deviceUdid, openerX, openerY, "screen"), 30_000);
    await delay(600);
    const { elements } = await deps.readAccessibilityElements(deviceUdid);
    const zoom = elements.find((element) => element.identifier === "Zoom-button");
    if (zoom) return zoom;
    const close = elements.find((element) => element.identifier === "Close-button")
      ?? (await at(opener.frame.x + 13, openerY)).find((element) => element.identifier === "Close-button");
    return close ? zoomBesideClose(close) : null;
  };

  /** Labels of the window menu's items, per action (iPadOS 26/27). */
  const WINDOW_MENU_LABELS: Record<Exclude<AppleWindowLayoutAction, "status" | "size" | "move">, string[]> = {
    fill: ["Fill"],
    left: ["Left"],
    right: ["Right"],
    top: ["Top"],
    bottom: ["Bottom"],
    split: ["Left and Right"],
    thirds: ["Arrange thirds", "Thirds"],
    quarters: ["Quarters"],
    "slide-over": ["Enter Slide Over"],
  };

  /** Where a layout puts the window's top left, to look there first (this orientation's first slot). */
  const layoutOrigin = (action: AppleWindowLayoutAction, screen: { width: number; height: number }): { x: number; y: number } | null => {
    const slot = appleWindowSlots(action, screen)[0];
    return slot ? { x: slot.x, y: slot.y } : null;
  };

  const windowMatches = (frame: AppleWindowFrame | null, expected: Partial<AppleWindowFrame> | null, tolerance: number): boolean => {
    if (!frame || !expected) return false;
    return (Object.keys(expected) as Array<keyof AppleWindowFrame>)
      .every((key) => Math.abs(frame[key] - (expected[key] as number)) <= tolerance);
  };

  const describeFrame = (frame: AppleWindowFrame | null): string => (frame
    ? `${Math.round(frame.width)}x${Math.round(frame.height)} at ${Math.round(frame.x)},${Math.round(frame.y)}`
    : "no window");

  /**
   * Lay out the front app's window on an iPad (`ade apple window`). Every
   * action ends with a read of the frame; `applied` says whether it landed.
   */
  const windowLayout = async (
    deviceUdid: string,
    laneKey: string,
    layoutArgs: AppleWindowLayoutArgs,
  ): Promise<AppleWindowLayoutResult> => {
    const action: AppleWindowLayoutAction = layoutArgs.action && APPLE_WINDOW_LAYOUT_ACTIONS.includes(layoutArgs.action)
      ? layoutArgs.action
      : layoutArgs.width != null || layoutArgs.height != null ? "size" : "status";
    const snapshot = await deps.getScreenSnapshot({ deviceUdid, ...(laneKey ? { laneId: laneKey } : {}) });
    const screen = { width: snapshot.screen.width, height: snapshot.screen.height };
    const start = await readAppWindow(deviceUdid, screen);
    const base = {
      deviceUdid,
      action,
      bundleId: start.bundleId,
      appName: start.appName,
      screen,
      before: start.frame,
      frameSource: start.placed ? "placed" as const : "inferred" as const,
    };
    const offScreenOf = (frame: AppleWindowFrame | null) => {
      if (!frame) return null;
      const off = appleWindowOffScreen(frame, screen);
      return off.left || off.top || off.right || off.bottom ? off : null;
    };
    if (start.lost) {
      throw new AdeExpectedError(
        `${APPLE_WINDOWING_UNAVAILABLE_CODE}: ${start.appName ?? "The app"} is in a window ADE cannot find: the helper could not place it, and its resize grabber and window controls did not answer (the window may hang off the screen's right or bottom edge). `
          + "Drag it back on screen, or bring it back with ade apple relaunch, then try again.",
        "user",
      );
    }
    if (action === "status") {
      const off = offScreenOf(start.frame);
      return { ...base, after: start.frame, applied: true, tolerance: 0, ...(off ? { offScreen: off } : {}) };
    }
    if (!start.windowed || !start.frame) {
      throw new AdeExpectedError(
        `${APPLE_WINDOWING_UNAVAILABLE_CODE}: the app in front is not in a resizable window, so there is nothing to lay out. `
          + "Window layouts need an iPad in windowed mode (iPadOS 26+): in the simulator's Settings › Multitasking & Gestures, choose Windowed Apps. "
          + "An iPhone has no windows. Bring the app to the front first (ade apple relaunch --bundle-id <id>).",
        "user",
      );
    }
    deps.touchDevice(deviceUdid);
    const tolerance = action === "size" || action === "move" ? 3 : 24;
    /**
     * A window partly off the screen (a thirds arrangement can leave one
     * hanging off an edge) hides its controls or its grabber: bring it wholly
     * on screen first, by its top strip, as a person would.
     */
    const bringOnScreen = async (frame: AppleWindowFrame): Promise<AppleWindowFrame> => {
      // A tiled window untiles on the first drag and takes its old size, so
      // the target is worked out again from each read (three drags at most).
      let moved: AppleWindowFrame | null = frame;
      for (let attempt = 0; attempt < 3 && moved && offScreenOf(moved); attempt += 1) {
        const current: AppleWindowFrame = moved;
        const to = {
          x: Math.min(Math.max(current.x, 0), Math.max(0, screen.width - current.width)),
          y: Math.min(Math.max(current.y, 0), Math.max(0, screen.height - current.height)),
        };
        moved = await moveAppWindow(deviceUdid, screen, current, to);
      }
      if (!moved || offScreenOf(moved)) {
        throw new AdeExpectedError(
          `${APPLE_WINDOWING_UNAVAILABLE_CODE}: the window is partly off the screen (${describeFrame(moved ?? frame)}) and dragging it back did not bring it on. `
            + "Try window --fill.",
          "user",
        );
      }
      return moved;
    };
    const filled = (frame: AppleWindowFrame | null) => Boolean(frame
      && Math.abs(frame.width - screen.width) <= 2 && Math.abs(frame.height - screen.height) <= 2);
    /**
     * A filled window shows no controls, and its first grabber drag only
     * takes it out of Fill (back to its last window size, centred), whatever
     * the drag asked. So that drag is made on its own and the window read
     * again before anything is measured against it.
     */
    const unfill = async (frame: AppleWindowFrame) => {
      const corner = { x: frame.x + frame.width - 8, y: frame.y + frame.height - 8 };
      await deps.enqueueControl("window-unfill", () => deps.helperSwipe(deviceUdid, {
        startX: corner.x,
        startY: corner.y,
        endX: corner.x - 160,
        endY: corner.y - 160,
        durationMs: 700,
      }, "screen"), 30_000);
      await delay(1_000);
      const unfilled = await readAppWindow(deviceUdid, screen);
      if (!unfilled.frame) {
        throw new AdeExpectedError(`${APPLE_WINDOWING_UNAVAILABLE_CODE}: the window left Fill but ADE could not find it again. Run window status.`, "user");
      }
      return unfilled;
    };
    /**
     * Why a move stopped short, from where iPadOS left the window. Measured:
     * a window brought within about 10 points of a screen edge is snapped to
     * it (700,300 became 710,300 on a 1210-wide screen, flush right), a
     * filled or tiled window first leaves its tile, and a window pushed past
     * the right edge is stashed there.
     */
    const describeMoveMiss = (after: AppleWindowFrame, to: { x: number; y: number }): string => {
      const snapped = [
        Math.abs(after.x) <= 1 && to.x !== 0 ? "the left edge" : null,
        Math.abs(after.x + after.width - screen.width) <= 1 ? "the right edge" : null,
        Math.abs(after.y) <= 1 && to.y !== 0 ? "the top" : null,
        Math.abs(after.y + after.height - screen.height) <= 1 ? "the bottom edge" : null,
        // The Dock is 123 points tall on an iPad Pro 11-inch, both ways up:
        // 100,100 for a 600-point window became 100,111 on an 834-point screen.
        Math.abs(after.y + after.height - (screen.height - APPLE_IPAD_DOCK_HEIGHT)) <= 2 ? "the top of the Dock" : null,
      ].filter(Boolean);
      const off = Math.round(Math.hypot(after.x - to.x, after.y - to.y));
      return `iPadOS left the window at ${describeFrame(after)}, ${off} pt from ${Math.round(to.x)},${Math.round(to.y)}`
        + (snapped.length ? `: it snapped it to ${snapped.join(" and ")}.` : ": it keeps a window where it can reach it, and a filled or tiled window leaves its tile (and takes back its old size) on the first drag.");
    };
    if (action === "move") {
      const to = { x: Number(layoutArgs.x), y: Number(layoutArgs.y) };
      if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) {
        throw new AdeExpectedError("window --move needs X,Y in points: where the window's top-left corner goes.", "user");
      }
      let after = await moveAppWindow(deviceUdid, screen, start.frame, to);
      const near = (frame: AppleWindowFrame | null) => Boolean(frame && Math.abs(frame.x - to.x) <= tolerance && Math.abs(frame.y - to.y) <= tolerance);
      // A tiled window leaves its slot on the first drag and can land a few
      // points short: one more drag of what is left.
      if (after && !near(after) && Math.hypot(after.x - to.x, after.y - to.y) < 200) {
        after = (await moveAppWindow(deviceUdid, screen, after, to)) ?? after;
      }
      const applied = near(after);
      return {
        ...base,
        after,
        applied,
        tolerance,
        ...(applied ? {} : {
          reason: after ? describeMoveMiss(after, to) : "After the drag the front app has no window ADE can read.",
        }),
      };
    }
    if (action === "size") {
      const width = Number(layoutArgs.width ?? start.frame.width);
      const height = Number(layoutArgs.height ?? start.frame.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new AdeExpectedError("window --size needs WIDTHxHEIGHT in points, both above 0.", "user");
      }
      const onScreen = await bringOnScreen(filled(start.frame) ? (await unfill(start.frame)).frame! : start.frame);
      if (onScreen.x + width > screen.width + 1 || onScreen.y + height > screen.height + 1) {
        throw new AdeExpectedError(
          `A ${Math.round(width)}x${Math.round(height)} window does not fit from where this one starts (${describeFrame(onScreen)}, screen ${screen.width}x${screen.height}). `
            + "The size keeps the top-left corner: move it first (window --move 0,0, --left, --top), or ask for a smaller size.",
          "user",
        );
      }
      const wanted = { width, height };
      let current = onScreen;
      let attempts = 0;
      // Each drag corrects what the one before left over, scaled by how much
      // of the last drag the window followed.
      let gain = { x: 1, y: 1 };
      while (attempts < 4 && !windowMatches(current, { width, height }, tolerance)) {
        attempts += 1;
        const dx = (wanted.width - current.width) * gain.x;
        const dy = (wanted.height - current.height) * gain.y;
        const corner = { x: current.x + current.width, y: current.y + current.height };
        // Inside the 40-point grabber, never past a screen edge.
        await deps.enqueueControl("window-resize", () => deps.helperSwipe(deviceUdid, {
          startX: corner.x - 8,
          startY: corner.y - 8,
          endX: corner.x - 8 + dx,
          endY: corner.y - 8 + dy,
          durationMs: 700,
        }, "screen"), 30_000);
        await delay(900);
        const next = (await readAppWindow(deviceUdid, screen, [{ x: current.x, y: current.y }])).frame;
        deps.logger.debug("apple.window_resize_step", { deviceUdid, attempt: attempts, from: current, dx, dy, to: next });
        if (!next) break;
        const movedX = next.width - current.width;
        const movedY = next.height - current.height;
        // The share of the drag the window followed sets the next aim. A free
        // window follows about 92% of it (the grab eats the rest); a window
        // iPadOS centred (out of Fill) grows on both sides, so it follows
        // about 200% of it.
        const clampGain = (value: number) => Math.min(1.5, Math.max(0.3, Number.isFinite(value) ? value : 1));
        if (Math.abs(dx) > 8 && Math.abs(movedX) > 4) gain = { ...gain, x: clampGain(dx / movedX) };
        if (Math.abs(dy) > 8 && Math.abs(movedY) > 4) gain = { ...gain, y: clampGain(dy / movedY) };
        // Nothing moved: the window is at its limit (a minimum or maximum size).
        if (Math.abs(movedX) < 1 && Math.abs(movedY) < 1) {
          current = next;
          break;
        }
        current = next;
      }
      const applied = windowMatches(current, { width, height }, tolerance);
      return {
        ...base,
        after: current,
        applied,
        tolerance,
        attempts,
        ...(applied ? {} : {
          reason: `The window stopped at ${describeFrame(current)}; ${Math.round(width)}x${Math.round(height)} may be under the app's minimum or past what the screen allows from that corner.`,
        }),
      };
    }
    if (action === "fill" && filled(start.frame)) {
      return { ...base, after: start.frame, applied: true, tolerance };
    }
    // A filled window shows no window controls. Any drag of its grabber
    // takes it out of Fill (back to its last window size), and then the
    // controls are there.
    let window: { frame: AppleWindowFrame | null; zoom: IosScreenElement | null; controls: IosScreenElement | null } = {
      frame: start.frame,
      zoom: start.zoom,
      controls: start.controls,
    };
    if (filled(start.frame)) {
      const unfilled = await unfill(start.frame);
      window = { frame: unfilled.frame, zoom: unfilled.zoom, controls: unfilled.controls };
    }
    // The controls sit at the window's top left: bring the window back only
    // when they would be off the screen (a window that outgrew a bottom or
    // right slot keeps them, and dragging it would untile it for nothing).
    const controlsHidden = (frame: AppleWindowFrame) => frame.x < 0 || frame.y < 0 || frame.x + 62 > screen.width || frame.y + 65 > screen.height;
    if (window.frame && controlsHidden(window.frame)) {
      const moved = await bringOnScreen(window.frame);
      const reread = await readAppWindow(deviceUdid, screen, [{ x: moved.x, y: moved.y }]);
      window = { frame: reread.frame ?? moved, zoom: reread.zoom, controls: reread.controls };
    }
    // The window menu: a long press on the green Zoom button.
    const zoom = window.zoom ?? await findWindowZoomButton(deviceUdid, window.frame!, window.controls);
    if (!zoom) {
      throw new AdeExpectedError(
        `${APPLE_WINDOWING_UNAVAILABLE_CODE}: the window's green Zoom button did not show, so its layout menu cannot open. Run window status, then try again.`,
        "user",
      );
    }
    const zoomX = zoom.frame.x + zoom.frame.width / 2;
    const zoomY = zoom.frame.y + zoom.frame.height / 2;
    await deps.enqueueControl("window-menu", () => deps.helperHold(deviceUdid, zoomX, zoomY, 1_300, "screen"), 30_000);
    await delay(700);
    const labels = WINDOW_MENU_LABELS[action as keyof typeof WINDOW_MENU_LABELS];
    const allLabels = Object.values(WINDOW_MENU_LABELS).flat();
    const isMenuButton = (element: IosScreenElement) => (element.elementType ?? element.role) === "Button"
      && element.label !== null && allLabels.includes(element.label);
    // The menu opens beside the Zoom button; an app's own "Left" button
    // elsewhere on screen is not one of its items.
    const nearZoom = (element: IosScreenElement) => Math.hypot(
      element.frame.x + element.frame.width / 2 - zoomX,
      element.frame.y + element.frame.height / 2 - zoomY,
    ) < 420;
    let menu = (await deps.readAccessibilityElements(deviceUdid)).elements.filter((element) => isMenuButton(element) && nearZoom(element));
    if (!menu.some((element) => labels.includes(element.label!))) {
      // The grid walk misses menu items as easily as the grabber: ask the
      // points around the button, 24 apart, where the menu can open.
      const seen = new Set(menu.map((element) => element.label));
      sweep: for (let dy = -260; dy <= 260; dy += 24) {
        for (let dx = -240; dx <= 260; dx += 24) {
          const x = zoomX + dx;
          const y = zoomY + dy;
          if (x < 0 || y < 0 || x > screen.width || y > screen.height || Math.abs(dy) < 16) continue;
          const hit = await readPoint(deviceUdid, x, y);
          for (const element of hit ?? []) {
            if (!isMenuButton(element) || seen.has(element.label)) continue;
            seen.add(element.label);
            menu.push(element);
          }
          if (menu.some((element) => labels.includes(element.label!))) break sweep;
        }
      }
    }
    const item = menu.find((element) => labels.includes(element.label!)) ?? null;
    if (!item) {
      const offered = menu.map((element) => element.label);
      // Close the menu with Escape (a tap on Zoom would Fill the window).
      await deps.helperGesture(async (send) => {
        await send({ type: "key", udid: deviceUdid, phase: "down", usage: ESCAPE_USAGE });
        await send({ type: "key", udid: deviceUdid, phase: "up", usage: ESCAPE_USAGE });
      }).catch(() => undefined);
      throw new AdeExpectedError(
        `The window menu has no "${labels[0]}" item${offered.length ? ` (it offers: ${offered.join(", ")})` : " (it did not open)"}. `
          + "This iPadOS may not offer that layout.",
        "user",
      );
    }
    await deps.enqueueControl("window-menu-item", () => deps.helperTap(
      deviceUdid,
      item.frame.x + item.frame.width / 2,
      item.frame.y + item.frame.height / 2,
      "screen",
    ), 30_000);
    await delay(1_200);
    const hint = layoutOrigin(action, screen);
    const after = (await readAppWindow(deviceUdid, screen, [...(hint ? [hint] : []), { x: window.frame!.x, y: window.frame!.y }])).frame;
    const offAfter = offScreenOf(after);
    // Orientation-aware: the slots come from this screen's size, and a window
    // may run off the screen only where its app's minimum size outgrew its slot.
    const verdict = after ? judgeAppleWindowLayout(action, after, screen, window.frame) : null;
    const applied = verdict?.landed === true;
    return {
      ...base,
      after,
      applied,
      tolerance,
      ...(verdict?.note ? { note: verdict.note } : {}),
      ...(applied ? {} : {
        reason: after
          ? offAfter && verdict?.strayOffScreen
            ? `The window is ${describeFrame(after)} after "${item.label}": partly off the screen (${describeAppleWindowOffScreen(offAfter)}). The app's minimum width may not fit that slot on a ${screen.width}x${screen.height} screen.`
            : `The window is ${describeFrame(after)} after "${item.label}"; that does not look like the ${action} layout of a ${screen.width}x${screen.height} screen.`
          : `After "${item.label}" the front app has no window ADE can read (another app may be in front now).`,
      }),
    };
  };

  return { windowLayout };
}
