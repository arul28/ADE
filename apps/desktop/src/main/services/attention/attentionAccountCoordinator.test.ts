import { describe, expect, it, vi } from "vitest";

import { PushRelayRequestError } from "../../../../../ade-cli/src/services/push/pushRelayClient";
import {
  ATTENTION_CONTRACT_VERSION,
  DEFAULT_ATTENTION_PREFERENCES,
  type AttentionSnapshot,
} from "../../../shared/types/attention";
import {
  ActivityAcknowledgmentStaleError,
  AttentionAccountCoordinator,
} from "./attentionAccountCoordinator";

function snapshot(
  overrides: Partial<AttentionSnapshot> = {},
): AttentionSnapshot {
  return {
    contractVersion: ATTENTION_CONTRACT_VERSION,
    scope: "machine",
    streamId: "machine:local",
    revision: 3,
    generatedAt: "2026-07-29T12:00:00.000Z",
    machines: [{
      machineKey: "machine-local",
      name: "This MacBook",
      online: true,
      lastSeenAt: "2026-07-29T12:00:00.000Z",
    }],
    items: [],
    tombstones: [],
    ...overrides,
  };
}

function logger() {
  return { warn: vi.fn() };
}

describe("AttentionAccountCoordinator", () => {
  it("reads the account stream without consulting the selected machine", async () => {
    const accountSnapshot = snapshot({
      scope: "account",
      streamId: "account:owner-a",
    });
    const getAttentionSnapshot = vi.fn(async () => accountSnapshot);
    const callAttention = vi.fn();
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot,
        acknowledgeAttention: vi.fn(),
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
      localRuntimeConnectionPool: { callAttention } as any,
    });

    await expect(coordinator.getSnapshot({
      since: 7.9,
      streamId: " account:owner-a ",
    })).resolves.toMatchObject({
      scope: "account",
      streamId: "account:owner-a",
      availability: {
        state: "ready",
        title: "",
        message: "",
        recovery: null,
      },
    });
    expect(getAttentionSnapshot).toHaveBeenCalledWith(7, "account:owner-a");
    expect(callAttention).not.toHaveBeenCalled();
  });

  it("marks only the responding host online in a machine fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:30:00.000Z"));
    const callAttention = vi.fn(async () => snapshot({
      streamId: "machine:machine-local",
      machines: [
        {
          machineKey: "machine-local",
          name: "This MacBook",
          online: false,
          lastSeenAt: "2026-07-29T11:00:00.000Z",
        },
        {
          machineKey: "machine-remote",
          name: "Studio Mac",
          online: true,
          lastSeenAt: "2026-07-29T10:00:00.000Z",
        },
      ],
      items: [
        {
          id: "local-item",
          revision: 1,
          machine: {
            machineKey: "machine-local",
            online: false,
            lastSeenAt: "2026-07-29T11:00:00.000Z",
          },
        } as never,
        {
          id: "remote-item",
          revision: 1,
          machine: {
            machineKey: "machine-remote",
            online: false,
            lastSeenAt: "2026-07-29T10:00:00.000Z",
          },
        } as never,
      ],
    }));
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => null,
      localRuntimeConnectionPool: { callAttention } as any,
    });

    const result = await coordinator.getSnapshot({});

    expect(result.machines?.[0]).toMatchObject({
      machineKey: "machine-local",
      online: true,
      lastSeenAt: "2026-07-29T12:30:00.000Z",
    });
    expect(result.machines?.[1]).toEqual({
      machineKey: "machine-remote",
      name: "Studio Mac",
      online: true,
      lastSeenAt: "2026-07-29T10:00:00.000Z",
    });
    expect(result.availability?.hostName).toBe("This MacBook");
    expect(result.items[0]?.machine).toMatchObject({
      machineKey: "machine-local",
      online: true,
      lastSeenAt: "2026-07-29T12:30:00.000Z",
    });
    expect(result.items[1]?.machine).toEqual({
      machineKey: "machine-remote",
      online: false,
      lastSeenAt: "2026-07-29T10:00:00.000Z",
    });
    vi.useRealTimers();
  });

  it("does not stamp an arbitrary machine when a legacy stream omits its key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:30:00.000Z"));
    const legacy = snapshot({
      streamId: "legacy-stream",
      machines: [{
        machineKey: "machine-first",
        name: "First Mac",
        online: false,
        lastSeenAt: "2026-07-29T11:00:00.000Z",
      }],
      items: [{
        id: "legacy-item",
        revision: 1,
        machine: {
          machineKey: "machine-first",
          online: false,
          lastSeenAt: "2026-07-29T11:00:00.000Z",
        },
      } as never],
    });
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => null,
      localRuntimeConnectionPool: {
        callAttention: vi.fn(async () => legacy),
      } as any,
    });

    const result = await coordinator.getSnapshot({});

    expect(result.machines).toEqual(legacy.machines);
    expect(result.items[0]?.machine).toEqual(legacy.items[0]?.machine);
    expect(result.availability?.hostName).toBe("this computer");
    vi.useRealTimers();
  });

  it("acknowledges with the revisions the renderer actually saw", async () => {
    const acknowledgeAttention = vi.fn(async () => ({
      applied: ["attention-1"],
      stale: [],
    }));
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => snapshot({
          scope: "account",
          items: [{ id: "attention-1", revision: 8 } as never],
        })),
        acknowledgeAttention,
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
    });

    await coordinator.getSnapshot({});
    await coordinator.acknowledge({
      itemIds: ["attention-1"],
      sourceRevisions: { "attention-1": 999 },
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-29T12:01:00.000Z",
    });

    expect(acknowledgeAttention).toHaveBeenCalledWith({
      itemIds: ["attention-1"],
      sourceRevisions: { "attention-1": 999 },
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-29T12:01:00.000Z",
    });
    expect(acknowledgeAttention).toHaveBeenCalledTimes(1);
    expect(coordinator).toBeInstanceOf(AttentionAccountCoordinator);
  });

  it("quotes only the alert fences the caller supplied, in one bulk call", async () => {
    // The narrow fence that replaces the retired `source_revision <= ?`
    // predicate: without it an in-flight "Clear all" can land AFTER a publish
    // flipped an item to needs_you, marking a brand-new alert seen+dismissed
    // before the user ever saw it. Caller-supplied only — a fingerprint this
    // process cached from another surface's poll is not what was on screen.
    const acknowledgeAttention = vi.fn(async () => ({
      applied: ["attention-1"],
      stale: ["attention-2"],
    }));
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => snapshot({
          scope: "account",
          items: [
            { id: "attention-1", revision: 8 } as never,
            { id: "attention-2", revision: 9 } as never,
          ],
        })),
        acknowledgeAttention,
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
    });

    await coordinator.getSnapshot({});
    const outcome = await coordinator.acknowledge({
      itemIds: ["attention-1", "attention-2"],
      alertFingerprints: {
        "attention-1": "  alert-v1  ",
        // Junk and out-of-batch entries are dropped, leaving those items
        // unfenced rather than failing the whole batch.
        "attention-2": "   ",
        "not-in-batch": "alert-v9",
      },
      expectedAccountOwnerId: "owner-a",
      dismissedAt: "2026-07-29T12:01:00.000Z",
    });

    expect(acknowledgeAttention).toHaveBeenCalledTimes(1);
    expect(acknowledgeAttention).toHaveBeenCalledWith({
      itemIds: ["attention-1", "attention-2"],
      alertFingerprints: { "attention-1": "alert-v1" },
      sourceRevisions: { "attention-1": 8, "attention-2": 9 },
      expectedAccountOwnerId: "owner-a",
      dismissedAt: "2026-07-29T12:01:00.000Z",
    });
    // Per-item outcomes survive the fence.
    expect(outcome).toEqual({ acknowledged: ["attention-1"], stale: ["attention-2"] });
  });

  it("chunks a batch past the relay's 64-id ceiling instead of truncating it", async () => {
    // The relay answers 400 for `itemIds.length > 64` before it parses anything
    // else. Truncating to 64 reported `acknowledged` for ids that never left
    // this process, so a large "Clear all" cleared optimistically and the
    // remainder came back on the next poll.
    const itemIds = Array.from({ length: 70 }, (_, index) => `attention-${index}`);
    const acknowledgeAttention = vi.fn(async (ack: {
      itemIds: string[];
      alertFingerprints?: Record<string, string>;
      sourceRevisions?: Record<string, number>;
    }) => ({
      applied: ack.itemIds,
      stale: [] as string[],
    }));
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => snapshot({
          scope: "account",
          items: itemIds.map((id, index) => ({ id, revision: index } as never)),
        })),
        acknowledgeAttention,
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
    });

    await coordinator.getSnapshot({});
    const outcome = await coordinator.acknowledge({
      itemIds,
      alertFingerprints: Object.fromEntries(itemIds.map((id) => [id, `alert-${id}`])),
      expectedAccountOwnerId: "owner-a",
      dismissedAt: "2026-07-29T12:01:00.000Z",
    });

    expect(acknowledgeAttention).toHaveBeenCalledTimes(2);
    const [first, second] = acknowledgeAttention.mock.calls.map((call) => call[0]);
    expect(first?.itemIds).toHaveLength(64);
    expect(second?.itemIds).toHaveLength(6);
    // Every id is acknowledged exactly once, in order, across the chunks.
    expect([...first!.itemIds, ...second!.itemIds]).toEqual(itemIds);
    // Per-item maps are rebuilt per chunk: a fence naming an id outside the
    // batch is a 400 for that whole call.
    for (const call of [first!, second!]) {
      expect(Object.keys(call.alertFingerprints ?? {})).toEqual(call.itemIds);
      expect(Object.keys(call.sourceRevisions ?? {})).toEqual(call.itemIds);
    }
    expect(outcome).toEqual({ acknowledged: itemIds, stale: [] });
  });

  it("merges per-item staleness across chunks and keeps a batch that fits to one call", async () => {
    const itemIds = Array.from({ length: 65 }, (_, index) => `attention-${index}`);
    const acknowledgeAttention = vi.fn(async (ack: { itemIds: string[] }) => ({
      applied: ack.itemIds.filter((id) => id !== "attention-64"),
      // The one item in the SECOND chunk is refused by its alert fence.
      stale: ack.itemIds.filter((id) => id === "attention-64"),
    }));
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => snapshot({
          scope: "account",
          items: itemIds.map((id, index) => ({ id, revision: index } as never)),
        })),
        acknowledgeAttention,
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
    });

    await coordinator.getSnapshot({});
    expect(await coordinator.acknowledge({
      itemIds,
      expectedAccountOwnerId: "owner-a",
    })).toEqual({
      acknowledged: itemIds.filter((id) => id !== "attention-64"),
      stale: ["attention-64"],
    });
    expect(acknowledgeAttention).toHaveBeenCalledTimes(2);

    // A batch that fits stays exactly one call — chunking is a ceiling, not a
    // new default of splitting work up.
    acknowledgeAttention.mockClear();
    await coordinator.acknowledge({
      itemIds: itemIds.slice(0, 64),
      expectedAccountOwnerId: "owner-a",
    });
    expect(acknowledgeAttention).toHaveBeenCalledTimes(1);
  });

  it("clears every item of a 200-row Clear all", async () => {
    const itemIds = Array.from({ length: 200 }, (_, index) => `attention-${index}`);
    const acknowledgeAttention = vi.fn(async (ack: { itemIds: string[] }) => ({
      applied: ack.itemIds,
      stale: [] as string[],
    }));
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => snapshot({
          scope: "account",
          items: itemIds.map((id, index) => ({ id, revision: index } as never)),
        })),
        acknowledgeAttention,
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
    });

    await coordinator.getSnapshot({});
    expect(await coordinator.acknowledge({
      itemIds,
      expectedAccountOwnerId: "owner-a",
    })).toEqual({ acknowledged: itemIds, stale: [] });
    // 64 + 64 + 64 + 8, and every id sent exactly once.
    expect(acknowledgeAttention).toHaveBeenCalledTimes(4);
    expect(acknowledgeAttention.mock.calls.flatMap((call) => call[0].itemIds))
      .toEqual(itemIds);
  });

  it("aborts at a failing chunk and never rolls back the chunks that landed", async () => {
    // The policy: a throwing chunk is systemic (auth, network, relay 5xx), so
    // stop rather than push the rest at a relay that just failed. Letting the
    // error propagate would make the renderer roll back the whole batch —
    // including rows the relay genuinely committed — so the user would watch
    // cleared rows come back.
    const itemIds = Array.from({ length: 200 }, (_, index) => `attention-${index}`);
    const acknowledgeAttention = vi.fn(async (ack: { itemIds: string[] }) => {
      if (ack.itemIds.includes("attention-64")) throw new Error("relay unavailable");
      return { applied: ack.itemIds, stale: [] as string[] };
    });
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => snapshot({
          scope: "account",
          items: itemIds.map((id, index) => ({ id, revision: index } as never)),
        })),
        acknowledgeAttention,
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
    });

    await coordinator.getSnapshot({});
    const outcome = await coordinator.acknowledge({
      itemIds,
      expectedAccountOwnerId: "owner-a",
    });

    // Chunk 1 landed and is reported acknowledged; the failed chunk and every
    // unsent chunk read as UNREACHED, so the caller rolls back exactly those —
    // and says the request did not complete rather than claiming they changed.
    expect(outcome.acknowledged).toEqual(itemIds.slice(0, 64));
    expect(outcome.stale).toEqual([]);
    expect(outcome.unreached).toEqual(itemIds.slice(64));
    expect(outcome.unreachedReason).toBe("relay unavailable");
    // Aborted, not continued: chunks 3 and 4 were never attempted.
    expect(acknowledgeAttention).toHaveBeenCalledTimes(2);
  });

  /**
   * The two ways a row fails to clear are different facts, and a batch can hit
   * both at once. Reporting them in one list made the renderer tell a user that
   * 136 items "changed after they loaded" when the relay had simply stopped
   * answering — nothing changed, and refreshing showed the same list back.
   */
  it("separates rows the relay refused from rows it never answered for", async () => {
    const itemIds = Array.from({ length: 200 }, (_, index) => `attention-${index}`);
    const acknowledgeAttention = vi.fn(async (ack: { itemIds: string[] }) => {
      if (ack.itemIds.includes("attention-64")) throw new Error("relay unavailable");
      // One genuine per-item refusal, inside the chunk that DID land.
      return { applied: ack.itemIds, stale: ack.itemIds.filter((id) => id === "attention-7") };
    });
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => snapshot({
          scope: "account",
          items: itemIds.map((id, index) => ({ id, revision: index } as never)),
        })),
        acknowledgeAttention,
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
    });

    await coordinator.getSnapshot({});
    const outcome = await coordinator.acknowledge({
      itemIds,
      expectedAccountOwnerId: "owner-a",
    });

    // Refused by the relay, which answered: this one really did change.
    expect(outcome.stale).toEqual(["attention-7"]);
    // Never answered for at all: the failed chunk plus every unsent chunk.
    expect(outcome.unreached).toEqual(itemIds.slice(64));
    expect(outcome.unreachedReason).toBe("relay unavailable");
    // The three lists stay disjoint and cover the whole batch, so the caller
    // can roll back `stale` + `unreached` and keep everything else.
    expect(outcome.acknowledged).toEqual(
      itemIds.slice(0, 64).filter((id) => id !== "attention-7"),
    );
    expect([...outcome.acknowledged, ...outcome.stale, ...outcome.unreached!].sort())
      .toEqual([...itemIds].sort());
  });

  it("rethrows the original error when the very first chunk fails", async () => {
    // Nothing landed, so a whole-batch rollback IS truthful — and the user gets
    // the real reason instead of a partial result that hides it.
    const itemIds = Array.from({ length: 70 }, (_, index) => `attention-${index}`);
    const acknowledgeAttention = vi.fn(async () => {
      throw new Error("relay unavailable");
    });
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => snapshot({
          scope: "account",
          items: itemIds.map((id, index) => ({ id, revision: index } as never)),
        })),
        acknowledgeAttention,
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
    });

    await coordinator.getSnapshot({});
    await expect(coordinator.acknowledge({
      itemIds,
      expectedAccountOwnerId: "owner-a",
    })).rejects.toThrow(/relay unavailable/);
    expect(acknowledgeAttention).toHaveBeenCalledTimes(1);
  });

  it("chunks machine-scope acks and never claims success for an unsent chunk", async () => {
    const itemIds = Array.from({ length: 70 }, (_, index) => `machine-${index}`);
    const callAttention = vi.fn(async (action: string, payload?: unknown) => {
      if (action === "getMachineSnapshot") {
        return snapshot({ items: itemIds.map((id, index) => ({ id, revision: index } as never)) });
      }
      const ids = (payload as { itemIds: string[] }).itemIds;
      if (ids.includes("machine-64")) throw new Error("brain unavailable");
      return undefined;
    });
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      localRuntimeConnectionPool: { callAttention } as never,
    });

    await coordinator.getSnapshot({});
    const outcome = await coordinator.acknowledge({
      itemIds,
      sourceRevisions: Object.fromEntries(itemIds.map((id, index) => [id, index])),
      expectedAccountOwnerId: "owner-a",
    });

    // The machine path used to return every id as acknowledged unconditionally,
    // so a truncated or failed chunk was reported as done work. It answers per
    // CHUNK — apply everything or throw — so a chunk that did not land is
    // unreached, and the host never refused a single row as stale.
    expect(outcome).toEqual({
      acknowledged: itemIds.slice(0, 64),
      stale: [],
      unreached: itemIds.slice(64),
      unreachedReason: "brain unavailable",
    });
    // The host throws unless EVERY id in a payload carries a finite revision,
    // so the revision map must be sliced to the chunk, not sent whole.
    const ackPayloads = callAttention.mock.calls
      .filter(([action]) => action === "acknowledge")
      .map(([, payload]) => payload as { itemIds: string[]; sourceRevisions: object });
    expect(ackPayloads).toHaveLength(2);
    for (const payload of ackPayloads) {
      expect(Object.keys(payload.sourceRevisions)).toEqual(payload.itemIds);
    }
  });

  it("omits the alert fence entirely when the caller quoted none", async () => {
    const acknowledgeAttention = vi.fn(async (_acknowledgment: { itemIds: string[] }) => ({
      applied: ["attention-1"],
      stale: [] as string[],
    }));
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => snapshot({
          scope: "account",
          items: [{ id: "attention-1", revision: 8 } as never],
        })),
        acknowledgeAttention,
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
    });

    await coordinator.getSnapshot({});
    await coordinator.acknowledge({
      itemIds: ["attention-1"],
      expectedAccountOwnerId: "owner-a",
    });

    expect(acknowledgeAttention.mock.calls[0]?.[0])
      .not.toHaveProperty("alertFingerprints");
  });

  it("does not manufacture staleness from a newer snapshot taken by another surface", async () => {
    const acknowledgeAttention = vi.fn(async () => ({
      applied: ["attention-1", "attention-2"],
      stale: [],
    }));
    let revision = 8;
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => snapshot({
          scope: "account",
          items: [{ id: "attention-1", revision: (revision += 1) } as never],
        })),
        acknowledgeAttention,
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
    });

    // What the user is looking at.
    await coordinator.getSnapshot({});
    // Another surface polls twice while the detail sheet stays open, and a
    // delta snapshot never mentions the second item at all.
    await coordinator.getSnapshot({});
    await coordinator.getSnapshot({});

    await expect(coordinator.acknowledge({
      itemIds: ["attention-1", "attention-2"],
      sourceRevisions: { "attention-1": 9, "attention-2": 4 },
      expectedAccountOwnerId: "owner-a",
      dismissedAt: "2026-07-29T12:02:00.000Z",
    })).resolves.toEqual({
      acknowledged: ["attention-1", "attention-2"],
      stale: [],
    });
    // One bulk call, carrying the renderer's own revisions.
    expect(acknowledgeAttention).toHaveBeenCalledTimes(1);
    expect(acknowledgeAttention).toHaveBeenCalledWith({
      itemIds: ["attention-1", "attention-2"],
      sourceRevisions: { "attention-1": 9, "attention-2": 4 },
      expectedAccountOwnerId: "owner-a",
      dismissedAt: "2026-07-29T12:02:00.000Z",
    });
  });

  it("keeps the applied half of a partially stale bulk acknowledgment", async () => {
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => snapshot({
          scope: "account",
          items: [
            { id: "attention-1", revision: 8 } as never,
            { id: "attention-2", revision: 2 } as never,
          ],
        })),
        acknowledgeAttention: vi.fn(async () => ({
          applied: ["attention-1"],
          stale: ["attention-2"],
        })),
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
    });

    await coordinator.getSnapshot({});
    await expect(coordinator.acknowledge({
      itemIds: ["attention-1", "attention-2"],
      expectedAccountOwnerId: "owner-a",
    })).resolves.toEqual({
      acknowledged: ["attention-1"],
      stale: ["attention-2"],
    });
  });

  it("surfaces relay-stale account acknowledgments as a typed refresh error", async () => {
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => snapshot({
          scope: "account",
          items: [{ id: "attention-1", revision: 8 } as never],
        })),
        acknowledgeAttention: vi.fn(async () => ({
          applied: [],
          stale: ["attention-1"],
        })),
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
    });

    await coordinator.getSnapshot({});
    const error = await coordinator.acknowledge({
      itemIds: ["attention-1"],
      expectedAccountOwnerId: "owner-a",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ActivityAcknowledgmentStaleError);
    expect(error).toMatchObject({
      code: "activity_acknowledgment_stale",
      staleItemIds: ["attention-1"],
    });
    expect((error as Error).message).toMatch(/refresh Activity/i);
  });

  it("writes one machine preference scope through the account relay", async () => {
    const putActivityMachinePreferences = vi.fn(async () => undefined);
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(),
        acknowledgeAttention: vi.fn(),
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
        putActivityMachinePreferences,
      },
    });

    await coordinator.putActivityMachinePreferences(
      " machine-1 ",
      { notificationsEnabled: false },
      "owner-a",
    );

    expect(putActivityMachinePreferences).toHaveBeenCalledWith(
      "owner-a",
      "machine-1",
      { notificationsEnabled: false },
    );
    expect(putActivityMachinePreferences).toHaveBeenCalledTimes(1);
    expect(coordinator).toBeInstanceOf(AttentionAccountCoordinator);
  });

  it("sanitizes account auth failures and falls back to the local machine", async () => {
    const testLogger = logger();
    const getAttentionSnapshot = vi.fn(async () => {
      throw new PushRelayRequestError(
        "getAttentionSnapshot",
        401,
        "production relay rejected bearer token",
      );
    });
    const callAttention = vi.fn(async () => snapshot());
    const coordinator = new AttentionAccountCoordinator({
      getLogger: () => testLogger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot,
        acknowledgeAttention: vi.fn(),
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
      localRuntimeConnectionPool: { callAttention } as any,
    });

    const result = await coordinator.getSnapshot({ since: 0 });

    expect(result).toMatchObject({
      scope: "machine",
      availability: {
        state: "degraded",
        title: "Account session needs attention",
        recovery: "sign_in",
        hostName: "This MacBook",
      },
    });
    expect(result.availability?.message).toContain("Showing work from This MacBook");
    expect(result.availability?.message).not.toMatch(/relay|bearer|401/i);
    expect(callAttention).toHaveBeenCalledWith("getMachineSnapshot", {});
    expect(testLogger.warn).toHaveBeenCalledWith(
      "attention.account_snapshot_failed",
      expect.objectContaining({ fallback: "local_machine" }),
    );
  });

  it("routes proven machine-fallback mutations through machine Attention", async () => {
    const callAttention = vi.fn(async (action: string) => {
      if (action === "getPreferences") return DEFAULT_ATTENTION_PREFERENCES;
      if (action === "getMachineSnapshot") {
        return snapshot({ items: [{ id: "attention-1", revision: 3 } as never] });
      }
      return undefined;
    });
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      localRuntimeConnectionPool: { callAttention } as any,
    });

    await coordinator.getSnapshot({});
    await coordinator.acknowledge({
      itemIds: [" attention-1 ", "", 3],
      sourceRevisions: { "attention-1": 3 },
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-29T12:01:00.000Z",
    });
    await coordinator.reportPresence({
      deviceId: "desktop-1",
      platform: "macOS",
    });
    await expect(coordinator.getPreferences({
      accountOwnerId: "owner-a",
    })).resolves.toEqual(DEFAULT_ATTENTION_PREFERENCES);
    await coordinator.putPreferences({
      accountOwnerId: "owner-a",
      preferences: DEFAULT_ATTENTION_PREFERENCES,
    });

    expect(callAttention).toHaveBeenNthCalledWith(1, "getMachineSnapshot", {});
    expect(callAttention).toHaveBeenNthCalledWith(2, "acknowledge", {
      itemIds: ["attention-1"],
      sourceRevisions: { "attention-1": 3 },
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-29T12:01:00.000Z",
      scope: "machine",
    });
    expect(callAttention).toHaveBeenNthCalledWith(
      3,
      "reportPresence",
      expect.objectContaining({ deviceId: "desktop-1" }),
    );
    expect(callAttention).toHaveBeenNthCalledWith(
      4,
      "getPreferences",
      { accountOwnerId: "owner-a" },
    );
    expect(callAttention).toHaveBeenNthCalledWith(
      5,
      "putPreferences",
      {
        accountOwnerId: "owner-a",
        preferences: DEFAULT_ATTENTION_PREFERENCES,
      },
    );
  });

  it("keeps degraded signed-in acknowledgments on the proven machine fallback", async () => {
    const acknowledgeAttention = vi.fn();
    const callAttention = vi.fn(async (action: string) => {
      if (action === "getMachineSnapshot") {
        return snapshot({ items: [{ id: "machine-item", revision: 3 } as never] });
      }
      return undefined;
    });
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-a",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(async () => {
          throw new PushRelayRequestError("getAttentionSnapshot", 503, "down");
        }),
        acknowledgeAttention,
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences: vi.fn(),
      },
      localRuntimeConnectionPool: { callAttention } as any,
    });

    await expect(coordinator.getSnapshot({})).resolves.toMatchObject({
      scope: "machine",
      availability: { state: "degraded" },
    });
    await coordinator.acknowledge({
      itemIds: ["machine-item"],
      sourceRevisions: { "machine-item": 3 },
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-29T12:01:00.000Z",
    });

    expect(callAttention).toHaveBeenLastCalledWith("acknowledge", {
      itemIds: ["machine-item"],
      sourceRevisions: { "machine-item": 3 },
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-29T12:01:00.000Z",
      scope: "machine",
    });
    expect(acknowledgeAttention).not.toHaveBeenCalled();
    // An item this process never cached is still the user's to acknowledge:
    // seen/dismissed are monotonic and idempotent, so there is no lost update
    // for an exact-revision fence to protect against.
    await expect(coordinator.acknowledge({
      itemIds: ["unproven-item"],
      sourceRevisions: { "unproven-item": 3 },
      expectedAccountOwnerId: "owner-a",
    })).resolves.toEqual({ acknowledged: ["unproven-item"], stale: [] });
  });

  it("rejects stale account preference writes before either backend is called", async () => {
    const callAttention = vi.fn();
    const putAttentionPreferences = vi.fn();
    const coordinator = new AttentionAccountCoordinator({
      getLogger: logger,
      getCurrentAccountOwnerId: () => "owner-b",
      accountAttentionClient: {
        getAttentionSnapshot: vi.fn(),
        acknowledgeAttention: vi.fn(),
        reportAttentionPresence: vi.fn(),
        getAttentionPreferences: vi.fn(),
        putAttentionPreferences,
      },
      localRuntimeConnectionPool: { callAttention } as any,
    });

    await expect(coordinator.putPreferences({
      accountOwnerId: "owner-a",
      preferences: DEFAULT_ATTENTION_PREFERENCES,
    })).rejects.toThrow(/account changed/i);
    expect(putAttentionPreferences).not.toHaveBeenCalled();
    expect(callAttention).not.toHaveBeenCalled();
  });

  it("reports mixed-version incompatibility once and names the host recovery", async () => {
    const testLogger = logger();
    const callAttention = vi.fn(async () => {
      throw new Error(
        "Remote ADE service method attention.call failed (code -32601): Method not found",
      );
    });
    const coordinator = new AttentionAccountCoordinator({
      getLogger: () => testLogger,
      getCurrentAccountOwnerId: () => null,
      localRuntimeConnectionPool: { callAttention } as any,
    });

    await expect(coordinator.getSnapshot({})).rejects.toThrow(
      /newer connected ADE brain.*update and restart ADE.*host machine/i,
    );
    await expect(coordinator.getSnapshot({})).rejects.toThrow(
      /newer connected ADE brain/i,
    );
    expect(testLogger.warn).toHaveBeenCalledTimes(1);
    expect(testLogger.warn).toHaveBeenCalledWith(
      "attention.runtime_incompatible",
      expect.objectContaining({ recovery: "update_and_restart_ade_brain" }),
    );
  });
});
