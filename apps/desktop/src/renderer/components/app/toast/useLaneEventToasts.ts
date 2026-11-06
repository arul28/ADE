import { useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";
import {
  LANES_INVALIDATED_LANE_ID,
  type LaneLifecycleEvent,
  type RebaseRunEventPayload,
} from "../../../../shared/types";
import { isChatLaunchLane } from "../../../state/chatLaunchStore";
import { localProjectBindingForRoot, useAppStore } from "../../../state/appStore";
import { arePathsEqual } from "../../../lib/pathUtils";
import { READABLE_TOAST_DURATION_MS, showToast } from "./toastStore";

/**
 * A toast names a lane and claims something happened to it, so an event that
 * cannot identify one lane has nothing truthful to say. Backstop for transports
 * that synthesize coarse refresh nudges: `lanes-invalidated` is already ignored
 * by type, and anything else arriving without real lane identity is a bug we
 * would otherwise render as "Lane archived".
 */
function namesARealLane(event: LaneLifecycleEvent): boolean {
  return (
    event.laneId.trim().length > 0
    && event.laneId !== LANES_INVALIDATED_LANE_ID
    && event.laneName.trim().length > 0
  );
}

export function useLaneEventToasts(navigate: NavigateFunction): void {
  // Lane lifecycle events arrive through both in-process Electron IPC and the
  // runtime event stream. The preload merges those paths for this subscription.
  useEffect(() => {
    const dispose = window.ade.lanes.onLifecycleEvent(
      (event: LaneLifecycleEvent) => {
        if (event.type === "lanes-invalidated") return;
        if (!namesARealLane(event)) return;
        const dot = event.color ?? undefined;
        // A new-lane launch shows its own lane's birth and cancellation.
        if ((event.type === "lane-created" || event.type === "lane-deleted") && isChatLaunchLane(event.laneId)) return;
        if (event.type === "lane-created") {
          showToast({
            id: `lane-${event.type}-${event.laneId}`,
            title: event.laneName,
            replayMask: { title: true },
            message: "Lane created",
            tone: "success",
            colorDot: dot,
            actions: [{
              label: "View",
              onClick: () =>
                navigate(`/lanes?laneId=${event.laneId}&focus=single`),
            }],
          });
          return;
        }
        // The archive rules archived it, not a person: say why, and offer Undo.
        if (event.type === "lane-archived" && event.autoArchive) {
          // Undo goes to the lane's own project. A remote machine's events
          // come only through the active tab's runtime pump, so that tab is
          // where its lane lives, however that machine spells its folder. A
          // local project's events reach every window that has it open,
          // background tabs included, so a lane from a project the active
          // local tab is not on is sent to its folder on this computer. Taken now,
          // so Undo still goes there after a tab switch, and stays unpinned
          // (the tab's own route) while that tab is the same one.
          const active = useAppStore.getState().projectBinding;
          const root = event.autoArchive.projectRoot;
          const origin = root && active?.kind !== "remote" && !(active?.rootPath && arePathsEqual(active.rootPath, root))
            ? localProjectBindingForRoot(root, root)
            : active;
          const laneId = event.laneId;
          const laneName = event.laneName;
          showToast({
            id: `lane-auto-archived-${laneId}`,
            title: laneName,
            replayMask: { title: true },
            message: `Archived automatically: ${event.autoArchive.reason}`,
            tone: "info",
            colorDot: dot,
            durationMs: READABLE_TOAST_DURATION_MS,
            actions: [{
              label: "Undo",
              onClick: () => {
                const current = useAppStore.getState().projectBinding;
                const pin = origin && current?.key !== origin.key ? origin : null;
                void window.ade.lanes.unarchive({ laneId }, pin).catch((err: unknown) => {
                  showToast({
                    id: `lane-auto-archived-${laneId}`,
                    title: laneName,
                    replayMask: { title: true },
                    message: `Couldn't restore it: ${err instanceof Error ? err.message : String(err)}`,
                    tone: "error",
                  });
                });
              },
            }],
          });
          return;
        }
        // A reclaim follows its own "Lane archived" event, and the screen that
        // started it reports the space it freed.
        if (event.type === "lane-renamed" || event.type === "lane-branch-updated" || event.type === "lane-reclaimed") return;
        showToast({
          id: `lane-${event.type}-${event.laneId}`,
          title: event.laneName,
          replayMask: { title: true },
          message:
            event.type === "lane-archived"
              ? "Lane archived"
              : event.type === "lane-unarchived"
                ? "Lane unarchived"
                : event.type === "lane-restored"
                  ? "Lane restored"
                  : "Lane deleted",
          tone: "info",
          colorDot: dot,
        });
      },
    );
    return dispose;
  }, [navigate]);

  // Rebase outcome events can stream multiple progress updates. Only terminal
  // states produce toasts, keyed by run id so repeated terminal updates collapse.
  useEffect(() => {
    const dispose = window.ade.lanes.rebaseSubscribe(
      (event: RebaseRunEventPayload) => {
        if (event.type !== "rebase-run-updated") return;
        const { run } = event;
        if (run.state === "running") return;
        const failedLane = run.failedLaneId
          ? run.lanes.find((lane) => lane.laneId === run.failedLaneId)
          : null;
        const rootLane = run.lanes.find(
          (lane) => lane.laneId === run.rootLaneId,
        );
        const laneLabel =
          failedLane?.laneName ?? rootLane?.laneName ?? run.rootLaneId;
        if (run.state === "completed") {
          if (run.actor === "user") return;
          showToast({
            id: `lane-rebase-${run.runId}`,
            title: laneLabel,
            replayMask: { title: true },
            message: "Rebase completed",
            tone: "success",
          });
          return;
        }
        // Git's own error text can name commits and files: masked in replays.
        // The fixed "Rebase aborted" / "Rebase failed" stay readable.
        const gitError = run.state === "aborted" ? "" : run.error?.trim() ?? "";
        showToast({
          id: `lane-rebase-${run.runId}`,
          title: laneLabel,
          replayMask: { title: true, message: Boolean(gitError) },
          message: run.state === "aborted" ? "Rebase aborted" : gitError || "Rebase failed",
          tone: "error",
        });
      },
    );
    return dispose;
  }, []);
}
