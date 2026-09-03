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
import { MODEL_REGISTRY, modelSupportsFastMode } from "../modelRegistry";
import {
  pluginChatCapabilities,
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
