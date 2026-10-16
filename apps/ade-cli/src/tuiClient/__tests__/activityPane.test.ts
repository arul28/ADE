import { describe, expect, it, vi } from "vitest";
import type {
  AttentionItem,
  AttentionSnapshot,
} from "../../../../desktop/src/shared/types/attention";
import type { AdeCodeConnection } from "../types";
import {
  accountSessionLabel,
  accountSessionStateFromResult,
  acknowledgeActivityItem,
  activityItemContext,
  activityItemDeepLink,
  activityItemElapsed,
  activityItemMark,
  activityPaneChipForKey,
  activityPaneChips,
  activityPaneEntries,
  buildActivityPaneModel,
  loadActivitySnapshot,
  reconnectOutcomeNotice,
} from "../activityPane";
import { PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE } from "../../services/account/accountMachinePublisherService";

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
  it("groups agents by the four board columns and folds Done under All", () => {
    const model = buildActivityPaneModel(snapshot([
      item({ id: "needs", phase: "needs_you", eventKind: "agent_needs_you" }),
      item({ id: "failed", phase: "failed", eventKind: "agent_failed" }),
      item({ id: "done", phase: "completed", eventKind: "agent_completed" }),
      item({ id: "live", phase: "running" }),
      item({ id: "ci", phase: "running", boardColumn: "waiting", waitingReason: "ci" }),
      item({ id: "dismissed", phase: "needs_you", dismissedAt: "2026-07-29T01:00:00.000Z" }),
    ]));

    expect(model.groups.map((group) => group.label)).toEqual(["NEEDS YOU", "WORKING", "WAITING"]);
    expect(model.counts).toEqual({ needs_you: 2, working: 1, waiting: 1, done: 1 });
    expect(model.foldedDoneCount).toBe(1);
    expect(model.items.map((entry) => entry.id)).not.toContain("dismissed");
    expect(model.items.map((entry) => entry.id)).not.toContain("done");
    // Done is one line in the list, not rows, until its chip is chosen.
    expect(activityPaneEntries(model, 0).entries.some((entry) => entry.kind === "fold")).toBe(true);

    const doneOnly = buildActivityPaneModel(model.snapshot, { column: "done" });
    expect(doneOnly.groups.map((group) => group.label)).toEqual(["DONE"]);
    expect(doneOnly.items.map((entry) => entry.id)).toEqual(["done"]);
    expect(doneOnly.foldedDoneCount).toBe(0);
    // The chip keeps every column's count, so the way back stays visible.
    expect(doneOnly.counts).toEqual(model.counts);
  });

  it.each([
    ["0", null],
    ["1", "needs_you"],
    ["2", "working"],
    ["3", "waiting"],
    ["4", "done"],
    ["5", undefined],
    ["x", undefined],
  ] as const)("maps chip key %s to %s", (key, column) => {
    expect(activityPaneChipForKey(key)).toBe(column);
  });

  it("labels the chips with counts and lights the one in force", () => {
    const model = buildActivityPaneModel(snapshot([
      item({ id: "needs", phase: "needs_you", eventKind: "agent_needs_you" }),
      item({ id: "live", phase: "running" }),
    ]), { column: "working" });
    expect(activityPaneChips(model).map(({ label, count, selected }) => [label, count, selected])).toEqual([
      ["All", 2, false],
      ["Needs you", 1, false],
      ["Working", 1, true],
      ["Waiting", 0, false],
      ["Done", 0, false],
    ]);
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
      .toEqual(["NEEDS YOU", "NOTIFICATIONS"]);
    expect(model.groups.find((group) => group.id === "needs_you")?.items
      .map((entry) => entry.id)).toEqual(["agent-failed"]);
    // An open PR nobody is waiting on is not a notification either.
    expect(model.groups.find((group) => group.id === "notifications")?.items
      .map((entry) => entry.id)).toEqual(["pr-checks"]);
    // Columns count agents only; a pull request is never in one.
    expect(model.counts).toEqual({ needs_you: 1, working: 0, waiting: 0, done: 0 });
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
      { now },
    );

    expect(model.items.map((entry) => entry.id)).toEqual(["live"]);
  });

  it.each([
    ["a raised hand", { phase: "needs_you", eventKind: "agent_needs_you" }, "needs_you", "!", "attention"],
    ["a failure, with its own red cross", { phase: "failed", eventKind: "agent_failed" }, "needs_you", "×", "error"],
    ["a running turn", { phase: "running" }, "working", "●", "running"],
    ["a planning turn, folded into Working", { phase: "running", chatActivityMode: "planning" }, "working", "●", "running"],
    ["a published wait", { phase: "stale", boardColumn: "waiting", waitingReason: "snoozed" }, "waiting", "‖", "neutral"],
    ["a session gone quiet, folded into Done", { phase: "stale", activityTier: "idle" }, "done", "✓", "done"],
    ["a finished turn", { phase: "completed", eventKind: "agent_completed" }, "done", "✓", "done"],
  ] as const)("marks %s", (_name, patch, column, glyph, tone) => {
    expect(activityItemMark(item(patch as Partial<AttentionItem>))).toEqual({ column, glyph, tone });
  });

  it("leads a waiting row's context with what it waits on", () => {
    expect(activityItemContext(item({ boardColumn: "waiting", waitingReason: "ci" })))
      .toBe("CI running · ADE · attention · Studio");
    expect(activityItemContext(item())).toBe("ADE · attention · Studio");
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

  it("never offers sign-in for a session it merely could not read", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "account.call") {
        return { result: { signedIn: false, sessionState: "unreadable" } };
      }
      return { ...snapshot([item()]), scope: "machine" };
    });

    const result = await loadActivitySnapshot(connection(asRequest(request)));
    expect(result.availability).toMatchObject({
      state: "degraded",
      recovery: "retry",
    });
    expect(result.availability?.message).not.toContain("ade login");
  });

  it("names an expired sign-in instead of a plain sign-out", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "account.call") {
        return { result: { signedIn: false, sessionState: "expired" } };
      }
      return { ...snapshot([item()]), scope: "machine" };
    });

    const result = await loadActivitySnapshot(connection(asRequest(request)));
    expect(result.availability).toMatchObject({
      state: "signed_out",
      recovery: "sign_in",
    });
    expect(result.availability?.message).toContain("expired");
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

  it("separates the three reasons signedIn can be false", () => {
    expect(accountSessionStateFromResult({ signedIn: true })).toBe("active");
    expect(accountSessionStateFromResult({ signedIn: false })).toBe("signed_out");
    expect(accountSessionStateFromResult({ signedIn: false, sessionState: "expired" }))
      .toBe("expired");
    expect(accountSessionStateFromResult({ signedIn: false, sessionState: "unreadable" }))
      .toBe("unreadable");
    // Hosts older than `sessionState` only report the read state.
    expect(accountSessionStateFromResult({ signedIn: false, sessionReadState: "unreadable" }))
      .toBe("unreadable");
  });

  it("only points at ade login when signing in is the right move", () => {
    expect(accountSessionLabel("active")).toBeNull();
    expect(accountSessionLabel("signed_out")).toContain("ade login");
    expect(accountSessionLabel("expired")).toContain("ade login");
    expect(accountSessionLabel("unreadable")).not.toContain("ade login");
  });

  it("asks a signed-in person to confirm it's them, never to sign in again", () => {
    const refusal = {
      repaired: false,
      state: "http_error",
      reason: PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE,
    };
    for (const result of [{ ...refusal, reasonCode: "pairing_authentication_required" }, refusal]) {
      const notice = reconnectOutcomeNotice(result);
      expect(notice.kind).toBe("error");
      expect(notice.message).toContain("Confirm it's you in your browser");
      expect(notice.message).toContain("ade machines reconnect");
      expect(notice.message).not.toMatch(/sign in/i);
    }
    // A present code decides: a removal is not talked into a browser step.
    const revoked = reconnectOutcomeNotice({ ...refusal, reasonCode: "machine_revoked" });
    expect(revoked.message).toBe(
      `Couldn't reconnect this computer: ${PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE} It's still disconnected from your account.`,
    );
    // The same words the desktop's Reconnect button and `ade machines reconnect` use.
    expect(reconnectOutcomeNotice({ repaired: true, wasRevoked: true, pushRestored: true, state: "registered" })).toEqual({
      kind: "success",
      message: "This computer is back on your account. Activity and alerts are delivering again.",
    });
    // Back on the account but not delivering yet is unfinished, not a success.
    expect(reconnectOutcomeNotice({ repaired: true, wasRevoked: true, pushRestored: false, state: "registered" }).kind)
      .toBe("info");
  });
});
