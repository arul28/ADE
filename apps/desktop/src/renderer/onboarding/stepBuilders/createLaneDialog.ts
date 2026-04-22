import type { TourStep } from "../registry";
import { docs } from "../docsLinks";
import { useAppStore } from "../../state/appStore";

const CREATE_LANE_DIALOG_REQUIRES = ["createLaneDialogOpen"] as const;
const CREATE_LANE_DIALOG_SELECTOR = '[data-tour="lanes.createDialog"]';
const CREATE_LANE_BASELINE_KEY = "createLaneBaselineIds";

function currentNonPrimaryLaneIds(): string[] {
  return useAppStore
    .getState()
    .lanes.filter((lane) => lane.laneType !== "primary")
    .map((lane) => lane.id);
}

/**
 * Reusable walkthrough for the CreateLaneDialog.
 * Walks the user through the visible New Lane menu, then the create dialog.
 *
 * Anchors (verified in CreateLaneDialog.tsx):
 *   lanes.newLane, lanes.createNewLane,
 *   lanes.createDialog, lanes.createDialog.name, lanes.createDialog.tabs,
 *   lanes.createDialog.primaryTab, lanes.createDialog.branchTab,
 *   lanes.createDialog.childTab, lanes.createDialog.branchBase,
 *   lanes.createDialog.create
 */
export function buildCreateLaneDialogWalkthrough(): TourStep[] {
  return [
    {
      id: "createLane.openMenu",
      target: '[data-tour="lanes.newLane"]',
      title: "Create a lane",
      body: "Click **New Lane**. For the tutorial, ADE will guide you through creating one fresh test lane.",
      placement: "bottom",
      docUrl: docs.lanesOverview,
      waitForSelector: '[data-tour="lanes.newLane"]',
      awaitingActionLabel: "Waiting for New Lane",
      advanceWhenSelector: '[data-tour="lanes.createNewLane"]',
      exitOnOutsideInteraction: true,
      beforeEnter: (ctx) => {
        ctx?.set(CREATE_LANE_BASELINE_KEY, currentNonPrimaryLaneIds());
      },
    },
    {
      id: "createLane.chooseCreate",
      target: '[data-tour="lanes.createNewLane"]',
      title: "Create new lane",
      body: "Choose **Create new lane**. This opens the dialog for a fresh worktree-backed lane.",
      placement: "right",
      docUrl: docs.lanesCreating,
      waitForSelector: '[data-tour="lanes.createNewLane"]',
      awaitingActionLabel: "Waiting for Create Lane dialog",
      advanceWhenSelector: '[data-tour="lanes.createDialog.name"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: ['[data-tour="lanes.newLane"]'],
    },
    {
      id: "createLane.nameField",
      target: '[data-tour="lanes.createDialog.name"]',
      title: "Name it",
      body: "Name this test lane **tour-sample**, or use any short name you can delete later. The **Create** button stays disabled until the name is valid.",
      placement: "right",
      requires: CREATE_LANE_DIALOG_REQUIRES,
      beforeEnter: (ctx) => {
        if (!ctx?.get<string[]>(CREATE_LANE_BASELINE_KEY)) {
          ctx?.set(CREATE_LANE_BASELINE_KEY, currentNonPrimaryLaneIds());
        }
      },
      focusTarget: true,
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [CREATE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesCreating,
    },
    {
      id: "createLane.sourceChoices",
      target: '[data-tour="lanes.createDialog.tabs"]',
      title: "Three ways to start",
      body: "**Primary** creates a fresh lane. **Branch** imports existing branch work. **Child** stacks work on another lane. Leave **Primary** selected for this tutorial.",
      placement: "right",
      requires: CREATE_LANE_DIALOG_REQUIRES,
      preventTargetInteraction: true,
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [CREATE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesCreating,
    },
    {
      id: "createLane.branchBase",
      target: '[data-tour="lanes.createDialog.branchBase"]',
      title: "Pick a branch base",
      body: "This test lane branches off the selected base, usually **main** or **primary**. Rebase suggestions follow this base later.",
      placement: "right",
      requires: CREATE_LANE_DIALOG_REQUIRES,
      focusTarget: true,
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [CREATE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesCreating,
    },
    {
      id: "createLane.branchTab",
      target: '[data-tour="lanes.createDialog.branchTab"]',
      title: "Branch is for existing work",
      body: "**Branch** is for work that already exists on a local or remote branch. Do not choose it for this tutorial lane.",
      placement: "right",
      requires: CREATE_LANE_DIALOG_REQUIRES,
      ghostCursor: {
        from: '[data-tour="lanes.createDialog.tabs"]',
        to: '[data-tour="lanes.createDialog.branchTab"]',
      },
      exitOnOutsideInteraction: true,
      preventTargetInteraction: true,
      allowedInteractionSelectors: [CREATE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesCreating,
    },
    {
      id: "createLane.childTab",
      target: '[data-tour="lanes.createDialog.childTab"]',
      title: "Child is for stacked lanes",
      body: "**Child** creates a lane that stacks on another lane. Useful later; for now, keep **Primary** selected.",
      placement: "right",
      requires: CREATE_LANE_DIALOG_REQUIRES,
      ghostCursor: {
        from: '[data-tour="lanes.createDialog.tabs"]',
        to: '[data-tour="lanes.createDialog.childTab"]',
      },
      exitOnOutsideInteraction: true,
      preventTargetInteraction: true,
      allowedInteractionSelectors: [CREATE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesCreating,
    },
    {
      id: "createLane.create",
      target: '[data-tour="lanes.createDialog.create"]',
      title: "Create the lane",
      body: "Click **Create**. When ADE finishes the worktree setup, the tutorial continues with the new lane.",
      placement: "left",
      requires: ["laneCountIncreased"],
      awaitingActionLabel: "Waiting for the new test lane",
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [CREATE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesCreating,
    },
  ];
}
