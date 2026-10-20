import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { ViewportOverlayPortal } from "../../ui/ViewportOverlayHost";
import { fixedFrameOf, fixedRect, fixedViewport } from "../../../lib/webZoom";
import {
  ONBOARDING_ANCHOR_ATTR,
  dismissHint,
  isHintOpen,
  isOnboardingActive,
  markHintDone,
  markHintShown,
  readOnboardingProgress,
  skipOnboarding,
  subscribeOnboardingProgress,
  type OnboardingHintId,
  type OnboardingProgress,
} from "../../../onboarding/onboardingProgress";
import { ONBOARDING_HINTS, type OnboardingHintDef } from "./onboardingHintDefs";
import "./onboardingHints.css";

/**
 * First-chat hints: after the welcome flow, ADE points at three real controls,
 * one at a time, without blocking anything. A ghost cursor glides once from
 * the middle of the window to the control, then a ring settles around it with
 * a small card beside it. Pointer events pass through everything but the card.
 *
 * Cost: while onboarding is off (almost every user, almost all the time) the
 * host renders nothing and holds only the progress subscription. While it is
 * on, one 1s scan looks for anchors; once every hint is finished the scan
 * stops with it.
 */

/** How often the scan looks for anchors, and how long one must stay before its hint starts. */
const SCAN_INTERVAL_MS = 1_000;
const SETTLE_MS = 900;
/** Ring padding around the control. */
const RING_PAD = 4;
const CARD_WIDTH = 280;
const CARD_GAP = 12;
const VIEWPORT_MARGIN = 8;
const GLIDE_MS = 700;
const PRESS_MS = 480;

/** Hints that already counted a show in this app session: one count per session, not per render. */
const shownThisSession = new Set<OnboardingHintId>();
/** Hints whose cursor already glided this session; one that comes back shows its ring straight away. */
const glidedThisSession = new Set<OnboardingHintId>();

/**
 * Whether a hint may still show. Counting this session's show can use up the
 * last one, and the hint still stays for the rest of the session.
 */
function hintStillOpen(id: OnboardingHintId, progress: OnboardingProgress): boolean {
  if (isHintOpen(id, progress)) return true;
  if (!shownThisSession.has(id) || !isOnboardingActive(progress)) return false;
  const hint = progress.hints[id];
  return !hint?.doneAt && !hint?.dismissedAt;
}

export function OnboardingHintHost() {
  const [progress, setProgress] = useState(readOnboardingProgress);
  useEffect(() => subscribeOnboardingProgress(() => setProgress(readOnboardingProgress())), []);
  const openKey = ONBOARDING_HINTS.filter((hint) => hintStillOpen(hint.id, progress))
    .map((hint) => hint.id)
    .join(",");
  if (!openKey) return null;
  return <OnboardingHintScanner openKey={openKey} />;
}

type ActiveHint = { def: OnboardingHintDef; anchor: HTMLElement };

function hasOpenModal(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]') != null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** On screen, not zero-sized, and not clipped or covered: its centre hit-tests to itself. */
function isAnchorVisible(node: HTMLElement): boolean {
  const rect = node.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= vw || rect.top >= vh) return false;
  const hit = document.elementFromPoint(
    clamp(rect.left + rect.width / 2, 1, vw - 1),
    clamp(rect.top + rect.height / 2, 1, vh - 1),
  );
  if (!hit) return false;
  return node === hit || node.contains(hit) || hit.closest("[data-onboarding-hint-layer]") != null;
}

function findVisibleAnchor(id: OnboardingHintId): HTMLElement | null {
  for (const node of document.querySelectorAll<HTMLElement>(`[${ONBOARDING_ANCHOR_ATTR}="${id}"]`)) {
    if (isAnchorVisible(node)) return node;
  }
  return null;
}

/**
 * The hint to show now. The one already up stays while its anchor does;
 * otherwise the first unfinished sequential hint, and only then a free one
 * (`needs-you`), so a later hint never jumps ahead of an earlier one.
 */
function pickHint(openIds: readonly OnboardingHintId[], current: ActiveHint | null): ActiveHint | null {
  if (hasOpenModal()) return null;
  if (current && openIds.includes(current.def.id)) {
    const anchor = isAnchorVisible(current.anchor) && current.anchor.getAttribute(ONBOARDING_ANCHOR_ATTR) === current.def.id
      ? current.anchor
      : findVisibleAnchor(current.def.id);
    if (anchor) return { def: current.def, anchor };
  }
  const sequential = ONBOARDING_HINTS.find((hint) => hint.sequential && openIds.includes(hint.id));
  if (sequential) {
    const anchor = findVisibleAnchor(sequential.id);
    if (anchor) return { def: sequential, anchor };
  }
  for (const hint of ONBOARDING_HINTS) {
    if (hint.sequential || !openIds.includes(hint.id)) continue;
    const anchor = findVisibleAnchor(hint.id);
    if (anchor) return { def: hint, anchor };
  }
  return null;
}

function OnboardingHintScanner({ openKey }: { openKey: string }) {
  const openIds = useMemo(() => openKey.split(",") as OnboardingHintId[], [openKey]);
  const [active, setActive] = useState<ActiveHint | null>(null);
  const activeRef = useRef<ActiveHint | null>(null);
  const pendingRef = useRef<{ id: OnboardingHintId; since: number } | null>(null);

  // Doing the thing finishes the hint, even before its ring shows.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const id = target.closest(`[${ONBOARDING_ANCHOR_ATTR}]`)?.getAttribute(ONBOARDING_ANCHOR_ATTR);
      const def = ONBOARDING_HINTS.find((hint) => hint.id === id);
      if (def?.doneOnClick && openIds.includes(def.id)) markHintDone(def.id);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [openIds]);

  useEffect(() => {
    const commit = (next: ActiveHint | null) => {
      const current = activeRef.current;
      if (current === next || (current && next && current.def === next.def && current.anchor === next.anchor)) return;
      activeRef.current = next;
      setActive(next);
    };
    const scan = () => {
      if (document.hidden) return;
      const current = activeRef.current;
      const next = pickHint(openIds, current);
      if (!next) {
        pendingRef.current = null;
        commit(null);
        return;
      }
      if (current && current.def.id === next.def.id) {
        commit(next);
        return;
      }
      // A new anchor: hide whatever was up and let the user look at the app first.
      commit(null);
      const now = performance.now();
      const pending = pendingRef.current;
      if (!pending || pending.id !== next.def.id) {
        pendingRef.current = { id: next.def.id, since: now };
        return;
      }
      if (now - pending.since < SETTLE_MS) return;
      pendingRef.current = null;
      commit(next);
    };
    scan();
    const interval = window.setInterval(scan, SCAN_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [openIds]);

  const activeId = active?.def.id ?? null;
  useEffect(() => {
    if (!activeId || shownThisSession.has(activeId)) return;
    shownThisSession.add(activeId);
    markHintShown(activeId);
  }, [activeId]);

  if (!active) return null;
  return <OnboardingHintOverlay key={active.def.id} def={active.def} anchor={active.anchor} />;
}

type Frame = { left: number; top: number; width: number; height: number; vw: number; vh: number };

/**
 * The anchor's box in the overlay's own style pixels. The hosted web client
 * zooms <body>, so a screen rect is mapped into that space; in Electron the
 * frame is the identity.
 */
function readFrame(anchor: HTMLElement): Frame {
  const frame = fixedFrameOf(null);
  const rect = fixedRect(frame, anchor.getBoundingClientRect());
  const viewport = fixedViewport(frame);
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    vw: viewport.width,
    vh: viewport.height,
  };
}

function sameFrame(a: Frame, b: Frame): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height && a.vw === b.vw && a.vh === b.vh;
}

/** The anchor's own corner radius, so the ring is rounded like the control. */
function anchorRadius(anchor: HTMLElement): number {
  const parsed = Number.parseFloat(window.getComputedStyle(anchor).borderTopLeftRadius);
  return Number.isFinite(parsed) ? parsed : 6;
}

function prefersReducedMotion(): boolean {
  if (document.documentElement.dataset.motion === "reduced") return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Box = { left: number; top: number; width: number; height: number };

/**
 * Where the card goes: beside a small control or a row (right, below, left,
 * above), so a sidebar row's card sits in the open page instead of over the
 * rows above it; above or below a wide control (the composer sits low, so
 * above first). Clamped inside the window either way.
 */
function placeCard(ring: Box, cardHeight: number, vw: number, vh: number): { x: number; y: number } {
  const w = CARD_WIDTH;
  const h = cardHeight;
  const right = ring.left + ring.width;
  const bottom = ring.top + ring.height;
  const wide = ring.width > CARD_WIDTH;
  const alignX = wide ? ring.left : ring.left + ring.width / 2 - w / 2;
  const alignY = ring.top + ring.height / 2 - h / 2;
  const sides = {
    right: { x: right + CARD_GAP, y: alignY, fits: right + CARD_GAP + w <= vw - VIEWPORT_MARGIN },
    below: { x: alignX, y: bottom + CARD_GAP, fits: bottom + CARD_GAP + h <= vh - VIEWPORT_MARGIN },
    left: { x: ring.left - CARD_GAP - w, y: alignY, fits: ring.left - CARD_GAP - w >= VIEWPORT_MARGIN },
    above: { x: alignX, y: ring.top - CARD_GAP - h, fits: ring.top - CARD_GAP - h >= VIEWPORT_MARGIN },
  };
  const rowLike = ring.width <= CARD_WIDTH * 2;
  const order = wide && !rowLike
    ? [sides.above, sides.below, sides.right, sides.left]
    : [sides.right, sides.below, sides.left, sides.above];
  const pick = order.find((side) => side.fits) ?? order[0]!;
  return {
    x: clamp(pick.x, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vw - w - VIEWPORT_MARGIN)),
    y: clamp(pick.y, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vh - h - VIEWPORT_MARGIN)),
  };
}

function translate(x: number, y: number): string {
  return `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

function OnboardingHintOverlay({ def, anchor }: { def: OnboardingHintDef; anchor: HTMLElement }) {
  const titleId = useId();
  const [frame, setFrame] = useState(() => readFrame(anchor));
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const radius = useMemo(() => anchorRadius(anchor), [anchor]);
  const [reduced] = useState(prefersReducedMotion);
  const [glide] = useState(() => !reduced && !glidedThisSession.has(def.id));
  const [ringShown, setRingShown] = useState(!glide);
  const [cursorShown, setCursorShown] = useState(glide);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const [cardHeight, setCardHeight] = useState<number | null>(null);

  // Follow the control: its own size, window resizes, any scroll, and a 1s
  // re-measure for layout moves none of those report. rAF-throttled.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      const next = readFrame(anchor);
      setFrame((prev) => (sameFrame(prev, next) ? prev : next));
    };
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(anchor);
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    const interval = window.setInterval(schedule, SCAN_INTERVAL_MS);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.clearInterval(interval);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [anchor]);

  // The ghost cursor: glide from the middle of the window, a small press,
  // then fade. Transform and opacity only; runs once per hint per session.
  useLayoutEffect(() => {
    const cursor = cursorRef.current;
    if (!glide || !cursor || typeof cursor.animate !== "function") {
      setRingShown(true);
      setCursorShown(false);
      return undefined;
    }
    glidedThisSession.add(def.id);
    const start = frameRef.current;
    // The arrow's tip sits 2px into its box.
    const fromX = start.vw / 2 - 2;
    const fromY = start.vh / 2 - 2;
    const toX = start.left + start.width / 2 - 2;
    const toY = start.top + start.height / 2 - 2;
    let cancelled = false;
    const glideAnimation = cursor.animate(
      [
        { transform: translate(fromX, fromY), opacity: 0 },
        { opacity: 1, offset: 0.2 },
        { transform: translate(toX, toY), opacity: 1 },
      ],
      { duration: GLIDE_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
    );
    let pressAnimation: Animation | null = null;
    glideAnimation.finished
      .then(() => {
        if (cancelled) return undefined;
        setRingShown(true);
        pressAnimation = cursor.animate(
          [
            { transform: `${translate(toX, toY)} scale(1)`, opacity: 1 },
            { transform: `${translate(toX, toY)} scale(0.8)`, opacity: 1, offset: 0.3 },
            { transform: `${translate(toX, toY)} scale(1)`, opacity: 1, offset: 0.55 },
            { transform: `${translate(toX, toY)} scale(1)`, opacity: 0 },
          ],
          { duration: PRESS_MS, easing: "ease-out", fill: "forwards" },
        );
        return pressAnimation.finished;
      })
      .then(() => {
        if (!cancelled) setCursorShown(false);
      })
      .catch(() => {
        // Cancelled on unmount.
      });
    return () => {
      cancelled = true;
      glideAnimation.cancel();
      pressAnimation?.cancel();
    };
  }, [def.id, glide]);

  useLayoutEffect(() => {
    if (!ringShown) return;
    const height = cardRef.current?.offsetHeight ?? null;
    if (height) setCardHeight(height);
  }, [ringShown]);

  const ring: Box = {
    left: frame.left - RING_PAD,
    top: frame.top - RING_PAD,
    width: frame.width + RING_PAD * 2,
    height: frame.height + RING_PAD * 2,
  };
  const card = cardHeight == null ? null : placeCard(ring, cardHeight, frame.vw, frame.vh);

  return (
    <ViewportOverlayPortal layer="onboardingHint">
      <div className="ade-onboarding-hint-layer" data-onboarding-hint-layer="" data-hint-id={def.id}>
        {cursorShown ? (
          <div ref={cursorRef} className="ade-onboarding-hint-cursor" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 20 20">
              <path d="M2.5 2.2 L2.5 16.2 L6.2 12.8 L8.7 18.2 L11.1 17.1 L8.6 11.8 L13.6 11.6 Z" />
            </svg>
          </div>
        ) : null}
        {ringShown ? (
          <>
            <div
              className="ade-onboarding-hint-ring"
              data-pulse={reduced ? undefined : "true"}
              aria-hidden
              style={{
                width: ring.width,
                height: ring.height,
                borderRadius: radius + RING_PAD,
                transform: translate(ring.left, ring.top),
              }}
            />
            <div
              className="ade-onboarding-hint-card-slot"
              data-placed={card ? "true" : undefined}
              style={{ width: CARD_WIDTH, transform: card ? translate(card.x, card.y) : undefined }}
            >
              <section
                ref={cardRef}
                className="kit-card ade-onboarding-hint-card"
                data-float="true"
                aria-labelledby={titleId}
              >
                <div className="ade-onboarding-hint-card-top">
                  <span className="kit-dot" data-state="accent" aria-hidden />
                  <h2 id={titleId} className="ade-onboarding-hint-title">{def.title}</h2>
                  <button
                    type="button"
                    className="kit-icon-btn ade-onboarding-hint-close"
                    aria-label="Close hint"
                    title="Close hint"
                    onClick={() => dismissHint(def.id)}
                  >
                    <X size={12} weight="bold" />
                  </button>
                </div>
                <p className="ade-onboarding-hint-line">{def.line}</p>
                <button type="button" className="ade-onboarding-hint-skip" onClick={skipOnboarding}>
                  Skip onboarding
                </button>
              </section>
            </div>
          </>
        ) : null}
      </div>
    </ViewportOverlayPortal>
  );
}
