import type { ModelPickerEntry } from "./components/ModelPicker/types";
import { PROVIDER_ORDER } from "./components/ModelPicker/modelPickerLayout";
import { providerLabel } from "./providerMetadata";
import type { AdeCodeProvider, SetupPaneRow, SetupPaneRowKind } from "./types";

/**
 * `/model` is a TRANSIENT WIZARD, not a browser.
 *
 * Four steps — provider family → internal family group → model → settings —
 * each a single vertical list. Enter advances (and on the last step commits and
 * closes the pane), Esc walks back one step and closes from step 1. The family
 * step is skipped entirely for providers that expose one flat model list.
 *
 * Everything in this module is pure: it takes the current selection plus the
 * model pool and produces the rows to paint, the next selection, and a
 * description of the side effect the caller should run. No Ink, no React, no
 * app state — so the whole navigation contract is unit-testable.
 */

export const MODEL_WIZARD_STEPS = ["provider", "family", "model", "settings"] as const;
export type ModelWizardStep = (typeof MODEL_WIZARD_STEPS)[number];

export type ModelWizardOptionKind = "recent" | "provider" | "family" | "model" | "setting" | "done";

export type ModelWizardOption = {
  /** Stable per-row id; also the hit-test target suffix. */
  id: string;
  kind: ModelWizardOptionKind;
  label: string;
  /** Right-hand value column (settings rows only). */
  value?: string | null;
  detail?: string | null;
  /** Short trailing annotation (e.g. "recent", "fast", "chat only"). */
  hint?: string | null;
  disabled?: boolean;
  provider?: AdeCodeProvider;
  familyKey?: string;
  modelId?: string;
  settingKind?: SetupPaneRowKind;
};

export type ModelWizardSelection = {
  step: ModelWizardStep;
  provider: AdeCodeProvider | null;
  familyKey: string | null;
  index: number;
};

export type ModelWizardView = {
  step: ModelWizardStep;
  title: string;
  /** Trail of already-chosen steps, painted above the list. */
  breadcrumb: string[];
  options: ModelWizardOption[];
  index: number;
  /** Footer key hints for this step. */
  hint: string;
};

export type ModelWizardInput = {
  selection: ModelWizardSelection;
  entries: readonly ModelPickerEntry[];
  recents: readonly string[];
  settingsRows: readonly SetupPaneRow[];
  activeModelId?: string | null;
};

/** Settings the wizard's last step exposes, in the order it paints them. */
export const MODEL_WIZARD_SETTING_KINDS: readonly SetupPaneRowKind[] = [
  "permission",
  "reasoning",
  "codex-fast",
  "interface",
];

const MAX_RECENT_SHORTCUTS = 3;
const FAMILY_FALLBACK_KEY = "__default__";

function familyKeyFor(entry: ModelPickerEntry): string {
  return entry.subProviderKey?.trim() || entry.subProvider?.trim() || FAMILY_FALLBACK_KEY;
}

export type ModelWizardFamily = { key: string; label: string; count: number };

/**
 * Internal family groups for one provider (Cursor's model families, OpenCode's
 * upstream providers, …). Returns a single group — or none — for providers with
 * a flat list; `modelWizardHasFamilyStep` turns that into "skip step 2".
 */
export function modelWizardFamilies(
  entries: readonly ModelPickerEntry[],
  provider: AdeCodeProvider,
): ModelWizardFamily[] {
  const groups = new Map<string, ModelWizardFamily>();
  for (const entry of entries) {
    if (entry.family !== provider) continue;
    const key = familyKeyFor(entry);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    groups.set(key, {
      key,
      label: entry.subProvider?.trim() || providerLabel(provider),
      count: 1,
    });
  }
  return [...groups.values()];
}

export function modelWizardHasFamilyStep(
  entries: readonly ModelPickerEntry[],
  provider: AdeCodeProvider | null,
): boolean {
  if (!provider) return false;
  return modelWizardFamilies(entries, provider).length > 1;
}

export function modelWizardProviders(entries: readonly ModelPickerEntry[]): AdeCodeProvider[] {
  const present = new Set<AdeCodeProvider>(entries.map((entry) => entry.family));
  const ordered = PROVIDER_ORDER.filter((provider) => present.has(provider));
  const extras = [...present].filter((provider) => !PROVIDER_ORDER.includes(provider));
  return [...ordered, ...extras];
}

export function modelWizardModels(
  entries: readonly ModelPickerEntry[],
  provider: AdeCodeProvider | null,
  familyKey: string | null,
): ModelPickerEntry[] {
  if (!provider) return [];
  const pool = entries.filter((entry) => entry.family === provider);
  if (!familyKey) return pool;
  const matching = pool.filter((entry) => familyKeyFor(entry) === familyKey);
  return matching.length ? matching : pool;
}

function modelHint(entry: ModelPickerEntry): string | null {
  const hints: string[] = [];
  if (entry.isFavorite) hints.push("★");
  if (entry.serviceTiers?.some((tier) => tier.trim().toLowerCase() === "fast")) hints.push("fast");
  if (entry.cursorAvailability) {
    const { cli, sdk } = entry.cursorAvailability;
    if (cli === true && sdk !== true) hints.push("cli only");
    else if (sdk === true && cli !== true) hints.push("chat only");
  }
  if (!entry.isAvailable) hints.push("sign in");
  return hints.length ? hints.join(" · ") : null;
}

function settingOptions(settingsRows: readonly SetupPaneRow[]): ModelWizardOption[] {
  const byKind = new Map<SetupPaneRowKind, SetupPaneRow>();
  for (const row of settingsRows) byKind.set(row.kind, row);
  const options: ModelWizardOption[] = [];
  for (const kind of MODEL_WIZARD_SETTING_KINDS) {
    const row = byKind.get(kind);
    if (!row) continue;
    options.push({
      id: `setting:${kind}`,
      kind: "setting",
      label: row.label,
      value: row.value,
      detail: row.detail ?? null,
      ...(row.disabled ? { disabled: true } : {}),
      settingKind: kind,
    });
  }
  options.push({
    id: "done",
    kind: "done",
    label: "Start with these settings",
    detail: "closes the picker",
  });
  return options;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

/**
 * Rows + title + hints for the current step. Callers paint this directly and
 * feed it back into the navigation helpers, so the render and the keyboard /
 * mouse handlers can never disagree about what row N is.
 */
export function buildModelWizardView(input: ModelWizardInput): ModelWizardView {
  const { selection, entries, recents, settingsRows } = input;
  const providerName = selection.provider ? providerLabel(selection.provider) : null;
  const families = selection.provider ? modelWizardFamilies(entries, selection.provider) : [];
  const familyLabel = selection.familyKey
    ? families.find((family) => family.key === selection.familyKey)?.label ?? null
    : null;

  if (selection.step === "provider") {
    const options: ModelWizardOption[] = [];
    const byModelId = new Map(entries.map((entry) => [entry.modelId, entry] as const));
    for (const modelId of recents.slice(0, MAX_RECENT_SHORTCUTS)) {
      const entry = byModelId.get(modelId);
      if (!entry) continue;
      options.push({
        id: `recent:${modelId}`,
        kind: "recent",
        label: entry.displayName,
        detail: providerLabel(entry.family),
        hint: entry.isFavorite ? "favorite" : "recent",
        ...(entry.isAvailable ? {} : { disabled: true }),
        provider: entry.family,
        modelId,
      });
    }
    for (const provider of modelWizardProviders(entries)) {
      const count = entries.filter((entry) => entry.family === provider).length;
      options.push({
        id: `provider:${provider}`,
        kind: "provider",
        label: providerLabel(provider),
        detail: `${count} model${count === 1 ? "" : "s"}`,
        provider,
      });
    }
    return {
      step: "provider",
      title: "Choose a provider",
      breadcrumb: [],
      options,
      index: clampIndex(selection.index, options.length),
      hint: "↑↓ move · ↵ select · esc close",
    };
  }

  if (selection.step === "family") {
    const options = families.map((family) => ({
      id: `family:${family.key}`,
      kind: "family" as const,
      label: family.label,
      detail: `${family.count} model${family.count === 1 ? "" : "s"}`,
      familyKey: family.key,
    }));
    return {
      step: "family",
      title: `${providerName ?? "Provider"} families`,
      breadcrumb: providerName ? [providerName] : [],
      options,
      index: clampIndex(selection.index, options.length),
      hint: "↑↓ move · ↵ select · esc back",
    };
  }

  if (selection.step === "model") {
    const models = modelWizardModels(entries, selection.provider, selection.familyKey);
    const options = models.map((entry) => ({
      id: `model:${entry.modelId}`,
      kind: "model" as const,
      label: entry.displayName,
      detail: entry.subProvider ?? null,
      hint: modelHint(entry),
      ...(entry.isAvailable ? {} : { disabled: true }),
      provider: entry.family,
      modelId: entry.modelId,
    }));
    return {
      step: "model",
      title: "Choose a model",
      breadcrumb: [providerName, familyLabel].filter((part): part is string => Boolean(part)),
      options,
      index: clampIndex(selection.index, options.length),
      hint: "↑↓ move · ↵ select · f favorite · esc back",
    };
  }

  const options = settingOptions(settingsRows);
  const activeModel = input.activeModelId
    ? entries.find((entry) => entry.modelId === input.activeModelId)?.displayName ?? null
    : null;
  return {
    step: "settings",
    title: "Settings",
    breadcrumb: [providerName, familyLabel, activeModel].filter((part): part is string => Boolean(part)),
    options,
    index: clampIndex(selection.index, options.length),
    hint: "↑↓ move · ←→ change · ↵ select · esc back",
  };
}

export function moveModelWizardIndex(view: ModelWizardView, delta: -1 | 1): number {
  if (view.options.length === 0) return 0;
  return clampIndex(view.index + delta, view.options.length);
}

/** Which step follows `provider` for this pool (skips an absent family step). */
export function stepAfterProvider(
  entries: readonly ModelPickerEntry[],
  provider: AdeCodeProvider,
): ModelWizardStep {
  return modelWizardHasFamilyStep(entries, provider) ? "family" : "model";
}

function modelStepIndexFor(
  entries: readonly ModelPickerEntry[],
  provider: AdeCodeProvider,
  familyKey: string | null,
  activeModelId: string | null | undefined,
): number {
  if (!activeModelId) return 0;
  const models = modelWizardModels(entries, provider, familyKey);
  return Math.max(0, models.findIndex((entry) => entry.modelId === activeModelId));
}

export type ModelWizardAdvance =
  /** Step moved with no side effect beyond remembering the provider. */
  | { kind: "step"; selection: ModelWizardSelection }
  /** A provider was chosen: apply its remembered settings, then show `selection`. */
  | { kind: "select-provider"; provider: AdeCodeProvider; selection: ModelWizardSelection }
  /** A model was chosen: commit it, then show the settings step. */
  | { kind: "select-model"; provider: AdeCodeProvider; modelId: string; selection: ModelWizardSelection }
  /** A model row that needs auth was chosen — caller should route to sign-in. */
  | { kind: "sign-in"; provider: AdeCodeProvider; modelId: string }
  /** A settings row was activated: cycle it and stay put. */
  | { kind: "cycle-setting"; settingKind: SetupPaneRowKind; direction: 1 | -1 }
  /** Final Enter: commit the draft/session settings and CLOSE the pane. */
  | { kind: "commit" }
  | { kind: "none" };

export function advanceModelWizard(input: ModelWizardInput): ModelWizardAdvance {
  const view = buildModelWizardView(input);
  const option = view.options[view.index];
  if (!option) return { kind: "none" };
  const { entries, selection } = input;

  if (option.kind === "recent") {
    if (option.disabled) {
      return option.provider && option.modelId
        ? { kind: "sign-in", provider: option.provider, modelId: option.modelId }
        : { kind: "none" };
    }
    if (!option.provider || !option.modelId) return { kind: "none" };
    return {
      kind: "select-model",
      provider: option.provider,
      modelId: option.modelId,
      selection: { step: "settings", provider: option.provider, familyKey: null, index: 0 },
    };
  }

  if (option.kind === "provider") {
    const provider = option.provider!;
    const nextStep = stepAfterProvider(entries, provider);
    return {
      kind: "select-provider",
      provider,
      selection: {
        step: nextStep,
        provider,
        familyKey: null,
        index: nextStep === "model"
          ? modelStepIndexFor(entries, provider, null, input.activeModelId)
          : 0,
      },
    };
  }

  if (option.kind === "family") {
    const provider = selection.provider;
    if (!provider || !option.familyKey) return { kind: "none" };
    return {
      kind: "step",
      selection: {
        step: "model",
        provider,
        familyKey: option.familyKey,
        index: modelStepIndexFor(entries, provider, option.familyKey, input.activeModelId),
      },
    };
  }

  if (option.kind === "model") {
    const provider = option.provider ?? selection.provider;
    if (!provider || !option.modelId) return { kind: "none" };
    if (option.disabled) return { kind: "sign-in", provider, modelId: option.modelId };
    return {
      kind: "select-model",
      provider,
      modelId: option.modelId,
      selection: { step: "settings", provider, familyKey: selection.familyKey, index: 0 },
    };
  }

  if (option.kind === "setting") {
    if (option.disabled || !option.settingKind) return { kind: "none" };
    return { kind: "cycle-setting", settingKind: option.settingKind, direction: 1 };
  }

  return { kind: "commit" };
}

/** ←/→ on the settings step cycles the focused row; elsewhere they do nothing. */
export function cycleModelWizardSetting(
  input: ModelWizardInput,
  direction: 1 | -1,
): { settingKind: SetupPaneRowKind; direction: 1 | -1 } | null {
  if (input.selection.step !== "settings") return null;
  const view = buildModelWizardView(input);
  const option = view.options[view.index];
  if (!option || option.kind !== "setting" || option.disabled || !option.settingKind) return null;
  return { settingKind: option.settingKind, direction };
}

export type ModelWizardBack =
  | { kind: "close" }
  | { kind: "step"; selection: ModelWizardSelection };

/**
 * Esc: one step back, closing the pane from step 1. The family step is skipped
 * on the way back exactly as it is on the way forward.
 */
export function backModelWizard(input: ModelWizardInput): ModelWizardBack {
  const { selection, entries } = input;
  if (selection.step === "provider") return { kind: "close" };
  const provider = selection.provider;
  if (selection.step === "family" || !provider) {
    return {
      kind: "step",
      selection: {
        step: "provider",
        provider,
        familyKey: null,
        index: providerStepIndexFor(input, provider),
      },
    };
  }
  if (selection.step === "model") {
    if (modelWizardHasFamilyStep(entries, provider)) {
      const families = modelWizardFamilies(entries, provider);
      const index = Math.max(0, families.findIndex((family) => family.key === selection.familyKey));
      return { kind: "step", selection: { step: "family", provider, familyKey: null, index } };
    }
    return {
      kind: "step",
      selection: {
        step: "provider",
        provider,
        familyKey: null,
        index: providerStepIndexFor(input, provider),
      },
    };
  }
  return {
    kind: "step",
    selection: {
      step: "model",
      provider,
      familyKey: selection.familyKey,
      index: modelStepIndexFor(entries, provider, selection.familyKey, input.activeModelId),
    },
  };
}

/**
 * Index of a provider's row on step 1. Derived from the rendered view, not from
 * `modelWizardProviders`, because the step also prepends recent-model shortcuts
 * — computing it from the provider list alone would land the cursor N rows off.
 */
function providerStepIndexFor(input: ModelWizardInput, provider: AdeCodeProvider | null): number {
  if (!provider) return 0;
  const view = buildModelWizardView({
    ...input,
    selection: { step: "provider", provider, familyKey: null, index: 0 },
  });
  const index = view.options.findIndex((option) => option.id === `provider:${provider}`);
  return index >= 0 ? index : 0;
}

/**
 * Opening selection for `/model`: land on the active provider's model list (or
 * its family list) so a retarget is two keystrokes, and on step 1 for a chat
 * with no provider yet.
 */
export function initialModelWizardSelection(args: {
  entries: readonly ModelPickerEntry[];
  provider: AdeCodeProvider | null;
  activeModelId?: string | null;
  /** Jump straight to the settings step (used by /effort). */
  startAtSettings?: boolean;
}): ModelWizardSelection {
  const { entries, provider } = args;
  if (!provider) return { step: "provider", provider: null, familyKey: null, index: 0 };
  if (args.startAtSettings) {
    return { step: "settings", provider, familyKey: null, index: 0 };
  }
  const step = stepAfterProvider(entries, provider);
  return {
    step,
    provider,
    familyKey: null,
    index: step === "model" ? modelStepIndexFor(entries, provider, null, args.activeModelId) : 0,
  };
}

/**
 * Re-clamp a selection against a pool that may have changed under it (catalog
 * refresh, provider signed out). Never throws the user to a different step —
 * only fixes an out-of-range index or a family key that no longer exists.
 */
export function normalizeModelWizardSelection(input: ModelWizardInput): ModelWizardSelection {
  const { selection, entries } = input;
  let familyKey = selection.familyKey;
  if (familyKey && selection.provider) {
    const families = modelWizardFamilies(entries, selection.provider);
    if (!families.some((family) => family.key === familyKey)) familyKey = null;
  }
  const view = buildModelWizardView({ ...input, selection: { ...selection, familyKey } });
  const index = clampIndex(selection.index, view.options.length);
  return index === selection.index && familyKey === selection.familyKey
    ? selection
    : { ...selection, familyKey, index };
}
