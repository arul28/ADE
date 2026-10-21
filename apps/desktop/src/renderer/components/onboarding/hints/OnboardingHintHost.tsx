import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { ViewportOverlayPortal } from "../../ui/ViewportOverlayHost";
import {
  ONBOARDING_ANCHOR_ATTR,
  dismissHint,
  isHintOpen,
  isOnboardingActive,
  isTourOpen,
  markHintDone,
  markHintShown,
  readOnboardingProgress,
  skipOnboarding,
  subscribeOnboardingProgress,
  type OnboardingHintId,
  type OnboardingProgress,
} from "../../../onboarding/onboardingProgress";
import { ONBOARDING_HINTS, type OnboardingHintDef } from "./onboardingHintDefs";
import { AdeTourCursorArt } from "../tour/AdeTourCursorArt";
import { watchTourDom, type TourWatch } from "../tour/tourWatch";
import {
  anchorRadius,
  findVisibleAnchor,
  hasOpenModal,
  isAnchorVisible,
  placeCard as placeBesideRing,
  prefersReducedMotion,
  readFrame,
  sameFrame,
  translate,
  type Box,
} from "../tour/anchorGeometry";
import "./onboardingHints.css";

/**
 * Contextual hints: after the guided tour (`OnboardingTourHost`), ADE points at
 * a real control when a moment calls for it (a chat that needs you), without
 * blocking anything. A ghost cursor glides once from
 * the middle of the window to the control, then a ring settles around it with
 * a small card beside it. Pointer events pass through everything but the card.
 *
 * Cost: while onboarding is off (almost every user, almost all the time) the
 * host renders nothing and holds only the progress subscription. While it is
 * on, it looks for anchors when the page changes (`watchTourDom`, at most once
 * a second, never while the window is hidden); once every hint is finished
 * the watch stops with it.
 */

/** At most how often the host looks for anchors, and how long one must stay before its hint starts. */
const SCAN_INTERVAL_MS = 1_000;
const SETTLE_MS = 900;
/** Ring padding around the control. */
const RING_PAD = 4;
const CARD_WIDTH = 280;
const CARD_GAP = 12;
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
  // The tour goes first; hints wait until it is finished.
  if (isTourOpen(progress)) return null;
  const openKey = ONBOARDING_HINTS.filter((hint) => hintStillOpen(hint.id, progress))
    .map((hint) => hint.id)
    .join(",");
  if (!openKey) return null;
  return <OnboardingHintScanner openKey={openKey} />;
}

type ActiveHint = { def: OnboardingHintDef; anchor: HTMLElement };

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
      // Anchors nest (a row inside its wrapper), so ask each hint about its own.
      for (const def of ONBOARDING_HINTS) {
        if (!def.doneOnClick || !openIds.includes(def.id)) continue;
        if (target.closest(`[${ONBOARDING_ANCHOR_ATTR}="${def.id}"]`)) markHintDone(def.id);
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [openIds]);

  useEffect(() => {
    let watch: TourWatch | null = null;
    const commit = (next: ActiveHint | null) => {
      const current = activeRef.current;
      if (current === next || (current && next && current.def === next.def && current.anchor === next.anchor)) return;
      activeRef.current = next;
      setActive(next);
    };
    const scan = () => {
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
        watch?.scheduleCheck(SETTLE_MS);
        return;
      }
      if (now - pending.since < SETTLE_MS) {
        watch?.scheduleCheck(SETTLE_MS - (now - pending.since));
        return;
      }
      pendingRef.current = null;
      commit(next);
    };
    watch = watchTourDom(scan, { minIntervalMs: SCAN_INTERVAL_MS });
    return () => watch?.dispose();
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

/**
 * Where the card goes: beside a small control or a row (right, below, left,
 * above), so a sidebar row's card sits in the open page instead of over the
 * rows above it; above or below a wide control (the composer sits low, so
 * above first). Clamped inside the window either way.
 */
function placeCard(ring: Box, cardHeight: number, vw: number, vh: number): { x: number; y: number } {
  const wide = ring.width > CARD_WIDTH;
  const rowLike = ring.width <= CARD_WIDTH * 2;
  const order = wide && !rowLike
    ? (["above", "below", "right", "left"] as const)
    : (["right", "below", "left", "above"] as const);
  return placeBesideRing(ring, { width: CARD_WIDTH, height: cardHeight }, { vw, vh }, order, CARD_GAP);
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
    // The arrow's tip sits 3px into its box.
    const fromX = start.vw / 2 - 3;
    const fromY = start.vh / 2 - 3;
    const toX = start.left + start.width / 2 - 3;
    const toY = start.top + start.height / 2 - 3;
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
            <AdeTourCursorArt />
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
