import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, CursorClick } from "@phosphor-icons/react";
import { ViewportOverlayPortal } from "../../ui/ViewportOverlayHost";
import { useAppStore } from "../../../state/appStore";
import {
  ONBOARDING_ANCHOR_ATTR,
  completeTour,
  isTourOpen,
  readOnboardingProgress,
  setTourStep,
  skipOnboarding,
  subscribeOnboardingProgress,
} from "../../../onboarding/onboardingProgress";
import {
  anchorRadius,
  findVisibleAnchor,
  hasOpenModal,
  isAnchorVisible,
  placeCard,
  prefersReducedMotion,
  readFrame,
  sameFrame,
  translate,
  type Box,
  type Frame,
} from "./anchorGeometry";
import { AdeTourCursorArt } from "./AdeTourCursorArt";
import { TOUR_STEPS, type TourDestination, type TourStepDef } from "./onboardingTourSteps";
import "./onboardingTour.css";

/**
 * The guided tour that follows first-run setup (and "Show me around again").
 * An ADE cursor glides to a real control, a ring settles on it, and a small
 * card beside it says what it is and what to do. Nothing is dimmed or
 * blocked: pointer events pass through everything but the card.
 *
 * The tour waits rather than breaks. When the user goes somewhere else, the
 * card and cursor step aside and a small "Tour paused" pill offers to take
 * them back; when the control is on screen again the step picks up where it
 * was, across reloads. Only "Skip tour" (or finishing) ends it.
 *
 * Cost: off (almost always) it renders nothing and holds one progress
 * subscription. While it runs, one 500ms scan looks for the current step's
 * control; the card follows its control with a ResizeObserver and rAF.
 */

const SCAN_INTERVAL_MS = 500;
/** A new control must stay this long before the tour moves onto it. */
const SETTLE_MS = 350;
/** Missing this long, the step pauses and the pill shows. */
const PAUSE_AFTER_MS = 1_200;
const RING_PAD = 5;
const CARD_WIDTH = 300;
const CARD_GAP = 14;
/** The cursor art's tip sits this far into its box. */
const CURSOR_TIP = 3;

/** Where the cursor last rested this session, so each glide starts where the previous one ended. */
let lastCursorPoint: { x: number; y: number } | null = null;
/** Steps whose cursor already glided this session; one that comes back shows straight away. */
const glidedThisSession = new Set<string>();

export function OnboardingTourHost() {
  const [progress, setProgress] = useState(readOnboardingProgress);
  useEffect(() => subscribeOnboardingProgress(() => setProgress(readOnboardingProgress())), []);
  if (!isTourOpen(progress)) return null;
  return <TourRunner stepId={progress.tour.step ?? null} />;
}

function stepIndexOf(stepId: string | null): number {
  const index = stepId ? TOUR_STEPS.findIndex((step) => step.id === stepId) : -1;
  return index < 0 ? 0 : index;
}

function findStepAnchor(step: TourStepDef): HTMLElement | null {
  for (const id of step.anchors) {
    const anchor = findVisibleAnchor(id);
    if (anchor) return anchor;
  }
  return null;
}

function isStepAnchor(step: TourStepDef, node: HTMLElement): boolean {
  const id = node.getAttribute(ONBOARDING_ANCHOR_ATTR);
  return id != null && step.anchors.includes(id);
}

/** "Show me": take the user to where a step's control lives. */
function useGoTo(): (destination: TourDestination) => void {
  const navigate = useNavigate();
  return useCallback((destination: TourDestination) => {
    const store = useAppStore.getState();
    if (destination === "home") {
      store.openNewTab();
      return;
    }
    if (store.isNewTabOpen && store.project) store.cancelNewTab();
    else if (store.showWelcome && store.project) store.setShowWelcome(false);
    navigate("/work");
    if (destination !== "draft") return;
    // Work keeps the last chat open; its own New chat button is the way to a
    // fresh draft, with the lane and machine Work would pick.
    window.setTimeout(() => {
      if (document.querySelector("[data-work-draft-surface]")) return;
      document.querySelector<HTMLElement>(`[${ONBOARDING_ANCHOR_ATTR}="new-chat"]`)?.click();
    }, 250);
  }, [navigate]);
}

type View =
  | { kind: "hidden" }
  | { kind: "paused" }
  | { kind: "shown"; anchor: HTMLElement };

function TourRunner({ stepId }: { stepId: string | null }) {
  const index = stepIndexOf(stepId);
  const step = TOUR_STEPS[index]!;
  const [view, setView] = useState<View>({ kind: "hidden" });
  const viewRef = useRef<View>(view);
  const directionRef = useRef<1 | -1>(1);
  const goTo = useGoTo();
  const autoNavigatedRef = useRef(false);

  const moveTo = useCallback((nextIndex: number, direction: 1 | -1) => {
    directionRef.current = direction;
    if (nextIndex >= TOUR_STEPS.length) {
      completeTour();
      return;
    }
    const next = TOUR_STEPS[Math.max(0, nextIndex)];
    if (next) setTourStep(next.id);
  }, []);
  const next = useCallback(() => moveTo(index + 1, 1), [index, moveTo]);
  const back = useCallback(() => moveTo(index - 1, -1), [index, moveTo]);

  // Doing what a click step asks moves the tour on, after the click lands.
  useEffect(() => {
    if (step.advance !== "click") return undefined;
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Anchors nest (a chat row inside the list), so look for this step's own.
      const hit = step.anchors.some((id) => target.closest(`[${ONBOARDING_ANCHOR_ATTR}="${id}"]`));
      if (hit) window.setTimeout(next, 0);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [next, step]);

  useEffect(() => {
    let pending: { anchor: HTMLElement; since: number } | null = null;
    let missingSince: number | null = null;
    const commit = (nextView: View) => {
      const current = viewRef.current;
      if (current.kind === nextView.kind && (nextView.kind !== "shown" || (current.kind === "shown" && current.anchor === nextView.anchor))) {
        return;
      }
      viewRef.current = nextView;
      setView(nextView);
    };
    const scan = () => {
      if (document.hidden) return;
      if (hasOpenModal()) {
        pending = null;
        missingSince = null;
        commit({ kind: "hidden" });
        return;
      }
      const current = viewRef.current;
      if (current.kind === "shown" && isAnchorVisible(current.anchor) && isStepAnchor(step, current.anchor)) {
        missingSince = null;
        return;
      }
      const anchor = findStepAnchor(step);
      if (anchor) {
        missingSince = null;
        // A control that just appeared: give the page a beat to settle first.
        const now = performance.now();
        if (current.kind === "shown") {
          commit({ kind: "shown", anchor });
          return;
        }
        if (!pending || pending.anchor !== anchor) {
          pending = { anchor, since: now };
          return;
        }
        if (now - pending.since < SETTLE_MS) return;
        pending = null;
        commit({ kind: "shown", anchor });
        return;
      }
      pending = null;
      if (step.skipIf?.()) {
        moveTo(index + directionRef.current, directionRef.current);
        return;
      }
      const now = performance.now();
      missingSince ??= now;
      if (now - missingSince < PAUSE_AFTER_MS) {
        if (current.kind === "shown") commit({ kind: "hidden" });
        return;
      }
      commit({ kind: "paused" });
      // The very first step takes the user there once on its own: right after
      // setup they may have landed on Home.
      if (index === 0 && step.goTo && !autoNavigatedRef.current) {
        autoNavigatedRef.current = true;
        goTo(step.goTo);
      }
    };
    scan();
    const interval = window.setInterval(scan, SCAN_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [goTo, index, moveTo, step]);

  const skip = useCallback(() => skipOnboarding(), []);
  const showMe = useCallback(() => {
    if (step.goTo) goTo(step.goTo);
  }, [goTo, step.goTo]);

  return (
    <>
      {view.kind === "shown" ? (
        <TourOverlay
          key={step.id}
          step={step}
          anchor={view.anchor}
          index={index}
          onNext={next}
          onBack={index > 0 ? back : null}
          onSkip={skip}
        />
      ) : null}
      {view.kind === "paused" ? (
        <TourPausedPill step={step} index={index} onShowMe={step.goTo ? showMe : null} onSkip={skip} />
      ) : null}
    </>
  );
}

function TourOverlay({
  step,
  anchor,
  index,
  onNext,
  onBack,
  onSkip,
}: {
  step: TourStepDef;
  anchor: HTMLElement;
  index: number;
  onNext: () => void;
  onBack: (() => void) | null;
  onSkip: () => void;
}) {
  const titleId = useId();
  const [frame, setFrame] = useState(() => readFrame(anchor));
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const radius = useMemo(() => anchorRadius(anchor), [anchor]);
  const [reduced] = useState(prefersReducedMotion);
  const [glide] = useState(() => !reduced && !glidedThisSession.has(step.id));
  const [arrived, setArrived] = useState(!glide);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const [cardHeight, setCardHeight] = useState<number | null>(null);
  const last = index === TOUR_STEPS.length - 1;

  // Follow the control: its own size, window resizes, any scroll, and a
  // periodic re-measure for layout moves none of those report. rAF-throttled.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      raf = 0;
      const nextFrame = readFrame(anchor);
      setFrame((prev) => (sameFrame(prev, nextFrame) ? prev : nextFrame));
    };
    const schedule = () => {
      if (!raf) raf = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(anchor);
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    const interval = window.setInterval(schedule, 1_000);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.clearInterval(interval);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [anchor]);

  const target = cursorTarget(frame);

  // The cursor glides from where it last rested (or the middle of the window)
  // to the control, then the ring and card settle. A click step adds two
  // presses. Transform only; runs once per step per session.
  useLayoutEffect(() => {
    const cursor = cursorRef.current;
    const start = frameRef.current;
    const to = cursorTarget(start);
    if (!cursor) return undefined;
    if (!glide || typeof cursor.animate !== "function") {
      cursor.style.transform = translate(to.x - CURSOR_TIP, to.y - CURSOR_TIP);
      lastCursorPoint = to;
      setArrived(true);
      return undefined;
    }
    glidedThisSession.add(step.id);
    const from = lastCursorPoint ?? { x: start.vw / 2, y: start.vh / 2 };
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const duration = Math.round(Math.min(950, Math.max(480, distance * 0.9)));
    const fromTransform = translate(from.x - CURSOR_TIP, from.y - CURSOR_TIP);
    const toTransform = translate(to.x - CURSOR_TIP, to.y - CURSOR_TIP);
    let cancelled = false;
    const glideAnimation = cursor.animate(
      [
        { transform: fromTransform, opacity: lastCursorPoint ? 1 : 0 },
        { opacity: 1, offset: 0.25 },
        { transform: toTransform, opacity: 1 },
      ],
      { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
    );
    let pressAnimation: Animation | null = null;
    glideAnimation.finished
      .then(() => {
        if (cancelled) return undefined;
        // Hand the resting place to inline style so the cursor can follow the control.
        cursor.style.transform = toTransform;
        cursor.style.opacity = "1";
        glideAnimation.cancel();
        lastCursorPoint = to;
        setArrived(true);
        if (step.advance !== "click") return undefined;
        pressAnimation = cursor.animate(
          [
            { transform: `${toTransform} scale(1)` },
            { transform: `${toTransform} scale(0.82)`, offset: 0.18 },
            { transform: `${toTransform} scale(1)`, offset: 0.36 },
            { transform: `${toTransform} scale(1)`, offset: 0.6 },
            { transform: `${toTransform} scale(0.82)`, offset: 0.78 },
            { transform: `${toTransform} scale(1)` },
          ],
          { duration: 1_400, easing: "ease-in-out", delay: 250 },
        );
        return pressAnimation.finished;
      })
      .catch(() => {
        // Cancelled on unmount.
      });
    return () => {
      cancelled = true;
      glideAnimation.cancel();
      pressAnimation?.cancel();
    };
  }, [glide, step.advance, step.id]);

  // After the glide, the cursor rests on the control and follows it.
  useEffect(() => {
    const cursor = cursorRef.current;
    if (!arrived || !cursor) return;
    cursor.style.transform = translate(target.x - CURSOR_TIP, target.y - CURSOR_TIP);
    lastCursorPoint = target;
  }, [arrived, target.x, target.y]);

  useLayoutEffect(() => {
    if (!arrived) return;
    const height = cardRef.current?.offsetHeight ?? null;
    if (height) setCardHeight(height);
  }, [arrived]);

  // Keyboard users land on the card's main button once it is placed.
  useEffect(() => {
    if (cardHeight == null || (step.advance === "click" && !last)) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    nextRef.current?.focus({ preventScroll: true });
  }, [cardHeight, last, step.advance]);

  const ring: Box = {
    left: frame.left - RING_PAD,
    top: frame.top - RING_PAD,
    width: frame.width + RING_PAD * 2,
    height: frame.height + RING_PAD * 2,
  };
  const card = cardHeight == null
    ? null
    : placeCard(ring, { width: CARD_WIDTH, height: cardHeight }, frame, step.place, CARD_GAP);
  const caret = card ? caretOffset(card, ring) : null;

  return (
    <ViewportOverlayPortal layer="onboardingTour">
      <div className="ade-tour-layer" data-onboarding-hint-layer="" data-tour-step={step.id}>
        {arrived ? (
          <div
            className="ade-tour-ring"
            data-pulse={reduced ? undefined : "true"}
            aria-hidden
            style={{
              width: ring.width,
              height: ring.height,
              borderRadius: radius + RING_PAD,
              transform: translate(ring.left, ring.top),
            }}
          />
        ) : null}
        <div ref={cursorRef} className="ade-tour-cursor" data-arrived={arrived ? "true" : undefined} aria-hidden>
          <AdeTourCursorArt />
        </div>
        {arrived ? (
          <div
            className="ade-tour-card-slot"
            data-placed={card ? "true" : undefined}
            style={{ width: CARD_WIDTH, transform: card ? translate(card.x, card.y) : undefined }}
          >
            <section
              ref={cardRef}
              className="kit-card ade-tour-card"
              data-float="true"
              data-side={card?.side}
              aria-labelledby={titleId}
            >
              {caret != null && card ? (
                <span
                  className="ade-tour-caret"
                  data-side={card.side}
                  aria-hidden
                  style={card.side === "above" || card.side === "below" ? { left: caret } : { top: caret }}
                />
              ) : null}
              <div className="ade-tour-card-top">
                <span className="ade-tour-count">
                  {index + 1} of {TOUR_STEPS.length}
                </span>
                <button type="button" className="ade-tour-skip" onClick={onSkip}>
                  Skip tour
                </button>
              </div>
              <h2 id={titleId} className="ade-tour-title">{step.title}</h2>
              <p className="ade-tour-line">{step.line}</p>
              <div className="ade-tour-actions">
                {step.advance === "click" ? (
                  <span className="ade-tour-ask">
                    <CursorClick size={13} weight="bold" aria-hidden />
                    {step.clickLabel ?? "Click it"}
                  </span>
                ) : (
                  <span />
                )}
                <span className="ade-tour-buttons">
                  {onBack ? (
                    <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={onBack}>
                      Back
                    </button>
                  ) : null}
                  <button
                    ref={nextRef}
                    type="button"
                    className={step.advance === "click" && !last ? "kit-btn kit-btn-ghost" : "kit-btn kit-btn-primary"}
                    data-size="sm"
                    onClick={onNext}
                  >
                    {last ? "Done" : "Next"}
                    {step.advance === "click" || last ? null : <ArrowRight size={12} weight="bold" aria-hidden />}
                  </button>
                </span>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </ViewportOverlayPortal>
  );
}

/** Where the cursor's tip rests: the middle of the control. */
function cursorTarget(frame: Frame): { x: number; y: number } {
  return { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 };
}

/** The caret's offset along the card edge that faces the control, kept off the corners. */
function caretOffset(card: { x: number; y: number; side: string }, ring: Box): number | null {
  const inset = 18;
  if (card.side === "above" || card.side === "below") {
    const centre = ring.left + ring.width / 2 - card.x;
    return Math.min(Math.max(centre, inset), CARD_WIDTH - inset);
  }
  const centre = ring.top + ring.height / 2 - card.y;
  return Math.max(centre, inset);
}

function TourPausedPill({
  step,
  index,
  onShowMe,
  onSkip,
}: {
  step: TourStepDef;
  index: number;
  onShowMe: (() => void) | null;
  onSkip: () => void;
}) {
  return (
    <ViewportOverlayPortal layer="onboardingTour">
      <div className="ade-tour-layer">
        <div className="ade-tour-pill" role="status">
          <span className="ade-tour-pill-cursor" aria-hidden>
            <AdeTourCursorArt />
          </span>
          <span className="ade-tour-pill-text">
            <span className="ade-tour-pill-title">Tour paused</span>
            <span className="ade-tour-pill-sub">
              {index + 1} of {TOUR_STEPS.length} · {step.title}
              {onShowMe ? null : ` · back in ${step.where}`}
            </span>
          </span>
          {onShowMe ? (
            <button type="button" className="kit-btn kit-btn-primary" data-size="sm" onClick={onShowMe}>
              Show me
            </button>
          ) : null}
          <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={onSkip}>
            Skip tour
          </button>
        </div>
      </div>
    </ViewportOverlayPortal>
  );
}
