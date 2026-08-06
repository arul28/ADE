import { describe, expect, it } from "vitest";

import {
  attentionNotchAppNavigation,
  attentionItemNavigationRequest,
  createAttentionNotchToastDeduper,
  parseAttentionNotchSettings,
  parseAttentionNotchSnapshot,
  parseAttentionNotchToast,
  remoteBindingMatchesProject,
  resolveAttentionNotchOutput,
} from "./attentionNotchRouter";
import type { AttentionItem, AttentionSnapshot } from "../../../shared/types";
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
    contractVersion: ATTENTION_CONTRACT_VERSION,
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

  it("routes notch chrome clicks and always demands app activation", () => {
    expect(attentionNotchAppNavigation({ type: "open_center" } as never)).toEqual({
      request: {
        target: { kind: "route", route: "/attention" },
        source: "attention-notch",
      },
      activatesApp: true,
    });
    expect(attentionNotchAppNavigation({ type: "open_settings" } as never)).toEqual({
      request: {
        target: { kind: "settings", tab: "activity", anchor: null },
        source: "attention-notch",
      },
      activatesApp: true,
    });
    expect(attentionNotchAppNavigation({ type: "refresh" } as never)).toBeNull();
    expect(attentionNotchAppNavigation({
      type: "open",
      itemId: "agent-1",
      destination: { kind: "session", sessionId: "session-1" },
    } as never)).toBeNull();
  });

  it("accepts bounded canonical snapshots and settings", () => {
    const activitySnapshot = {
      ...snapshot(item({
        activityTier: "signal",
        contentFingerprint: "content-v2",
        alertFingerprint: "alert-v2",
        statusSince: "2026-07-28T12:00:01.000Z",
      })),
      itemsTruncated: true,
    } satisfies AttentionSnapshot;
    expect(parseAttentionNotchSnapshot(activitySnapshot)).toEqual(activitySnapshot);
    expect(parseAttentionNotchSnapshot({
      ...activitySnapshot,
      itemsTruncated: "yes",
    })).toBeNull();
    expect(parseAttentionNotchSnapshot({
      ...activitySnapshot,
      items: [{ ...activitySnapshot.items[0], activityTier: "urgent" }],
    })).toBeNull();
    expect(parseAttentionNotchSettings({
      enabled: true,
      revealMode: "always",
      expandedPanelEnabled: false,
      preferredDisplayId: 12,
      hideDetails: false,
      celebrationsEnabled: true,
      soundsEnabled: false,
    })).toEqual({
      enabled: true,
      revealMode: "always",
      expandedPanelEnabled: false,
      preferredDisplayId: 12,
      hideDetails: false,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });
  });

  it("keeps a pinned strip pinned when a retired reveal mode is replayed", () => {
    // A renderer that persisted `minimal`/`click` must not be dropped (which
    // would discard the whole settings message) nor silently demoted to hover,
    // which hides a strip the user deliberately pinned.
    for (const legacy of ["minimal", "click"]) {
      expect(parseAttentionNotchSettings({
        enabled: true,
        revealMode: legacy,
        preferredDisplayId: null,
        hideDetails: false,
        celebrationsEnabled: true,
        soundsEnabled: false,
      })).toMatchObject({ revealMode: "always" });
    }
    // A non-string is still malformed, as before.
    expect(parseAttentionNotchSettings({
      enabled: true,
      revealMode: 3,
      preferredDisplayId: null,
      hideDetails: false,
      celebrationsEnabled: true,
      soundsEnabled: false,
    })).toBeNull();
  });

  // A renderer built before the presentation controls existed still has to
  // land, and has to land on the behaviour it was built against.
  it("defaults notch presentation when a payload predates it", () => {
    expect(parseAttentionNotchSettings({
      enabled: true,
      preferredDisplayId: null,
      hideDetails: false,
      celebrationsEnabled: true,
      soundsEnabled: false,
    })).toEqual({
      enabled: true,
      revealMode: "hover",
      expandedPanelEnabled: true,
      preferredDisplayId: null,
      hideDetails: false,
      celebrationsEnabled: true,
      soundsEnabled: false,
    });
  });

  it("ignores the retired presentation flags rather than rejecting the payload", () => {
    // `automaticRevealEnabled` / `tickerEnabled` are gone from the contract —
    // the native helper stopped reading them. A renderer or helper still
    // sending them, with any value, must still have its REAL preferences land;
    // validating a key nothing consumes could only throw settings away.
    for (const retired of [
      { automaticRevealEnabled: "sometimes" },
      { tickerEnabled: 1 },
      { automaticRevealEnabled: false, tickerEnabled: false },
    ]) {
      expect(parseAttentionNotchSettings({
        enabled: true,
        preferredDisplayId: null,
        hideDetails: false,
        celebrationsEnabled: true,
        soundsEnabled: false,
        ...retired,
      })).toEqual({
        enabled: true,
        revealMode: "hover",
        expandedPanelEnabled: true,
        preferredDisplayId: null,
        hideDetails: false,
        celebrationsEnabled: true,
        soundsEnabled: false,
      });
    }
  });

  it("normalizes an invented notch reveal mode instead of dropping the payload", () => {
    // A settings message carries `enabled`, `hideDetails` and the rest too;
    // rejecting all of it over one unrecognized mode string loses real user
    // preferences. The mode falls back, the message lands.
    expect(parseAttentionNotchSettings({
      enabled: true,
      revealMode: "telepathy",
      preferredDisplayId: null,
      hideDetails: false,
      celebrationsEnabled: true,
      soundsEnabled: false,
    })).toMatchObject({ enabled: true, revealMode: "hover" });
    expect(parseAttentionNotchSettings({
      enabled: true,
      expandedPanelEnabled: "yes",
      preferredDisplayId: null,
      hideDetails: false,
      celebrationsEnabled: true,
      soundsEnabled: false,
    })).toBeNull();
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

  it("accepts a well-formed counts block and rejects a malformed one", () => {
    const counts = {
      needsYou: 2,
      working: 5,
      done: 1,
      total: 61,
      machinesOnline: 1,
      machinesTotal: 3,
    };
    expect(parseAttentionNotchSnapshot({ ...snapshot(), counts })).not.toBeNull();
    // Absent stays valid: publishers older than the counts block still land.
    expect(parseAttentionNotchSnapshot(snapshot())).not.toBeNull();
    expect(parseAttentionNotchSnapshot({
      ...snapshot(),
      counts: { ...counts, total: -1 },
    })).toBeNull();
    expect(parseAttentionNotchSnapshot({
      ...snapshot(),
      counts: { ...counts, working: 1.5 },
    })).toBeNull();
    expect(parseAttentionNotchSnapshot({
      ...snapshot(),
      counts: { ...counts, machinesTotal: undefined },
    })).toBeNull();
  });

  it("treats the five-group counts as optional-if-present, never required", () => {
    const counts = {
      needsYou: 2,
      working: 5,
      done: 1,
      total: 61,
      machinesOnline: 1,
      machinesTotal: 3,
    };
    // THE rollout case: a machine still on the three-group counts block omits
    // `failed`/`planning`. Requiring them would drop the ENTIRE snapshot and
    // blank the notch, so absence must parse.
    expect(parseAttentionNotchSnapshot({ ...snapshot(), counts })).not.toBeNull();
    expect(parseAttentionNotchSnapshot({
      ...snapshot(),
      counts: { ...counts, failed: 0, planning: 4 },
    })).not.toBeNull();
    // Present but junk is still a malformed counts block: the strip reads
    // "N failed" straight off it, so a wrong number must surface as a parse
    // failure rather than be shown.
    for (const bad of [-1, 1.5, "3", Number.NaN]) {
      expect(parseAttentionNotchSnapshot({
        ...snapshot(),
        counts: { ...counts, failed: bad },
      })).toBeNull();
      expect(parseAttentionNotchSnapshot({
        ...snapshot(),
        counts: { ...counts, planning: bad },
      })).toBeNull();
    }
  });

  // The router's write cap has to stay under the helper's read cap, or an
  // accepted snapshot is silently dropped on the far side of the pipe.
  it("caps the published projection at 64 items and 192KB", () => {
    const many = (count: number) => ({
      ...snapshot(),
      items: Array.from({ length: count }, (_unused, index) =>
        item({ id: `agent-${index}`, fingerprint: `agent-${index}:3` })),
    });
    expect(parseAttentionNotchSnapshot(many(64))).not.toBeNull();
    expect(parseAttentionNotchSnapshot(many(65))).toBeNull();
    expect(parseAttentionNotchSnapshot({
      ...snapshot(),
      items: [item({ detail: "x".repeat(8_000) })],
      // A single oversized field is enough once the payload clears 192KB.
      generatedAt: "2026-07-28T12:00:03.000Z",
      streamId: "s".repeat(400),
      tombstones: Array.from({ length: 4_000 }, (_unused, index) => ({
        id: `tombstone-${index}-${"x".repeat(40)}`,
        revision: 1,
        deletedAt: "2026-07-28T12:00:03.000Z",
      })),
    })).toBeNull();
  });

  it("validates toasts and rejects anything the native side would have to bend", () => {
    expect(parseAttentionNotchToast({
      itemId: "agent-1",
      eventKind: "pr_merged",
      treatment: "celebration",
      title: "Merged #42",
      subtitle: "acme/ade",
      tone: "emerald",
      durationMs: 1_650,
    })).toEqual({
      itemId: "agent-1",
      eventKind: "pr_merged",
      treatment: "celebration",
      title: "Merged #42",
      subtitle: "acme/ade",
      tone: "emerald",
      durationMs: 1_650,
    });

    // itemId is optional: a toast can be about the account, not a row.
    expect(parseAttentionNotchToast({
      eventKind: "agent_needs_you",
      treatment: "alert",
      title: "Agent needs you",
    })).toEqual({
      itemId: null,
      eventKind: "agent_needs_you",
      treatment: "alert",
      title: "Agent needs you",
      subtitle: null,
      tone: null,
      durationMs: null,
    });

    expect(parseAttentionNotchToast({
      eventKind: "agent_vibed",
      treatment: "alert",
      title: "Agent needs you",
    })).toBeNull();
    expect(parseAttentionNotchToast({
      eventKind: "agent_needs_you",
      treatment: "fanfare",
      title: "Agent needs you",
    })).toBeNull();
    expect(parseAttentionNotchToast({
      eventKind: "agent_needs_you",
      treatment: "alert",
      title: "x".repeat(257),
    })).toBeNull();
    expect(parseAttentionNotchToast({
      eventKind: "agent_needs_you",
      treatment: "alert",
      title: "",
    })).toBeNull();
    expect(parseAttentionNotchToast({
      eventKind: "agent_needs_you",
      treatment: "alert",
      title: "Agent needs you",
      tone: "chartreuse",
    })).toBeNull();
    // Out of range is rejected rather than clamped: 800..15000 mirrors the
    // native clamp, and a host outside it has drifted.
    expect(parseAttentionNotchToast({
      eventKind: "agent_needs_you",
      treatment: "alert",
      title: "Agent needs you",
      durationMs: 200,
    })).toBeNull();
    expect(parseAttentionNotchToast({
      eventKind: "agent_needs_you",
      treatment: "alert",
      title: "Agent needs you",
      durationMs: 60_000,
    })).toBeNull();
  });

  it("deduplicates the same cross-window toast for five seconds", () => {
    let now = 1_000;
    const shouldForward = createAttentionNotchToastDeduper(() => now);
    const toast = {
      itemId: "agent-1",
      eventKind: "agent_needs_you" as const,
      treatment: "alert" as const,
      title: "Agent needs you",
    };

    expect(shouldForward(toast)).toBe(true);
    expect(shouldForward({ ...toast, title: "A second window's copy" })).toBe(false);
    expect(shouldForward({ ...toast, eventKind: "agent_failed" })).toBe(true);
    expect(shouldForward({ ...toast, itemId: "agent-2" })).toBe(true);

    now += 5_000;
    expect(shouldForward(toast)).toBe(true);

    const titleOnly = { ...toast, itemId: null };
    expect(shouldForward(titleOnly)).toBe(true);
    expect(shouldForward({ ...titleOnly })).toBe(false);
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
