import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ViewportOverlayPortal } from "../../ui/ViewportOverlayHost";
import { fixedFrameOf, fixedRect } from "../../../lib/webZoom";
import {
  anchorRadius,
  clamp,
  hasBox,
  isAnchorVisible,
  placeCard,
  prefersReducedMotion,
  readFrame,
  translate,
  VIEWPORT_MARGIN,
  type Box,
  type CardSide,
} from "../tour/anchorGeometry";
import { AdeTourCursorArt } from "../tour/AdeTourCursorArt";
import { watchTourDom, type TourWatch } from "../tour/tourWatch";
import { clearSpotlight, useSpotlightRequest, type SpotlightRequest, type SpotlightSpot } from "./spotlight";
import "./spotlight.css";

/**
 * Draws the spotlight `showSpotlight` asks for (see `spotlight.ts`): the
 * tour's ring and a one-line label, in the tour's layer, through the tour's
 * geometry and its event-driven page watch. Nothing is dimmed or blocked;
 * every pointer event passes through.
 *
 * Cost: renders nothing until asked. While it waits it wakes only on page
 * changes (no polling) and gives up after a few seconds; once shown, the ring
 * follows its element by direct style writes on scroll, resize and its size
 * changing (every frame for its first second, while the page it landed on
 * finishes animating in), and the whole thing is gone a few seconds later.
 */

/** A new element must stay this long before it is ringed: the page is settling after navigation. */
const SETTLE_MS = 300;
/** Wait this long for a spot before giving up. */
const DEFAULT_WAIT_MS = 4_000;
/** Present but scrolled away this long: scroll it into view, once. */
const NUDGE_AFTER_MS = 900;
/** Shown this long, then it fades. */
const SHOW_MS = 6_000;
const LEAVE_MS = 220;
/** Follow the element every frame this long after it is ringed: entrance animations move it with no event. */
const FOLLOW_SETTLE_MS = 1_200;
const RING_PAD = 6;
const LABEL_GAP = 10;
const LABEL_MAX_WIDTH = 300;

export function SpotlightHost() {
  const request = useSpotlightRequest();
  if (!request) return null;
  return <SpotlightRunner key={request.id} id={request.id} request={request} />;
}

type Found = { node: HTMLElement; spot: SpotlightSpot };

function findSpot(spots: readonly SpotlightSpot[]): Found | null {
  for (const spot of spots) {
    for (const node of document.querySelectorAll<HTMLElement>(spot.selector)) {
      if (isAnchorVisible(node)) return { node, spot };
    }
  }
  return null;
}

/** A spot that is laid out but scrolled or clipped out of view: bring the first into view. */
function scrollFirstSpotIntoView(spots: readonly SpotlightSpot[]): void {
  for (const spot of spots) {
    for (const node of document.querySelectorAll<HTMLElement>(spot.selector)) {
      if (!hasBox(node)) continue;
      if (typeof node.checkVisibility === "function" && !node.checkVisibility({ visibilityProperty: true })) continue;
      node.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }
  }
}

/** The nearest ancestor that scrolls or clips, so the ring does not spill over the chrome around a scrolled list. */
function clippingAncestor(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") return parent;
  }
  return null;
}

/** A ring at least this big is a whole section; its label goes inside. */
const SECTION_MIN_WIDTH = 560;
const SECTION_MIN_HEIGHT = 140;

function labelFits(
  side: CardSide,
  ring: Box,
  size: { width: number; height: number },
  viewport: { vw: number; vh: number },
): boolean {
  const room = {
    right: viewport.vw - VIEWPORT_MARGIN - (ring.left + ring.width + LABEL_GAP),
    left: ring.left - LABEL_GAP - VIEWPORT_MARGIN,
    below: viewport.vh - VIEWPORT_MARGIN - (ring.top + ring.height + LABEL_GAP),
    above: ring.top - LABEL_GAP - VIEWPORT_MARGIN,
  }[side];
  return side === "right" || side === "left" ? room >= size.width : room >= size.height;
}

function SpotlightRunner({ id, request }: { id: number; request: SpotlightRequest }) {
  const [found, setFound] = useState<Found | null>(null);
  const [leaving, setLeaving] = useState(false);
  const foundRef = useRef<Found | null>(null);

  // Find a spot whenever the page changes, until one shows or time runs out.
  // Once shown, a spot that goes away (Work swapped a draft for the chat it
  // restored) is looked for again while time remains.
  useEffect(() => {
    const startedAt = performance.now();
    const deadline = startedAt + (request.waitMs ?? DEFAULT_WAIT_MS);
    let pending: { found: Found; since: number } | null = null;
    let nudged = false;
    let watch: TourWatch | null = null;
    const commit = (next: Found | null) => {
      foundRef.current = next;
      setFound(next);
    };
    const evaluate = () => {
      const now = performance.now();
      const shown = foundRef.current;
      if (shown) {
        if (shown.node.isConnected && isAnchorVisible(shown.node)) return;
        if (now >= deadline) {
          clearSpotlight(id);
          return;
        }
        commit(null);
      }
      if (now >= deadline) {
        clearSpotlight(id);
        return;
      }
      const hit = !request.ready || request.ready() ? findSpot(request.spots) : null;
      if (hit) {
        if (!pending || pending.found.node !== hit.node) pending = { found: hit, since: now };
        const settleLeft = SETTLE_MS - (now - pending.since);
        if (settleLeft > 0) {
          watch?.scheduleCheck(settleLeft);
          return;
        }
        pending = null;
        commit(hit);
        return;
      }
      pending = null;
      if (!nudged && now - startedAt >= NUDGE_AFTER_MS) {
        nudged = true;
        scrollFirstSpotIntoView(request.spots);
      }
      // Wake again for the nudge and for the deadline; page changes wake it sooner.
      const nextAt = nudged ? deadline : Math.min(deadline, startedAt + NUDGE_AFTER_MS);
      watch?.scheduleCheck(Math.max(0, nextAt - now));
    };
    watch = watchTourDom(evaluate, { minIntervalMs: 120 });
    return () => watch?.dispose();
  }, [id, request]);

  // Shown: fade after a while, or at once on any click or Escape.
  const shownNode = found?.node ?? null;
  useEffect(() => {
    if (!shownNode) return undefined;
    const leave = () => setLeaving(true);
    const timer = window.setTimeout(leave, SHOW_MS);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") leave();
    };
    document.addEventListener("pointerdown", leave, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", leave, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [shownNode]);

  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(() => clearSpotlight(id), prefersReducedMotion() ? 0 : LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [id, leaving]);

  if (!found) return null;
  return (
    <ViewportOverlayPortal layer="onboardingTour">
      <div className="ade-spot-layer" data-onboarding-hint-layer="" data-leaving={leaving || undefined}>
        <SpotlightRing key={`${found.spot.selector}|${found.spot.label}`} node={found.node} label={found.spot.label} />
      </div>
    </ViewportOverlayPortal>
  );
}

function SpotlightRing({ node, label }: { node: HTMLElement; label: string }) {
  const ringRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const radius = useMemo(() => anchorRadius(node), [node]);
  const clipper = useMemo(() => clippingAncestor(node), [node]);

  // Marks the ringed element, so a control that only shows on hover (a
  // message's ↶ Rewind) can show while it is pointed at.
  useEffect(() => {
    node.setAttribute("data-spotlight-target", "");
    return () => node.removeAttribute("data-spotlight-target");
  }, [node]);

  // Follow the element with direct style writes, once a frame at most, and
  // only when something moved: scrolls, resizes, and its own size changing.
  useLayoutEffect(() => {
    let raf = 0;
    let last = "";
    const layout = () => {
      raf = 0;
      if (!node.isConnected) return;
      const frame = readFrame(node);
      let left = frame.left - RING_PAD;
      let top = frame.top - RING_PAD;
      let right = frame.left + frame.width + RING_PAD;
      let bottom = frame.top + frame.height + RING_PAD;
      // Keep the ring inside the window and inside the list it scrolls in,
      // so a tall section reads as framed rather than cut off.
      const edge = 2;
      left = Math.max(left, edge);
      top = Math.max(top, edge);
      right = Math.min(right, frame.vw - edge);
      bottom = Math.min(bottom, frame.vh - edge);
      if (clipper) {
        const clip = fixedRect(fixedFrameOf(null), clipper.getBoundingClientRect());
        left = Math.max(left, clip.left - RING_PAD + 2);
        top = Math.max(top, clip.top - RING_PAD + 2);
        right = Math.min(right, clip.right + RING_PAD - 2);
        bottom = Math.min(bottom, clip.bottom + RING_PAD - 2);
      }
      const ring: Box = { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
      const labelEl = labelRef.current;
      const size = { width: labelEl?.offsetWidth ?? 0, height: labelEl?.offsetHeight ?? 0 };
      const key = `${ring.left}|${ring.top}|${ring.width}|${ring.height}|${size.width}|${size.height}|${frame.vw}|${frame.vh}`;
      if (key === last) return;
      last = key;
      const ringEl = ringRef.current;
      if (ringEl) {
        ringEl.style.width = `${ring.width}px`;
        ringEl.style.height = `${ring.height}px`;
        ringEl.style.transform = translate(ring.left, ring.top);
      }
      if (!labelEl || !size.width) return;
      // A whole section (a settings group, a page panel) keeps the label just
      // inside its bottom-right corner: outside, it would cover the next
      // section's heading, and a section's own heading and content start at
      // its top-left. Anything
      // smaller gets the label beside the ring where there is room (a tall
      // list prefers its side), else inside its top-left corner.
      const section = ring.width >= SECTION_MIN_WIDTH && ring.height >= SECTION_MIN_HEIGHT;
      const order: readonly CardSide[] = ring.height > ring.width
        ? ["right", "left", "below", "above"]
        : ["below", "above", "right", "left"];
      const side = section ? undefined : order.find((candidate) => labelFits(candidate, ring, size, frame));
      const spot = side
        ? placeCard(ring, size, frame, [side], LABEL_GAP)
        : {
          x: section
            ? clamp(ring.left + ring.width - size.width - 12, VIEWPORT_MARGIN, frame.vw - size.width - VIEWPORT_MARGIN)
            : clamp(ring.left + 12, VIEWPORT_MARGIN, frame.vw - size.width - VIEWPORT_MARGIN),
          y: section
            ? clamp(
              Math.min(ring.top + ring.height, frame.vh) - size.height - 12,
              VIEWPORT_MARGIN,
              frame.vh - size.height - VIEWPORT_MARGIN,
            )
            : clamp(ring.top + 12, VIEWPORT_MARGIN, frame.vh - size.height - VIEWPORT_MARGIN),
          side: "inside",
        };
      labelEl.style.transform = translate(spot.x, spot.y);
      labelEl.dataset.side = spot.side;
    };
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(layout);
    };
    layout();
    // A page that just opened may still be sliding into place, which no
    // event reports: follow it every frame for a moment, then on events only.
    const settleUntil = performance.now() + FOLLOW_SETTLE_MS;
    let settleRaf = 0;
    const settle = () => {
      layout();
      settleRaf = performance.now() < settleUntil ? window.requestAnimationFrame(settle) : 0;
    };
    settleRaf = window.requestAnimationFrame(settle);
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    if (labelRef.current) observer.observe(labelRef.current);
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
      if (raf) window.cancelAnimationFrame(raf);
      if (settleRaf) window.cancelAnimationFrame(settleRaf);
    };
  }, [clipper, node]);

  const pulse = !prefersReducedMotion();
  return (
    <>
      <div
        ref={ringRef}
        className="ade-spot-ring"
        data-pulse={pulse || undefined}
        aria-hidden
        style={{ borderRadius: radius + RING_PAD }}
      />
      <div ref={labelRef} className="ade-spot-label" role="status" style={{ maxWidth: LABEL_MAX_WIDTH }}>
        <span className="ade-spot-label-cursor" aria-hidden>
          <AdeTourCursorArt />
        </span>
        <span className="ade-spot-label-text">{label}</span>
      </div>
    </>
  );
}
