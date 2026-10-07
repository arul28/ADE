import { describe, expect, it } from "vitest";

import {
  attentionItemNavigationRequest,
  parseAttentionItem,
  remoteBindingMatchesProject,
} from "./attentionItemRouting";
import type { AttentionItem } from "../../../shared/types";
import { ATTENTION_CONTRACT_VERSION } from "../../../shared/types/attention";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
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
    laneName: "activity",
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

describe("Activity item routing", () => {
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
    // Root path alone is not evidence about which host a window is bound to,
    // so an unresolved machine matches nothing.
    expect(remoteBindingMatchesProject(
      binding,
      { ...foreign.project, rootPath: "/projects/Other" },
      null,
    )).toBe(false);
    expect(remoteBindingMatchesProject(
      binding,
      foreign.project,
      "machine-a",
    )).toBe(true);
    expect(remoteBindingMatchesProject(
      binding,
      foreign.project,
      "machine-b",
    )).toBe(false);
  });

  it("matches a window already bound to the item's project under the runtime's own id", () => {
    // The binding carries the registry id; the item carries the owning
    // machine's uuid. Without the rootPath fallback every click opened another
    // window for a project that was already on screen.
    const binding = {
      kind: "remote" as const,
      key: "remote:machine-a:project_9f2c1b7a4e",
      targetId: "machine-a",
      runtimeName: "Machine A",
      projectId: "project_9f2c1b7a4e",
      rootPath: "/projects/ADE/",
      displayName: "ADE",
    };
    expect(remoteBindingMatchesProject(binding, item().project, "machine-a")).toBe(true);
    // Machine unknown: the shared root path is the only identity left, and it
    // still has a caller (an Activity item with no account machine key).
    expect(remoteBindingMatchesProject(binding, item().project, null)).toBe(true);
    expect(remoteBindingMatchesProject(
      binding,
      { ...item().project, rootPath: "/projects/Other" },
      "machine-a",
    )).toBe(false);
  });


  it("rejects malformed or cross-kind renderer payloads", () => {
    expect(parseAttentionItem(item())).not.toBeNull();
    expect(parseAttentionItem({ ...item(), phase: "invented_phase" })).toBeNull();
    expect(parseAttentionItem({
      ...item(),
      kind: "pull_request",
      destination: item().destination,
    })).toBeNull();
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
      source: "attention",
    });
  });
});
