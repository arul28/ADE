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
 *   lanes.manageDialog.tabs, lanes.manageDialog.delete
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
      title: "Pick what to remove",
      body: "Check off what you want gone: the lane folder, the branch on your computer, the branch on GitHub — or hit **Select everything**. Nothing is checked by default, so you can't delete by accident.",
      placement: "bottom",
      requires: MANAGE_LANE_DIALOG_REQUIRES,
      waitForSelector: '[data-tour="lanes.manageDialog.tabs"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [MANAGE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
    },
    {
      id: "manageLane.deleteButton",
      target: '[data-tour="lanes.manageDialog.delete"]',
      title: "The point of no return",
      body: "Click this and whatever you checked is gone for good. It stays disabled until you pick at least one thing, and your real project is always protected — you can never accidentally delete it from this dialog.",
      placement: "left",
      requires: MANAGE_LANE_DIALOG_REQUIRES,
      waitForSelector: '[data-tour="lanes.manageDialog.delete"]',
      exitOnOutsideInteraction: true,
      allowedInteractionSelectors: [MANAGE_LANE_DIALOG_SELECTOR],
      docUrl: docs.lanesOverview,
    },
  ];
}
