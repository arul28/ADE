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

function rememberCreatedLaneName(ctx: { get: <T = unknown>(k: string) => T | undefined; set: (k: string, v: unknown) => void } | undefined): void {
  if (!ctx) return;
  const baseline = new Set(ctx.get<string[]>(CREATE_LANE_BASELINE_KEY) ?? []);
  const { lanes, selectedLaneId } = useAppStore.getState();
  const createdLane =
    lanes.find((lane) => lane.id === selectedLaneId && lane.laneType !== "primary" && !baseline.has(lane.id)) ??
    lanes.find((lane) => lane.laneType !== "primary" && !baseline.has(lane.id));
  if (createdLane?.name) {
    ctx.set("laneName", createdLane.name);
  }
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
      body: "Click **New Lane**. A lane is a safe copy of the project for one task, like `fix-login-copy` or `try-new-checkout-flow`. The tutorial makes one disposable lane so you can see the shape.",
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
      body: "Choose **Create new lane**. ADE will make a fresh Git worktree: a real folder on disk with its own branch, separate from primary.",
      placement: "right",
      docUrl: docs.lanesCreating,
      waitForSelector: '[data-tour="lanes.createNewLane"]',
      awaitingActionLabel: "Waiting for Create Lane dialog",
      advanceWhenSelector: '[data-tour="lanes.createDialog.name"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [
        '[data-tour="lanes.newLane"]',
        '[data-tour="lanes.createNewLane"]',
      ],
    },
    {
      id: "createLane.nameField",
      target: '[data-tour="lanes.createDialog.name"]',
      title: "Name it",
      body: "Use a short task name, not a sentence. Good examples: `fix-login-copy`, `test-new-sidebar`, `tour-sample`. ADE uses this name for the lane and its branch/worktree identity.",
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
      body: "**Primary** starts from the clean main project. **Branch** is for work you already started on a Git branch. **Child** makes a stacked lane that depends on another lane. Leave **Primary** selected here.",
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
      body: "The base is the starting line. If the base is `main`, ADE compares your lane to `main`; if new commits land on `main`, ADE can tell you the lane may need a rebase.",
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
      body: "Use **Branch** when work already exists, like `feature/search` on your machine or GitHub, and you want ADE to manage it as a lane. Do not choose it for this tutorial lane.",
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
      body: "Use **Child** when task B depends on task A. Example: parent lane `build-checkout-page`, child lane `polish-checkout-errors`. The child ships after the parent.",
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
      body: "Click **Create**. ADE makes the branch and worktree folder, selects the new lane, and keeps primary untouched.",
      placement: "left",
      requires: ["laneCountIncreased"],
      awaitingActionLabel: "Waiting for the new test lane",
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [CREATE_LANE_DIALOG_SELECTOR],
      afterLeave: (ctx) => rememberCreatedLaneName(ctx),
      docUrl: docs.lanesCreating,
    },
  ];
}
