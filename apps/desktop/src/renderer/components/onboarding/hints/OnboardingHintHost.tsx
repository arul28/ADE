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
  createSettle,
  findVisibleAnchor,
  followAnchor,
  isAnchorVisible,
  placeCard,
  prefersReducedMotion,
  readFrame,
  sameFrame,
  translate,
  type Box,
  type Frame,
} from "../tour/anchorGeometry";
import { FLOATS_OVER_BROWSER_PROPS, modalOpen } from "../../ui/overlayState";
import { TourCursorMotion, type Point } from "../tour/tourCursor";
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
/** The cursor's fade after its press, before it is taken out. */
const CURSOR_FADE_MS = 200;

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
  const openIds = useMemo<readonly OnboardingHintId[]>(
    () => (isTourOpen(progress) ? [] : ONBOARDING_HINTS.filter((hint) => hintStillOpen(hint.id, progress)).map((hint) => hint.id)),
    [progress],
  );
  if (!openIds.length) return null;
  return <OnboardingHintScanner openIds={openIds} />;
}

type ActiveHint = { def: OnboardingHintDef; anchor: HTMLElement };

/** The hint to show now: the one already up while its anchor stays, else the first open one on screen. */
function pickHint(openIds: readonly OnboardingHintId[], current: ActiveHint | null): ActiveHint | null {
  if (modalOpen()) return null;
  if (current && openIds.includes(current.def.id)) {
    const anchor = isAnchorVisible(current.anchor) && current.anchor.getAttribute(ONBOARDING_ANCHOR_ATTR) === current.def.id
      ? current.anchor
      : findVisibleAnchor(current.def.id);
    if (anchor) return { def: current.def, anchor };
  }
  for (const hint of ONBOARDING_HINTS) {
    if (!openIds.includes(hint.id)) continue;
    const anchor = findVisibleAnchor(hint.id);
    if (anchor) return { def: hint, anchor };
  }
  return null;
}

function OnboardingHintScanner({ openIds }: { openIds: readonly OnboardingHintId[] }) {
  const [active, setActive] = useState<ActiveHint | null>(null);
  const activeRef = useRef<ActiveHint | null>(null);

  // Doing the thing finishes the hint, even before its ring shows.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Anchors nest (a row inside its wrapper), so ask each hint about its own.
      for (const id of openIds) {
        if (target.closest(`[${ONBOARDING_ANCHOR_ATTR}="${id}"]`)) markHintDone(id);
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [openIds]);

  useEffect(() => {
    let watch: TourWatch | null = null;
    const settle = createSettle<OnboardingHintId>(SETTLE_MS);
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
        settle.reset();
        commit(null);
        return;
      }
      if (current && current.def.id === next.def.id) {
        commit(next);
        return;
      }
      // A new anchor: hide whatever was up and let the user look at the app first.
      commit(null);
      const settleLeft = settle.wait(next.def.id, performance.now());
      if (settleLeft > 0) {
        watch?.scheduleCheck(settleLeft);
        return;
      }
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
function placeHintCard(ring: Box, cardHeight: number, frame: Frame): { x: number; y: number } {
  const wide = ring.width > CARD_WIDTH;
  const rowLike = ring.width <= CARD_WIDTH * 2;
  const order = wide && !rowLike
    ? (["above", "below", "right", "left"] as const)
    : (["right", "below", "left", "above"] as const);
  return placeCard(ring, { width: CARD_WIDTH, height: cardHeight }, frame, order, CARD_GAP);
}

/** The middle of the control, where the cursor's tip lands. */
function centreOf(frame: Frame): Point {
  return { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 };
}

function OnboardingHintOverlay({ def, anchor }: { def: OnboardingHintDef; anchor: HTMLElement }) {
  const titleId = useId();
  const radius = useMemo(() => anchorRadius(anchor), [anchor]);
  const [reduced] = useState(prefersReducedMotion);
  const [glide] = useState(() => !reduced && !glidedThisSession.has(def.id));
  const [ringShown, setRingShown] = useState(!glide);
  const [cursorShown, setCursorShown] = useState(glide);
  const [cursor] = useState(() => new TourCursorMotion({ resume: false }));
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);

  // The ghost cursor: the tour's own glide from the middle of the window,
  // one press, then it fades. Runs once per hint per session.
  useLayoutEffect(() => {
    if (!glide) return undefined;
    const element = cursorRef.current;
    if (!element || typeof element.animate !== "function") {
      setRingShown(true);
      setCursorShown(false);
      return undefined;
    }
    glidedThisSession.add(def.id);
    cursor.attach(element);
    const frame = readFrame(anchor);
    let fadeTimer = 0;
    cursor.glideTo(
      centreOf(frame),
      {
        reduced: false,
        press: true,
        viewport: { x: frame.vw, y: frame.vh },
        afterPress: () => {
          cursor.hide();
          fadeTimer = window.setTimeout(() => setCursorShown(false), CURSOR_FADE_MS);
        },
      },
      () => setRingShown(true),
    );
    return () => {
      window.clearTimeout(fadeTimer);
      cursor.stop();
    };
    // The glide starts once, toward wherever the control is when the hint opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, def.id, glide]);

  // Follow the control with direct style writes (its size, the card's size,
  // window resizes, any scroll, and a slow re-measure for moves none of those
  // report). A frame that did not move writes nothing.
  useLayoutEffect(() => {
    let lastFrame: Frame | null = null;
    let lastCardHeight = -1;
    const layout = () => {
      const frame = readFrame(anchor);
      const cardHeight = cardRef.current?.offsetHeight ?? 0;
      if (lastFrame && sameFrame(lastFrame, frame) && cardHeight === lastCardHeight) return;
      lastFrame = frame;
      lastCardHeight = cardHeight;
      cursor.follow(centreOf(frame));
      const ring: Box = {
        left: frame.left - RING_PAD,
        top: frame.top - RING_PAD,
        width: frame.width + RING_PAD * 2,
        height: frame.height + RING_PAD * 2,
      };
      const ringElement = ringRef.current;
      if (ringElement) {
        ringElement.style.width = `${ring.width}px`;
        ringElement.style.height = `${ring.height}px`;
        ringElement.style.transform = translate(ring.left, ring.top);
      }
      const slot = slotRef.current;
      if (!slot || !cardHeight) return;
      const card = placeHintCard(ring, cardHeight, frame);
      slot.style.transform = translate(card.x, card.y);
      slot.dataset.placed = "true";
    };
    const follow = followAnchor(anchor, layout, { fallbackMs: SCAN_INTERVAL_MS, observe: [cardRef.current] });
    return follow.dispose;
  }, [anchor, cursor, ringShown]);

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
              ref={ringRef}
              className="ade-onboarding-hint-ring"
              data-pulse={reduced ? undefined : "true"}
              aria-hidden
              style={{ borderRadius: radius + RING_PAD }}
            />
            <div ref={slotRef} className="ade-onboarding-hint-card-slot" style={{ width: CARD_WIDTH }}>
              <section
                ref={cardRef}
                className="kit-card ade-onboarding-hint-card"
                data-float="true"
                {...FLOATS_OVER_BROWSER_PROPS}
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
