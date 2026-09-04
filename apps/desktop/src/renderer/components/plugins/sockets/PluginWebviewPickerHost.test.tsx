/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const { modelPickState } = vi.hoisted(() => ({
  modelPickState: { modelId: "anthropic/claude-sonnet-5" },
}));

vi.mock("../../shared/ModelPicker/ModelPicker", () => ({
  ModelPicker: ({
    onChange,
  }: {
    onChange: (modelId: string, options?: { fastMode: boolean }) => void;
  }) => (
    <button type="button" onClick={() => onChange(modelPickState.modelId, { fastMode: true })}>
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

import { createUnknownModelPlaceholder } from "../../shared/ModelPicker/modelCatalog";
import {
  DEFAULT_RUNTIME_CATALOG_SCOPE,
  clearRuntimeCatalogScopeDescriptors,
  runtimeCatalogScopeDescriptors,
} from "../../shared/ModelPicker/runtimeCatalogCache";
import { PluginWebviewPickerHost } from "./PluginWebviewPickerHost";
import {
  openPluginWebviewPicker,
  resetPluginWebviewPicker,
} from "./pluginWebviewPickerStore";

afterEach(() => {
  cleanup();
  resetPluginWebviewPicker();
  modelPickState.modelId = "anthropic/claude-sonnet-5";
  clearRuntimeCatalogScopeDescriptors();
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
    await expect(pending).resolves.toEqual(expect.objectContaining({
      modelId: "anthropic/claude-sonnet-5",
      fastMode: true,
      provider: "claude",
    }));
  });

  /**
   * A model only the RUNTIME CATALOG knows, which is the case the answer used
   * to drop.
   *
   * The Cursor and Droid CLI models are built per checkout from what the CLI
   * reports, so they never reach the module-level registries — but ADE's own
   * picker offers them, and this host renders that picker. Resolving the pick
   * through `getModelById` alone therefore found nothing, and the reply carried
   * no `provider`. `ui.pickPermissionMode` takes `provider` as its argument, so
   * the page's permission picker had nothing to key on and refused: the reader
   * chose a model from ADE's own list and got a dead control.
   */
  it("names the provider for a model only the runtime catalog knows", async () => {
    // What `buildRuntimeCatalogDescriptors` does with a model id the registry
    // has never heard of: a placeholder, filed under the bound machine's scope.
    // The picker offers it, so a reader can choose it.
    const catalogModel = createUnknownModelPlaceholder("acme-provider/acme-model");
    runtimeCatalogScopeDescriptors(DEFAULT_RUNTIME_CATALOG_SCOPE)
      .set(catalogModel.id, catalogModel);
    modelPickState.modelId = catalogModel.id;

    const pending = openPluginWebviewPicker({
      pluginId: "acme",
      guestKey: "guest-1",
      verb: "ui.pickModel",
      args: {},
    });
    render(<PluginWebviewPickerHost />);
    await act(async () => {
      fireEvent.click(screen.getByText("pick-model"));
    });

    const answer = await pending as Record<string, unknown>;
    expect(answer.modelId).toBe("acme-provider/acme-model");
    expect(answer.provider).toBe("opencode");
    // The provider named is one `chat.capabilities` lists, so the page can look
    // its permission modes up from the same answer it already holds. Both of
    // these were absent before, and `ui.pickPermissionMode` takes `provider`.
    expect(answer.defaultPermissionMode).toBe("edit");
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
      label: "Accept edits",
    });
  });

  it("anchors to the guest-relative rect the page measured", () => {
    const guest = document.createElement("div");
    guest.setAttribute("data-plugin-webview-guest", "guest-1");
    Object.defineProperty(guest, "getBoundingClientRect", {
      value: () => ({ top: 100, left: 200, width: 400, height: 300, right: 600, bottom: 400, x: 200, y: 100, toJSON: () => ({}) }),
    });
    document.body.appendChild(guest);
    try {
      openPluginWebviewPicker({
        pluginId: "acme",
        guestKey: "guest-1",
        verb: "ui.pickProvider",
        args: { rect: { top: 40, left: 80, width: 96, height: 24 } },
      });
      render(<PluginWebviewPickerHost />);
      const holder = document.querySelector("[data-plugin-webview-picker='ui.pickProvider'] > div") as HTMLElement;
      expect(holder.style.top).toBe("140px");
      expect(holder.style.left).toBe("280px");
      expect(holder.style.width).toBe("96px");
      expect(holder.style.minHeight).toBe("24px");
    } finally {
      guest.remove();
    }
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
