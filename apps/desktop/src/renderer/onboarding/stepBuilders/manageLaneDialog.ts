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
      title: "Open the lane menu",
      bodyTemplate: (ctx) => {
        const lane = ctx.get<string>("laneName") ?? "this lane";
        return `Right-click **${lane}**'s tab to open its menu of actions (rename, archive, delete, etc.).`;
      },
      body: "Right-click a lane's tab to open its menu of actions (rename, archive, delete, etc.).",
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
      title: "Manage Lane",
      body: "Pick **Manage Lane**. This just opens a dialog where you can choose what to do — nothing happens to your lane yet.",
      placement: "right",
      docUrl: docs.lanesOverview,
      waitForSelector: '[data-tour="lanes.manageLane"]',
      awaitingActionLabel: "Waiting for Manage Lane dialog",
      advanceWhenSelector: '[data-tour="lanes.manageDialog.laneInfo"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [
        '[data-tour="lanes.laneTab"]',
        '[data-tour="lanes.manageLane"]',
      ],
    },
    {
      id: "manageLane.laneInfo",
      target: '[data-tour="lanes.manageDialog.laneInfo"]',
      title: "What lane this is",
      body: "Quick check: this is the lane you're about to manage. Name, branch, where its folder lives. Everything below affects *this* lane only.",
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
      title: "Park it instead of deleting",
      body: "**Archive** hides the lane from your list without actually deleting anything. Good for *\"I might come back to this someday\"* situations — the files stay on your computer, ADE just stops showing it.",
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
      title: "How thorough to delete",
      body: "Three levels: remove just the lane folder, also delete the branch on your computer, or also delete the branch on GitHub. Pick how far you want it gone.",
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
      title: "Type to confirm",
      body: "Deletion is permanent, so ADE asks you to type the lane's name to make sure you really mean it. The delete button stays disabled until what you type matches.",
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
      title: "The point of no return",
      body: "Click this and the lane is gone for good. Your real project is always protected — you can never accidentally delete it from this dialog.",
      placement: "left",
      requires: MANAGE_LANE_DIALOG_REQUIRES,
      waitForSelector: '[data-tour="lanes.manageDialog.delete"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [MANAGE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
    },
  ];
}
