import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import type { AttentionItem } from "../../../../desktop/src/shared/types/attention";
import { buildActivityPaneModel } from "../activityPane";
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
    statusSince: "2026-07-29T00:00:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
  };
}

describe("ActivityPane", () => {
  // Rows carry their age, so the frame is only reproducible against a fixed now.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T02:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders scope, urgency, ownership, offline honesty, and keyboard help", () => {
    const model = buildActivityPaneModel({
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
        content={{ kind: "activity", model }}
        selectedIndex={0}
        focused
        width={64}
      />,
    ).lastFrame() ?? "";

    expect(view).toContain("ACTIVITY");
    expect(view).toContain("THIS MACHINE");
    expect(view).toContain("Showing this machine while you retry.");
    expect(view).toContain("NEEDS YOU");
    expect(view).toContain("Codex needs approval");
    expect(view).toContain("ADE · account-attention · Mac Studio · 2h ago");
    expect(view).toContain("offline, last known");
    expect(view).toContain("Enter opens exact destination");
    expect(view).toContain("R refresh");
  });

  it("keeps the age when the pane is too narrow for the whole project trail", () => {
    const model = buildActivityPaneModel({
      contractVersion: 1,
      scope: "account",
      availability: {
        state: "ready",
        title: "Account Activity",
        message: "Live across your ADE account.",
        recovery: null,
      },
      streamId: "account-1",
      revision: 1,
      generatedAt: "2026-07-29T00:00:00.000Z",
      items: [attentionItem()],
      tombstones: [],
    });
    const view = render(
      <RightPane
        content={{ kind: "activity", model }}
        selectedIndex={0}
        focused
        width={40}
      />,
    ).lastFrame() ?? "";

    expect(view).toContain("2h ago");
    expect(view).not.toContain("account-attention · Mac Studio");
  });
});
