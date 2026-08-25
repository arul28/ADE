import { describe, expect, it } from "vitest";
import {
  advanceModelWizard,
  backModelWizard,
  buildModelWizardView,
  cycleModelWizardSetting,
  initialModelWizardSelection,
  modelWizardFamilies,
  modelWizardHasFamilyStep,
  moveModelWizardIndex,
  normalizeModelWizardSelection,
  stepAfterProvider,
  type ModelWizardInput,
  type ModelWizardSelection,
} from "../modelWizard";
import type { ModelPickerEntry } from "../components/ModelPicker/types";
import type { SetupPaneRow } from "../types";

function entry(overrides: Partial<ModelPickerEntry> & Pick<ModelPickerEntry, "modelId" | "family">): ModelPickerEntry {
  return {
    runtimeModelId: overrides.modelId,
    displayName: overrides.modelId,
    isFavorite: false,
    isAvailable: true,
    authStatus: "ready",
    ...overrides,
  } as ModelPickerEntry;
}

// Two providers: codex is a flat list, cursor has two internal families.
const ENTRIES: ModelPickerEntry[] = [
  entry({ modelId: "gpt-5.6-sol", family: "codex", displayName: "GPT-5.6 Sol", subProvider: "OpenAI", subProviderKey: "codex" }),
  entry({ modelId: "gpt-5.6-terra", family: "codex", displayName: "GPT-5.6 Terra", subProvider: "OpenAI", subProviderKey: "codex" }),
  entry({ modelId: "cursor-composer", family: "cursor", displayName: "Composer", subProvider: "Composer", subProviderKey: "composer" }),
  entry({ modelId: "cursor-agent", family: "cursor", displayName: "Agent", subProvider: "Agent", subProviderKey: "agent" }),
  entry({ modelId: "cursor-agent-fast", family: "cursor", displayName: "Agent Fast", subProvider: "Agent", subProviderKey: "agent", serviceTiers: ["fast"] }),
];

const SETTINGS: SetupPaneRow[] = [
  { kind: "provider", label: "Provider", value: "Codex" },
  { kind: "model", label: "Model", value: "GPT-5.6 Sol" },
  { kind: "interface", label: "Interface", value: "Chat" },
  { kind: "reasoning", label: "Reasoning", value: "Extra High" },
  { kind: "permission", label: "Permissions", value: "default" },
  { kind: "codex-fast", label: "Fast mode", value: "off" },
  { kind: "apply", label: "Confirm", value: "ready" },
];

function input(selection: ModelWizardSelection, overrides: Partial<ModelWizardInput> = {}): ModelWizardInput {
  return {
    selection,
    entries: ENTRIES,
    recents: [],
    settingsRows: SETTINGS,
    activeModelId: null,
    ...overrides,
  };
}

describe("modelWizard steps", () => {
  it("lists providers on step 1, ordered, with model counts", () => {
    const view = buildModelWizardView(input({ step: "provider", provider: null, familyKey: null, index: 0 }));
    expect(view.options.map((option) => option.id)).toEqual(["provider:codex", "provider:cursor"]);
    expect(view.options[0]?.detail).toBe("2 models");
    expect(view.options[1]?.detail).toBe("3 models");
  });

  it("prepends recent models as shortcuts on step 1", () => {
    const view = buildModelWizardView(
      input({ step: "provider", provider: null, familyKey: null, index: 0 }, { recents: ["cursor-agent", "unknown-id"] }),
    );
    expect(view.options[0]).toMatchObject({ id: "recent:cursor-agent", kind: "recent", provider: "cursor" });
    // Unknown recents (catalog churn) are dropped, not rendered as dead rows.
    expect(view.options.map((option) => option.id)).not.toContain("recent:unknown-id");
  });

  it("skips the family step for a provider with one flat list", () => {
    expect(modelWizardHasFamilyStep(ENTRIES, "codex")).toBe(false);
    expect(stepAfterProvider(ENTRIES, "codex")).toBe("model");
    expect(modelWizardHasFamilyStep(ENTRIES, "cursor")).toBe(true);
    expect(stepAfterProvider(ENTRIES, "cursor")).toBe("family");
    expect(modelWizardFamilies(ENTRIES, "cursor").map((family) => family.key)).toEqual(["composer", "agent"]);
  });

  it("marks unavailable and fast models on the model step", () => {
    const entries = [
      ...ENTRIES,
      entry({ modelId: "cursor-cli-only", family: "cursor", subProvider: "Agent", subProviderKey: "agent", isAvailable: false, cursorAvailability: { cli: true, sdk: false } }),
    ];
    const view = buildModelWizardView(
      input({ step: "model", provider: "cursor", familyKey: "agent", index: 0 }, { entries }),
    );
    expect(view.options.find((option) => option.modelId === "cursor-agent-fast")?.hint).toContain("fast");
    const cliOnly = view.options.find((option) => option.modelId === "cursor-cli-only");
    expect(cliOnly?.disabled).toBe(true);
    expect(cliOnly?.hint).toContain("cli only");
  });

  it("shows only permission/reasoning/fast/interface plus a commit row on step 4", () => {
    const view = buildModelWizardView(input({ step: "settings", provider: "codex", familyKey: null, index: 0 }));
    expect(view.options.map((option) => option.id)).toEqual([
      "setting:permission",
      "setting:reasoning",
      "setting:codex-fast",
      "setting:interface",
      "done",
    ]);
    // GPT-5.6 label rules arrive already resolved on the row's value.
    expect(view.options[1]?.value).toBe("Extra High");
  });
});

describe("modelWizard navigation", () => {
  it("clamps ↑/↓ at the list edges", () => {
    const view = buildModelWizardView(input({ step: "provider", provider: null, familyKey: null, index: 0 }));
    expect(moveModelWizardIndex(view, -1)).toBe(0);
    expect(moveModelWizardIndex(view, 1)).toBe(1);
    expect(moveModelWizardIndex({ ...view, index: 1 }, 1)).toBe(1);
  });

  it("Enter on a provider advances to family or straight to models", () => {
    const cursor = advanceModelWizard(input({ step: "provider", provider: null, familyKey: null, index: 1 }));
    expect(cursor).toMatchObject({ kind: "select-provider", provider: "cursor", selection: { step: "family" } });
    const codex = advanceModelWizard(input({ step: "provider", provider: null, familyKey: null, index: 0 }));
    expect(codex).toMatchObject({ kind: "select-provider", provider: "codex", selection: { step: "model" } });
  });

  it("Enter on a model commits it and drops into settings", () => {
    const result = advanceModelWizard(input({ step: "model", provider: "codex", familyKey: null, index: 1 }));
    expect(result).toEqual({
      kind: "select-model",
      provider: "codex",
      modelId: "gpt-5.6-terra",
      selection: { step: "settings", provider: "codex", familyKey: null, index: 0 },
    });
  });

  it("Enter on an unavailable model routes to sign-in instead of committing", () => {
    const entries = [entry({ modelId: "claude-x", family: "claude", isAvailable: false })];
    const result = advanceModelWizard(input({ step: "model", provider: "claude", familyKey: null, index: 0 }, { entries }));
    expect(result).toEqual({ kind: "sign-in", provider: "claude", modelId: "claude-x" });
  });

  it("Enter on a recent shortcut skips straight to settings", () => {
    const result = advanceModelWizard(
      input({ step: "provider", provider: null, familyKey: null, index: 0 }, { recents: ["cursor-agent"] }),
    );
    expect(result).toMatchObject({ kind: "select-model", modelId: "cursor-agent", selection: { step: "settings" } });
  });

  it("Enter on the last step commits and closes; ←/→ cycle a setting", () => {
    const settings = input({ step: "settings", provider: "codex", familyKey: null, index: 4 });
    expect(advanceModelWizard(settings)).toEqual({ kind: "commit" });
    expect(cycleModelWizardSetting({ ...settings, selection: { ...settings.selection, index: 0 } }, -1))
      .toEqual({ settingKind: "permission", direction: -1 });
    // The commit row is not a setting, so arrows there are inert.
    expect(cycleModelWizardSetting(settings, 1)).toBeNull();
    // Arrows outside the settings step never cycle anything.
    expect(cycleModelWizardSetting(input({ step: "model", provider: "codex", familyKey: null, index: 0 }), 1)).toBeNull();
  });

  it("Esc walks back one step and closes from step 1", () => {
    expect(backModelWizard(input({ step: "provider", provider: null, familyKey: null, index: 0 })))
      .toEqual({ kind: "close" });
    expect(backModelWizard(input({ step: "settings", provider: "cursor", familyKey: "agent", index: 0 })))
      .toMatchObject({ kind: "step", selection: { step: "model", provider: "cursor", familyKey: "agent" } });
    expect(backModelWizard(input({ step: "model", provider: "cursor", familyKey: "agent", index: 0 })))
      .toMatchObject({ kind: "step", selection: { step: "family", provider: "cursor" } });
    expect(backModelWizard(input({ step: "family", provider: "cursor", familyKey: null, index: 0 })))
      .toMatchObject({ kind: "step", selection: { step: "provider" } });
  });

  it("Esc from a flat provider's model list skips the absent family step", () => {
    const back = backModelWizard(input({ step: "model", provider: "codex", familyKey: null, index: 0 }));
    expect(back).toMatchObject({ kind: "step", selection: { step: "provider", provider: "codex" } });
    // ...and lands the cursor on that provider's row, past any recent shortcuts.
    const withRecents = backModelWizard(
      input({ step: "model", provider: "codex", familyKey: null, index: 0 }, { recents: ["cursor-agent"] }),
    );
    expect(withRecents).toMatchObject({ kind: "step", selection: { index: 1 } });
  });

  it("opens on the active provider's list, homed on the active model", () => {
    expect(initialModelWizardSelection({ entries: ENTRIES, provider: "codex", activeModelId: "gpt-5.6-terra" }))
      .toEqual({ step: "model", provider: "codex", familyKey: null, index: 1 });
    expect(initialModelWizardSelection({ entries: ENTRIES, provider: "cursor", activeModelId: null }))
      .toEqual({ step: "family", provider: "cursor", familyKey: null, index: 0 });
    expect(initialModelWizardSelection({ entries: ENTRIES, provider: "codex", startAtSettings: true }))
      .toEqual({ step: "settings", provider: "codex", familyKey: null, index: 0 });
  });

  it("re-clamps a selection whose pool shrank under it", () => {
    const shrunk = normalizeModelWizardSelection(
      input({ step: "model", provider: "codex", familyKey: "gone", index: 9 }),
    );
    expect(shrunk).toEqual({ step: "model", provider: "codex", familyKey: null, index: 1 });
  });
});
