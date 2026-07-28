import { describe, expect, it } from "vitest";

import {
  attentionRemoteBindingMatches,
  attentionItemNavigationRequest,
  parseAttentionNotchSettings,
  parseAttentionNotchSnapshot,
  resolveAttentionNotchOutput,
} from "./attentionNotchRouter";
import type { AttentionItem, AttentionSnapshot } from "../../../shared/types";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    contractVersion: 1,
    id: "agent-1",
    revision: 3,
    fingerprint: "agent-1:3",
    kind: "agent",
    eventKind: "agent_needs_you",
    phase: "needs_you",
    machine: {
      machineKey: "machine-1",
      name: "MacBook Pro",
      online: true,
      lastSeenAt: "2026-07-28T12:00:00.000Z",
    },
    project: {
      projectId: "project-1",
      name: "ADE",
      rootPath: "/projects/ADE",
    },
    laneId: "d228b30e-d2b8-4140-b901-4e9aeab0ad38",
    laneName: "notch",
    provider: "codex",
    model: "gpt-5",
    title: "Agent needs you",
    preview: "Approve the command",
    privacyPreview: "Agent needs your attention",
    detail: null,
    recentActivity: ["Read package.json"],
    planProgress: { completed: 2, total: 4, current: "Waiting for approval" },
    destination: {
      kind: "session",
      sessionId: "session-1",
      itemId: "approval-1",
      eventId: null,
    },
    actions: [
      { id: "approve-1", kind: "approve", label: "Approve" },
      { id: "seen-1", kind: "mark_seen", label: "Mark seen" },
    ],
    occurredAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:02.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function snapshot(attentionItem = item()): AttentionSnapshot {
  return {
    contractVersion: 1,
    revision: 4,
    generatedAt: "2026-07-28T12:00:03.000Z",
    items: [attentionItem],
    tombstones: [],
  };
}

describe("Attention Notch routing", () => {
  it("never path-matches a canonical foreign machine to another machine", () => {
    const foreign = item({
      machine: {
        ...item().machine,
        accountMachineKey: "account-machine-b",
      },
    });
    const binding = {
      kind: "remote" as const,
      key: "remote:machine-a:project-1",
      targetId: "machine-a",
      runtimeName: "Machine A",
      projectId: "project-1",
      rootPath: "/projects/ADE",
      displayName: "ADE",
    };
    expect(attentionRemoteBindingMatches(
      foreign,
      binding,
      null,
      true,
    )).toBe(false);
    expect(attentionRemoteBindingMatches(
      foreign,
      binding,
      "machine-a",
      true,
    )).toBe(true);
  });

  it("accepts bounded canonical snapshots and settings", () => {
    expect(parseAttentionNotchSnapshot(snapshot())).toEqual(snapshot());
    expect(parseAttentionNotchSettings({
      enabled: true,
      preferredDisplayId: 12,
      hideDetails: false,
      celebrationsEnabled: true,
      soundsEnabled: false,
    })).toEqual({
      enabled: true,
      preferredDisplayId: 12,
      hideDetails: false,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });
  });

  it("rejects malformed or cross-kind renderer payloads", () => {
    expect(parseAttentionNotchSnapshot({
      ...snapshot(),
      items: [{ ...item(), phase: "invented_phase" }],
    })).toBeNull();
    expect(parseAttentionNotchSnapshot({
      ...snapshot(),
      items: [{
        ...item(),
        kind: "pull_request",
        destination: item().destination,
      }],
    })).toBeNull();
    expect(parseAttentionNotchSettings({
      enabled: true,
      preferredDisplayId: -1,
      hideDetails: false,
      celebrationsEnabled: true,
      soundsEnabled: true,
    })).toBeNull();
  });

  it("uses the canonical snapshot destination instead of trusting helper output", () => {
    const current = item();
    expect(resolveAttentionNotchOutput({
      type: "open",
      itemId: current.id,
      destination: { kind: "session", sessionId: "stale-session" },
    }, snapshot(current))).toEqual({
      kind: "ignore",
      reason: "stale_destination",
    });
  });

  it("routes unsupported inline actions to the exact destination", () => {
    const current = item();
    expect(resolveAttentionNotchOutput({
      type: "action",
      itemId: current.id,
      destination: {
        eventId: current.destination.kind === "session"
          ? current.destination.eventId
          : null,
        itemId: current.destination.kind === "session"
          ? current.destination.itemId
          : null,
        sessionId: current.destination.kind === "session"
          ? current.destination.sessionId
          : "",
        kind: "session",
      },
      action: current.actions[0]!,
    }, snapshot(current))).toEqual({
      kind: "navigate",
      item: current,
      request: attentionItemNavigationRequest(current),
      fallbackAction: current.actions[0],
    });
  });

  it("keeps acknowledgement actions inline", () => {
    const current = item();
    expect(resolveAttentionNotchOutput({
      type: "action",
      itemId: current.id,
      destination: current.destination,
      action: current.actions[1]!,
    }, snapshot(current))).toEqual({
      kind: "acknowledge",
      item: current,
      mode: "seen",
    });
  });

  it("preserves exact PR ids and detail tabs", () => {
    const pr = item({
      id: "pr-1",
      kind: "pull_request",
      eventKind: "pr_checks_failing",
      phase: "checks_failing",
      destination: {
        kind: "pull_request",
        prId: "database-pr-id",
        repoOwner: "acme",
        repoName: "ade",
        number: 42,
        tab: "checks",
        eventId: "event-7",
      },
    });
    expect(attentionItemNavigationRequest(pr)).toEqual({
      target: {
        kind: "pr",
        prId: "database-pr-id",
        prNumber: 42,
        laneId: pr.laneId,
        repoOwner: "acme",
        repoName: "ade",
        detailTab: "checks",
      },
      source: "attention-notch",
    });
  });
});
