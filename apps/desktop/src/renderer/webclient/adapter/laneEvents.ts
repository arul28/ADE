import {
  LANES_INVALIDATED_LANE_ID,
  emptyLaneEventsListResult,
  emptyLaneEventsSummaryResult,
} from "../../../shared/types";
import type {
  LaneEventsChangedEvent,
  LaneEventsListArgs,
  LaneEventsListResult,
  LaneEventsSummaryArgs,
  LaneEventsSummaryResult,
} from "../../../shared/types";
import type { AdapterInfra, AdeNamespace } from "./types";
import { assertWebRuntimePinRoutable, type RuntimePinArg } from "./runtimePinGuard";

/**
 * The lane story on hosted web.
 *
 * The host serves the same two reads the Electron preload does, under the sync
 * remote commands `lanes.listEvents` / `lanes.eventsSummary`. What web does NOT
 * have is the runtime's `lane_events_changed` push — the hosted client only
 * learns about host-side writes through CRR table invalidations. So `onChanged`
 * is wired to the `lanes` invalidation domain (`lane_events` is classified into
 * it in `infra/invalidation.ts`) and re-emits with the same
 * `LANES_INVALIDATED_LANE_ID` sentinel the lane lifecycle bridge uses: "some
 * lane's story moved, refetch what you have open". Subscribers must treat that
 * lane id as a wildcard rather than a real lane.
 */
export function createLaneEventsNamespace(infra: AdapterInfra): AdeNamespace<"laneEvents"> {
  const { commands, events } = infra;

  function guardPin(operation: string, pin: RuntimePinArg): void {
    assertWebRuntimePinRoutable(`laneEvents.${operation}`, pin, infra);
  }

  infra.addDispose(
    events.on("lanesInvalidated", (event) => {
      commands.invalidateCache(["lanes.listEvents", "lanes.eventsSummary"]);
      events.emit("laneEventsChanged", {
        laneId: LANES_INVALIDATED_LANE_ID,
        kinds: [],
        at: event.at,
      });
    })
  );

  return {
    list: async (args: LaneEventsListArgs, pin?: RuntimePinArg) => {
      guardPin("list", pin);
      return await commands.call<LaneEventsListResult>(
        "lanes.listEvents",
        { ...args } as Record<string, unknown>,
        {
          fallback: () => emptyLaneEventsListResult(args?.laneId ?? ""),
          idempotent: true,
          cacheTtlMs: 2_000,
        }
      );
    },
    summary: async (args: LaneEventsSummaryArgs, pin?: RuntimePinArg) => {
      guardPin("summary", pin);
      return await commands.call<LaneEventsSummaryResult>(
        "lanes.eventsSummary",
        { ...args } as Record<string, unknown>,
        {
          fallback: () => emptyLaneEventsSummaryResult(),
          idempotent: true,
          cacheTtlMs: 2_000,
        }
      );
    },
    onChanged: (cb: (event: LaneEventsChangedEvent) => void, pin?: RuntimePinArg) => {
      guardPin("onChanged", pin);
      return events.on("laneEventsChanged", cb);
    },
  } as AdeNamespace<"laneEvents">;
}
