import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { deriveMissionSnapshot, missionFeatureCounts, orderMissionFeatures } from "./chatMission";

function env(event: AgentChatEventEnvelope["event"], seq: number): AgentChatEventEnvelope {
  return { sessionId: "s1", timestamp: `2026-06-05T00:00:0${seq}.000Z`, sequence: seq, event } as AgentChatEventEnvelope;
}

describe("deriveMissionSnapshot", () => {
  it("returns null when there are no mission events", () => {
    expect(deriveMissionSnapshot([])).toBeNull();
    expect(
      deriveMissionSnapshot([env({ type: "text", text: "hi" }, 0), env({ type: "done", turnId: "t", status: "completed", model: "m" }, 1)]),
    ).toBeNull();
  });

  it("takes the latest of each mission event (full-value, not delta)", () => {
    const snapshot = deriveMissionSnapshot([
      env({ type: "mission_state", state: "initializing" }, 0),
      env({ type: "mission_features", features: [{ id: "f1", description: "A", status: "pending" }] }, 1),
      env({ type: "mission_state", state: "running" }, 2),
      env({ type: "mission_features", features: [
        { id: "f1", description: "A", status: "completed" },
        { id: "f2", description: "B", status: "in_progress", currentWorkerSessionId: "w2" },
      ] }, 3),
      env({ type: "mission_progress", entries: [{ type: "worker_started", workerSessionId: "w2" }] }, 4),
    ]);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.state).toBe("running");
    expect(snapshot!.features).toHaveLength(2);
    expect(snapshot!.features[1]).toMatchObject({ id: "f2", status: "in_progress", currentWorkerSessionId: "w2" });
    expect(snapshot!.progress).toHaveLength(1);
  });

  it("is non-null even if only one mission event kind appears", () => {
    const snapshot = deriveMissionSnapshot([env({ type: "mission_state", state: "awaiting_input" }, 0)]);
    expect(snapshot).toEqual({ state: "awaiting_input", features: [], progress: [] });
  });
});

describe("orderMissionFeatures + counts", () => {
  it("orders active first, then pending, completed, cancelled", () => {
    const ordered = orderMissionFeatures([
      { id: "done", description: "", status: "completed" },
      { id: "active", description: "", status: "in_progress" },
      { id: "queued", description: "", status: "pending" },
      { id: "dropped", description: "", status: "cancelled" },
    ]);
    expect(ordered.map((f) => f.id)).toEqual(["active", "queued", "done", "dropped"]);
  });

  it("counts completed and in-progress features", () => {
    expect(missionFeatureCounts([
      { id: "1", description: "", status: "completed" },
      { id: "2", description: "", status: "in_progress" },
      { id: "3", description: "", status: "pending" },
    ])).toEqual({ total: 3, completed: 1, inProgress: 1 });
  });
});
