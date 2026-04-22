import type { TourStep } from "../registry";
import { docs } from "../docsLinks";

const CREATE_LANE_FALLBACK_MS = 30_000;
const CREATE_LANE_DIALOG_REQUIRES = ["createLaneDialogOpen"] as const;

/**
 * Reusable walkthrough for the CreateLaneDialog.
 * Opens the dialog, walks through name/branch-base fields, demos the
 * Attach-existing tab switch, and submits.
 *
 * Anchors (verified in CreateLaneDialog.tsx):
 *   lanes.createDialog.name, lanes.createDialog.tabs,
 *   lanes.createDialog.attachTab, lanes.createDialog.branchBase,
 *   lanes.createDialog.create
 */
export function buildCreateLaneDialogWalkthrough(): TourStep[] {
  return [
    {
      id: "createLane.open",
      target: "",
      title: "Make your first lane",
      body: "The Create Lane dialog is open. Use it to make a worktree-backed branch, or continue with an existing lane if you already have one.",
      docUrl: docs.lanesOverview,
      requires: CREATE_LANE_DIALOG_REQUIRES,
      fallbackAfterMs: CREATE_LANE_FALLBACK_MS,
      fallbackNextLabel: "Continue without creating",
      fallbackNotice: "You can continue with an existing lane or come back to lane creation later.",
      beforeEnter: async () => [{ type: "openDialog", id: "lanes.create" }],
    },
    {
      id: "createLane.nameField",
      target: '[data-tour="lanes.createDialog.name"]',
      title: "Name it",
      body: "Give the lane a short, memorable name. The Create button stays disabled until the name is valid.",
      placement: "right",
      requires: CREATE_LANE_DIALOG_REQUIRES,
      fallbackAfterMs: CREATE_LANE_FALLBACK_MS,
      fallbackNextLabel: "Continue without creating",
      fallbackNotice: "The dialog can be reopened from the Lanes toolbar.",
      docUrl: docs.lanesCreating,
    },
    {
      id: "createLane.branchBase",
      target: '[data-tour="lanes.createDialog.branchBase"]',
      title: "Pick a branch base",
      body: "This lane branches off whatever you pick here — usually primary. Rebase suggestions follow this base.",
      placement: "right",
      requires: CREATE_LANE_DIALOG_REQUIRES,
      fallbackAfterMs: CREATE_LANE_FALLBACK_MS,
      fallbackNextLabel: "Continue without creating",
      fallbackNotice: "The dialog can be reopened from the Lanes toolbar.",
      docUrl: docs.lanesCreating,
    },
    {
      id: "createLane.attachTab",
      target: '[data-tour="lanes.createDialog.tabs"]',
      title: "Import existing worktrees",
      body: "Already have worktrees on disk? Switch to Import existing and point at a branch instead of creating a fresh one.",
      placement: "bottom",
      requires: CREATE_LANE_DIALOG_REQUIRES,
      fallbackAfterMs: CREATE_LANE_FALLBACK_MS,
      fallbackNextLabel: "Continue without creating",
      fallbackNotice: "The dialog can be reopened from the Lanes toolbar.",
      ghostCursor: {
        from: '[data-tour="lanes.createDialog.tabs"]',
        to: '[data-tour="lanes.createDialog.attachTab"]',
      },
      docUrl: docs.lanesCreating,
    },
    {
      id: "createLane.create",
      target: '[data-tour="lanes.createDialog.create"]',
      title: "Create the lane",
      body: "Click Create — ADE spins up the worktree in the background and a new lane tab appears.",
      placement: "top",
      requires: ["laneExists"],
      fallbackAfterMs: CREATE_LANE_FALLBACK_MS,
      fallbackNextLabel: "Continue with existing lanes",
      fallbackNotice: "If you already have lanes, you can continue without creating another one.",
      waitForSelector: '[data-tour="lanes.laneTab"]',
      docUrl: docs.lanesCreating,
    },
  ];
}
