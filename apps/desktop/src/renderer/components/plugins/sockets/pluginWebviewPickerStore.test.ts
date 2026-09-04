import { afterEach, describe, expect, it } from "vitest";

import {
  getPluginWebviewPicker,
  isPluginWebviewPickerVerb,
  openPluginWebviewPicker,
  pickPluginWebviewUi,
  resetPluginWebviewPicker,
  settlePluginWebviewPicker,
} from "./pluginWebviewPickerStore";

afterEach(() => {
  resetPluginWebviewPicker();
});

describe("plugin webview picker store", () => {
  it("answers the choice and forgets the standing request", async () => {
    const pending = openPluginWebviewPicker({
      pluginId: "acme",
      guestKey: "guest-1",
      verb: "ui.pickLane",
      args: {},
    });
    expect(getPluginWebviewPicker()).toMatchObject({ pluginId: "acme", verb: "ui.pickLane" });
    settlePluginWebviewPicker({ laneId: "lane-1", name: "Main" });
    await expect(pending).resolves.toEqual({ laneId: "lane-1", name: "Main" });
    expect(getPluginWebviewPicker()).toBeNull();
  });

  it("answers null when a second picker replaces the first", async () => {
    const first = openPluginWebviewPicker({
      pluginId: "acme",
      guestKey: "guest-1",
      verb: "ui.pickModel",
      args: {},
    });
    const second = openPluginWebviewPicker({
      pluginId: "acme",
      guestKey: "guest-1",
      verb: "ui.pickProvider",
      args: {},
    });
    await expect(first).resolves.toBeNull();
    settlePluginWebviewPicker({ provider: "anthropic" });
    await expect(second).resolves.toEqual({ provider: "anthropic" });
  });

  it("is a picker verb only for the five named pickers", () => {
    expect(isPluginWebviewPickerVerb("ui.pickModel")).toBe(true);
    expect(isPluginWebviewPickerVerb("ui.confirm")).toBe(false);
  });

  it("refuses a non-picker method rather than answering null", async () => {
    await expect(pickPluginWebviewUi("ui.toast", {}, { pluginId: "acme", guestKey: "g" }))
      .rejects.toThrow("This client can’t open that picker yet.");
  });

  it("refuses a permission pick with no provider rather than answering null", async () => {
    await expect(pickPluginWebviewUi("ui.pickPermissionMode", {}, { pluginId: "acme", guestKey: "g" }))
      .rejects.toThrow("ADE doesn’t have a permission control for that provider.");
    expect(getPluginWebviewPicker()).toBeNull();
  });
});
