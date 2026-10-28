import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CursorClick, PaperPlaneRight } from "@phosphor-icons/react";
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
  createSettle,
  findOutOfViewAnchor,
  followAnchor,
  findVisibleAnchor,
  isAnchorVisible,
  placeCard,
  prefersReducedMotion,
  readFrame,
  sameFrame,
  translate,
  type Box,
  type Frame,
} from "./anchorGeometry";
import { FLOATS_OVER_BROWSER_PROPS, modalOpen } from "../../ui/overlayState";
import { useLaneChatHandoff } from "../../../lib/laneChatHandoff";
import { AdeTourCursorArt } from "./AdeTourCursorArt";
import { FIRST_CHAT_PROMPT, pickFirstChatModel, type FirstChatModel } from "./firstChat";
import { setOpenDraftModel } from "../../chat/draftModelSeam";
import {
  TOUR_FINISH_ID,
  TOUR_STEPS,
  isDoStep,
  noChatsToOpen,
  stepCopy,
  type TourAsk,
  type TourPlace,
  type TourStepDef,
} from "./onboardingTourSteps";
import { TourCursorMotion, type Point } from "./tourCursor";
import { TourFinishCard } from "./TourFinishCard";
import { watchTourDom, type TourWatch } from "./tourWatch";
import { useGoTo } from "../spotlight/useGoTo";
import "./onboardingTour.css";

/**
 * The guided tour that follows first-run setup (and "Show me around again").
 * One ADE cursor glides from control to control, a ring settles on each, and
 * a small card beside it says what it is: a read step ends in Next, a do-it
 * step asks for one thing ("Click New chat") and moves on when it is done.
 * Nothing is dimmed or blocked: pointer events pass through everything but
 * the card.
 *
 * The tour waits rather than breaks. When the control is not on screen (the
 * user went elsewhere, or has not got there yet) the cursor fades where it
 * is and a small pill offers "Show me"; when the control is back the cursor
 * glides on from there, across reloads. The tour never navigates on its own.
 * After the last step a "You're all set" card closes it.
 *
 * Cost: off (almost always) it renders nothing and holds one progress
 * subscription. While it runs it does no polling: it wakes on DOM changes,
 * resizes, scrolls and input (coalesced to at most three checks a second, at
 * the start of a frame, none while the window is hidden), and the ring and
 * card follow their control by direct style writes, not React renders.
 */

/** A new control must stay this long before the tour moves onto it. */
const SETTLE_MS = 350;
/** A step's skip condition must hold this long before the tour moves past it. */
const SKIP_SETTLE_MS = 400;
/** Missing this long, the step pauses and the pill shows. */
const PAUSE_AFTER_MS = 1_200;
/** At most this often the tour re-checks the page after a change. */
const CHECK_INTERVAL_MS = 300;
/** A slow re-measure for layout moves no event reports (an animated pane). */
const FOLLOW_FALLBACK_MS = 1_500;
const RING_PAD = 5;
const CARD_WIDTH = 300;
const CARD_GAP = 14;

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

const anchorKeys = new WeakMap<HTMLElement, number>();
let nextAnchorKey = 1;

/** A stable id per anchor element, so a new element for the same control counts as a new place to glide to. */
function anchorKeyOf(anchor: HTMLElement): number {
  let key = anchorKeys.get(anchor);
  if (key == null) {
    key = nextAnchorKey++;
    anchorKeys.set(anchor, key);
  }
  return key;
}

type FirstChatSetup = { model: FirstChatModel | null; noAgents: boolean } | null;

/** Filled once per app session: a later visit to the step keeps what the user did to the draft. */
let firstChatSetup: FirstChatSetup = null;

/**
 * The first-chat step: once Work shows an empty chats list, start a new chat
 * in the primary lane with the first question in its composer and a cheap
 * model picked (`firstChat.ts`). Never sends. On the tab's own machine
 * (`pin` null), where its lanes and its status come from.
 *
 * ADE picked that model, not the user, so the draft neither remembers it as
 * the machine's default nor saves it as the composer's last-used model
 * (`rememberLaunchDefaults: false`); a model the user picks in the step is
 * theirs and sticks.
 */
function useFirstChatPrefill(active: boolean): FirstChatSetup {
  const handOff = useLaneChatHandoff(null, { startDraftInLane: true });
  const primaryLaneId = useAppStore((state) => state.lanes.find((lane) => lane.laneType === "primary")?.id ?? null);
  const [setup, setSetup] = useState<FirstChatSetup>(firstChatSetup);

  useEffect(() => {
    if (!active || !primaryLaneId || firstChatSetup) return undefined;
    let cancelled = false;
    let watch: TourWatch | null = null;
    const check = () => {
      // Wait for Work's chats list to say there is nothing yet.
      if (firstChatSetup || !noChatsToOpen()) return;
      firstChatSetup = { model: null, noAgents: false };
      watch?.dispose();
      handOff({ laneId: primaryLaneId, sessionId: null, prompt: FIRST_CHAT_PROMPT });
      void window.ade.ai.getStatus()
        .then(async (status) => {
          const model = pickFirstChatModel(status);
          firstChatSetup = { model, noAgents: !(status.availableModelIds ?? []).length };
          if (!cancelled) setSetup(firstChatSetup);
          if (model) await setOpenDraftModel({ modelId: model.id, rememberLaunchDefaults: false });
        })
        .catch(() => undefined);
    };
    watch = watchTourDom(check, { minIntervalMs: CHECK_INTERVAL_MS });
    return () => {
      cancelled = true;
      watch?.dispose();
    };
  }, [active, handOff, primaryLaneId]);

  return setup;
}

function firstChatLine(setup: FirstChatSetup): string | null {
  if (!setup) return null;
  if (setup.model) {
    return `We filled in a first question on ${setup.model.label}, a quick, low-cost model. `
      + "Nothing runs until you send it.";
  }
  if (setup.noAgents) {
    return "Connect an agent first: the model menu here shows what's set up, "
      + "and Settings › Agents & Models adds more.";
  }
  return null;
}

type View =
  | { kind: "hidden" }
  /** The control is not on screen. `outOfView`: it is there, but clipped or scrolled away. */
  | { kind: "waiting"; outOfView: HTMLElement | null }
  | { kind: "shown"; anchor: HTMLElement };

function sameView(a: View, b: View): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "shown" && b.kind === "shown") return a.anchor === b.anchor;
  if (a.kind === "waiting" && b.kind === "waiting") return a.outOfView === b.outOfView;
  return true;
}

/** Where the cursor's tip rests: the middle of the control. */
function cursorTarget(frame: Frame): Point {
  return { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 };
}

/** The tour's own first step, reused to send the user to a project when a later step needs one. */
const OPEN_PROJECT_STEP = TOUR_STEPS.find((candidate) => candidate.id === "open-project")!;

function TourRunner({ stepId }: { stepId: string | null }) {
  const finishing = stepId === TOUR_FINISH_ID;
  const index = stepIndexOf(stepId);
  const noProjectOpen = useAppStore((state) => state.project == null);
  const step = useMemo(() => {
    const own = TOUR_STEPS[index]!;
    // A step that lives inside a project, with none open (the user closed
    // it, or the tour resumed on a fresh launch): point at the projects
    // first, holding this step's place until one opens.
    if (!noProjectOpen || (own.goTo !== "draft" && own.goTo !== "work")) return own;
    return { ...OPEN_PROJECT_STEP, id: `${own.id}:open-project`, skipIf: undefined };
  }, [index, noProjectOpen]);
  const [view, setView] = useState<View>({ kind: "hidden" });
  const viewRef = useRef<View>(view);
  const directionRef = useRef<1 | -1>(1);
  /** Steps whose card showed during this run: coming back to one says "Tour paused", not "Up next". */
  const seenRef = useRef(new Set<string>());
  const [cursor] = useState(() => new TourCursorMotion());
  const [arrivedKey, setArrivedKey] = useState<string | null>(null);
  const relayoutRef = useRef<(() => void) | null>(null);
  const recheckRef = useRef<(() => void) | null>(null);
  const goTo = useGoTo();

  const moveTo = useCallback((nextIndex: number, direction: 1 | -1) => {
    directionRef.current = direction;
    if (nextIndex >= TOUR_STEPS.length) {
      setTourStep(TOUR_FINISH_ID);
      return;
    }
    const next = TOUR_STEPS[Math.max(0, nextIndex)];
    if (next) setTourStep(next.id);
  }, []);
  const next = useCallback(() => moveTo(index + 1, 1), [index, moveTo]);

  // Doing what a click step asks moves the tour on, after the click lands.
  // Only a real click: "Show me" presses New chat itself.
  useEffect(() => {
    if (finishing || step.advance !== "click") return undefined;
    const onClick = (event: MouseEvent) => {
      if (!event.isTrusted) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      // Anchors nest (a chat row inside the list), so look for this step's own.
      const hit = step.anchors.some((id) => target.closest(`[${ONBOARDING_ANCHOR_ATTR}="${id}"]`));
      if (hit) window.setTimeout(next, 0);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [finishing, next, step]);

  // Find the step's control whenever the page changes: show it once it has
  // settled, pause when it has been gone a moment, skip a step with nothing
  // to do. Event-driven (`watchTourDom`), no polling.
  useEffect(() => {
    if (finishing) return undefined;
    const settle = createSettle<HTMLElement>(SETTLE_MS);
    let missingSince: number | null = null;
    let skipSince: number | null = null;
    let watch: TourWatch | null = null;
    const commit = (nextView: View) => {
      if (sameView(viewRef.current, nextView)) return;
      viewRef.current = nextView;
      setView(nextView);
    };
    const evaluate = () => {
      if (modalOpen()) {
        settle.reset();
        missingSince = null;
        commit({ kind: "hidden" });
        return;
      }
      const now = performance.now();
      const current = viewRef.current;
      // Nothing to do here (already done, or nothing to point at): carry on
      // the way the user was going; at the first step, that is forward. Only
      // once it has held a moment: right after a click the old page is still
      // up (a draft before the chat it opened), and a skip decided on it
      // would race past steps that are about to apply.
      if (step.skipIf?.()) {
        settle.reset();
        skipSince ??= now;
        const skipLeft = SKIP_SETTLE_MS - (now - skipSince);
        if (skipLeft > 0) {
          if (current.kind === "shown" && !isStepAnchor(step, current.anchor)) commit({ kind: "hidden" });
          watch?.scheduleCheck(skipLeft);
          return;
        }
        const direction = index + directionRef.current < 0 ? 1 : directionRef.current;
        moveTo(index + direction, direction);
        return;
      }
      skipSince = null;
      if (current.kind === "shown" && isStepAnchor(step, current.anchor) && isAnchorVisible(current.anchor)) {
        missingSince = null;
        relayoutRef.current?.();
        return;
      }
      const anchor = findStepAnchor(step);
      if (anchor) {
        missingSince = null;
        if (current.kind === "shown") {
          commit({ kind: "shown", anchor });
          return;
        }
        // A control that just appeared: give the page a beat to settle first.
        const settleLeft = settle.wait(anchor, now);
        if (settleLeft > 0) {
          watch?.scheduleCheck(settleLeft);
          return;
        }
        commit({ kind: "shown", anchor });
        return;
      }
      settle.reset();
      missingSince ??= now;
      const pauseLeft = PAUSE_AFTER_MS - (now - missingSince);
      if (pauseLeft > 0) {
        if (current.kind === "shown") commit({ kind: "hidden" });
        watch?.scheduleCheck(pauseLeft);
        return;
      }
      commit({ kind: "waiting", outOfView: findOutOfViewAnchor(step.anchors) });
    };
    watch = watchTourDom(evaluate, { minIntervalMs: CHECK_INTERVAL_MS });
    recheckRef.current = () => watch?.scheduleCheck();
    return () => {
      recheckRef.current = null;
      watch?.dispose();
    };
  }, [finishing, index, moveTo, step]);

  // The one cursor glides to each new control (a new step, or the same one
  // back from a pause) from wherever it is, then the ring and card settle.
  const shownKey = !finishing && view.kind === "shown" ? `${step.id}|${anchorKeyOf(view.anchor)}` : null;
  const shownAnchor = view.kind === "shown" ? view.anchor : null;
  const doStep = isDoStep(step);
  useLayoutEffect(() => {
    if (finishing) return;
    if (!shownKey || !shownAnchor) {
      cursor.hide();
      setArrivedKey(null);
      return;
    }
    seenRef.current.add(step.id);
    const frame = readFrame(shownAnchor);
    cursor.glideTo(
      cursorTarget(frame),
      { reduced: prefersReducedMotion(), press: doStep, viewport: { x: frame.vw, y: frame.vh } },
      () => setArrivedKey(shownKey),
    );
    // Only a new place to point at restarts the glide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey]);

  useEffect(() => () => cursor.stop(), [cursor]);

  const firstChat = useFirstChatPrefill(!finishing && step.id === "first-chat");

  const skip = useCallback(() => skipOnboarding(), []);
  const backIndex = useMemo(() => {
    if (finishing) return null;
    // The nearest earlier step that would not skip itself right away.
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      if (!TOUR_STEPS[candidate]!.skipIf?.()) return candidate;
    }
    return null;
    // `view` is in the deps so the answer is fresh each time the card shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishing, index, view]);
  const back = useCallback(() => {
    if (backIndex != null) moveTo(backIndex, -1);
  }, [backIndex, moveTo]);
  const outOfView = view.kind === "waiting" ? view.outOfView : null;
  const showMe = useCallback(() => {
    if (outOfView) {
      outOfView.scrollIntoView({ block: "nearest", inline: "nearest" });
      return;
    }
    if (step.goTo) goTo(step.goTo === "work" ? "/work" : step.goTo);
  }, [goTo, outOfView, step.goTo]);

  const setCursorElement = useCallback((element: HTMLDivElement | null) => cursor.attach(element), [cursor]);

  const anchorId = shownAnchor?.getAttribute(ONBOARDING_ANCHOR_ATTR) ?? null;
  const copy = stepCopy(step, anchorId);
  const line = step.id === "first-chat" ? firstChatLine(firstChat) ?? copy.line : copy.line;

  return (
    <ViewportOverlayPortal layer="onboardingTour">
      <div
        className="ade-tour-layer"
        data-onboarding-hint-layer=""
        data-tour-step={finishing ? TOUR_FINISH_ID : step.id}
      >
        <div ref={setCursorElement} className="ade-tour-cursor" aria-hidden>
          <AdeTourCursorArt />
        </div>
        {finishing ? (
          <TourFinishCard cursor={cursor} onReplay={() => moveTo(0, 1)} onDone={completeTour} />
        ) : null}
        {!finishing && shownAnchor && shownKey ? (
          <TourStepOverlay
            key={step.id}
            step={step}
            title={copy.title}
            line={line}
            ask={copy.ask}
            place={copy.place}
            anchor={shownAnchor}
            arrived={arrivedKey === shownKey}
            cursor={cursor}
            relayoutRef={relayoutRef}
            recheckRef={recheckRef}
            index={index}
            onNext={next}
            onBack={backIndex != null ? back : null}
            onSkip={skip}
          />
        ) : null}
        {!finishing && view.kind === "waiting" ? (
          <TourPill
            step={step}
            index={index}
            seen={seenRef.current.has(step.id)}
            outOfView={outOfView != null}
            onShowMe={outOfView || step.goTo ? showMe : null}
            onSkip={skip}
          />
        ) : null}
      </div>
    </ViewportOverlayPortal>
  );
}

function AskIcon({ ask }: { ask: TourAsk }) {
  if (ask.icon === "send") return <PaperPlaneRight size={13} weight="fill" aria-hidden />;
  return <CursorClick size={13} weight="bold" aria-hidden />;
}

function TourStepOverlay({
  step,
  title,
  line,
  ask,
  place,
  anchor,
  arrived,
  cursor,
  relayoutRef,
  recheckRef,
  index,
  onNext,
  onBack,
  onSkip,
}: {
  step: TourStepDef;
  title: string;
  /** The card's sentence: the step's own, or one the host filled in (the first chat's model). */
  line: string;
  ask: TourAsk | undefined;
  place: readonly TourPlace[];
  anchor: HTMLElement;
  /** The cursor reached the control: the ring and card show. */
  arrived: boolean;
  cursor: TourCursorMotion;
  relayoutRef: { current: (() => void) | null };
  /** Asks the runner to look again: a control that moved may have gone out of view. */
  recheckRef: { current: (() => void) | null };
  index: number;
  onNext: () => void;
  onBack: (() => void) | null;
  onSkip: () => void;
}) {
  const titleId = useId();
  const radius = useMemo(() => anchorRadius(anchor), [anchor]);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const doStep = isDoStep(step);
  const last = index === TOUR_STEPS.length - 1;

  // Follow the control with direct style writes: its size, the card's size,
  // window resizes, any scroll, page changes the runner reports, and a slow
  // re-measure for moves none of those catch. rAF-coalesced; a frame that did
  // not move writes nothing.
  useLayoutEffect(() => {
    let lastFrame: Frame | null = null;
    let lastCardHeight = -1;
    const layout = () => {
      const frame = readFrame(anchor);
      const cardHeight = cardRef.current?.offsetHeight ?? 0;
      if (lastFrame && sameFrame(lastFrame, frame) && cardHeight === lastCardHeight) return;
      if (lastFrame && !sameFrame(lastFrame, frame)) recheckRef.current?.();
      lastFrame = frame;
      lastCardHeight = cardHeight;
      // Until the glide lands it owns the cursor (this effect runs before the
      // runner's glide starts); after that the cursor rests on the control.
      if (arrived) cursor.follow(cursorTarget(frame));
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
      const card = placeCard(ring, { width: CARD_WIDTH, height: cardHeight }, frame, place, CARD_GAP);
      slot.style.transform = translate(card.x, card.y);
      slot.dataset.placed = "true";
      cardRef.current?.setAttribute("data-side", card.side);
      const caret = caretRef.current;
      if (!caret) return;
      caret.dataset.side = card.side;
      const offset = caretOffset(card, ring);
      caret.style.left = card.side === "above" || card.side === "below" ? `${offset}px` : "";
      caret.style.top = card.side === "above" || card.side === "below" ? "" : `${offset}px`;
    };
    const follow = followAnchor(anchor, layout, { fallbackMs: FOLLOW_FALLBACK_MS, observe: [cardRef.current] });
    const { schedule } = follow;
    relayoutRef.current = schedule;
    return () => {
      if (relayoutRef.current === schedule) relayoutRef.current = null;
      follow.dispose();
    };
  }, [anchor, arrived, cursor, place, recheckRef, relayoutRef]);

  // Keyboard users land on the card's main button once it is placed.
  useEffect(() => {
    if (!arrived || (doStep && !last)) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    nextRef.current?.focus({ preventScroll: true });
  }, [arrived, doStep, last]);

  if (!arrived) return null;
  return (
    <>
      <div
        ref={ringRef}
        className="ade-tour-ring"
        data-kind={doStep ? "do" : "read"}
        data-pulse={doStep && !prefersReducedMotion() ? "true" : undefined}
        aria-hidden
        style={{ borderRadius: radius + RING_PAD }}
      />
      <div ref={slotRef} className="ade-tour-card-slot" style={{ width: CARD_WIDTH }}>
        <section
          ref={cardRef}
          className="kit-card ade-tour-card"
          data-float="true"
          {...FLOATS_OVER_BROWSER_PROPS}
          data-kind={doStep ? "do" : "read"}
          aria-labelledby={titleId}
        >
          <span ref={caretRef} className="ade-tour-caret" aria-hidden />
          <div className="ade-tour-card-top">
            <span className="ade-tour-count">
              {index + 1} of {TOUR_STEPS.length}
            </span>
            <button type="button" className="ade-tour-skip" onClick={onSkip}>
              Skip tour
            </button>
          </div>
          <h2 id={titleId} className="ade-tour-title">{title}</h2>
          <p className="ade-tour-line">{line}</p>
          {doStep && ask ? (
            <p className="ade-tour-ask" role="status">
              <span className="ade-tour-ask-icon">
                <AskIcon ask={ask} />
              </span>
              {ask.label}
            </p>
          ) : null}
          <div className="ade-tour-actions">
            {onBack ? (
              <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={onBack}>
                Back
              </button>
            ) : null}
            {doStep ? (
              <button ref={nextRef} type="button" className="ade-tour-pass" onClick={onNext}>
                Skip this step
              </button>
            ) : (
              <button ref={nextRef} type="button" className="kit-btn kit-btn-primary" data-size="sm" onClick={onNext}>
                {last ? "Done" : "Next"}
                {last ? null : <ArrowRight size={12} weight="bold" aria-hidden />}
              </button>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

/** The caret's offset along the card edge that faces the control, kept off the corners. */
function caretOffset(card: { x: number; y: number; side: string }, ring: Box): number {
  const inset = 18;
  if (card.side === "above" || card.side === "below") {
    const centre = ring.left + ring.width / 2 - card.x;
    return Math.min(Math.max(centre, inset), CARD_WIDTH - inset);
  }
  const centre = ring.top + ring.height / 2 - card.y;
  return Math.max(centre, inset);
}

function TourPill({
  step,
  index,
  seen,
  outOfView,
  onShowMe,
  onSkip,
}: {
  step: TourStepDef;
  index: number;
  /** The step's card showed before: the user stepped away from it. */
  seen: boolean;
  /** The control is on this page but clipped or scrolled out of view. */
  outOfView: boolean;
  onShowMe: (() => void) | null;
  onSkip: () => void;
}) {
  const count = `${index + 1} of ${TOUR_STEPS.length}`;
  let title: string;
  let sub: string;
  if (outOfView) {
    title = `${step.title}: out of view`;
    sub = "Make the window wider, or scroll to it.";
  } else if (seen) {
    // The user stepped away from a step they had seen.
    title = "Tour paused";
    sub = `${count} · ${step.title}${onShowMe ? "" : ` · back in ${step.where}`}`;
  } else {
    // The step's control lives somewhere the user has not gone yet.
    title = `Up next: ${step.title}`;
    sub = onShowMe ? `${count} · in ${step.where}` : `${count} · go to ${step.where} to carry on`;
  }
  return (
    <div className="ade-tour-pill" role="status">
      <span className="ade-tour-pill-cursor" aria-hidden>
        <AdeTourCursorArt />
      </span>
      <span className="ade-tour-pill-text">
        <span className="ade-tour-pill-title">{title}</span>
        <span className="ade-tour-pill-sub">{sub}</span>
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
  );
}
