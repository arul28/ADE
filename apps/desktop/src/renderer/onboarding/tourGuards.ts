export const TOUR_ADVANCE_REQUIREMENTS = [
  "projectOpen",
  "laneExists",
  "laneCountIncreased",
  "chatStarted",
  "commitExists",
  "prCreated",
  "createLaneDialogOpen",
  "managelaneDialogOpen",
  "manageLaneDialogOpen",
  "prCreateModalOpen",
] as const;

export type TourAdvanceRequirement =
  (typeof TOUR_ADVANCE_REQUIREMENTS)[number];

export type TourGuardStep = {
  id?: string;
  requires?: readonly string[];
  fallbackAfterMs?: number;
};

export type TourGuardAppState = {
  projectOpen?: boolean;
  projectRootPath?: string | null;

  laneExists?: boolean;
  laneCount?: number | null;
  laneCountIncreased?: boolean;

  chatStarted?: boolean;
  chatSessionCount?: number | null;

  commitExists?: boolean;
  commitCount?: number | null;

  prCreated?: boolean;
  prCount?: number | null;

  createLaneDialogOpen?: boolean;
  managelaneDialogOpen?: boolean;
  manageLaneDialogOpen?: boolean;
  prCreateModalOpen?: boolean;
  openDialogIds?: readonly string[];
  stepElapsedMs?: number | null;
};

const KNOWN_REQUIREMENTS = new Set<string>(TOUR_ADVANCE_REQUIREMENTS);

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasPositiveCount(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isDialogOpen(
  appState: TourGuardAppState,
  dialogId: string,
): boolean {
  return appState.openDialogIds?.includes(dialogId) === true;
}

function requirementMet(
  requirement: string,
  appState: TourGuardAppState,
): boolean {
  if (!KNOWN_REQUIREMENTS.has(requirement)) return false;

  switch (requirement as TourAdvanceRequirement) {
    case "projectOpen":
      return appState.projectOpen === true || hasText(appState.projectRootPath);
    case "laneExists":
      return appState.laneExists === true || hasPositiveCount(appState.laneCount);
    case "laneCountIncreased":
      return appState.laneCountIncreased === true;
    case "chatStarted":
      return (
        appState.chatStarted === true ||
        hasPositiveCount(appState.chatSessionCount)
      );
    case "commitExists":
      return (
        appState.commitExists === true || hasPositiveCount(appState.commitCount)
      );
    case "prCreated":
      return appState.prCreated === true || hasPositiveCount(appState.prCount);
    case "createLaneDialogOpen":
      return (
        appState.createLaneDialogOpen === true ||
        isDialogOpen(appState, "lanes.create")
      );
    case "managelaneDialogOpen":
    case "manageLaneDialogOpen":
      return (
        appState.managelaneDialogOpen === true ||
        appState.manageLaneDialogOpen === true ||
        isDialogOpen(appState, "lanes.manage")
      );
    case "prCreateModalOpen":
      return (
        appState.prCreateModalOpen === true ||
        isDialogOpen(appState, "prs.create")
      );
  }
}

export function canAdvance(
  step: TourGuardStep | null | undefined,
  appState: TourGuardAppState = {},
): boolean {
  const requirements = step?.requires;
  if (!requirements || requirements.length === 0) return true;
  if (
    typeof step?.fallbackAfterMs === "number" &&
    step.fallbackAfterMs >= 0 &&
    typeof appState.stepElapsedMs === "number" &&
    appState.stepElapsedMs >= step.fallbackAfterMs
  ) {
    return true;
  }
  return requirements.every((requirement) => requirementMet(requirement, appState));
}

export function unmetRequirements(
  step: TourGuardStep | null | undefined,
  appState: TourGuardAppState = {},
): string[] {
  const requirements = step?.requires;
  if (!requirements || requirements.length === 0) return [];
  return requirements.filter((requirement) => !requirementMet(requirement, appState));
}

export function isFallbackAdvanceActive(
  step: TourGuardStep | null | undefined,
  appState: TourGuardAppState = {},
): boolean {
  const requirements = step?.requires;
  if (!requirements || requirements.length === 0) return false;
  if (
    typeof step?.fallbackAfterMs !== "number" ||
    step.fallbackAfterMs < 0 ||
    typeof appState.stepElapsedMs !== "number" ||
    appState.stepElapsedMs < step.fallbackAfterMs
  ) {
    return false;
  }
  return requirements.some((requirement) => !requirementMet(requirement, appState));
}
