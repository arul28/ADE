import type { TourStep } from "../registry";
import { docs } from "../docsLinks";

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
      title: "1. Pick what to keep",
      body: "When you change files, they show up here as **unstaged**. \"Staging\" just means *\"include this in my next save.\"* You can stage one file at a time, or hit **Stage all** to include everything.",
      placement: "left",
      requires: ["laneExists"],
      waitForSelector: '[data-tour="lanes.gitActionsPane"]',
      docUrl: docs.lanesOverview,
    },
    {
      id: "gitActions.commit",
      target: '[data-tour="lanes.gitActionsPane"]',
      title: "2. Save a snapshot",
      bodyTemplate: (ctx) => {
        const lane = ctx.get<string>("laneName") ?? "this lane";
        return `A **commit** is a saved snapshot of your work — a checkpoint you can come back to. Write a short message saying what changed in **${lane}**, then click commit (or hit ${modifierKey}+Enter). You can only commit if you've staged something first.`;
      },
      body: `A **commit** is a saved snapshot of your work — a checkpoint you can come back to. Write a short message saying what changed, then click commit (or hit ${modifierKey}+Enter). You can only commit if you've staged something first.`,
      placement: "left",
      requires: ["laneExists"],
      waitForSelector: '[data-tour="lanes.gitActionsPane"]',
      docUrl: docs.lanesOverview,
    },
    {
      id: "gitActions.push",
      target: '[data-tour="lanes.gitActionsPane"]',
      title: "3. Share it",
      body: "**Pushing** uploads your saved snapshots somewhere shareable (like GitHub) so others can see them. The button label changes based on what you need: **Publish** the first time, **Push** for new snapshots, or **Force Push** for unusual cases.",
      placement: "left",
      requires: ["laneExists"],
      waitForSelector: '[data-tour="lanes.gitActionsPane"]',
      docUrl: docs.lanesOverview,
    },
  ];
}
