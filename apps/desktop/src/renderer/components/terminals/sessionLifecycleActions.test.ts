/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationRuleDraft, OpenProjectBinding } from "../../../shared/types";
import {
  deleteAutomationRules,
  listAutomationRules,
  saveAutoHandoffRules,
  settleSessions,
  snoozeSessionsForDuration,
} from "./sessionLifecycleActions";

const { toasts } = vi.hoisted(() => ({ toasts: [] as Array<Record<string, unknown>> }));
vi.mock("../app/toast/toastStore", () => ({
  showToast: (toast: Record<string, unknown>) => { toasts.push(toast); },
}));

function draft(id: string): AutomationRuleDraft {
  return { id, name: id, enabled: true, actions: [] } as unknown as AutomationRuleDraft;
}

/** Every automations call in order, so the write/delete sequence is assertable. */
let calls: string[];
let saveDraft: ReturnType<typeof vi.fn>;
let deleteRule: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls = [];
  toasts.length = 0;
  saveDraft = vi.fn(async ({ draft: written }: { draft: AutomationRuleDraft }) => {
    calls.push(`save:${written.id}`);
    return { rule: {}, rules: [] };
  });
  deleteRule = vi.fn(async ({ id }: { id: string }) => {
    calls.push(`delete:${id}`);
    return [];
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: { automations: { saveDraft, deleteRule } },
  });
});

afterEach(() => {
  delete (window as unknown as { ade?: unknown }).ade;
  vi.restoreAllMocks();
});

describe("saveAutoHandoffRules", () => {
  it("writes the new rules before it deletes the ones the user turned off", async () => {
    const saved = await saveAutoHandoffRules({
      drafts: [draft("rule-limit"), draft("rule-failure")],
      staleRuleIds: ["rule-ended"],
      sessionId: "chat-42",
    });

    expect(saved).toBe(true);
    // `saveDraft` upserts by id, so writing first can only ever leave the old
    // rule beside the new one — never a window with neither.
    expect(calls).toEqual(["save:rule-limit", "save:rule-failure", "delete:rule-ended"]);
    expect(toasts[0]).toMatchObject({ title: "Auto handoff saved" });
  });

  it("keeps the old rules when a later draft throws", async () => {
    saveDraft.mockImplementationOnce(async ({ draft: written }: { draft: AutomationRuleDraft }) => {
      calls.push(`save:${written.id}`);
      return { rule: {}, rules: [] };
    }).mockImplementationOnce(async () => {
      throw new Error("config write failed");
    });

    const saved = await saveAutoHandoffRules({
      drafts: [draft("rule-limit"), draft("rule-failure")],
      staleRuleIds: ["rule-ended"],
      sessionId: "chat-42",
    });

    expect(saved).toBe(false);
    // The user keeps what they had rather than losing the old rules to a
    // half-written new set.
    expect(deleteRule).not.toHaveBeenCalled();
    expect(toasts[0]).toMatchObject({ title: "Auto handoff failed", tone: "error" });
  });

  it("reports a failed delete instead of claiming the save succeeded", async () => {
    deleteRule.mockRejectedValueOnce(new Error("project config is untrusted"));

    const saved = await saveAutoHandoffRules({
      drafts: [draft("rule-limit")],
      staleRuleIds: ["rule-ended"],
      sessionId: "chat-42",
    });

    // The rule the user turned off is still armed; saying "saved" would be a lie.
    expect(saved).toBe(false);
    expect(toasts.some((toast) => toast.title === "Auto handoff saved")).toBe(false);
    expect(toasts[0]).toMatchObject({ title: "Auto handoff failed", tone: "error" });
  });

  it("treats an already-retired rule as removed", async () => {
    // A one-shot rule deletes itself when it runs, so "not found" is the
    // success case for the condition the user just turned off.
    deleteRule.mockRejectedValueOnce(new Error("Automation rule not found: rule-ended"));

    const saved = await saveAutoHandoffRules({
      drafts: [draft("rule-limit")],
      staleRuleIds: ["rule-ended"],
      sessionId: "chat-42",
    });

    expect(saved).toBe(true);
    expect(toasts[0]).toMatchObject({ title: "Auto handoff saved" });
  });
});

describe("automations machine pinning", () => {
  const binding = {
    kind: "remote",
    targetId: "studio",
    projectId: "proj-1",
    rootPath: "/srv/app",
  } as unknown as OpenProjectBinding;

  it("forwards the chat's pin to list, saveDraft, and deleteRule", async () => {
    const list = vi.fn().mockResolvedValue([]);
    (window.ade.automations as { list?: unknown }).list = list;
    saveDraft.mockClear();
    deleteRule.mockClear();

    await listAutomationRules(binding);
    await saveAutoHandoffRules({
      drafts: [draft("rule-limit")],
      staleRuleIds: ["rule-ended"],
      sessionId: "chat-42",
      pin: binding,
    });
    await deleteAutomationRules(["rule-x"], binding);

    // A remote chat's rules belong to that machine, not this tab's project.
    expect(list).toHaveBeenCalledWith(binding);
    expect(saveDraft.mock.calls[0]![1]).toBe(binding);
    expect(deleteRule.mock.calls.every((call) => call[1] === binding)).toBe(true);
  });

  it("returns null from a failed list so callers can tell it from an empty list", async () => {
    (window.ade.automations as { list?: unknown }).list = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(listAutomationRules(binding)).resolves.toBeNull();
  });

  it("returns null when the automations surface is unavailable", async () => {
    delete (window.ade.automations as { list?: unknown }).list;
    await expect(listAutomationRules()).resolves.toBeNull();
  });
});

describe("bulk lifecycle writes", () => {
  const studio = { kind: "remote", key: "studio", targetId: "studio", projectId: "proj-1" } as unknown as OpenProjectBinding;
  type Action = { label: string; onClick: () => void };
  const undoOf = (toast: Record<string, unknown> | undefined) =>
    (toast?.actions as Action[] | undefined)?.find((action) => action.label === "Undo");

  let sessionsApi: Record<string, ReturnType<typeof vi.fn>>;
  beforeEach(() => {
    sessionsApi = {
      settle: vi.fn(async (id: string) => {
        if (id === "remote-broken") throw new Error("machine offline");
      }),
      unsettle: vi.fn(async () => undefined),
      snoozeSession: vi.fn(async () => undefined),
      wakeSession: vi.fn(async () => undefined),
    };
    (window.ade as unknown as { sessions: unknown }).sessions = sessionsApi;
  });

  it("settles each row on its own machine, reports a partial failure once, and undoes only what settled", async () => {
    await settleSessions([
      { session: { id: "local-a" } },
      { session: { id: "local-b" } },
      { session: { id: "remote-broken" }, pin: studio },
    ]);

    // Each row reaches its owning machine, and none asks to dismiss pending
    // input: bulk settle only ever files at-rest rows away.
    expect(sessionsApi.settle.mock.calls).toEqual([["local-a"], ["local-b"], ["remote-broken", undefined, studio]]);
    const failures = toasts.filter((toast) => toast.tone === "error");
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.title)).toContain("1 of 3");
    const done = toasts.find((toast) => toast.tone !== "error");
    expect(done?.title).toBe("Settled 2 sessions");

    undoOf(done)!.onClick();
    await vi.waitFor(() => expect(sessionsApi.unsettle).toHaveBeenCalledTimes(2));
    expect(sessionsApi.unsettle.mock.calls.map((call) => call[0])).toEqual(["local-a", "local-b"]);
  });

  it("keeps a separate Undo for each batch snoozed to the same deadline", async () => {
    const now = Date.parse("2026-10-02T10:00:00Z");
    await snoozeSessionsForDuration([{ session: { id: "a1" } }, { session: { id: "a2" } }], "hour", now);
    await snoozeSessionsForDuration([{ session: { id: "b1" }, pin: studio }, { session: { id: "b2" } }], "hour", now);

    expect(toasts).toHaveLength(2);
    // A shared id would let the second toast replace the first and strand
    // batch A's Undo.
    expect(toasts[0]!.id).not.toBe(toasts[1]!.id);

    undoOf(toasts[0])!.onClick();
    await vi.waitFor(() => expect(sessionsApi.wakeSession).toHaveBeenCalledTimes(2));
    expect(sessionsApi.wakeSession.mock.calls.map((call) => call[0])).toEqual(["a1", "a2"]);

    undoOf(toasts[1])!.onClick();
    await vi.waitFor(() => expect(sessionsApi.wakeSession).toHaveBeenCalledTimes(4));
    expect(sessionsApi.wakeSession.mock.calls[2]).toEqual(["b1", "manual", studio]);
  });
});
