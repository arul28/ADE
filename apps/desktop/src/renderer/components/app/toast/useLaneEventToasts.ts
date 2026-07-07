import { useEffect } from "react";
import type { NavigateFunction } from "react-router-dom";
import type {
  LaneLifecycleEvent,
  RebaseRunEventPayload,
} from "../../../../shared/types";
import { showToast } from "./toastStore";

export function useLaneEventToasts(navigate: NavigateFunction): void {
  // Lane lifecycle events arrive through both in-process Electron IPC and the
  // runtime event stream. The preload merges those paths for this subscription.
  useEffect(() => {
    const dispose = window.ade.lanes.onLifecycleEvent(
      (event: LaneLifecycleEvent) => {
        const dot = event.color ?? undefined;
        if (event.type === "lane-created") {
          showToast({
            id: `lane-${event.type}-${event.laneId}`,
            title: event.laneName,
            message: "Lane created",
            tone: "success",
            colorDot: dot,
            action: {
              label: "View",
              onClick: () =>
                navigate(`/lanes?laneId=${event.laneId}&focus=single`),
            },
          });
          return;
        }
        if (event.type === "lane-renamed") return;
        showToast({
          id: `lane-${event.type}-${event.laneId}`,
          title: event.laneName,
          message:
            event.type === "lane-archived"
              ? "Lane archived"
              : event.type === "lane-unarchived"
                ? "Lane unarchived"
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
            message: "Rebase completed",
            tone: "success",
          });
          return;
        }
        showToast({
          id: `lane-rebase-${run.runId}`,
          title: laneLabel,
          message:
            run.state === "aborted"
              ? "Rebase aborted"
              : run.error?.trim() || "Rebase failed",
          tone: "error",
        });
      },
    );
    return dispose;
  }, []);
}
