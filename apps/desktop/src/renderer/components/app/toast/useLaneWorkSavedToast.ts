import { useEffect } from "react";
import { DELETED_LANE_KEEP_DAYS } from "../../../../shared/laneCleanup";
import { stripElectronErrorWrapper } from "../../../../shared/codedError";
import { machineIdForBinding } from "../../../../shared/machineIdentity";
import type { LaneDeleteEvent, OpenProjectBinding } from "../../../../shared/types";
import { extractError } from "../../../lib/format";
import { isWebClientMode } from "../../../lib/webClientMode";
import { navigateToAppTarget } from "../../../lib/openExternal";
import { useAppStore } from "../../../state/appStore";
import { restoredLaneToast } from "./restoredLaneToast";
import { READABLE_TOAST_DURATION_MS, showToast } from "./toastStore";

/**
 * The project a finished delete ran in: the user can switch tabs while it
 * runs, so what follows it must not use the active tab. The event's `origin`
 * names it; the active tab is only the fallback for a delete this window did
 * not start.
 */
export function deleteEventBinding(event: LaneDeleteEvent): OpenProjectBinding | null {
  return event.origin !== undefined ? event.origin : useAppStore.getState().projectBinding ?? null;
}

/**
 * A delete that kept unsaved work says so once, on the machine it ran on,
 * with a way back: Restore now, or the list in Recently deleted.
 */
export function useLaneWorkSavedToast(): void {
  useEffect(() => {
    const subscribe = window.ade?.lanes?.onDeleteEvent;
    if (!subscribe) return;
    const announced = new Set<string>();
    return subscribe((event) => {
      const { savedWork: saved, overallStatus } = event.progress;
      const finished = overallStatus === "completed" || overallStatus === "completed_with_warnings";
      if (!finished || !saved || announced.has(saved.id)) return;
      announced.add(saved.id);
      const binding = deleteEventBinding(event);
      const toastId = `lane-work-saved:${saved.id}`;
      const openRecentlyDeleted = () => navigateToAppTarget({
        kind: "settings",
        entryId: "storage.recentlyDeleted",
        ...(binding?.kind === "remote" ? { machineId: machineIdForBinding(binding) } : {}),
      });
      const replayMask = { title: true, message: true };
      const restore = () => {
        showToast({ id: toastId, tone: "info", title: `Restoring ${saved.laneName}…`, durationMs: 0, replayMask });
        // ADE Web has no route to a local pin; its own machine is the default.
        void window.ade.lanes.restoreDeleted({ id: saved.id }, isWebClientMode() && binding?.kind === "local" ? null : binding)
          .then((result) => showToast({ id: toastId, ...restoredLaneToast(saved, result) }))
          .catch((reason: unknown) => {
            showToast({
              id: toastId,
              tone: "error",
              title: `Couldn't restore ${saved.laneName}`,
              message: stripElectronErrorWrapper(extractError(reason)),
              replayMask,
              actions: [{ label: "Recently deleted", onClick: openRecentlyDeleted }],
            });
          });
      };
      showToast({
        id: toastId,
        tone: "info",
        title: saved.uncommitted ? `Kept ${saved.laneName}'s uncommitted work` : `Kept ${saved.laneName}'s unpushed commits`,
        message: `ADE keeps it for ${DELETED_LANE_KEEP_DAYS} days.`,
        durationMs: READABLE_TOAST_DURATION_MS,
        replayMask,
        actions: [
          // Stays open: Restore replaces this toast with its progress.
          { label: "Restore lane", onClick: restore, keepOpen: true },
          { label: "Recently deleted", onClick: openRecentlyDeleted },
        ],
      });
    });
  }, []);
}
