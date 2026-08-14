import { describe, expect, it } from "vitest";
import { buildCursorCloudAutomationDispatches } from "./cursorCloudAutomationDispatch";
import type { CursorCloudIngressEventRecord } from "./cursorCloudIngressService";

function record(overrides: Partial<CursorCloudIngressEventRecord> = {}): CursorCloudIngressEventRecord {
  return {
    id: "rec-1",
    source: "relay",
    deliveryId: "delivery-1",
    eventId: "delivery-1",
    agentId: "bc-agent-1",
    status: "FINISHED",
    summary: "Cloud agent finished",
    branchName: "cursor/cloud-branch",
    prUrl: "https://github.com/ade/ade/pull/1",
    payload: { id: "bc-agent-1", status: "FINISHED", event: "statusChange" },
    createdAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildCursorCloudAutomationDispatches", () => {
  it("maps FINISHED to cursor.cloud_finished", () => {
    const dispatches = buildCursorCloudAutomationDispatches(record());
    expect(dispatches).toEqual([expect.objectContaining({
      source: "cursor-relay",
      triggerType: "cursor.cloud_finished",
      eventName: "statusChange",
      branch: "cursor/cloud-branch",
      eventKey: "delivery-1",
    })]);
    expect(dispatches[0]?.triggerType).not.toBe("auto");
  });

  it("maps ERROR to cursor.cloud_error", () => {
    const dispatches = buildCursorCloudAutomationDispatches(record({
      status: "ERROR",
      summary: "Cloud agent failed",
      payload: { id: "bc-agent-1", status: "ERROR" },
    }));
    expect(dispatches.map((entry) => entry.triggerType)).toEqual(["cursor.cloud_error"]);
  });

  it("ignores non-terminal statuses", () => {
    expect(buildCursorCloudAutomationDispatches(record({ status: "RUNNING" }))).toEqual([]);
    expect(buildCursorCloudAutomationDispatches(record({ status: "CREATING" }))).toEqual([]);
  });
});
