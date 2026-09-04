import { describe, expect, it } from "vitest";

import { pluginChatModelCapabilities } from "../../../../shared/plugins/chatCapabilities";
import {
  pluginWebviewPickerImmediateNull,
  refusePluginWebviewPicker,
  resolvePluginWebviewPermissionFamily,
} from "./pluginWebviewPickerPolicy";

describe("plugin webview picker policy", () => {
  it("accepts both permission-group names and registry families", () => {
    expect(resolvePluginWebviewPermissionFamily("claude")).toBe("claude");
    expect(resolvePluginWebviewPermissionFamily("anthropic")).toBe("claude");
    expect(resolvePluginWebviewPermissionFamily("openai")).toBe("codex");
    expect(resolvePluginWebviewPermissionFamily("factory")).toBe("droid");
    expect(resolvePluginWebviewPermissionFamily("unknown")).toBeNull();
    expect(resolvePluginWebviewPermissionFamily("")).toBeNull();
  });

  it("refuses a permission pick with no provider rather than answering null", () => {
    expect(refusePluginWebviewPicker("ui.pickPermissionMode", {})).toBe(
      "ADE doesn’t have a permission control for that provider.",
    );
    expect(refusePluginWebviewPicker("ui.pickPermissionMode", { provider: "claude" })).toBeNull();
  });

  it("refuses a reasoning pick with no model rather than answering null", () => {
    expect(refusePluginWebviewPicker("ui.pickReasoningEffort", {})).toBe(
      "ADE needs a model to open that reasoning control.",
    );
    expect(refusePluginWebviewPicker("ui.pickReasoningEffort", { model: "claude-opus-4-6" })).toBeNull();
  });

  it("answers null without drawing when the model has no reasoning ladder", () => {
    expect(pluginWebviewPickerImmediateNull("ui.pickLane", {})).toBe(false);
    expect(pluginWebviewPickerImmediateNull("ui.pickReasoningEffort", { model: "missing-model" })).toBe(false);
    const withoutLadder = pluginChatModelCapabilities().find((entry) => entry.reasoningEfforts.length === 0);
    expect(withoutLadder).toBeTruthy();
    expect(pluginWebviewPickerImmediateNull("ui.pickReasoningEffort", { model: withoutLadder!.id })).toBe(true);
  });
});
