/**
 * What `chat.capabilities` promises a launch form, and the guard that keeps it
 * true.
 *
 * Two different obligations are pinned here. The first is INTERNAL consistency:
 * a default the answer names must be a choice the same answer offers, or a page
 * preselects a rung its own picker does not contain and the launch is refused by
 * a validator the page cannot see. The second is the DRIFT guard, and it is the
 * reason `chatCapabilities.ts` restates lists that already exist: the app's own
 * pills live in `renderer/lib/nativeLaunchControls.ts`, which a shared module
 * may not import and a plugin host — running in main and in the daemon, where
 * there is no renderer — cannot reach at all. So the values are duplicated, and
 * this file is where the duplication is made honest: a mode added to ADE's own
 * Claude pill and not to the plugin answer fails here rather than quietly
 * leaving every plugin page a version behind.
 */

import { describe, expect, it } from "vitest";

import {
  CLAUDE_PERMISSION_OPTIONS,
  CODEX_PERMISSION_PRESETS,
  DROID_PERMISSION_OPTIONS,
  OPENCODE_PERMISSION_OPTIONS,
  cursorModeChoices,
} from "../../renderer/lib/nativeLaunchControls";
import {
  MODEL_REGISTRY,
  getDefaultModelDescriptor,
  modelSupportsFastMode,
} from "../modelRegistry";
import {
  pluginChatCapabilities,
  pluginChatDefaultModel,
  type PluginChatProviderCapability,
} from "./chatCapabilities";

function providerNamed(provider: string): PluginChatProviderCapability {
  const found = pluginChatCapabilities().providers.find((entry) => entry.provider === provider);
  expect(found, `no capability for provider "${provider}"`).toBeTruthy();
  return found!;
}

describe("provider capabilities", () => {
  it("names a default that is one of the provider's own modes", () => {
    for (const provider of pluginChatCapabilities().providers) {
      const values = provider.permissionModes.map((option) => option.value);
      expect(values.length, `${provider.provider} offers no modes`).toBeGreaterThan(0);
      expect(values, `${provider.provider} defaults off its own list`)
        .toContain(provider.defaultPermissionMode);
    }
  });

  it("names a launch field for every provider", () => {
    for (const provider of pluginChatCapabilities().providers) {
      expect(provider.permissionField, `${provider.provider} has no launch field`).toBeTruthy();
    }
  });
});

describe("drift guard against the app's own launch controls", () => {
  // Order included on purpose: these lists are drawn as pills in the order they
  // are written, and a plugin page rebuilding ADE's form should read the same
  // sequence the app shows rather than a set that happens to have the same
  // members.
  it("matches ADE's own Claude permission pill, value, label and detail", () => {
    expect(providerNamed("claude").permissionModes).toEqual(
      CLAUDE_PERMISSION_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        detail: option.detail,
      })),
    );
  });

  it("matches ADE's own Codex presets rather than the sixteen raw combinations", () => {
    expect(providerNamed("codex").permissionModes).toEqual(
      CODEX_PERMISSION_PRESETS.map((option) => ({
        value: option.value,
        label: option.label,
        detail: option.detail,
      })),
    );
  });

  it("matches ADE's own OpenCode pill", () => {
    // Value and label only: the renderer's OpenCode list carries no `detail`,
    // and the sentences in `chatCapabilities.ts` are written for the plugin
    // answer alone. What must not drift is which modes exist and what they are
    // called.
    expect(providerNamed("opencode").permissionModes.map(({ value, label }) => ({ value, label })))
      .toEqual(OPENCODE_PERMISSION_OPTIONS.map(({ value, label }) => ({ value, label })));
  });

  it("matches ADE's own Droid pill, value, label and detail", () => {
    expect(providerNamed("droid").permissionModes).toEqual(
      DROID_PERMISSION_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        detail: option.detail,
      })),
    );
  });

  it("offers exactly the Cursor modes the app itself offers", () => {
    expect(providerNamed("cursor").permissionModes.map((option) => option.value))
      .toEqual(cursorModeChoices());
  });
});

describe("model capabilities", () => {
  it("reports fast mode for a model with a fast service tier and not for one without", () => {
    const models = pluginChatCapabilities().models;
    const withFast = MODEL_REGISTRY.find((descriptor) => modelSupportsFastMode(descriptor));
    const withoutFast = MODEL_REGISTRY.find((descriptor) => !modelSupportsFastMode(descriptor));
    expect(withFast, "the registry has no fast-tier model to test with").toBeTruthy();
    expect(withoutFast, "the registry has no plain model to test with").toBeTruthy();

    expect(models.find((model) => model.id === withFast!.id)?.fastMode).toBe(true);
    expect(models.find((model) => model.id === withoutFast!.id)?.fastMode).toBe(false);
  });

  it("keeps every default reasoning effort inside that model's own ladder", () => {
    for (const model of pluginChatCapabilities().models) {
      if (model.defaultReasoningEffort === null) continue;
      expect(
        model.reasoningEfforts.map((option) => option.effort),
        `${model.id} defaults to a rung it does not offer`,
      ).toContain(model.defaultReasoningEffort);
    }
  });

  it("reports a null default rather than an empty string for a model with no ladder", () => {
    for (const model of pluginChatCapabilities().models) {
      if (model.reasoningEfforts.length > 0) continue;
      expect(model.defaultReasoningEffort, `${model.id} has no ladder but names a rung`).toBeNull();
    }
  });
});

/**
 * The launch-form SEED, which is the half of the answer that is not a registry
 * fact. `providers` and `models` say what may be chosen; `defaultModel` says
 * what is chosen before the reader touches anything, and ADE's own form takes
 * that from the user's recent launches. A page that had to guess opened on a
 * hard-coded id while the composer beside it opened on the user's last model —
 * the divergence these cases pin shut.
 */
describe("default model", () => {
  it("takes the most recent model the host still has", () => {
    const someModel = pluginChatCapabilities().models.find((model) => !model.deprecated);
    expect(someModel, "the registry offers no model to seed from").toBeTruthy();

    const seeded = pluginChatDefaultModel([someModel!.id]);
    expect(seeded?.modelId).toBe(someModel!.id);
    expect(seeded?.provider).toBe(someModel!.provider);
  });

  it("skips a recent model this host no longer has rather than abandoning the list", () => {
    const models = pluginChatCapabilities().models;
    const second = models[1];
    expect(second, "the registry has fewer than two models").toBeTruthy();

    // A dynamic OpenCode id from a catalog that is no longer installed. Falling
    // to the registry default here would move the user's form under them for
    // one absent entry, when they have a perfectly good second-most-recent.
    const seeded = pluginChatDefaultModel(["opencode/gone-from-this-machine", second!.id]);
    expect(seeded?.modelId).toBe(second!.id);
  });

  it("falls back to the Claude default for a user who has launched nothing", () => {
    const seeded = pluginChatDefaultModel([]);
    expect(seeded).not.toBeNull();
    expect(seeded!.modelId).toBe(getDefaultModelDescriptor("claude")?.id);
  });

  it("answers the same seed BatchLaunchModal's own expression would", () => {
    // The rule restated in `pluginChatDefaultModel`, spelled here exactly as
    // `BatchLaunchModal.tsx` spells it. A change to either that is not a change
    // to both fails here rather than leaving plugin pages a version behind.
    const ids = new Set(pluginChatCapabilities().models.map((model) => model.id));
    for (const recents of [[], ["claude-not-a-real-id"], [[...ids][3] ?? ""]]) {
      const modalWouldPick = recents.find((id) => ids.has(id))
        ?? getDefaultModelDescriptor("claude")?.id
        ?? getDefaultModelDescriptor("opencode")?.id
        ?? "";
      expect(pluginChatDefaultModel(recents)?.modelId ?? "").toBe(modalWouldPick);
    }
  });

  it("seeds an effort and a permission mode the same answer offers", () => {
    const capabilities = pluginChatCapabilities({ recents: [] });
    const seeded = capabilities.defaultModel;
    expect(seeded).not.toBeNull();

    const model = capabilities.models.find((entry) => entry.id === seeded!.modelId);
    expect(model, "the seed names a model the answer does not list").toBeTruthy();
    if (seeded!.effort !== undefined) {
      expect(model!.reasoningEfforts.map((option) => option.effort)).toContain(seeded!.effort);
    }
    if (seeded!.permissionMode !== undefined) {
      const provider = capabilities.providers.find((entry) => entry.provider === seeded!.provider);
      expect(provider, "the seed names a provider the answer does not list").toBeTruthy();
      expect(provider!.permissionModes.map((option) => option.value)).toContain(seeded!.permissionMode);
      expect(seeded!.permissionMode).toBe(provider!.defaultPermissionMode);
    }
  });

  it("never offers fast mode on a model that has no fast tier", () => {
    const capabilities = pluginChatCapabilities();
    const seeded = capabilities.defaultModel!;
    const model = capabilities.models.find((entry) => entry.id === seeded.modelId)!;
    if (!model.fastMode) expect(seeded.fastMode).toBeUndefined();
    else expect(seeded.fastMode).toBe(false);
  });

  it("carries the seed on the whole answer, as null rather than absent when there is none", () => {
    const capabilities = pluginChatCapabilities();
    expect("defaultModel" in capabilities).toBe(true);
  });
});
