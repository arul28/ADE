import type { TourStep } from "../registry";
import { docs } from "../docsLinks";

const MANAGE_LANE_DIALOG_REQUIRES = ["manageLaneDialogOpen"] as const;
const MANAGE_LANE_DIALOG_SELECTOR = '[data-tour="lanes.manageDialog"]';

/**
 * Reusable walkthrough for the ManageLaneDialog.
 * Covers opening the menu, lane info, archive, and delete-scope sections.
 *
 * Anchors (verified in ManageLaneDialog.tsx):
 *   lanes.laneTab, lanes.manageLane,
 *   lanes.manageDialog.laneInfo, lanes.manageDialog.archive,
 *   lanes.manageDialog.tabs, lanes.manageDialog.confirm,
 *   lanes.manageDialog.delete
 */
export function buildManageLaneDialogWalkthrough(): TourStep[] {
  return [
    {
      id: "manageLane.openMenu",
      target: '[data-tour="lanes.laneTab"]',
      title: "Open lane actions",
      bodyTemplate: (ctx) => {
        const lane = ctx.get<string>("laneName") ?? "this lane";
        return `Right-click ${lane}'s lane tab to open its actions menu.`;
      },
      body: "Right-click a lane tab to open its actions menu.",
      placement: "bottom",
      docUrl: docs.lanesOverview,
      waitForSelector: '[data-tour="lanes.laneTab"]',
      awaitingActionLabel: "Waiting for lane menu",
      advanceWhenSelector: '[data-tour="lanes.manageLane"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: ['[data-tour="lanes.laneTab"]'],
    },
    {
      id: "manageLane.openDialog",
      target: '[data-tour="lanes.manageLane"]',
      title: "Manage lane",
      body: "Choose Manage Lane. The dialog opens without touching the lane yet.",
      placement: "right",
      docUrl: docs.lanesOverview,
      waitForSelector: '[data-tour="lanes.manageLane"]',
      awaitingActionLabel: "Waiting for Manage Lane dialog",
      advanceWhenSelector: '[data-tour="lanes.manageDialog.laneInfo"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: ['[data-tour="lanes.laneTab"]'],
    },
    {
      id: "manageLane.laneInfo",
      target: '[data-tour="lanes.manageDialog.laneInfo"]',
      title: "Lane at a glance",
      body: "Name, branch, type, and worktree path live here. Management actions below affect this selected lane.",
      placement: "bottom",
      requires: MANAGE_LANE_DIALOG_REQUIRES,
      waitForSelector: '[data-tour="lanes.manageDialog.laneInfo"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [MANAGE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
    },
    {
      id: "manageLane.archive",
      target: '[data-tour="lanes.manageDialog.archive"]',
      title: "Archive, don't delete",
      body: "Archive hides a lane from ADE without touching the worktree or branch. Good for parking a lane you might come back to.",
      placement: "left",
      requires: MANAGE_LANE_DIALOG_REQUIRES,
      waitForSelector: '[data-tour="lanes.manageDialog.archive"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [MANAGE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
    },
    {
      id: "manageLane.deleteTabs",
      target: '[data-tour="lanes.manageDialog.tabs"]',
      title: "Choose what to remove",
      body: "Choose how far deletion goes: remove only the worktree, also delete the local branch, or also delete the remote branch.",
      placement: "bottom",
      requires: MANAGE_LANE_DIALOG_REQUIRES,
      waitForSelector: '[data-tour="lanes.manageDialog.tabs"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [MANAGE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
    },
    {
      id: "manageLane.deleteConfirm",
      target: '[data-tour="lanes.manageDialog.confirm"]',
      title: "Confirm the lane",
      body: "Type the exact phrase shown above the field. The delete button enables only after it matches.",
      placement: "right",
      requires: MANAGE_LANE_DIALOG_REQUIRES,
      waitForSelector: '[data-tour="lanes.manageDialog.confirm"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [MANAGE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
    },
    {
      id: "manageLane.deleteButton",
      target: '[data-tour="lanes.manageDialog.delete"]',
      title: "Delete only when you mean it",
      body: "This is the destructive action. Primary lanes are protected and never reach this state.",
      placement: "left",
      requires: MANAGE_LANE_DIALOG_REQUIRES,
      waitForSelector: '[data-tour="lanes.manageDialog.delete"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [MANAGE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
    },
  ];
}
