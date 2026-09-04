/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../shared/ModelPicker/ModelPicker", () => ({
  ModelPicker: ({
    onChange,
  }: {
    onChange: (modelId: string, options?: { fastMode: boolean }) => void;
  }) => (
    <button type="button" onClick={() => onChange("anthropic/claude-sonnet-4-5", { fastMode: true })}>
      pick-model
    </button>
  ),
}));

vi.mock("../../terminals/LaneCombobox", () => ({
  LaneCombobox: ({ onChange }: { onChange: (laneId: string) => void }) => (
    <button type="button" onClick={() => onChange("lane-1")}>pick-lane</button>
  ),
}));

vi.mock("../../shared/PermissionModePicker", () => ({
  PermissionModePicker: ({ onSelect }: { onSelect: (value: string) => void }) => (
    <button type="button" onClick={() => onSelect("acceptEdits")}>pick-permission</button>
  ),
}));

vi.mock("../../shared/ModelPicker/ReasoningEffortPicker", () => ({
  ReasoningEffortPicker: ({
    modelId,
    onChange,
  }: {
    modelId: string;
    onChange: (effort: string | null) => void;
  }) => (
    <button type="button" onClick={() => onChange("high")}>pick-reasoning-{modelId}</button>
  ),
}));

vi.mock("../../shared/ModelPicker/ModelPickerRail", () => ({
  ModelPickerRail: ({ onSelect }: { onSelect: (selection: string) => void }) => (
    <button type="button" onClick={() => onSelect("provider:anthropic")}>pick-provider</button>
  ),
}));

vi.mock("../../../state/appStore", () => ({
  useAppStore: (selector: (state: { lanes: { id: string; name: string }[] }) => unknown) =>
    selector({ lanes: [{ id: "lane-1", name: "Main" }] }),
}));

import { PluginWebviewPickerHost } from "./PluginWebviewPickerHost";
import {
  openPluginWebviewPicker,
  resetPluginWebviewPicker,
} from "./pluginWebviewPickerStore";

afterEach(() => {
  cleanup();
  resetPluginWebviewPicker();
});

describe("PluginWebviewPickerHost", () => {
  it("answers a model choice from ADE's own picker, including fast mode", async () => {
    const pending = openPluginWebviewPicker({
      pluginId: "acme",
      guestKey: "guest-1",
      verb: "ui.pickModel",
      args: {},
    });
    render(<PluginWebviewPickerHost />);
    expect(document.querySelector("[data-plugin-webview-picker='ui.pickModel']")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("pick-model"));
    });
    await expect(pending).resolves.toEqual({
      modelId: "anthropic/claude-sonnet-4-5",
      fastMode: true,
    });
  });

  it("answers a lane choice with the id and the display name", async () => {
    const pending = openPluginWebviewPicker({
      pluginId: "acme",
      guestKey: "guest-1",
      verb: "ui.pickLane",
      args: {},
    });
    render(<PluginWebviewPickerHost />);
    await expect(pending).resolves.toEqual({ laneId: "lane-1", name: "Main" });
  });

  it("answers a permission choice with the provider's native field", async () => {
    const pending = openPluginWebviewPicker({
      pluginId: "acme",
      guestKey: "guest-1",
      verb: "ui.pickPermissionMode",
      args: { provider: "claude" },
    });
    render(<PluginWebviewPickerHost />);
    await expect(pending).resolves.toEqual({
      provider: "claude",
      field: "claudePermissionMode",
      value: "acceptEdits",
    });
  });

  it("answers null when the dimmer is dismissed", async () => {
    const pending = openPluginWebviewPicker({
      pluginId: "acme",
      guestKey: "guest-1",
      verb: "ui.pickProvider",
      args: {},
    });
    render(<PluginWebviewPickerHost />);
    const dimmer = document.querySelector("[data-plugin-webview-picker='ui.pickProvider']") as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(dimmer);
    });
    await expect(pending).resolves.toBeNull();
  });
});
