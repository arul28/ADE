// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkerActivityFeed } from "./WorkerActivityFeed";

describe("WorkerActivityFeed", () => {
  it("renders merged run and session activity in reverse chronological order", () => {
    render(
      <WorkerActivityFeed
        runs={[
          {
            id: "run-1",
            agentId: "agent-1",
            status: "completed",
            wakeupReason: "manual",
            context: {},
            createdAt: "2026-03-05T10:30:00.000Z",
            updatedAt: "2026-03-05T10:31:00.000Z",
          },
        ]}
        sessions={[
          {
            id: "session-1",
            sessionId: "sess-1",
            summary: "Reviewed auth module",
            startedAt: "2026-03-05T09:00:00.000Z",
            endedAt: "2026-03-05T09:05:00.000Z",
            provider: "claude",
            modelId: null,
            capabilityMode: "full_mcp",
            createdAt: "2026-03-05T09:00:00.000Z",
          },
        ]}
      />,
    );

    const items = screen.getAllByText(/Heartbeat: manual|Reviewed auth module/);
    expect(items[0]?.textContent).toContain("Heartbeat: manual");
    expect(items[1]?.textContent).toContain("Reviewed auth module");
  });

  it("shows an empty state when there is no activity", () => {
    render(<WorkerActivityFeed runs={[]} sessions={[]} />);
    expect(screen.getByText("No activity recorded yet.")).toBeTruthy();
  });
});
