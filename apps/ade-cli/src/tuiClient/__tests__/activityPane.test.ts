import { describe, expect, it, vi } from "vitest";
import type {
  AttentionItem,
  AttentionSnapshot,
} from "../../../../desktop/src/shared/types/attention";
import type { AdeCodeConnection } from "../types";
import {
  acknowledgeActivityItem,
  activityItemContext,
  activityItemDeepLink,
  activityPaneEntries,
  buildActivityPaneModel,
  loadActivitySnapshot,
} from "../activityPane";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    contractVersion: 1,
    id: "item-1",
    revision: 1,
    fingerprint: "fp-1",
    kind: "agent",
    eventKind: "agent_running",
    phase: "running",
    machine: {
      machineKey: "machine-1",
      name: "Studio",
      online: true,
      lastSeenAt: "2026-07-29T00:00:00.000Z",
    },
    project: {
      projectId: "project-1",
      name: "ADE",
      rootPath: "/workspace/ADE",
    },
    laneId: "lane-1",
    laneName: "attention",
    title: "Codex is working",
    preview: "Implementing account Activity",
    privacyPreview: "Agent is working",
    destination: {
      kind: "session",
      sessionId: "session-1",
      itemId: "message-1",
    },
    actions: [],
    occurredAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    seenAt: null,
    dismissedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function snapshot(items: AttentionItem[]): AttentionSnapshot {
  return {
    contractVersion: 1,
    scope: "account",
    availability: {
      state: "ready",
      title: "Account Activity",
      message: "Live across your ADE account.",
      recovery: null,
    },
    streamId: "account-1",
    revision: 7,
    generatedAt: "2026-07-29T00:00:00.000Z",
    items,
    tombstones: [],
  };
}

function connection(
  request: AdeCodeConnection["request"],
  action: AdeCodeConnection["action"] = vi.fn(async () => {
    throw new Error("unexpected action fallback");
  }),
): AdeCodeConnection {
  return {
    mode: "attached",
    projectRoot: "/workspace/ADE",
    workspaceRoot: "/workspace/ADE",
    socketPath: "/tmp/ade.sock",
    request,
    action,
    actionList: vi.fn(),
    tool: vi.fn(),
    onChatEvent: vi.fn(() => () => {}),
    subscribeRuntimeEvents: vi.fn(),
    close: vi.fn(),
  };
}

function asRequest(
  implementation: (method: string, params?: unknown) => Promise<unknown>,
): AdeCodeConnection["request"] {
  return async <T>(method: string, params?: unknown): Promise<T> =>
    await implementation(method, params) as T;
}

describe("account-wide Activity pane", () => {
  it("groups waiting, failure, unreviewed, and live work without counting live as waiting", () => {
    const model = buildActivityPaneModel(snapshot([
      item({ id: "needs", phase: "needs_you", eventKind: "agent_needs_you" }),
      item({ id: "failed", phase: "failed", eventKind: "agent_failed" }),
      item({ id: "done", phase: "completed", eventKind: "agent_completed" }),
      item({ id: "live", phase: "running" }),
      item({ id: "dismissed", phase: "needs_you", dismissedAt: "2026-07-29T01:00:00.000Z" }),
    ]));

    expect(model.groups.map((group) => group.label)).toEqual([
      "NEEDS YOU",
      "FAILING OR BLOCKED",
      "DONE, UNREVIEWED",
      "LIVE NOW",
    ]);
    expect(model.waitingCount).toBe(3);
    expect(model.liveCount).toBe(1);
    expect(model.items.map((entry) => entry.id)).not.toContain("dismissed");
  });

  it("reads Activity through the project-independent machine RPC", async () => {
    const accountSnapshot = snapshot([item()]);
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "account.call") return { result: { signedIn: true } };
      expect(method).toBe("attention.call");
      expect(params).toEqual({ action: "getSnapshot", args: { since: 0 } });
      return accountSnapshot;
    });

    await expect(loadActivitySnapshot(connection(asRequest(request)))).resolves.toMatchObject({
      scope: "account",
      streamId: "account-1",
    });
    expect(request).not.toHaveBeenCalledWith(
      "attention.call",
      expect.objectContaining({ projectId: expect.anything() }),
    );
  });

  it("uses a truthful connected-machine fallback while signed out", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "account.call") return { result: { signedIn: false } };
      expect(params).toEqual({ action: "getMachineSnapshot", args: {} });
      return { ...snapshot([item()]), scope: "machine" };
    });

    const result = await loadActivitySnapshot(connection(asRequest(request)));
    expect(result).toMatchObject({
      scope: "machine",
      availability: {
        state: "signed_out",
        recovery: "sign_in",
      },
    });
    expect(result.availability?.message).toContain("Local work remains available");
  });

  it("acknowledges machine fallback items through the machine-scoped contract", async () => {
    const request = vi.fn(async () => null);
    await acknowledgeActivityItem(
      connection(asRequest(request)),
      { id: "machine-item", revision: 7 },
      "machine",
      "account-a",
    );

    expect(request).toHaveBeenCalledWith("attention.call", {
      action: "acknowledge",
      args: {
        itemIds: ["machine-item"],
        sourceRevisions: { "machine-item": 7 },
        expectedAccountOwnerId: "account-a",
        seenAt: expect.any(String),
        scope: "machine",
      },
    });
  });

  it("names an old signed-out host instead of fabricating an empty machine fallback", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "account.call") return { result: { signedIn: false } };
      throw new Error("Unsupported Activity method: attention.call");
    });

    await expect(loadActivitySnapshot(
      connection(asRequest(request)),
      { hostName: "Mac Studio" },
    )).resolves.toMatchObject({
      scope: "machine",
      availability: {
        state: "incompatible",
        title: "Update Mac Studio",
        recovery: "update_host",
      },
      items: [],
    });
  });

  it("names the incompatible remote host and preserves machine-local work", async () => {
    const machine = { ...snapshot([item()]), scope: "machine" as const };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "account.call") return { result: { signedIn: true } };
      if ((params as { action?: string })?.action === "getSnapshot") {
        throw new Error("Unsupported Activity method: attention.call");
      }
      if ((params as { action?: string })?.action === "getMachineSnapshot") {
        return machine;
      }
      throw new Error(`unexpected ${method}`);
    });
    const result = await loadActivitySnapshot(connection(asRequest(request)), {
      hostName: "Mac Studio",
    });
    expect(result).toMatchObject({
      scope: "machine",
      availability: {
        state: "incompatible",
        title: "Update Mac Studio",
        recovery: "update_host",
        hostName: "Mac Studio",
      },
    });
  });

  it("never falls back through the selected-project action namespace", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "account.call") return { result: { signedIn: true } };
      throw new Error("Account Activity snapshot failed: unauthorized");
    });
    const selectedProjectActionCalls = vi.fn();
    const selectedProjectAction: AdeCodeConnection["action"] = async <T>(
      domain: string,
      action: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      selectedProjectActionCalls(domain, action, args);
      throw new Error("selected-project action must not run");
    };
    const result = await loadActivitySnapshot(
      connection(asRequest(request), selectedProjectAction),
    );

    expect(result).toMatchObject({
      scope: "machine",
      availability: { state: "unavailable", recovery: "retry" },
      items: [],
    });
    expect(selectedProjectActionCalls).not.toHaveBeenCalled();
  });

  it("routes to the canonical exact destination and labels offline ownership", () => {
    const target = item({
      machine: {
        machineKey: "machine-2",
        accountMachineKey: "account-machine-2",
        name: "MacBook Pro",
        online: false,
        lastSeenAt: "2026-07-28T20:00:00.000Z",
      },
    });
    expect(activityItemDeepLink(target)).toBe(
      "ade://session/session-1?item=message-1&accountMachineKey=account-machine-2&projectId=project-1",
    );
    expect(activityItemContext(target)).toBe("ADE · attention · MacBook Pro");
  });

  it("keeps the keyboard selection visible in a bounded pane window", () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      item({ id: `item-${index}`, phase: index < 10 ? "needs_you" : "running" }));
    const model = buildActivityPaneModel(snapshot(items));
    const window = activityPaneEntries(model, 18, 8);
    expect(window.entries.some((entry) => entry.kind === "item" && entry.itemIndex === 18)).toBe(true);
    expect(window.hiddenBefore).toBeGreaterThan(0);
  });
});
