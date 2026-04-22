import type { TourStep } from "../registry";
import { docs } from "../docsLinks";

const GIT_ACTION_FALLBACK_MS = 30_000;

function commitShortcutModifier(): "Cmd" | "Ctrl" {
  if (typeof navigator !== "undefined" && /mac/i.test(navigator.platform)) {
    return "Cmd";
  }
  return "Ctrl";
}

/**
 * Reusable walkthrough for the Git Actions pane inside LanesPage.
 * Walks Stage → Commit → Push at a conceptual level. The pane's individual
 * buttons don't yet carry `data-tour` anchors (LaneGitActionsPane.tsx has
 * none today), so each beat spotlights the pane-level anchor
 * `lanes.gitActionsPane` and explains what to look for inside it.
 */
export function buildGitActionsPaneWalkthrough(): TourStep[] {
  const modifierKey = commitShortcutModifier();
  return [
    {
      id: "gitActions.stage",
      target: '[data-tour="lanes.gitActionsPane"]',
      title: "Stage files",
      body: "When unstaged files exist, they appear in the Unstaged section. Use per-file controls or Stage all to choose what goes into the next commit.",
      placement: "left",
      requires: ["laneExists"],
      waitForSelector: '[data-tour="lanes.gitActionsPane"]',
      docUrl: docs.lanesOverview,
    },
    {
      id: "gitActions.commit",
      target: '[data-tour="lanes.gitActionsPane"]',
      title: "Commit controls",
      bodyTemplate: (ctx) => {
        const lane = ctx.get<string>("laneName") ?? "this lane";
        return `Commits require staged changes in ${lane} unless Amend is enabled. ${modifierKey}+Enter runs the commit action when the button is enabled.`;
      },
      body: `Commits require staged changes unless Amend is enabled. ${modifierKey}+Enter runs the commit action when the button is enabled.`,
      placement: "left",
      requires: ["laneExists", "commitExists"],
      fallbackAfterMs: GIT_ACTION_FALLBACK_MS,
      fallbackNextLabel: "Continue without committing",
      fallbackNotice: "No commit is required to keep learning the rest of ADE.",
      waitForSelector: '[data-tour="lanes.gitActionsPane"]',
      docUrl: docs.lanesOverview,
    },
    {
      id: "gitActions.push",
      target: '[data-tour="lanes.gitActionsPane"]',
      title: "Publish or push",
      body: "The remote button changes with the lane state: Publish for a new remote branch, Push for local commits, or Force Push when history was rewritten.",
      placement: "left",
      requires: ["laneExists", "commitExists"],
      fallbackAfterMs: GIT_ACTION_FALLBACK_MS,
      fallbackNextLabel: "Continue without pushing",
      fallbackNotice: "Push controls stay disabled until the lane has commits and a usable remote state.",
      waitForSelector: '[data-tour="lanes.gitActionsPane"]',
      docUrl: docs.lanesOverview,
    },
  ];
}
