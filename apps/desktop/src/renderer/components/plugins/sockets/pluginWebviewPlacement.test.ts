/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";

import { readPluginActionWebview } from "../../../../shared/plugins/sdk";
import { openPluginActionWebview } from "./pluginActionDispatch";
import {
  getPluginWebviewPopover,
  resetPluginWebviewPopover,
} from "./pluginWebviewPopoverStore";
import {
  closePluginWebviewOverlay,
  getPluginWebviewOverlay,
} from "./pluginWebviewOverlayStore";

/**
 * Where an `openWebview` answer actually lands.
 *
 * Two rules are worth pinning, and both are about what a plugin CANNOT decide.
 * An answer with no placement opens the overlay, which is what every
 * `openWebview` meant before the page tier had more than one host — an older
 * plugin must not move because the host grew. And a `picker` asked for from a
 * screen with no composer becomes a popover under the pressed control, because
 * refusing would leave the reader with a button that does nothing on a screen
 * where the page would have been perfectly readable.
 */

beforeEach(() => {
  resetPluginWebviewPopover();
  closePluginWebviewOverlay();
});

describe("readPluginActionWebview", () => {
  it("reads a placement the plugin asked for", () => {
    expect(readPluginActionWebview({ openWebview: { surfaceId: "issues", placement: "picker" } }))
      .toEqual({ surfaceId: "issues", placement: "picker" });
  });

  it("drops an unknown placement and keeps the open", () => {
    expect(readPluginActionWebview({ openWebview: { surfaceId: "issues", placement: "sidebar" } }))
      .toEqual({ surfaceId: "issues" });
  });

  it("keeps the pointer beside the placement", () => {
    expect(readPluginActionWebview({
      openWebview: { surfaceId: "issues", placement: "popover", context: { issue: "ADE-1" } },
    })).toEqual({ surfaceId: "issues", placement: "popover", context: { issue: "ADE-1" } });
  });
});

describe("openPluginActionWebview", () => {
  it("opens the overlay when the answer names no placement", () => {
    expect(openPluginActionWebview({
      pluginId: "acme",
      surfaceId: "issues",
      subject: null,
    })).toBe("overlay");
    expect(getPluginWebviewPopover()).toBeNull();
    expect(getPluginWebviewOverlay()).toMatchObject({ pluginId: "acme", surfaceId: "issues" });
  });

  it("anchors a popover at the control that was pressed", () => {
    expect(openPluginActionWebview({
      pluginId: "acme",
      surfaceId: "issues",
      placement: "popover",
      subject: null,
      anchor: { x: 10, y: 20, width: 30, height: 40 },
    })).toBe("popover");
    expect(getPluginWebviewPopover()).toMatchObject({
      kind: "popover",
      anchor: { x: 10, y: 20, width: 30, height: 40 },
    });
  });

  it("anchors a picker at the composer row when one is on screen", () => {
    const row = document.createElement("div");
    row.setAttribute("data-plugin-composer-anchor", "work");
    row.getBoundingClientRect = () => ({
      x: 0, y: 700, left: 0, top: 700, width: 600, height: 32,
      right: 600, bottom: 732, toJSON: () => ({}),
    });
    document.body.appendChild(row);
    try {
      expect(openPluginActionWebview({
        pluginId: "acme",
        surfaceId: "issues",
        placement: "picker",
        subject: null,
        anchor: { x: 10, y: 20, width: 30, height: 40 },
      })).toBe("composer-picker");
      expect(getPluginWebviewPopover()).toMatchObject({
        kind: "composer-picker",
        anchor: { x: 0, y: 700, width: 600, height: 32 },
      });
    } finally {
      row.remove();
    }
  });

  it("falls back to the pressed control when there is no composer to anchor to", () => {
    expect(openPluginActionWebview({
      pluginId: "acme",
      surfaceId: "issues",
      placement: "picker",
      subject: null,
      anchor: { x: 10, y: 20, width: 30, height: 40 },
    })).toBe("composer-picker");
    expect(getPluginWebviewPopover()).toMatchObject({
      kind: "composer-picker",
      anchor: { x: 10, y: 20, width: 30, height: 40 },
    });
  });

  it("carries the plugin's pointer through to the page", () => {
    openPluginActionWebview({
      pluginId: "acme",
      surfaceId: "issues",
      placement: "popover",
      subject: null,
      pointer: { issue: "ADE-148" },
    });
    expect(getPluginWebviewPopover()).toMatchObject({ pointer: { issue: "ADE-148" } });
  });
});
