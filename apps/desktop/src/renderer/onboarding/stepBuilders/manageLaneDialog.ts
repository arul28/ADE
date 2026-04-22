import type { TourStep } from "../registry";
import { docs } from "../docsLinks";

const MANAGE_LANE_DIALOG_REQUIRES = ["managelaneDialogOpen"] as const;

/**
 * Reusable walkthrough for the ManageLaneDialog.
 * Covers the lane info / rename header, archive, and delete-scope sections.
 *
 * Anchors (verified in ManageLaneDialog.tsx):
 *   lanes.manageDialog.rename, lanes.manageDialog.archive,
 *   lanes.manageDialog.tabs, lanes.manageDialog.delete
 *
 * Note: the dialog does not have an in-place rename input today — the "rename"
 * anchor stands on the lane-info section. Copy reflects that.
 */
export function buildManageLaneDialogWalkthrough(): TourStep[] {
  return [
    {
      id: "manageLane.open",
      target: "",
      title: "Tidy up the lane",
      bodyTemplate: (ctx) => {
        const lane = ctx.get<string>("laneName") ?? "this lane";
        return `Time to tidy up ${lane}. Manage Lane is where you archive, rename, or delete a lane and its worktree.`;
      },
      body: "Manage Lane is where you archive, rename, or delete a lane and its worktree.",
      docUrl: docs.lanesOverview,
      requires: MANAGE_LANE_DIALOG_REQUIRES,
      beforeEnter: async () => [{ type: "openDialog", id: "lanes.manage" }],
    },
    {
      id: "manageLane.rename",
      target: '[data-tour="lanes.manageDialog.rename"]',
      title: "Lane at a glance",
      body: "Name, branch, and worktree path live here. Rename via the branch reference — ADE keeps the worktree in sync.",
      placement: "bottom",
      requires: MANAGE_LANE_DIALOG_REQUIRES,
      waitForSelector: '[data-tour="lanes.manageDialog.rename"]',
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
      docUrl: docs.lanesOverview,
    },
    {
      id: "manageLane.deleteTabs",
      target: '[data-tour="lanes.manageDialog.tabs"]',
      title: "Choose what to remove",
      body: "Delete the worktree, the local branch, or the remote branch — independently. Pick the scope that matches how far you want to roll back.",
      placement: "bottom",
      requires: MANAGE_LANE_DIALOG_REQUIRES,
      waitForSelector: '[data-tour="lanes.manageDialog.tabs"]',
      docUrl: docs.lanesOverview,
    },
    {
      id: "manageLane.deleteConfirm",
      target: '[data-tour="lanes.manageDialog.delete"]',
      title: "Confirm and delete",
      body: "Type the lane name to confirm, then Delete removes the pieces you selected. Primary lanes are protected — you can't delete them here.",
      placement: "top",
      requires: MANAGE_LANE_DIALOG_REQUIRES,
      waitForSelector: '[data-tour="lanes.manageDialog.delete"]',
      docUrl: docs.lanesOverview,
    },
  ];
}
