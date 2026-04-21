import React, { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { useAppStore } from "../../state/appStore";
import { useOnboardingStore } from "../../state/onboardingStore";
import { getTour } from "../../onboarding/registry";
import { TourHost } from "./tour/TourHost";
import { WelcomeWizard } from "./WelcomeWizard";
import { DidYouKnow } from "./DidYouKnow";

// Ensure tour registrations run even if TourHost hasn't mounted yet (e.g. while
// the welcome wizard is still showing).
import "../../onboarding/tours";

export function OnboardingBootstrap() {
  const location = useLocation();
  const onboardingEnabled = useAppStore((s) => s.onboardingEnabled);
  const showWelcome = useAppStore((s) => s.showWelcome);
  const project = useAppStore((s) => s.project);

  const hydrated = useOnboardingStore((s) => s.hydrated);
  const hydrate = useOnboardingStore((s) => s.hydrate);
  const progress = useOnboardingStore((s) => s.progress);
  const wizardOpen = useOnboardingStore((s) => s.wizardOpen);
  const activeTourId = useOnboardingStore((s) => s.activeTourId);

  const wizardAutoFiredRef = useRef(false);
  const laneTourAutoFiredRef = useRef(false);
  const workTourAutoFiredRef = useRef(false);
  const filesTourAutoFiredRef = useRef(false);
  const runTourAutoFiredRef = useRef(false);

  // Hydrate once.
  useEffect(() => {
    if (!hydrated) {
      void hydrate();
    }
  }, [hydrated, hydrate]);

  const hasActiveProject = Boolean(project?.rootPath);
  const onProjectSetup =
    location.pathname === "/project" ||
    location.pathname === "/onboarding" ||
    !hasActiveProject ||
    showWelcome;

  // Auto-open welcome wizard on first run.
  useEffect(() => {
    if (!hydrated || !progress) return;
    if (!onboardingEnabled) return;
    if (onProjectSetup) return;
    if (wizardAutoFiredRef.current) return;

    const wizardUntouched =
      progress.wizardCompletedAt === null && progress.wizardDismissedAt === null;
    if (!wizardUntouched) return;
    if (wizardOpen) return;

    wizardAutoFiredRef.current = true;
    useOnboardingStore.getState().openWizard();
  }, [hydrated, progress, onboardingEnabled, onProjectSetup, wizardOpen]);

  // Auto-start Lanes tour on first Lanes-route visit, after the wizard is resolved.
  useEffect(() => {
    if (!hydrated || !progress) return;
    if (!onboardingEnabled) return;
    if (laneTourAutoFiredRef.current) return;
    if (wizardOpen) return;
    if (activeTourId) return;
    if (onProjectSetup) return;

    const wizardResolved =
      progress.wizardCompletedAt !== null || progress.wizardDismissedAt !== null;
    if (!wizardResolved) return;

    const tour = getTour("lanes");
    if (!tour || tour.steps.length === 0) return;

    // Match the registered route prefix (e.g. `/lanes`).
    const onLanesRoute =
      location.pathname === tour.route || location.pathname.startsWith(`${tour.route}/`);
    if (!onLanesRoute) return;

    const entry = progress.tours[tour.id];
    const laneTouched =
      (entry?.completedAt ?? null) !== null || (entry?.dismissedAt ?? null) !== null;
    if (laneTouched) return;

    laneTourAutoFiredRef.current = true;
    void useOnboardingStore.getState().startTour(tour.id);
  }, [
    hydrated,
    progress,
    onboardingEnabled,
    wizardOpen,
    activeTourId,
    onProjectSetup,
    location.pathname,
  ]);

  // Auto-start Work tour on first /lanes visit (work pane is nested inside lanes), after wizard resolves.
  useEffect(() => {
    if (!hydrated || !progress) return;
    if (!onboardingEnabled) return;
    if (workTourAutoFiredRef.current) return;
    if (wizardOpen) return;
    if (activeTourId) return;
    if (onProjectSetup) return;

    const wizardResolved =
      progress.wizardCompletedAt !== null || progress.wizardDismissedAt !== null;
    if (!wizardResolved) return;

    const tour = getTour("work");
    if (!tour || tour.steps.length === 0) return;

    const onWorkRoute =
      location.pathname === tour.route || location.pathname.startsWith(`${tour.route}/`);
    if (!onWorkRoute) return;

    // Only auto-fire once the lanes tour has been seen.
    const laneEntry = progress.tours["lanes"];
    const lanesSeen =
      (laneEntry?.completedAt ?? null) !== null || (laneEntry?.dismissedAt ?? null) !== null;
    if (!lanesSeen) return;

    const entry = progress.tours[tour.id];
    const tourTouched =
      (entry?.completedAt ?? null) !== null || (entry?.dismissedAt ?? null) !== null;
    if (tourTouched) return;

    workTourAutoFiredRef.current = true;
    void useOnboardingStore.getState().startTour(tour.id);
  }, [
    hydrated,
    progress,
    onboardingEnabled,
    wizardOpen,
    activeTourId,
    onProjectSetup,
    location.pathname,
  ]);

  // Auto-start Files tour on first /files visit, after wizard resolves.
  useEffect(() => {
    if (!hydrated || !progress) return;
    if (!onboardingEnabled) return;
    if (filesTourAutoFiredRef.current) return;
    if (wizardOpen) return;
    if (activeTourId) return;
    if (onProjectSetup) return;

    const wizardResolved =
      progress.wizardCompletedAt !== null || progress.wizardDismissedAt !== null;
    if (!wizardResolved) return;

    const tour = getTour("files");
    if (!tour || tour.steps.length === 0) return;

    const onFilesRoute =
      location.pathname === tour.route || location.pathname.startsWith(`${tour.route}/`);
    if (!onFilesRoute) return;

    const entry = progress.tours[tour.id];
    const tourTouched =
      (entry?.completedAt ?? null) !== null || (entry?.dismissedAt ?? null) !== null;
    if (tourTouched) return;

    filesTourAutoFiredRef.current = true;
    void useOnboardingStore.getState().startTour(tour.id);
  }, [
    hydrated,
    progress,
    onboardingEnabled,
    wizardOpen,
    activeTourId,
    onProjectSetup,
    location.pathname,
  ]);

  // Auto-start Run tour on first /run visit, after wizard resolves.
  useEffect(() => {
    if (!hydrated || !progress) return;
    if (!onboardingEnabled) return;
    if (runTourAutoFiredRef.current) return;
    if (wizardOpen) return;
    if (activeTourId) return;
    if (onProjectSetup) return;

    const wizardResolved =
      progress.wizardCompletedAt !== null || progress.wizardDismissedAt !== null;
    if (!wizardResolved) return;

    const tour = getTour("run");
    if (!tour || tour.steps.length === 0) return;

    const onRunRoute =
      location.pathname === tour.route || location.pathname.startsWith(`${tour.route}/`);
    if (!onRunRoute) return;

    const entry = progress.tours[tour.id];
    const tourTouched =
      (entry?.completedAt ?? null) !== null || (entry?.dismissedAt ?? null) !== null;
    if (tourTouched) return;

    runTourAutoFiredRef.current = true;
    void useOnboardingStore.getState().startTour(tour.id);
  }, [
    hydrated,
    progress,
    onboardingEnabled,
    wizardOpen,
    activeTourId,
    onProjectSetup,
    location.pathname,
  ]);

  return (
    <>
      <WelcomeWizard />
      <TourHost />
      <DidYouKnow />
    </>
  );
}
