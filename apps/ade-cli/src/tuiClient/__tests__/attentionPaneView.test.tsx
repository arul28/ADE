import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { AttentionItem } from "../../../../desktop/src/shared/types/attention";
import { buildAttentionPaneModel } from "../attentionPane";
import { RightPane } from "../components/RightPane";

function attentionItem(): AttentionItem {
  return {
    contractVersion: 1,
    id: "needs-you",
    revision: 1,
    fingerprint: "fp",
    kind: "agent",
    eventKind: "agent_needs_you",
    phase: "needs_you",
    machine: {
      machineKey: "studio",
      name: "Mac Studio",
      online: false,
      lastSeenAt: "2026-07-29T00:00:00.000Z",
    },
    project: { projectId: "ade", name: "ADE" },
    laneId: "lane-1",
    laneName: "account-attention",
    title: "Codex needs approval",
    preview: "Approve the next step",
    privacyPreview: "Agent needs approval",
    destination: { kind: "session", sessionId: "session-1" },
    actions: [],
    occurredAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
  };
}

describe("AttentionPane", () => {
  it("renders scope, urgency, ownership, offline honesty, and keyboard help", () => {
    const model = buildAttentionPaneModel({
      contractVersion: 1,
      scope: "machine",
      availability: {
        state: "degraded",
        title: "Account sync needs attention",
        message: "Showing this machine while you retry.",
        recovery: "retry",
      },
      streamId: "machine:studio",
      revision: 1,
      generatedAt: "2026-07-29T00:00:00.000Z",
      items: [attentionItem()],
      tombstones: [],
    });
    const view = render(
      <RightPane
        content={{ kind: "attention", model }}
        selectedIndex={0}
        focused
        width={52}
      />,
    ).lastFrame() ?? "";

    expect(view).toContain("ATTENTION");
    expect(view).toContain("THIS MACHINE");
    expect(view).toContain("Showing this machine while you retry.");
    expect(view).toContain("NEEDS YOU");
    expect(view).toContain("Codex needs approval");
    expect(view).toContain("ADE · account-attention · Mac Studio");
    expect(view).toContain("offline, last known");
    expect(view).toContain("Enter opens exact destination");
    expect(view).toContain("R refresh");
  });
});
