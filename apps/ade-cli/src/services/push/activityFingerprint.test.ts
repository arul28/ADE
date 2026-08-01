import { describe, expect, it } from "vitest";
import {
  ATTENTION_CONTRACT_VERSION,
  type AttentionItem,
} from "../../../../desktop/src/shared/types/attention";
import {
  activityAlertFingerprint,
  activityContentFingerprint,
} from "./activityFingerprint";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    id: "agent:machine:session",
    revision: 1,
    fingerprint: "legacy",
    activityTier: "ambient",
    kind: "agent",
    eventKind: "agent_running",
    phase: "running",
    machine: {
      machineKey: "machine",
      name: "MacBook",
      online: true,
      lastSeenAt: "2026-08-01T12:00:00.000Z",
    },
    project: { projectId: "project", name: "ADE" },
    laneId: "lane",
    laneName: "feature",
    provider: "Codex",
    model: "gpt-5",
    title: "Codex is working",
    preview: "Working for 1.2s · 120 tokens · 3 files",
    privacyPreview: "An ADE agent is working.",
    destination: { kind: "session", sessionId: "session", itemId: "approval-1" },
    actions: [{ id: "open", kind: "open", label: "Open" }],
    occurredAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: "2026-08-01T14:00:00.000Z",
    ...overrides,
  };
}

describe("Activity fingerprints", () => {
  it("keeps content and alert identity stable across elapsed/count preview churn", () => {
    const first = item();
    const churned = item({
      revision: 99,
      preview: "Working for 48.9s · 8,420 tokens · 27 files",
      occurredAt: "2026-08-01T12:00:48.000Z",
      updatedAt: "2026-08-01T12:00:48.000Z",
      expiresAt: "2026-08-01T14:00:48.000Z",
      machine: {
        ...first.machine,
        online: false,
        lastSeenAt: "2026-08-01T12:00:48.000Z",
      },
      detail: "different noisy detail",
      recentActivity: ["tool event"],
    });

    expect(activityContentFingerprint(churned)).toBe(activityContentFingerprint(first));
    expect(activityAlertFingerprint(churned)).toBe(activityAlertFingerprint(first));
  });

  it("changes alert identity when the session destination item changes", () => {
    const first = item();
    const nextApproval = item({
      destination: { kind: "session", sessionId: "session", itemId: "approval-2" },
    });

    expect(activityAlertFingerprint(nextApproval)).not.toBe(activityAlertFingerprint(first));
  });
});
