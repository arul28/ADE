import { describe, expect, it, vi } from "vitest";
import type {
  AttentionItem,
  AttentionSnapshot,
} from "../../../../desktop/src/shared/types/attention";
import type { AdeCodeConnection } from "../types";
import {
  ACTIVITY_PANE_GROUP_BY_STATE_GROUP,
  acknowledgeActivityItem,
  activityItemContext,
  activityItemDeepLink,
  activityItemElapsed,
  activityPaneEntries,
  buildActivityPaneModel,
  groupForItem,
  loadActivitySnapshot,
} from "../activityPane";
import stateGroupCases from "../../../../desktop/src/shared/attention/activityStateGroup.cases.json";

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

/**
 * The state-group rule is implemented on five surfaces that cannot share code
 * (renderer, native notch, iOS, the hermetic push-relay Worker, and this pane).
 * `activityStateGroup.cases.json` is the pin that turns a documented mirror
 * into an enforced one — every implementation runs the same cases through its
 * own mapper. The pane keeps its own headings, so it conforms via the declared
 * `ACTIVITY_PANE_GROUP_BY_STATE_GROUP` table rather than by producing the
 * canonical names; drift in WHICH band a phase belongs to still fails here.
 */
describe("Activity pane state-group conformance", () => {
  it("has cases to check", () => {
    expect(stateGroupCases.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of stateGroupCases.cases) {
    it(`files "${testCase.name}" with the canonical ${testCase.expected} band`, () => {
      const subject = item({
        phase: testCase.phase as AttentionItem["phase"],
        activityTier: testCase.tier as AttentionItem["activityTier"],
        ...(testCase.chatActivityMode
          ? { chatActivityMode: testCase.chatActivityMode as "planning" }
          : {}),
        // Unseen, so a `done`-band row lands in DONE, UNREVIEWED rather than
        // the tail — the split this pane adds on top of the canonical band.
        seenAt: null,
      });
      const expected = ACTIVITY_PANE_GROUP_BY_STATE_GROUP[
        testCase.expected as keyof typeof ACTIVITY_PANE_GROUP_BY_STATE_GROUP
      ];
      const actual = groupForItem(subject);
      // The canonical `done` band splits: idle-tier history is the ambient tail.
      const resolved = expected === "done" && testCase.tier === "idle" ? "recent" : expected;
      expect(actual).toBe(resolved);
    });
  }
});

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

  // Activity is an AGENT feed on every surface. A lane with an open PR used to
  // render twice — once as the agent working it, once as the PR — and a PR in
  // `checks_failing` borrowed the agent FAILING heading. Non-agent rows keep
  // flowing, but as the notification tail `activityFeedOrder` defines.
  it("keeps pull requests out of the agent bands and files them as notifications", () => {
    const model = buildActivityPaneModel(snapshot([
      item({ id: "agent-failed", phase: "failed", eventKind: "agent_failed" }),
      item({
        id: "pr-checks",
        kind: "pull_request",
        eventKind: "pr_checks_failing",
        phase: "checks_failing",
      }),
      item({
        id: "pr-open",
        kind: "pull_request",
        eventKind: "pr_opened",
        phase: "open",
        activityTier: "ambient",
      }),
    ]));

    expect(model.groups.map((group) => group.label))
      .toEqual(["FAILING OR BLOCKED", "NOTIFICATIONS"]);
    expect(model.groups.find((group) => group.id === "failing")?.items
      .map((entry) => entry.id)).toEqual(["agent-failed"]);
    // An open PR nobody is waiting on is not a notification either.
    expect(model.groups.find((group) => group.id === "notifications")?.items
      .map((entry) => entry.id)).toEqual(["pr-checks"]);
    // Agent bands are what the pane counts as waiting; notifications are not.
    expect(model.waitingCount).toBe(1);
  });

  it("drops expired rows the way every other Activity surface does", () => {
    const now = Date.parse("2026-07-29T02:00:00.000Z");
    const model = buildActivityPaneModel(
      snapshot([
        item({ id: "live", phase: "needs_you", eventKind: "agent_needs_you" }),
        item({
          id: "expired",
          phase: "needs_you",
          eventKind: "agent_needs_you",
          expiresAt: "2026-07-29T01:00:00.000Z",
        }),
      ]),
      now,
    );

    expect(model.items.map((entry) => entry.id)).toEqual(["live"]);
  });

  it("files idle-tier roster history as recent instead of counting it as waiting", () => {
    const model = buildActivityPaneModel(snapshot([
      item({ id: "needs", phase: "needs_you", eventKind: "agent_needs_you" }),
      item({
        id: "ended",
        phase: "completed",
        eventKind: "agent_completed",
        activityTier: "idle",
      }),
      item({ id: "idle", phase: "stale", activityTier: "idle" }),
    ]));

    expect(model.groups.map((group) => group.label)).toEqual(["NEEDS YOU", "RECENT"]);
    expect(model.groups.find((group) => group.label === "RECENT")?.items
      .map((entry) => entry.id)).toEqual(["idle", "ended"]);
    expect(model.waitingCount).toBe(1);
  });

  it("reports how long a row has held its phase, preferring the publisher's anchor", () => {
    const now = Date.parse("2026-07-29T02:00:00.000Z");
    expect(activityItemElapsed(
      item({ statusSince: "2026-07-29T00:00:00.000Z", updatedAt: "2026-07-29T01:59:00.000Z" }),
      now,
    )).toBe("2h ago");
    expect(activityItemElapsed(item({ updatedAt: "2026-07-29T01:30:00.000Z" }), now))
      .toBe("30m ago");
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
      throw new Error("Unknown Activity action: getMachineSnapshot");
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
