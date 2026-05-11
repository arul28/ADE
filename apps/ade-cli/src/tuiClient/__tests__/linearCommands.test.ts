import { describe, expect, it } from "vitest";
import { buildLinearToolRequest, parseLinearArgs } from "../linearCommands";

describe("linear command routing", () => {
  it("parses flags and quoted values", () => {
    expect(parseLinearArgs("run cancel run-1 --reason \"not ready\" --launch false")).toEqual({
      positionals: ["run", "cancel", "run-1"],
      options: { reason: "not ready", launch: false },
    });
  });

  it("routes sync dashboard and queue resolution", () => {
    expect(buildLinearToolRequest("sync dashboard")).toEqual({
      kind: "tool",
      title: "Linear sync dashboard",
      toolName: "getLinearSyncDashboard",
      args: {},
    });
    expect(buildLinearToolRequest("sync resolve queue-1 approve --note ok")).toEqual({
      kind: "tool",
      title: "Linear sync resolve",
      toolName: "resolveLinearSyncQueueItem",
      args: {
        queueItemId: "queue-1",
        action: "approve",
        note: "ok",
      },
    });
  });

  it("routes worker handoff and reports usage for missing fields", () => {
    expect(buildLinearToolRequest("route worker LIN-123 agent-1")).toEqual({
      kind: "tool",
      title: "Linear route worker",
      toolName: "routeLinearIssueToWorker",
      args: { issueId: "LIN-123", agentId: "agent-1" },
    });
    expect(buildLinearToolRequest("run cancel run-1")).toEqual({
      kind: "usage",
      title: "Linear run cancel",
      body: "Usage: /linear run cancel <run-id> --reason <reason>",
    });
  });
});
