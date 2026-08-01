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
    expect(result.availability?.hostName).toBe("this Mac");
    vi.useRealTimers();
  });

  it("fences account acknowledgments with cached revisions and the loaded owner", async () => {
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
      sourceRevisions: { "attention-1": 8 },
      expectedAccountOwnerId: "owner-a",
      seenAt: "2026-07-29T12:01:00.000Z",
    });
    expect(acknowledgeAttention).toHaveBeenCalledTimes(1);
    expect(coordinator).toBeInstanceOf(AttentionAccountCoordinator);
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
    await expect(coordinator.acknowledge({
      itemIds: ["unproven-item"],
      sourceRevisions: { "unproven-item": 3 },
      expectedAccountOwnerId: "owner-a",
    })).rejects.toThrow(/exact item revision/i);
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
