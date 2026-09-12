/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationRuleDraft } from "../../../shared/types";
import { saveAutoHandoffRules } from "./sessionLifecycleActions";

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
