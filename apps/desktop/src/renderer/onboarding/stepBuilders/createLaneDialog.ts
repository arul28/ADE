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
      title: "Make your first lane",
      body: "Click **New Lane**. We'll make a throwaway sandbox just for this tutorial — call it whatever you like, then delete it at the end. Real lanes get useful names like `fix-login-bug` or `try-dark-mode`.",
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
      title: "Choose \"Create new lane\"",
      body: "Pick this option. Behind the scenes, ADE creates a new folder on your computer that's a separate copy of your project — that's what makes it a sandbox. (Git people: it's a worktree on a fresh branch.)",
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
      title: "Give it a name",
      body: "Short and task-shaped works best — like `fix-login-copy` or `try-dark-mode`, not full sentences. ADE uses this name for the folder and the Git branch.",
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
      title: "Where to start from",
      body: "Three options: **Primary** (start from your clean main project — the usual choice), **Branch** (use work you already started on a Git branch), or **Child** (build on top of another lane). Leave **Primary** selected for the tutorial.",
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
      title: "What to copy from",
      body: "Pick which branch this sandbox copies from — usually `main`. ADE compares your lane's changes against this so it can tell you what's different and warn you when the original has moved on.",
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
      title: "Already started somewhere else?",
      body: "If you already have a Git branch with work on it (like `feature/search` from a teammate or your earlier work), use **Branch** to bring it in as a lane instead of starting fresh. Skip this for the tutorial.",
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
      title: "Building on another lane?",
      body: "Use **Child** when one task depends on another — like *\"build the checkout page\"* (parent) and *\"polish the checkout error messages\"* (child). The child ships after the parent. Skip for the tutorial.",
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
      title: "Make it",
      body: "Click **Create**. ADE makes the new sandbox folder, switches you to it, and your real project stays untouched.",
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
