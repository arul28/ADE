import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TourCtx, TourStep as TourStepType } from "../../../onboarding/registry";
import {
  canAdvance as canAdvanceTourStep,
  isFallbackAdvanceActive,
  type TourGuardAppState,
  unmetRequirements,
} from "../../../onboarding/tourGuards";
import { useAppStore } from "../../../state/appStore";
import { useOnboardingStore } from "../../../state/onboardingStore";
import { ActIntro } from "../fx/ActIntro";
import { TourStep } from "./TourStep";

const SELECTOR_RETRY_MS = 500;
const RETRY_INTERVAL_MS = 50;
const OUTSIDE_INTERACTION_GRACE_MS = 2_500;
const INTERACTIVE_SHORTCUT_SELECTOR =
  'button, a[href], input, select, textarea, [contenteditable]:not([contenteditable="false"])';
let lastActIntroAdvanceAtMs = 0;

type TourOverlayProps = {
  step: TourStepType;
  stepIndex: number;
  totalSteps: number;
  ctx?: TourCtx | null;
};

type TargetState =
  | { kind: "found"; rect: DOMRect }
  | { kind: "missing" };

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function shouldLetEnterActivateTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(INTERACTIVE_SHORTCUT_SELECTOR) != null;
}

function shouldLetElementOwnKeyboard(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".ade-tour-step")) return false;
  return target.closest(INTERACTIVE_SHORTCUT_SELECTOR) != null;
}

function hasTargetSelector(step: TourStepType): boolean {
  return step.target.trim().length > 0;
}

function hasDomTarget(selector: string): boolean {
  try {
    return document.querySelector(selector) != null;
  } catch {
    return false;
  }
}

function countDomTargets(selector: string): number {
  try {
    return document.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

function visibleRectForElement(el: HTMLElement): DOMRect | null {
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return rect;

  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const childRect = visibleRectForElement(child);
    if (childRect) return childRect;
  }

  return null;
}

function firstVisibleRectForSelector(selector: string): DOMRect | null {
  let elements: NodeListOf<Element>;
  try {
    elements = document.querySelectorAll(selector);
  } catch {
    return null;
  }

  for (const element of Array.from(elements)) {
    if (!(element instanceof HTMLElement)) continue;
    const rect = visibleRectForElement(element);
    if (rect) return rect;
  }

  return null;
}

function eventTargetMatchesSelector(target: EventTarget | null, selector: string): boolean {
  if (!(target instanceof Element)) return false;
  const trimmed = selector.trim();
  if (!trimmed) return false;
  try {
    return target.closest(trimmed) != null;
  } catch {
    return false;
  }
}

function labelForUnmetRequirements(unmet: readonly string[]): string | null {
  if (unmet.length === 0) return null;
  if (unmet.includes("projectOpen")) return "Waiting for a project";
  if (unmet.includes("laneCountIncreased")) return "Waiting for the new test lane";
  if (unmet.includes("laneExists")) return "Waiting for a lane";
  if (unmet.includes("createLaneDialogOpen")) return "Waiting for the Create Lane dialog";
  if (unmet.includes("managelaneDialogOpen") || unmet.includes("manageLaneDialogOpen")) {
    return "Waiting for the Manage Lane dialog";
  }
  if (unmet.includes("prCreateModalOpen")) return "Waiting for the Create PR dialog";
  if (unmet.includes("prCreated")) return "Waiting for a PR";
  if (unmet.includes("commitExists")) return "Waiting for a commit";
  if (unmet.includes("chatStarted")) return "Waiting for a chat";
  return "Waiting for required state";
}

export function TourOverlay({ step, stepIndex, totalSteps, ctx }: TourOverlayProps) {
  const nextStep = useOnboardingStore((s) => s.nextStep);
  const prevStep = useOnboardingStore((s) => s.prevStep);
  const dismissCurrentTour = useOnboardingStore((s) => s.dismissCurrentTour);
  const completeCurrentTour = useOnboardingStore((s) => s.completeCurrentTour);
  const project = useAppStore((s) => s.project);
  const projectHydrated = useAppStore((s) => s.projectHydrated);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const isNewTabOpen = useAppStore((s) => s.isNewTabOpen);
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);

  const [target, setTarget] = useState<TargetState>({ kind: "missing" });
  const [reduceMotion] = useState(prefersReducedMotion);
  const [stepStartedAtMs, setStepStartedAtMs] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [exitConfirmationOpen, setExitConfirmationOpen] = useState(false);
  const [laneCountAtStepStart, setLaneCountAtStepStart] = useState(() =>
    useAppStore.getState().lanes.filter((lane) => lane.laneType !== "primary").length,
  );
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const autoAdvancedStepRef = useRef<string | null>(null);

  const isLast = stepIndex >= totalSteps - 1;
  const stepElapsedMs = Math.max(0, nowMs - stepStartedAtMs);
  const laneCount = lanes.filter((lane) => lane.laneType !== "primary").length;
  const nonPrimaryLaneIds = lanes.filter((lane) => lane.laneType !== "primary").map((lane) => lane.id);
  const selectedNonPrimaryLaneOpen = lanes.some((lane) => lane.id === selectedLaneId && lane.laneType !== "primary");
  const createLaneBaselineIds = ctx?.get<string[]>("createLaneBaselineIds");
  const laneCountIncreased = Array.isArray(createLaneBaselineIds)
    ? nonPrimaryLaneIds.some((laneId) => !createLaneBaselineIds.includes(laneId))
    : laneCount > laneCountAtStepStart;
  const createLaneDialogOpen = hasDomTarget('[data-tour="lanes.createDialog.name"]');
  const createLaneStepCompleted =
    step.id?.startsWith("createLane.") === true &&
    selectedNonPrimaryLaneOpen &&
    !createLaneDialogOpen;
  const workspaceProjectOpen =
    projectHydrated === true &&
    showWelcome !== true &&
    isNewTabOpen !== true &&
    Boolean(project?.rootPath);
  const appState: TourGuardAppState = {
    projectOpen: workspaceProjectOpen,
    projectRootPath: workspaceProjectOpen ? project?.rootPath ?? null : null,
    laneExists: laneCount > 0,
    laneCount,
    laneCountIncreased,
    chatStarted: hasDomTarget('[data-tour="work.sessionItem"]'),
    chatSessionCount: countDomTargets('[data-tour="work.sessionItem"]'),
    commitExists: hasDomTarget('[data-tour="history.entry"]'),
    commitCount: countDomTargets('[data-tour="history.entry"]'),
    prCreated: hasDomTarget('[data-tour="prs.listRow"]'),
    prCount: countDomTargets('[data-tour="prs.listRow"]'),
    createLaneDialogOpen: createLaneDialogOpen || createLaneStepCompleted,
    manageLaneDialogOpen: hasDomTarget('[data-tour="lanes.manageDialog.laneInfo"]'),
    managelaneDialogOpen: hasDomTarget('[data-tour="lanes.manageDialog.laneInfo"]'),
    prCreateModalOpen: hasDomTarget('[data-tour="prs.createModal.base"], [data-tour="prs.createModal.title"]'),
    stepElapsedMs,
  };
  const unmet = unmetRequirements(step, appState);
  const fallbackActive = isFallbackAdvanceActive(step, appState);
  const requirementsSatisfied = canAdvanceTourStep(step, appState);
  const awaitingRequirementSatisfied =
    Boolean(step.awaitingActionLabel) &&
    Boolean(step.requires?.length) &&
    requirementsSatisfied;
  const canUseManualNext =
    requirementsSatisfied && (!step.awaitingActionLabel || fallbackActive || awaitingRequirementSatisfied);
  const waitingLabel = labelForUnmetRequirements(unmet);

  const measure = useCallback(() => {
    const selector = step.target.trim();
    if (!selector) {
      setTarget({ kind: "missing" });
      return true;
    }
    const rect = firstVisibleRectForSelector(selector);
    if (rect) {
      setTarget({ kind: "found", rect });
      return true;
    }
    return false;
  }, [step.target]);

  useEffect(() => {
    const now = Date.now();
    setStepStartedAtMs(now);
    setNowMs(now);
    setLaneCountAtStepStart(
      useAppStore.getState().lanes.filter((lane) => lane.laneType !== "primary").length,
    );
    autoAdvancedStepRef.current = null;
    setExitConfirmationOpen(false);
  }, [step.id, stepIndex]);

  useEffect(() => {
    if (!step.requires?.length && typeof step.fallbackAfterMs !== "number") return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [step.fallbackAfterMs, step.requires]);

  // Retry locating the selector when the step changes. The first 500ms controls
  // the missing fallback, but observation continues so lazy route content can
  // still attach to the active step once it appears.
  useEffect(() => {
    setTarget({ kind: "missing" });
    if (measure()) return;

    let cancelled = false;
    const start = Date.now();
    const interval = window.setInterval(() => {
      if (cancelled) return;
      const found = measure();
      if (found) {
        window.clearInterval(interval);
        return;
      }
      if (Date.now() - start >= SELECTOR_RETRY_MS) {
        setTarget((current) => (current.kind === "found" ? current : { kind: "missing" }));
      }
    }, RETRY_INTERVAL_MS);
    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            if (cancelled) return;
            if (measure()) {
              window.clearInterval(interval);
              observer?.disconnect();
            }
          })
        : null;
    observer?.observe(document.body, { childList: true, subtree: true });

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      observer?.disconnect();
    };
  }, [measure]);

  // Re-measure on viewport changes.
  useEffect(() => {
    const onChange = () => {
      measure();
    };
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
    };
  }, [measure]);

  // Focus management: remember whatever was focused before the tour started, restore on unmount.
  useEffect(() => {
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === "function") {
        try {
          prev.focus();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  const advanceTour = useCallback(() => {
    if (isLast) {
      void completeCurrentTour();
    } else {
      void nextStep();
    }
  }, [isLast, completeCurrentTour, nextStep]);

  const handleNext = useCallback(() => {
    if (!canUseManualNext) return;
    advanceTour();
  }, [advanceTour, canUseManualNext]);

  const handlePrev = useCallback(() => {
    if (step.disableBack) return;
    void prevStep();
  }, [prevStep, step.disableBack]);

  const handleDismiss = useCallback(() => {
    void dismissCurrentTour();
  }, [dismissCurrentTour]);

  const requestExitConfirmation = useCallback(() => {
    setExitConfirmationOpen(true);
  }, []);

  // Some steps intentionally wait for the UI to open another surface, such as
  // the project browser. Advance as soon as that destination exists.
  useEffect(() => {
    const selector = step.advanceWhenSelector?.trim();
    if (!selector) return;
    let settled = false;
    const hasTarget = () => {
      try {
        return document.querySelector(selector) != null;
      } catch {
        return false;
      }
    };
    const advance = () => {
      if (settled) return;
      if (!hasTarget()) return;
      settled = true;
      (document.activeElement as HTMLElement | null)?.blur?.();
      advanceTour();
    };
    if (hasTarget()) {
      advance();
      return;
    }
    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => advance())
        : null;
    observer?.observe(document.body, { childList: true, subtree: true });
    return () => {
      settled = true;
      observer?.disconnect();
    };
  }, [advanceTour, step.advanceWhenSelector]);

  useEffect(() => {
    if (!step.awaitingActionLabel) return;
    if (!step.requires?.includes("laneCountIncreased")) return;
    if (!requirementsSatisfied) return;
    const autoAdvanceKey = `${step.id ?? stepIndex}:laneCountIncreased`;
    if (autoAdvancedStepRef.current === autoAdvanceKey) return;
    autoAdvancedStepRef.current = autoAdvanceKey;
    (document.activeElement as HTMLElement | null)?.blur?.();
    advanceTour();
  }, [advanceTour, requirementsSatisfied, step.awaitingActionLabel, step.id, step.requires, stepIndex]);

  useEffect(() => {
    if (!step.id?.startsWith("createLane.")) return;
    if (step.id === "createLane.openMenu" || step.id === "createLane.chooseCreate") return;
    // The dedicated `laneCountIncreased` effect above already drives the
    // auto-advance for action-gated steps that require lane creation. Let it
    // own that signal so we don't double-advance (and skip a step) off the
    // same event.
    if (step.awaitingActionLabel && step.requires?.includes("laneCountIncreased")) return;
    const createLaneFlowCompleted =
      laneCountIncreased || createLaneStepCompleted;
    if (!createLaneFlowCompleted) return;
    const autoAdvanceKey = `${step.id}:createdLane`;
    if (autoAdvancedStepRef.current === autoAdvanceKey) return;
    autoAdvancedStepRef.current = autoAdvanceKey;
    (document.activeElement as HTMLElement | null)?.blur?.();
    advanceTour();
  }, [advanceTour, createLaneStepCompleted, laneCountIncreased, step.awaitingActionLabel, step.id, step.requires]);

  // Keyboard handling at the document level.
  useEffect(() => {
    if (step.actIntro) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (shouldLetElementOwnKeyboard(e.target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (step.exitOnOutsideInteraction) {
          requestExitConfirmation();
        } else {
          handleDismiss();
        }
        return;
      }
      if (e.key === "ArrowRight" || e.key === "Enter") {
        if (e.key === "Enter" && shouldLetEnterActivateTarget(e.target)) return;
        e.preventDefault();
        handleNext();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrev();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNext, handlePrev, handleDismiss, requestExitConfirmation, step.actIntro, step.exitOnOutsideInteraction]);

  // Action-gated steps should not pretend the user is still following the
  // script after they click somewhere unrelated. Let the app handle the click,
  // then ask whether to keep the tutorial running.
  useEffect(() => {
    if (!step.exitOnOutsideInteraction) return;
    const onPointerDown = (event: PointerEvent) => {
      if (Date.now() - stepStartedAtMs < OUTSIDE_INTERACTION_GRACE_MS) return;
      if (Date.now() - lastActIntroAdvanceAtMs < OUTSIDE_INTERACTION_GRACE_MS) return;
      const target = event.target;
      if (step.preventTargetInteraction && eventTargetMatchesSelector(target, step.target)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (eventTargetMatchesSelector(target, ".ade-tour-step")) return;
      if (eventTargetMatchesSelector(target, ".ade-tour-exit-confirm")) return;
      if (eventTargetMatchesSelector(target, step.target)) return;
      for (const selector of step.allowedInteractionSelectors ?? []) {
        if (eventTargetMatchesSelector(target, selector)) return;
      }
      if (!eventTargetMatchesSelector(target, INTERACTIVE_SHORTCUT_SELECTOR)) return;
      requestExitConfirmation();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [
    requestExitConfirmation,
    step.allowedInteractionSelectors,
    step.exitOnOutsideInteraction,
    step.preventTargetInteraction,
    step.target,
    stepStartedAtMs,
  ]);

  if (typeof document === "undefined") return null;

  const targetRect = target.kind === "found" ? target.rect : null;
  const missing = hasTargetSelector(step) && target.kind !== "found";

  if (step.actIntro) {
    const completeActIntro = () => {
      lastActIntroAdvanceAtMs = Date.now();
      advanceTour();
    };
    return createPortal(
      <ActIntro
        title={step.actIntro.title}
        subtitle={step.actIntro.subtitle}
        variant={step.actIntro.variant}
        onComplete={completeActIntro}
        onSkip={completeActIntro}
      />,
      document.body,
    );
  }

  return createPortal(
    <div
      className="ade-tour-overlay"
      role={step.focusTarget ? undefined : "dialog"}
      aria-modal={step.focusTarget ? undefined : true}
      aria-label={step.title}
      data-reduce-motion={reduceMotion ? "true" : "false"}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        pointerEvents: "none",
      }}
    >
      <TourBackdrop rect={targetRect} reduceMotion={reduceMotion} />
      {targetRect ? <TourSpotlight rect={targetRect} /> : null}
      <TourStep
        step={step}
        ctx={ctx}
        stepIndex={stepIndex}
        totalSteps={totalSteps}
        targetRect={targetRect}
        missing={missing}
        canAdvance={requirementsSatisfied}
        fallbackActive={fallbackActive}
        waitingLabel={waitingLabel}
        onNext={handleNext}
        onPrev={handlePrev}
        onDismiss={handleDismiss}
        isLast={isLast}
      />
      {exitConfirmationOpen ? (
        <TourExitConfirmation
          onStay={() => setExitConfirmationOpen(false)}
          onExit={handleDismiss}
        />
      ) : null}
    </div>,
    document.body,
  );
}

function TourExitConfirmation({
  onStay,
  onExit,
}: {
  onStay: () => void;
  onExit: () => void;
}) {
  return (
    <div
      className="ade-tour-exit-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ade-tour-exit-title"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        width: 300,
        padding: "14px 16px",
        borderRadius: 10,
        background: "var(--color-popup-bg, #151325)",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        color: "var(--color-fg, #F0F0F2)",
        boxShadow: "0 16px 44px -12px rgba(0,0,0,0.7)",
        pointerEvents: "auto",
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <h2
        id="ade-tour-exit-title"
        style={{ margin: 0, fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}
      >
        Exit tutorial?
      </h2>
      <p
        style={{
          margin: "6px 0 12px",
          fontSize: 12,
          lineHeight: 1.45,
          color: "var(--color-muted-fg, #B7B6C3)",
        }}
      >
        That action is outside this step. Stay with the guide, or exit and use ADE freely.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={onStay}
          style={{
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid rgba(255, 255, 255, 0.12)",
            background: "transparent",
            color: "var(--color-fg, #F0F0F2)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Stay
        </button>
        <button
          type="button"
          onClick={onExit}
          style={{
            padding: "6px 10px",
            borderRadius: 6,
            border: "1px solid transparent",
            background: "var(--color-accent, #A78BFA)",
            color: "var(--color-accent-fg, #0B0620)",
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Exit tutorial
        </button>
      </div>
    </div>
  );
}

function TourSpotlight({ rect }: { rect: DOMRect }) {
  const padding = 6;
  return (
    <div
      className="ade-tour-spotlight"
      aria-hidden="true"
      style={{
        position: "absolute",
        top: Math.max(0, rect.top - padding),
        left: Math.max(0, rect.left - padding),
        width: rect.width + padding * 2,
        height: rect.height + padding * 2,
        pointerEvents: "none",
      }}
    />
  );
}

type TourBackdropProps = {
  rect: DOMRect | null;
  reduceMotion: boolean;
};

function TourBackdrop({ rect, reduceMotion }: TourBackdropProps) {
  const w = typeof window !== "undefined" ? window.innerWidth : 0;
  const h = typeof window !== "undefined" ? window.innerHeight : 0;
  const padding = 6;
  const radius = 8;

  if (!rect) {
    return (
      <div
        className="ade-tour-backdrop"
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0, 0, 0, 0.55)",
          transition: reduceMotion ? "none" : "background 160ms ease",
        }}
      />
    );
  }

  const x = Math.max(0, rect.left - padding);
  const y = Math.max(0, rect.top - padding);
  const cw = Math.min(w - x, rect.width + padding * 2);
  const ch = Math.min(h - y, rect.height + padding * 2);

  // SVG with a full-screen rect minus a rounded cutout via mask.
  return (
    <svg
      className="ade-tour-backdrop"
      width={w}
      height={h}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      aria-hidden="true"
    >
      <defs>
        <mask id="ade-tour-mask">
          <rect width={w} height={h} fill="white" />
          <rect x={x} y={y} width={cw} height={ch} rx={radius} ry={radius} fill="black" />
        </mask>
      </defs>
      <rect
        width={w}
        height={h}
        fill="rgba(0,0,0,0.55)"
        mask="url(#ade-tour-mask)"
        style={{ transition: reduceMotion ? "none" : "all 160ms ease" }}
      />
    </svg>
  );
}
