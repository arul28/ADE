/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutomationRuleSummary, LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import {
  AUTO_HANDOFF_DEFAULT_RETRIES,
  AutoHandoffModal,
  autoHandoffFormIsValid,
  buildAutoHandoffDrafts,
  selectAutoHandoffRulesForSession,
} from "./AutoHandoffModal";

/**
 * The real pickers are Radix popovers over the live model catalog; this suite is
 * about the rule payload, so they are replaced with the smallest controls that
 * still carry a value in and out.
 */
vi.mock("../shared/ModelPicker/ModelPicker", () => ({
  // Deliberately NOT a <select>: one of the tests below asserts the modal
  // contains no native select at all, and a stub that shipped one would make
  // that assertion vacuous.
  ModelPicker: ({ value, onChange }: { value: string; onChange: (id: string) => void }) => (
    <input
      aria-label="Handoff model"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
const { catalogTiers } = vi.hoisted(() => ({ catalogTiers: { value: [] as string[] } }));
vi.mock("../shared/ModelPicker/modelCatalog", () => ({
  resolveModelDescriptorWithRuntimeCatalog: () => ({ reasoningTiers: catalogTiers.value }),
}));
vi.mock("../shared/ModelPicker/ReasoningEffortPicker", () => ({
  ReasoningEffortPicker: ({ reasoningEffort }: { reasoningEffort: string | null }) => (
    <span data-testid="effort">{reasoningEffort ?? "auto"}</span>
  ),
}));

const lanes: LaneSummary[] = [
  {
    id: "lane-1",
    name: "Lane 1",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "refs/heads/lane-1",
    worktreePath: "/tmp/lane-1",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-07-10T10:00:00.000Z",
  },
  {
    id: "lane-2",
    name: "Lane 2",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "refs/heads/lane-2",
    worktreePath: "/tmp/lane-2",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-07-10T10:00:00.000Z",
  },
];

vi.mock("../../state/appStore", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ lanes }),
}));

vi.mock("../../lib/modelOptions", () => ({
  deriveConfiguredModelIds: () => ["anthropic/claude-opus-5", "openai/gpt-5.6-luna"],
}));

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "chat-42",
    laneId: "lane-1",
    laneName: "Lane 1",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "claude-chat",
    title: "Ship the sync fix",
    modelId: "anthropic/claude-opus-5",
    status: "running",
    startedAt: "2026-07-10T12:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "idle",
    resumeCommand: null,
    ...overrides,
  } as TerminalSessionSummary;
}

let saveDraft: ReturnType<typeof vi.fn>;
let deleteRule: ReturnType<typeof vi.fn>;

beforeEach(() => {
  catalogTiers.value = [];
  saveDraft = vi.fn().mockResolvedValue({ rule: {}, rules: [] });
  deleteRule = vi.fn().mockResolvedValue([]);
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      ai: { getStatus: vi.fn().mockResolvedValue({ availableModelIds: [] }) },
      automations: { list: vi.fn().mockResolvedValue([]), saveDraft, deleteRule },
    },
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
  vi.restoreAllMocks();
});

function renderModal(existingRules: AutomationRuleSummary[] = []) {
  const onClose = vi.fn();
  render(
    <AutoHandoffModal session={makeSession()} existingRules={existingRules} onClose={onClose} />,
  );
  return { onClose };
}

describe("AutoHandoffModal draft payloads", () => {
  it("writes one scoped, one-shot rule per selected condition through saveDraft", () => {
    const drafts = buildAutoHandoffDrafts({
      form: {
        conditions: { limit: true, failure: true, ended: false },
        targetModelId: "openai/gpt-5.6-luna",
        reasoningEffort: "high",
        prompt: "Pick up from {{trigger.session.modelId}}.",
        mode: "fork",
        laneTarget: "same",
        targetLaneId: "",
        retries: 2,
      },
      session: { id: "chat-42", title: "Ship the sync fix" },
      scoped: true,
    });

    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      id: "auto-handoff-chat-42-limit",
      name: "Auto handoff · usage limit · Ship the sync fix",
      enabled: true,
      origin: "chat-menu",
      scope: { sessionId: "chat-42", sessionTitle: "Ship the sync fix" },
      oneShot: true,
      maxRuns: 2,
      mode: "review",
      triggers: [{ type: "session.limit_reached", sessionId: "chat-42" }],
      trigger: { type: "session.limit_reached", sessionId: "chat-42" },
      executor: { mode: "automation-bot" },
      actions: [{
        type: "handoff",
        handoffMode: "fork",
        targetModelId: "openai/gpt-5.6-luna",
        targetLaneMode: "same",
        promptTemplate: "Pick up from {{trigger.session.modelId}}.",
        reasoningEffort: "high",
      }],
    });
    // A same-lane handoff writes no targetLaneId at all; the runtime reads that
    // field only for targetLaneMode "explicit".
    expect(drafts[0]!.actions[0]).not.toHaveProperty("targetLaneId");
    expect(drafts[1]!.triggers[0]!.type).toBe("session.failed");
    expect(drafts[1]!.id).toBe("auto-handoff-chat-42-failure");
  });

  it("drops scope and oneShot for the rule-for-all variant, and keeps a distinct id", () => {
    const form = {
      conditions: { limit: true, failure: false, ended: false },
      targetModelId: "openai/gpt-5.6-luna",
      reasoningEffort: null,
      prompt: "",
      mode: "brief" as const,
      laneTarget: "explicit" as const,
      targetLaneId: "lane-2",
      retries: 1,
    };
    const scoped = buildAutoHandoffDrafts({ form, session: { id: "chat-42", title: "T" }, scoped: true });
    const all = buildAutoHandoffDrafts({ form, session: { id: "chat-42", title: "T" }, scoped: false });

    expect(all[0]!.id).toBe("auto-handoff-all-limit");
    expect(all[0]!.id).not.toBe(scoped[0]!.id);
    expect(all[0]).not.toHaveProperty("scope");
    expect(all[0]).not.toHaveProperty("oneShot");
    // Nothing narrows the trigger to one chat, which is exactly what "for all" means.
    expect(all[0]!.triggers[0]).toEqual({ type: "session.limit_reached" });
    expect(all[0]!.actions[0]).toMatchObject({
      handoffMode: "brief",
      targetLaneMode: "explicit",
      targetLaneId: "lane-2",
    });
    expect(all[0]!.actions[0]).not.toHaveProperty("promptTemplate");
  });

  it("writes the exact lane fields for each of the three lane targets", () => {
    const build = (laneTarget: "same" | "new" | "explicit", targetLaneId = "") => buildAutoHandoffDrafts({
      form: {
        conditions: { limit: true, failure: false, ended: false },
        targetModelId: "openai/gpt-5.6-luna",
        reasoningEffort: null,
        prompt: "",
        mode: laneTarget === "same" ? "fork" : "brief",
        laneTarget,
        targetLaneId,
        retries: 3,
      },
      session: { id: "chat-42", title: "Ship the sync fix" },
      scoped: true,
    })[0]!.actions[0]!;

    expect(build("same")).toEqual({
      type: "handoff",
      handoffMode: "fork",
      targetModelId: "openai/gpt-5.6-luna",
      targetLaneMode: "same",
    });
    // No laneNameTemplate on purpose: with none, the service names the lane
    // from the rule's scope.sessionTitle, which is the chat's own title.
    expect(build("new")).toEqual({
      type: "handoff",
      handoffMode: "brief",
      targetModelId: "openai/gpt-5.6-luna",
      targetLaneMode: "new",
    });
    expect(build("explicit", "lane-2")).toEqual({
      type: "handoff",
      handoffMode: "brief",
      targetModelId: "openai/gpt-5.6-luna",
      targetLaneMode: "explicit",
      targetLaneId: "lane-2",
    });
  });

  it("treats explicit with no lane as invalid, so the shape the service rejects is unreachable", () => {
    const form = {
      conditions: { limit: true, failure: false, ended: false },
      targetModelId: "openai/gpt-5.6-luna",
      reasoningEffort: null,
      prompt: "",
      mode: "brief" as const,
      laneTarget: "explicit" as const,
      targetLaneId: "   ",
      retries: 3,
    };
    expect(autoHandoffFormIsValid(form)).toBe(false);
    expect(autoHandoffFormIsValid({ ...form, targetLaneId: "lane-2" })).toBe(true);
  });

  it("maps the retry count onto maxRuns and clamps it", () => {
    const build = (retries: number) => buildAutoHandoffDrafts({
      form: {
        conditions: { limit: true, failure: false, ended: false },
        targetModelId: "m",
        reasoningEffort: null,
        prompt: "",
        mode: "fork",
        laneTarget: "same",
        targetLaneId: "",
        retries,
      },
      session: { id: "c", title: "t" },
      scoped: true,
    })[0]!;

    expect(build(3).maxRuns).toBe(3);
    expect(build(0).maxRuns).toBe(1);
    expect(build(99).maxRuns).toBe(5);
  });
});

describe("AutoHandoffModal", () => {
  it("disables Save until a condition is chosen and says why", async () => {
    renderModal();
    await screen.findByRole("dialog");

    // The dialog mounts before the model list resolves, and a form with no
    // model is invalid — so asserting an enabled Save on first paint is a race
    // that only loses on a slow runner. Wait for the default model, which is
    // the completion signal for the async load.
    await waitFor(() => {
      expect((screen.getByLabelText("Handoff model") as HTMLSelectElement).value).toBeTruthy();
    });
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    // "usage limit" is on by default; turning it off leaves nothing to fire on.
    fireEvent.click(screen.getByRole("switch", { name: "usage limit" }));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("at least one");
    expect((screen.getByRole("button", { name: /rule for all/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("defaults the model to the first configured one that is not the chat's own", async () => {
    renderModal();
    await waitFor(() => {
      expect((screen.getByLabelText("Handoff model") as HTMLSelectElement).value).toBe("openai/gpt-5.6-luna");
    });
  });

  it("saves a scoped rule and deletes the conditions the user left off", async () => {
    const { onClose } = renderModal();
    await waitFor(() => {
      expect((screen.getByLabelText("Handoff model") as HTMLSelectElement).value).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    expect(saveDraft.mock.calls[0]![0]).toEqual({
      draft: expect.objectContaining({
        id: "auto-handoff-chat-42-limit",
        origin: "chat-menu",
        oneShot: true,
        scope: { sessionId: "chat-42", sessionTitle: "Ship the sync fix" },
      }),
    });
    // The two unchecked conditions are removed rather than left armed.
    expect(deleteRule.mock.calls.map((call) => call[0].id).sort()).toEqual([
      "auto-handoff-chat-42-ended",
      "auto-handoff-chat-42-failure",
    ]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("saves an unscoped rule from the rule-for-all link", async () => {
    renderModal();
    await waitFor(() => {
      expect((screen.getByLabelText("Handoff model") as HTMLSelectElement).value).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /rule for all/ }));

    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    const draft = saveDraft.mock.calls[0]![0].draft;
    expect(draft.id).toBe("auto-handoff-all-limit");
    expect(draft.scope).toBeUndefined();
    expect(draft.oneShot).toBeUndefined();
  });

  it("prefills from the rules already saved for this chat", async () => {
    const rule = {
      id: "auto-handoff-chat-42-ended",
      name: "Auto handoff",
      origin: "chat-menu",
      scope: { sessionId: "chat-42", sessionTitle: "Ship the sync fix" },
      oneShot: true,
      maxRuns: 4,
      enabled: true,
      mode: "review",
      triggers: [{ type: "session.ended_without_pr", sessionId: "chat-42" }],
      trigger: { type: "session.ended_without_pr", sessionId: "chat-42" },
      execution: {
        kind: "built-in",
        builtIn: {
          actions: [{
            type: "handoff",
            handoffMode: "brief",
            targetModelId: "anthropic/claude-opus-5",
            promptTemplate: "carry on",
          }],
        },
      },
      actions: [],
    } as unknown as AutomationRuleSummary;

    renderModal([rule]);
    await screen.findByRole("dialog");

    expect((screen.getByRole("switch", { name: "chat ends" })).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("switch", { name: "usage limit" })).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByLabelText("Handoff model") as HTMLSelectElement).value).toBe("anthropic/claude-opus-5");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect((screen.getByLabelText("Retries") as HTMLInputElement).value).toBe("4");
  });

  it("forces a brief for both of the non-same lane targets, and says why Fork would move it back", async () => {
    renderModal();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    for (const target of ["a new lane", "choose a lane…"]) {
      // Re-enter from Fork each time, so each case is a real transition.
      fireEvent.click(screen.getByRole("button", { name: "Fork" }));
      expect(screen.getByRole("radio", { name: "this lane" }).getAttribute("aria-checked")).toBe("true");

      fireEvent.click(screen.getByRole("radio", { name: target }));
      expect(screen.getByRole("button", { name: "Brief" }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("button", { name: "Fork" }).getAttribute("aria-pressed")).toBe("false");
      expect(screen.getByRole("button", { name: "Fork" }).getAttribute("title"))
        .toContain("stay in the chat's own lane");
    }
  });

  it("snaps the lane target back to this lane when Fork is picked", async () => {
    renderModal();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    fireEvent.click(screen.getByRole("radio", { name: "choose a lane…" }));
    fireEvent.click(screen.getByRole("button", { name: "Handoff lane" }));
    fireEvent.click(await screen.findByRole("option", { name: /Lane 2/ }));
    expect(screen.getByRole("radio", { name: "choose a lane…" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    // Both halves of the coupling: the mode moved, and the destination moved
    // with it, so the pair can never present the shape the service rejects.
    expect(screen.getByRole("radio", { name: "this lane" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Fork" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Handoff lane" })).toBeNull();
  });

  it("will not save an explicit lane target until a lane is chosen", async () => {
    renderModal();
    await waitFor(() => {
      expect((screen.getByLabelText("Handoff model") as HTMLInputElement).value).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("radio", { name: "choose a lane…" }));

    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Pick the lane");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Handoff lane" }));
    fireEvent.click(await screen.findByRole("option", { name: /Lane 2/ }));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    expect(saveDraft.mock.calls[0]![0].draft.actions[0]).toMatchObject({
      handoffMode: "brief",
      targetLaneMode: "explicit",
      targetLaneId: "lane-2",
    });
  });

  it("says where a new lane comes from, and names it after this chat", async () => {
    renderModal();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("radio", { name: "a new lane" }));

    expect(screen.getByText(/named after this chat/)).toBeTruthy();
    // The sentence mirrors the destination rather than carrying a second control.
    expect(screen.getByRole("button", { name: "Handoff lane: a new lane" })).toBeTruthy();
  });

  it("saves on Enter when the form is valid, and never from inside the prompt", async () => {
    renderModal();
    await waitFor(() => {
      expect((screen.getByLabelText("Handoff model") as HTMLSelectElement).value).toBeTruthy();
    });

    // Enter inside the multi-line prompt belongs to the prompt.
    fireEvent.keyDown(screen.getByLabelText("Prompt"), { key: "Enter" });
    expect(saveDraft).not.toHaveBeenCalled();

    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Enter" });
    await waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
  });

  it("uses ADE's lane combobox, never a native select", async () => {
    renderModal();
    await screen.findByRole("dialog");

    // A native <select> keeps macOS chrome no matter what Tailwind says, so the
    // sentence card must not contain one at all.
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("radio", { name: "choose a lane…" }));

    expect(document.querySelectorAll("select")).toHaveLength(0);
    const lane = screen.getByRole("button", { name: "Handoff lane" });
    expect(lane.tagName).toBe("BUTTON");
    expect(lane.getAttribute("aria-haspopup")).toBe("listbox");
  });

  it("hides the word \"effort\" whenever its control would render nothing", async () => {
    // ReasoningEffortPicker returns null for a model with no tiers, which used
    // to leave the noun dangling at the end of the sentence.
    renderModal();
    await screen.findByRole("dialog");
    expect(screen.queryByText("effort")).toBeNull();
    expect(screen.queryByTestId("effort")).toBeNull();

    cleanup();
    catalogTiers.value = ["low", "high"];
    renderModal();
    await screen.findByRole("dialog");
    // The word and the control arrive together or not at all.
    expect(screen.getByText("effort")).toBeTruthy();
    expect(screen.getByTestId("effort")).toBeTruthy();
  });

  it("defaults Retries to the service's one-shot cap", async () => {
    renderModal();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect((screen.getByLabelText("Retries") as HTMLInputElement).value)
      .toBe(String(AUTO_HANDOFF_DEFAULT_RETRIES));
    expect(AUTO_HANDOFF_DEFAULT_RETRIES).toBe(3);
  });

  it("closes on Escape", async () => {
    const { onClose } = renderModal();
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("selectAutoHandoffRulesForSession", () => {
  it("matches on scope but only for rules that actually hand off", () => {
    const base = {
      name: "x",
      origin: "chat-menu",
      enabled: true,
      mode: "review",
      triggers: [],
      trigger: { type: "manual" },
      actions: [],
    };
    const rules = [
      { ...base, id: "a", scope: { sessionId: "chat-42", sessionTitle: "t" }, actions: [{ type: "handoff" }] },
      { ...base, id: "b", scope: { sessionId: "chat-42", sessionTitle: "t" }, actions: [{ type: "run-tests" }] },
      { ...base, id: "c", scope: { sessionId: "other", sessionTitle: "t" }, actions: [{ type: "handoff" }] },
      { ...base, id: "d", actions: [{ type: "handoff" }] },
    ] as unknown as AutomationRuleSummary[];

    expect(selectAutoHandoffRulesForSession(rules, "chat-42").map((rule) => rule.id)).toEqual(["a"]);
  });
});
