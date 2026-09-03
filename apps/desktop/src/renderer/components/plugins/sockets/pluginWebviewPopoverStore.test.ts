import { beforeEach, describe, expect, it } from "vitest";

import {
  closePluginWebviewPopover,
  getPluginWebviewPopover,
  openPluginWebviewPopover,
  resetPluginWebviewPopover,
} from "./pluginWebviewPopoverStore";
import { pluginWebviewPopoverPosition } from "./PluginWebviewPopoverHost";

/**
 * The two rules that make an anchored page a control rather than a window.
 *
 * One at a time, because a guest is a renderer process and two anchored cards
 * over one another have no reading; and a second press of the same control
 * closes, because a button whose second press opens a second copy of its own
 * page has a meaning the reader cannot see.
 */

const base = {
  pluginId: "acme",
  surfaceId: "issues",
  kind: "popover" as const,
  subject: null,
  anchor: null,
};

beforeEach(() => {
  resetPluginWebviewPopover();
});

describe("openPluginWebviewPopover", () => {
  it("holds one card at a time, replacing rather than stacking", () => {
    openPluginWebviewPopover(base);
    openPluginWebviewPopover({ ...base, surfaceId: "settings" });
    expect(getPluginWebviewPopover()).toMatchObject({ surfaceId: "settings" });
  });

  it("closes when the same control is pressed again", () => {
    const first = openPluginWebviewPopover(base);
    expect(first).toBeGreaterThan(0);
    expect(openPluginWebviewPopover(base)).toBe(0);
    expect(getPluginWebviewPopover()).toBeNull();
  });

  it("opens rather than toggling when another plugin names the same surface", () => {
    openPluginWebviewPopover(base);
    expect(openPluginWebviewPopover({ ...base, pluginId: "other" })).toBeGreaterThan(0);
    expect(getPluginWebviewPopover()).toMatchObject({ pluginId: "other" });
  });

  it("ignores a close for a card a newer open already replaced", () => {
    const stale = openPluginWebviewPopover(base);
    openPluginWebviewPopover({ ...base, surfaceId: "settings" });
    closePluginWebviewPopover(stale);
    expect(getPluginWebviewPopover()).toMatchObject({ surfaceId: "settings" });
  });
});

describe("pluginWebviewPopoverPosition", () => {
  const viewport = { width: 1200, height: 800 };

  it("uses the host default when the manifest asks for no size", () => {
    const position = pluginWebviewPopoverPosition({ x: 400, y: 40, width: 40, height: 24 }, viewport);
    expect(position.width).toBe(520);
    expect(position.height).toBe(640);
    expect(position.top).toBe(72);
  });

  it("honours the manifest hint", () => {
    const position = pluginWebviewPopoverPosition(
      { x: 400, y: 40, width: 40, height: 24 },
      viewport,
      { width: 360, height: 300 },
    );
    expect(position.width).toBe(360);
    expect(position.height).toBe(300);
  });

  it("clamps a page that asked for more than the window", () => {
    const position = pluginWebviewPopoverPosition(null, viewport, { width: 4000, height: 4000 });
    expect(position.width).toBe(viewport.width - 24);
    expect(position.height).toBe(viewport.height - 24);
    expect(position.left).toBeGreaterThanOrEqual(12);
    expect(position.top).toBeGreaterThanOrEqual(12);
  });

  it("flips above a control at the bottom, which is where a composer picker sits", () => {
    const position = pluginWebviewPopoverPosition(
      { x: 400, y: 740, width: 400, height: 40 },
      viewport,
      { width: 400, height: 400 },
    );
    expect(position.top).toBeLessThan(740);
    expect(position.top).toBeGreaterThanOrEqual(12);
  });

  it("centres a press that came from no locatable control", () => {
    const position = pluginWebviewPopoverPosition(null, viewport, { width: 400, height: 400 });
    expect(position.left).toBe(400);
    expect(position.top).toBe(200);
  });

  it("keeps the card inside the window on the horizontal axis", () => {
    const position = pluginWebviewPopoverPosition(
      { x: 1190, y: 40, width: 10, height: 24 },
      viewport,
      { width: 520, height: 300 },
    );
    expect(position.left + position.width).toBeLessThanOrEqual(viewport.width - 12);
  });
});
