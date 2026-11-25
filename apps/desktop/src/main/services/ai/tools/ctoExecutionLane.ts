import type { Logger } from "../../logging/logger";
import type { CtoOperatorToolDeps } from "./ctoOperatorTools";

/**
 * Where CTO-launched work runs, for the in-process CTO and the MCP bridge
 * alike. An explicit lane wins; otherwise the work gets a *fresh* lane. It
 * never falls back to the CTO's own lane: that is the project's main checkout.
 * A failed lane create surfaces (spawnChat reports it) instead of quietly
 * re-targeting the main checkout.
 */
export function createCtoExecutionLaneResolver(
  laneService: Pick<CtoOperatorToolDeps["laneService"], "create">,
  logger: Pick<Logger, "info">,
): CtoOperatorToolDeps["resolveExecutionLane"] {
  return async ({ requestedLaneId, purpose, freshLaneName, freshLaneDescription }) => {
    const explicit = requestedLaneId?.trim();
    if (explicit) return explicit;
    const name = freshLaneName?.trim() || purpose?.trim() || "CTO work";
    const lane = await laneService.create({
      name,
      ...(freshLaneDescription?.trim() ? { description: freshLaneDescription.trim() } : {}),
    });
    logger.info("agent_chat.cto_execution_lane_created", { laneId: lane.id, name, purpose: purpose ?? null });
    return lane.id;
  };
}
