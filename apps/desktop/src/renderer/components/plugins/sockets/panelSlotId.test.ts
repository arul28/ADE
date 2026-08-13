import { describe, expect, it } from "vitest";

import { pluginViewerKind, parsePluginViewerKind } from "./contributionModel";
import {
  isPluginPanelSlotId,
  parsePluginPanelSlotId,
  pluginPanelSlotId,
} from "./panelSlotId";

/**
 * Two encoders of one grammar, held to each other.
 *
 * `panelSlotId` exists separately from `contributionModel`'s viewer kind only
 * because the app store and the per-chat companion state cannot import a module
 * that reaches React — see the header note there. That is a packaging reason,
 * not a semantic one, so the two must agree byte for byte forever. This file is
 * what makes them fail loudly rather than diverge quietly on the one input that
 * would ever expose it: an id containing a colon.
 */
describe("plugin panel slot ids", () => {
  it("encodes exactly what the file-viewer kind encodes", () => {
    for (const [pluginId, panelId] of [
      ["prompts", "library"],
      ["a", "b"],
      // A panel id with a colon is the whole reason the split is first-colon.
      ["prompts", "library:v2"],
    ] as const) {
      expect(pluginPanelSlotId(pluginId, panelId)).toBe(pluginViewerKind(pluginId, panelId));
    }
  });

  it("round-trips, and parses what the viewer kind parses", () => {
    const id = pluginPanelSlotId("prompts", "library:v2");
    expect(parsePluginPanelSlotId(id)).toEqual({ pluginId: "prompts", panelId: "library:v2" });
    expect(parsePluginPanelSlotId(id)).toEqual(parsePluginViewerKind(id));
  });

  it("refuses everything a built-in tab id could be", () => {
    // The built-in rail and drawer ids, which must never parse as a slot —
    // a false positive here sends a real tab through the plugin branch.
    for (const builtin of ["terminal", "git", "files", "ios", "app-control", "browser", "agents", "proof"]) {
      expect(isPluginPanelSlotId(builtin)).toBe(false);
    }
    // Structurally short of a slot id: no panel, no plugin, nothing after the
    // prefix at all.
    for (const malformed of ["plugin:", "plugin:prompts", "plugin:prompts:", "plugin::library", ""]) {
      expect(parsePluginPanelSlotId(malformed)).toBeNull();
    }
  });
});
