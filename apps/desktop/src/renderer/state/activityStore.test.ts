import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTENTION_CONTRACT_VERSION,
  type AttentionItem,
} from "../../shared/types";
import {
  acknowledgeActivityItem,
  acknowledgeActivityItems,
  activityStore,
  resetActivityStoreForTests,
  selectActivityUnseenCount,
} from "./activityStore";

function installAcknowledge(
  acknowledge: (args: {
    itemIds: string[];
    alertFingerprints?: Record<string, string>;
  }) => Promise<{
    acknowledged: string[];
    stale: string[];
    /** Omitted by every producer that has nothing to report — and by older ones. */
    unreached?: string[];
    unreachedReason?: string;
  }>,
) {
  const spy = vi.fn(acknowledge);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { ade: { attention: { acknowledge: spy } } },
  });
  return spy;
}

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

  it("tracks the global unseen badge across machines", () => {
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
    });

    expect(selectActivityUnseenCount(activityStore.getState())).toBe(2);
  });

  it("excludes expired work from the global badge", () => {
    activityStore.setState({
      itemsById: {
        expired: item("expired", "needs_you", {
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
        current: item("current", "running", {
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      },
    });
    expect(selectActivityUnseenCount(activityStore.getState())).toBe(0);
  });

  /**
   * "Clear all" was N calls, N races, and N swallowed rejections. One call with
   * one outcome is the whole fix, and the request has to name every row.
   */
  it("clears a whole batch in one call", async () => {
    const acknowledge = installAcknowledge(async ({ itemIds }) => ({
      acknowledged: itemIds,
      stale: [],
    }));
    activityStore.setState({
      accountOwnerId: "account-a",
      itemsById: {
        first: item("first", "needs_you"),
        second: item("second", "completed"),
      },
    });

    const outcome = await acknowledgeActivityItems(["first", "second"], "dismiss");

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge.mock.calls[0]![0]).toMatchObject({
      itemIds: ["first", "second"],
      expectedAccountOwnerId: "account-a",
    });
    expect(outcome).toEqual({ acknowledged: ["first", "second"], stale: [], unreached: [] });
    expect(activityStore.getState().itemsById.first?.dismissedAt).not.toBeNull();
    expect(activityStore.getState().itemsById.second?.dismissedAt).not.toBeNull();
    expect(activityStore.getState().pendingAcknowledgements).toEqual({});
  });

  /**
   * The narrow fence, and the reason it exists.
   *
   * Poll at revision N with a row `running`; the user hits Clear all; the row
   * flips to `needs_you` and THAT publish lands first, resetting seen and
   * dismissed because the alert identity changed. Without a fence the ack then
   * marks the new needs-you entry seen and dismissed, and an alert nobody ever
   * saw is gone from the inbox and the badge. Quoting the fingerprint the user
   * actually looked at is what lets the host refuse that one row — and only
   * that row. A publisher that sends no `alertFingerprint` quotes nothing, so
   * an older fleet acks exactly as it does today.
   */
  it("quotes the alert fingerprint it displayed for each acknowledged row", async () => {
    const acknowledge = installAcknowledge(async ({ itemIds }) => ({
      acknowledged: itemIds,
      stale: [],
    }));
    activityStore.setState({
      accountOwnerId: "account-a",
      itemsById: {
        fenced: item("fenced", "needs_you", { alertFingerprint: "alert-v2" }),
        padded: item("padded", "needs_you", { alertFingerprint: "  alert-v3  " }),
        legacy: item("legacy", "needs_you"),
      },
    });

    await acknowledgeActivityItems(["fenced", "padded", "legacy"], "dismiss");

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge.mock.calls[0]![0].alertFingerprints).toEqual({
      fenced: "alert-v2",
      padded: "alert-v3",
    });
  });

  /**
   * The host answers per item, so the rollback is per item too: putting the
   * nine rows that DID clear back because a tenth moved would be the same lie
   * as pretending the tenth cleared.
   */
  it("rolls back only the rows the host refused as stale", async () => {
    installAcknowledge(async ({ itemIds }) => ({
      acknowledged: itemIds.filter((id) => id !== "second"),
      stale: ["second"],
    }));
    activityStore.setState({
      itemsById: {
        first: item("first", "needs_you"),
        second: item("second", "needs_you"),
        third: item("third", "completed"),
      },
    });

    const outcome = await acknowledgeActivityItems(
      ["first", "second", "third"],
      "dismiss",
    );

    expect(outcome).toEqual({
      acknowledged: ["first", "third"],
      stale: ["second"],
      unreached: [],
    });
    expect(activityStore.getState().itemsById.first?.dismissedAt).not.toBeNull();
    expect(activityStore.getState().itemsById.third?.dismissedAt).not.toBeNull();
    expect(activityStore.getState().itemsById.second?.dismissedAt).toBeNull();
    expect(activityStore.getState().itemsById.second?.seenAt).toBeNull();
    // The refused row explains itself; the others carry no error at all.
    expect(activityStore.getState().acknowledgementErrors.second).toContain(
      "changed on the machine that owns it",
    );
    expect(activityStore.getState().acknowledgementErrors.first).toBeUndefined();
    expect(activityStore.getState().pendingAcknowledgements).toEqual({});
  });

  /**
   * The rollback is identical; the explanation is not. A row in a chunk that
   * threw was never answered for, so telling the user it "changed on the
   * machine that owns it" points them at a refresh that changes nothing.
   */
  it("explains an unreached row as a failed request, not as a stale one", async () => {
    installAcknowledge(async () => ({
      acknowledged: ["first"],
      stale: ["second"],
      unreached: ["third"],
      unreachedReason: "Failed to fetch",
    }));
    activityStore.setState({
      itemsById: {
        first: item("first", "needs_you"),
        second: item("second", "needs_you"),
        third: item("third", "needs_you"),
      },
    });

    const outcome = await acknowledgeActivityItems(
      ["first", "second", "third"],
      "dismiss",
    );

    expect(outcome).toEqual({
      acknowledged: ["first"],
      stale: ["second"],
      unreached: ["third"],
      unreachedReason: "Failed to fetch",
    });
    // Both failures roll back; only the row that landed stays cleared.
    expect(activityStore.getState().itemsById.first?.dismissedAt).not.toBeNull();
    expect(activityStore.getState().itemsById.second?.dismissedAt).toBeNull();
    expect(activityStore.getState().itemsById.third?.dismissedAt).toBeNull();
    // And each rolled-back row carries its OWN reason.
    expect(activityStore.getState().acknowledgementErrors.second).toContain(
      "changed on the machine that owns it",
    );
    expect(activityStore.getState().acknowledgementErrors.third).toContain(
      "couldn’t reach Activity",
    );
    expect(activityStore.getState().acknowledgementErrors.third)
      .not.toContain("changed on the machine that owns it");
    expect(activityStore.getState().pendingAcknowledgements).toEqual({});
  });

  /**
   * `unreached` is additive and optional: the machine paths never populate it,
   * and neither does any producer built before it existed.
   */
  it("treats an outcome with no unreached list as nothing unreached", async () => {
    installAcknowledge(async ({ itemIds }) => ({
      acknowledged: itemIds,
      stale: [],
    }));
    activityStore.setState({ itemsById: { only: item("only", "needs_you") } });

    const outcome = await acknowledgeActivityItems(["only"], "dismiss");

    expect(outcome).toEqual({ acknowledged: ["only"], stale: [], unreached: [] });
    expect(activityStore.getState().itemsById.only?.dismissedAt).not.toBeNull();
    expect(activityStore.getState().acknowledgementErrors).toEqual({});
  });

  it("surfaces a stale single item as a rejection its one caller can see", async () => {
    installAcknowledge(async () => ({ acknowledged: [], stale: ["needs"] }));
    activityStore.setState({ itemsById: { needs: item("needs", "needs_you") } });

    await expect(acknowledgeActivityItem("needs", "dismiss")).rejects.toThrow(
      /changed on the machine that owns it/,
    );
    expect(activityStore.getState().itemsById.needs?.dismissedAt).toBeNull();
  });

  it("rolls the whole batch back when the call itself fails", async () => {
    installAcknowledge(async () => {
      throw new Error("Relay unreachable");
    });
    activityStore.setState({
      itemsById: {
        first: item("first", "needs_you"),
        second: item("second", "needs_you"),
      },
    });

    await expect(acknowledgeActivityItems(["first", "second"], "dismiss"))
      .rejects.toThrow("Relay unreachable");
    expect(activityStore.getState().itemsById.first?.dismissedAt).toBeNull();
    expect(activityStore.getState().itemsById.second?.dismissedAt).toBeNull();
    expect(activityStore.getState().acknowledgementErrors.first).toBe("Relay unreachable");
    expect(activityStore.getState().acknowledgementErrors.second).toBe("Relay unreachable");
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
