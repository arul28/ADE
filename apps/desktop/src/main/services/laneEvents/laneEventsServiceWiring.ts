/**
 * Lane-story writers that both hosts (the desktop main process and the
 * `ade serve` daemon) must share, so their behaviour cannot drift. The service
 * itself is constructed directly by each host from `createLaneEventsService`;
 * only genuinely shared logic lives here.
 */
import type { RebaseRunEventPayload } from "../../../shared/types/lanes";
import type { LaneEventsService } from "./laneEventsService";

export type { LaneEventsService };

/**
 * Record a `rebase` event per lane touched by a finished rebase run. Both
 * hosts call this from their `onRebaseEvent` hook so the story reads the same
 * whether the rebase ran under the desktop app or the daemon. Best-effort by
 * construction: a rebase must never fail because of its own bookkeeping.
 */
export function recordLaneRebaseEvent(
  service: LaneEventsService | null,
  event: RebaseRunEventPayload,
): void {
  if (!service) return;
  if (event.type !== "rebase-run-updated") return;
  const run = event.run;
  if (run.state === "running") return;
  const outcome = run.state === "completed" ? "completed" : "failed";
  for (const lane of run.lanes) {
    if (lane.status === "pending" || lane.status === "skipped") continue;
    void service
      .record({
        laneId: lane.laneId,
        kind: "rebase",
        ts: run.finishedAt ?? event.timestamp,
        actor: { kind: run.actor === "auto" ? "system" : "human", attribution: "session" },
        ref: `${run.runId}:${lane.laneId}`,
        branchRef: null,
        payload: {
          onto: run.baseBranch ?? "",
          outcome: run.actor === "auto" ? "auto" : outcome,
          message: lane.error ?? null,
        },
      })
      .catch(() => {
        // The lane story never interferes with a rebase.
      });
  }
}
