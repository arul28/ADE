import { describe, expect, it } from "vitest";

import {
  PLUGIN_OVERLAY_STACK_MAX,
  pushPluginOverlayFrame,
  type PluginOverlayFrame,
} from "./PluginWebviewOverlayHost";

/**
 * The plugin overlay's own back stack.
 *
 * A plugin tab has the router — `PluginTabPage` writes `?panel=` with
 * `replace: false`, so Back is the browser's and costs nothing. The overlay has
 * no address, and before this it passed no `onNavigate` at all: the `{navigate}`
 * verb was silently DROPPED there, so a panel that sent the reader to a detail
 * view did nothing visible and its author had no way to learn why.
 *
 * The rules are the phone's, so a plugin's navigation behaves the same in both
 * places.
 */
describe("plugin overlay back stack", () => {
  const root = { panelId: "fleet", title: "Fleet" };
  const noFrames: readonly PluginOverlayFrame[] = [];

  it("pushes a navigation to a different panel", () => {
    const frames = pushPluginOverlayFrame(noFrames, { panelId: "agent" }, root);
    expect(frames.map((frame) => frame.panelId)).toEqual(["agent"]);
  });

  it("replaces rather than pushes when the navigation names the panel on top", () => {
    // The plugin is re-addressing the screen the reader is on, usually with a
    // new context. A push would leave a Back that goes nowhere visible.
    const opened = pushPluginOverlayFrame(noFrames, { panelId: "agent" }, root);
    const readdressed = pushPluginOverlayFrame(
      opened,
      { panelId: "agent", context: { id: "bc-2" } },
      root,
    );
    expect(readdressed.map((frame) => frame.panelId)).toEqual(["agent"]);
    expect(readdressed[0]?.context).toEqual({ id: "bc-2" });
    // The title stays the one the frame was pushed under, so the chevron
    // beneath it does not rename itself under the reader.
    expect(readdressed[0]?.title).toBe("agent");
  });

  it("treats a navigation to the root panel as a replace of nothing", () => {
    // Nothing is stacked, so there is nothing to replace and nothing to push:
    // the overlay is already showing that panel.
    expect(pushPluginOverlayFrame(noFrames, { panelId: "fleet" }, root)).toEqual([]);
  });

  it("caps the stack and drops the oldest", () => {
    let frames = noFrames;
    for (let index = 0; index < 20; index += 1) {
      frames = pushPluginOverlayFrame(frames, { panelId: `panel-${index}` }, root);
    }
    expect(frames).toHaveLength(PLUGIN_OVERLAY_STACK_MAX);
    expect(frames[0]?.panelId).toBe("panel-12");
    expect(frames[frames.length - 1]?.panelId).toBe("panel-19");
  });

  it("carries a navigation's context and omits it when there is none", () => {
    const withContext = pushPluginOverlayFrame(
      noFrames,
      { panelId: "agent", context: { id: "bc-1" } },
      root,
    );
    expect(withContext[0]?.context).toEqual({ id: "bc-1" });
    // Absent rather than an empty object: the destination is not still about
    // what the previous panel was about, and `renderContext` reads the
    // difference.
    expect(pushPluginOverlayFrame(noFrames, { panelId: "agent" }, root)[0])
      .not.toHaveProperty("context");
  });
});
