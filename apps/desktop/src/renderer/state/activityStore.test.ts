import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTENTION_CONTRACT_VERSION,
  type AttentionItem,
} from "../../shared/types";
import {
  acknowledgeActivityItem,
  activityStore,
  resetActivityStoreForTests,
  selectActivityCounts,
  selectActivityItems,
  selectActivityUnseenCount,
} from "./activityStore";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

function item(
  id: string,
  phase: AttentionItem["phase"],
  patch: Partial<AttentionItem> = {},
): AttentionItem {
  const updatedAt = patch.updatedAt ?? "2026-07-28T14:00:00.000Z";
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    id,
    revision: patch.revision ?? 1,
    fingerprint: `fingerprint-${id}`,
    kind: "agent",
    eventKind: phase === "completed" ? "agent_completed" : "agent_needs_you",
    phase,
    machine: {
      machineKey: "studio",
      name: "Studio Mac",
      online: true,
      lastSeenAt: updatedAt,
    },
    project: { projectId: "ade", name: "ADE", rootPath: "/repo/ade" },
    provider: "codex",
    title: `Task ${id}`,
    preview: "Working carefully",
    privacyPreview: "Agent update",
    destination: { kind: "session", sessionId: `session-${id}` },
    actions: [],
    occurredAt: updatedAt,
    updatedAt,
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...patch,
  };
}

afterEach(() => {
  resetActivityStoreForTests();
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("activityStore", () => {
  it("merges incremental snapshots and removes only explicit tombstones", () => {
    activityStore.getState().applySnapshot({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      revision: 10,
      generatedAt: "2026-07-28T14:00:00.000Z",
      items: [
        item("a", "running", { revision: 3 }),
        item("b", "needs_you", { revision: 2 }),
      ],
    });
    activityStore.getState().applySnapshot({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      revision: 11,
      generatedAt: "2026-07-28T14:01:00.000Z",
      items: [
        item("a", "blocked", { revision: 4 }),
        item("c", "running", { revision: 1 }),
      ],
    });

    expect(Object.keys(activityStore.getState().itemsById).sort()).toEqual(["a", "b", "c"]);
    expect(activityStore.getState().itemsById.a?.phase).toBe("blocked");

    activityStore.getState().applySnapshot({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      revision: 12,
      generatedAt: "2026-07-28T14:02:00.000Z",
      items: [],
      tombstones: [
        {
          id: "b",
          revision: 3,
          deletedAt: "2026-07-28T14:02:00.000Z",
        },
      ],
    });

    expect(Object.keys(activityStore.getState().itemsById).sort()).toEqual(["a", "c"]);
  });

  it("keeps newer item revisions and honors tombstones", () => {
    activityStore.getState().upsertItem(item("a", "running", { revision: 3 }));
    activityStore.getState().upsertItem(item("a", "failed", { revision: 2 }));
    expect(activityStore.getState().itemsById.a?.phase).toBe("running");

    activityStore.getState().removeItem({
      id: "a",
      revision: 3,
      deletedAt: "2026-07-28T14:05:00.000Z",
    });
    expect(activityStore.getState().itemsById.a).toBeUndefined();

    activityStore.getState().upsertItem(item("a", "failed", { revision: 3 }));
    expect(activityStore.getState().itemsById.a).toBeUndefined();

    activityStore.getState().upsertItem(item("a", "failed", { revision: 4 }));
    expect(activityStore.getState().itemsById.a?.phase).toBe("failed");
  });

  it("clears the prior account when the revision stream resets", () => {
    activityStore.getState().applySnapshot({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      revision: 40,
      generatedAt: "2026-07-28T14:00:00.000Z",
      items: [item("private-account-a", "needs_you")],
    });
    activityStore.setState({
      pendingAcknowledgements: {
        "private-account-a": {
          previous: item("private-account-a", "needs_you"),
          seenAt: "2026-07-28T14:01:00.000Z",
        },
      },
      acknowledgementErrors: {
        "private-account-a": "Network unavailable",
      },
    });

    activityStore.getState().applySnapshot({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      revision: 2,
      generatedAt: "2026-07-28T14:02:00.000Z",
      items: [item("account-b", "running")],
    });

    expect(Object.keys(activityStore.getState().itemsById)).toEqual(["account-b"]);
    expect(activityStore.getState().pendingAcknowledgements).toEqual({});
    expect(activityStore.getState().acknowledgementErrors).toEqual({});
    expect(activityStore.getState().revision).toBe(2);
  });

  it.each([
    ["lower", 2],
    ["equal", 40],
    ["higher", 80],
  ])("clears account A when account B has a %s revision", (_label, nextRevision) => {
    activityStore.getState().applySnapshot({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      streamId: "account-a",
      revision: 40,
      generatedAt: "2026-07-28T14:00:00.000Z",
      items: [item("private-account-a", "needs_you")],
    });

    activityStore.getState().applySnapshot({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      streamId: "account-b",
      revision: nextRevision,
      generatedAt: "2026-07-28T14:02:00.000Z",
      items: [item("account-b", "running")],
    });

    expect(activityStore.getState().streamId).toBe("account-b");
    expect(Object.keys(activityStore.getState().itemsById)).toEqual(["account-b"]);
  });

  it("refreshes retained item presence without requiring a new item revision", () => {
    const retained = item("remote-item", "running");
    activityStore.getState().applySnapshot({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      streamId: "account-a",
      revision: 3,
      generatedAt: "2026-07-28T14:00:00.000Z",
      items: [retained],
    });

    activityStore.getState().applySnapshot({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      streamId: "account-a",
      revision: 3,
      generatedAt: "2026-07-28T14:02:00.000Z",
      machines: [{
        ...retained.machine,
        online: false,
        lastSeenAt: "2026-07-28T13:58:00.000Z",
      }],
      items: [],
    });

    expect(activityStore.getState().itemsById[retained.id]?.machine).toMatchObject({
      online: false,
      lastSeenAt: "2026-07-28T13:58:00.000Z",
    });
  });

  it("filters global items by view and project scope", () => {
    activityStore.setState({
      itemsById: {
        live: item("live", "running"),
        inbox: item("inbox", "needs_you"),
        recent: item("recent", "completed", {
          seenAt: "2026-07-28T14:02:00.000Z",
          updatedAt: "2026-07-28T14:02:00.000Z",
        }),
        other: item("other", "running", {
          project: { projectId: "other-project", name: "Other" },
        }),
      },
      scope: { kind: "project", projectId: "ade", label: "ADE" },
      view: "live",
    });

    expect(selectActivityItems(activityStore.getState()).map((entry) => entry.id)).toEqual([
      "inbox",
      "live",
    ]);

    activityStore.getState().setView("recent");
    expect(
      selectActivityItems(
        activityStore.getState(),
        Date.parse("2026-07-28T15:00:00.000Z"),
      ).map((entry) => entry.id),
    ).toEqual(["recent"]);
  });

  it("tracks scoped counts separately from the global unseen badge", () => {
    activityStore.setState({
      itemsById: {
        needs: item("needs", "needs_you"),
        seen: item("seen", "completed", {
          seenAt: "2026-07-28T14:01:00.000Z",
        }),
        other: item("other", "needs_you", {
          machine: {
            machineKey: "laptop",
            name: "Laptop",
            online: true,
            lastSeenAt: "2026-07-28T14:00:00.000Z",
          },
        }),
      },
      scope: { kind: "machine", machineKey: "studio", label: "Studio Mac" },
    });

    expect(selectActivityCounts(activityStore.getState()).inbox).toBe(1);
    expect(selectActivityUnseenCount(activityStore.getState())).toBe(2);
  });

  it("excludes expired work from views, counts, and the global badge", () => {
    activityStore.setState({
      itemsById: {
        expired: item("expired", "needs_you", {
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
        current: item("current", "running", {
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      },
      view: "live",
    });
    const now = Date.parse("2026-07-28T14:00:00.000Z");

    expect(selectActivityItems(activityStore.getState(), now).map((entry) => entry.id)).toEqual([
      "current",
    ]);
    expect(selectActivityCounts(activityStore.getState(), now)).toMatchObject({
      live: 1,
      inbox: 0,
    });
    expect(selectActivityUnseenCount(activityStore.getState())).toBe(0);
  });

  it("rolls back only acknowledgement fields when a newer snapshot arrives", async () => {
    let rejectAcknowledgement: (error: Error) => void = () => {};
    const acknowledgement = new Promise<void>((_, reject) => {
      rejectAcknowledgement = reject;
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ade: {
          attention: {
            acknowledge: vi.fn(() => acknowledgement),
          },
        },
      },
    });
    activityStore.setState({
      revision: 1,
      itemsById: {
        needs: item("needs", "needs_you"),
      },
    });

    const pending = acknowledgeActivityItem("needs", "seen");
    expect(activityStore.getState().itemsById.needs?.seenAt).not.toBeNull();

    activityStore.getState().applySnapshot({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      revision: 2,
      generatedAt: "2026-07-28T14:03:00.000Z",
      items: [
        item("needs", "blocked", {
          revision: 2,
          title: "New server title",
        }),
      ],
    });
    rejectAcknowledgement(new Error("Network unavailable"));
    await expect(pending).rejects.toThrow("Network unavailable");

    expect(activityStore.getState().itemsById.needs).toMatchObject({
      revision: 2,
      phase: "blocked",
      title: "New server title",
      seenAt: null,
      dismissedAt: null,
    });
  });
});
