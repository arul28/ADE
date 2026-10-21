import { translate } from "./anchorGeometry";

/**
 * The tour's one ADE cursor, moved by hand rather than by React: a single
 * element the runner owns for as long as the tour is open, so it glides from
 * wherever it is to each new control (between steps, and back from a pause)
 * instead of appearing at the next one.
 *
 * Motion is transform and opacity only (WAAPI), eased, and finite: a glide
 * whose length follows the distance, then, on a do-it step, one press.
 * Reduce motion skips the travel and fades the cursor in where it lands.
 */

export type Point = { x: number; y: number };

/** The cursor art's tip sits this far into its box. */
const TIP = 3;
const GLIDE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const FADE_MS = 160;

/** Where the cursor last rested this app session, so a new tour run starts there too. */
let restingPoint: Point | null = null;

function glideMs(distance: number): number {
  return Math.round(Math.min(900, Math.max(380, 260 + distance * 0.55)));
}

function placeAt(point: Point): string {
  return translate(point.x - TIP, point.y - TIP);
}

export type GlideOptions = {
  reduced: boolean;
  press: boolean;
  viewport: Point;
  /** After the press (or right after arriving, with no press). */
  afterPress?: () => void;
};

export class TourCursorMotion {
  private element: HTMLElement | null = null;
  /** Where the tip is (or is heading, mid-glide). */
  private point: Point | null;
  private shown = false;
  private motion: Animation | null = null;
  private fade: Animation | null = null;
  private gliding = false;
  /** Starts where the last tour cursor rested, and leaves its own rest for the next one. */
  private readonly resume: boolean;

  /**
   * `resume: false` (a hint's one-off cursor) always starts from the middle
   * of the window and does not move the tour's resting point.
   */
  constructor(options: { resume?: boolean } = {}) {
    this.resume = options.resume ?? true;
    this.point = this.resume ? restingPoint : null;
  }

  private rest(point: Point): void {
    this.point = point;
    if (this.resume) restingPoint = point;
  }

  attach(element: HTMLElement | null): void {
    if (this.element === element) return;
    this.stop();
    this.element = element;
    if (!element) return;
    element.style.opacity = "0";
    if (this.point) element.style.transform = placeAt(this.point);
  }

  /**
   * Moves to `to` and calls `onArrive` when the tip is there. Starts from
   * where the cursor is right now (mid-glide too), else from the middle of
   * the window. `press` adds two clicks on arrival.
   */
  glideTo(to: Point, options: GlideOptions, onArrive: () => void): void {
    const element = this.element;
    if (!element) return;
    const from = this.currentPoint() ?? this.point ?? { x: options.viewport.x / 2, y: options.viewport.y / 2 };
    this.stopMotion();
    this.rest(to);
    const wasShown = this.shown;
    this.shown = true;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    element.style.transform = placeAt(to);
    if (options.reduced || typeof element.animate !== "function") {
      // No travel: the cursor fades in where it lands.
      if (!wasShown || distance >= 2) element.style.opacity = "0";
      this.fadeTo(1, false);
      onArrive();
      options.afterPress?.();
      return;
    }
    // Fading in as it starts to move reads as the cursor arriving, not popping.
    this.fadeTo(1, false, wasShown ? 0 : FADE_MS);
    if (distance < 2) {
      this.afterArrive(to, options, onArrive);
      return;
    }
    this.gliding = true;
    const glide = element.animate(
      [{ transform: placeAt(from) }, { transform: placeAt(to) }],
      { duration: glideMs(distance), easing: GLIDE_EASING },
    );
    this.motion = glide;
    glide.finished
      .then(() => {
        if (this.motion !== glide) return;
        this.gliding = false;
        this.motion = null;
        this.afterArrive(this.point ?? to, options, onArrive);
      })
      .catch(() => {
        // Replaced by a newer glide, or the tour closed.
      });
  }

  /** Keeps the resting cursor on a control that moved (scroll, resize). Mid-glide, the glide's end catches up. */
  follow(to: Point): void {
    const element = this.element;
    if (!element || !this.point) return;
    if (Math.abs(to.x - this.point.x) < 0.5 && Math.abs(to.y - this.point.y) < 0.5) return;
    this.rest(to);
    if (this.gliding) return;
    element.style.transform = placeAt(to);
  }

  /** Steps aside (paused, hidden): fades out where it is, ready to glide on from there. */
  hide(): void {
    const element = this.element;
    if (!element) return;
    const at = this.currentPoint();
    this.stopMotion();
    if (at) {
      this.rest(at);
      element.style.transform = placeAt(at);
    }
    if (!this.shown) return;
    this.shown = false;
    this.fadeTo(0, false);
  }

  stop(): void {
    this.stopMotion();
    this.fade?.cancel();
    this.fade = null;
  }

  private afterArrive(to: Point, options: GlideOptions, onArrive: () => void): void {
    onArrive();
    const element = this.element;
    if (!options.press || !element || typeof element.animate !== "function") {
      options.afterPress?.();
      return;
    }
    // One short click. A transform animation here ticks style on the main
    // thread every frame (measured), so it stays brief; the ring's pulse,
    // opacity only, carries the rest of the "here".
    const at = placeAt(to);
    const pressing = element.animate(
      [
        { transform: `${at} scale(1)` },
        { transform: `${at} scale(0.78)`, offset: 0.4 },
        { transform: `${at} scale(1)` },
      ],
      { duration: 460, easing: "ease-in-out", delay: 160 },
    );
    this.motion = pressing;
    pressing.finished
      .then(() => {
        if (this.motion !== pressing) return;
        this.motion = null;
        options.afterPress?.();
      })
      .catch(() => undefined);
  }

  private fadeTo(opacity: 0 | 1, instant: boolean, duration = FADE_MS): void {
    const element = this.element;
    if (!element) return;
    this.fade?.cancel();
    this.fade = null;
    const from = element.style.opacity || "0";
    element.style.opacity = String(opacity);
    if (instant || duration <= 0 || from === String(opacity) || typeof element.animate !== "function") return;
    this.fade = element.animate([{ opacity: Number(from) }, { opacity }], { duration, easing: "ease-out" });
  }

  private stopMotion(): void {
    this.gliding = false;
    const motion = this.motion;
    this.motion = null;
    motion?.cancel();
  }

  /** Where the tip is on screen now, read from the running glide when there is one. */
  private currentPoint(): Point | null {
    const element = this.element;
    if (!element || !this.motion) return this.point;
    const transform = window.getComputedStyle(element).transform;
    if (!transform || transform === "none") return this.point;
    const matrix = new DOMMatrixReadOnly(transform);
    return { x: matrix.m41 + TIP, y: matrix.m42 + TIP };
  }
}
