import { describe, expect, it } from "vitest";

import {
  PLUGIN_SOCKET_KIND_LABELS,
  PLUGIN_SURFACE_LABELS,
  describeManifestAdds,
  describeManifestRemoves,
  describePluginContributionPlacement,
} from "./installDisclosure";
import { parsePluginManifest, type PluginManifest } from "./manifest";
import { PLUGIN_SOCKET_KINDS, PLUGIN_SURFACE_IDS } from "./sockets";

/** A manifest with only the surfaces a case needs. */
function manifestWithSurfaces(surfaces: Array<Record<string, unknown>>): PluginManifest {
  const parsed = parsePluginManifest({
    name: "ade-focus",
    version: "1.0.0",
    displayName: "Focus",
    description: "A pomodoro timer.",
    vocabVersion: 1,
    // No `entry`: a UI-only plugin, so the "Adds:" list is exactly the surface
    // lines this suite is about.
    surfaces,
    panels: [{ id: "focus" }, { id: "other" }],
  });
  expect(parsed.errors).toEqual([]);
  return parsed.manifest!;
}

/**
 * The reader-facing names for the taxonomy.
 *
 * `Record<PluginSocketKind, string>` already makes a MISSING kind a type error.
 * What the compiler cannot catch is a kind added with a placeholder, a duplicate
 * that makes two different additions read identically — which is the exact bug
 * these labels exist to fix — or a label that is the identifier with the hyphens
 * taken out, which teaches the reader the vocabulary instead of sparing them it.
 */

describe("socket kind labels", () => {
  it("names every kind in the taxonomy, once each", () => {
    const labels = PLUGIN_SOCKET_KINDS.map((kind) => PLUGIN_SOCKET_KIND_LABELS[kind]);
    expect(labels).toHaveLength(PLUGIN_SOCKET_KINDS.length);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.trim().length).toBeGreaterThan(0);
  });

  it("is sentence case, because these sit in a UI that writes prose", () => {
    for (const kind of PLUGIN_SOCKET_KINDS) {
      const label = PLUGIN_SOCKET_KIND_LABELS[kind];
      expect(label[0], kind).toBe(label[0]?.toUpperCase());
      // No Title Case beyond the first word. "Work" survives because it is the
      // tab's own name, which the surface labels capitalize too.
      const shouted = label.slice(1).split(" ").filter((word) => /^[A-Z]/.test(word));
      expect(shouted.every((word) => word === "Work"), `${kind}: ${label}`).toBe(true);
    }
  });

  it("names the four kinds whose identifiers are jargon in the product's words", () => {
    // The four an author writes and a reader has no reason to learn. Each is a
    // thing on screen: the rail it appears in, the box it sits beside.
    expect(PLUGIN_SOCKET_KIND_LABELS["work-rail-pane"]).toBe("Work tools pane");
    expect(PLUGIN_SOCKET_KIND_LABELS["drawer-tab"]).toBe("Chat drawer tab");
    expect(PLUGIN_SOCKET_KIND_LABELS["chat-header-action"]).toBe("Chat header button");
    expect(PLUGIN_SOCKET_KIND_LABELS["composer-action"]).toBe("Composer button");
  });

  it("separates the two additions one plugin can make to one surface", () => {
    // The dogfood failure, as a sentence pair: HN's header button and its Work
    // pane are both labelled "HN" on the surface "work", and the rows were
    // therefore identical.
    expect(describePluginContributionPlacement("chat-header-action", "work"))
      .toBe("Chat header button in Work");
    expect(describePluginContributionPlacement("work-rail-pane", "work"))
      .toBe("Work tools pane in Work");
  });

  it("reads correctly for every surface a socket may name", () => {
    for (const surface of PLUGIN_SURFACE_IDS) {
      expect(describePluginContributionPlacement("toolbar-action", surface))
        .toBe(`Toolbar button in ${PLUGIN_SURFACE_LABELS[surface]}`);
    }
  });

  it("names a row-badge on app as a notification on the plugin's tab", () => {
    expect(describePluginContributionPlacement("row-badge", "app"))
      .toBe("Notification badge on its tab");
    expect(describePluginContributionPlacement("row-badge", "lanes"))
      .toBe("Row badge in Lanes");
  });
});

/**
 * One feature declared as two surfaces must be disclosed as one line.
 *
 * The pomodoro plugin from the live round declared a `webview` for its rich
 * desktop tab and a `tab` for the panel every other client renders in its
 * place — the shape the docs recommend — and the card listed "Focus tab" AND
 * "Focus tab — desktop only, custom UI", which reads as a plugin claiming two
 * tabs in the rail. It claims one.
 */
describe("surface disclosure", () => {
  it("says a tab and its webview twin once, naming what each client gets", () => {
    const manifest = manifestWithSurfaces([
      { kind: "tab", id: "focus-tab", title: "Focus", panelId: "focus" },
      { kind: "webview", id: "focus-web", title: "Focus", panelId: "focus", entryHtml: "ui/index.html" },
    ]);
    expect(describeManifestAdds(manifest)).toEqual([
      "Focus tab (custom UI on desktop; panel on other devices)",
    ]);
  });

  it("pairs on the shared panel id even when the two titles differ", () => {
    // The strong signal: the webview's `panelId` IS what the phone draws, so a
    // tab rendering the same panel is that same surface however it is titled.
    const manifest = manifestWithSurfaces([
      { kind: "tab", id: "focus-tab", title: "Focus", panelId: "focus" },
      { kind: "webview", id: "focus-web", title: "Focus Timer", panelId: "focus", entryHtml: "ui/index.html" },
    ]);
    expect(describeManifestAdds(manifest)).toEqual([
      "Focus tab (custom UI on desktop; panel on other devices)",
    ]);
  });

  it("keeps the desktop-only line for a webview with no tab half", () => {
    const manifest = manifestWithSurfaces([
      { kind: "webview", id: "focus-web", title: "Focus", panelId: "focus", entryHtml: "ui/index.html" },
    ]);
    expect(describeManifestAdds(manifest)).toEqual(["Focus tab — desktop only, custom UI"]);
  });

  it("leaves an unrelated tab and webview as two lines", () => {
    const manifest = manifestWithSurfaces([
      { kind: "tab", id: "focus-tab", title: "Focus", panelId: "focus" },
      { kind: "webview", id: "stats-web", title: "Stats", panelId: "other", entryHtml: "ui/index.html" },
    ]);
    expect(describeManifestAdds(manifest)).toEqual([
      "Focus tab",
      "Stats tab — desktop only, custom UI",
    ]);
  });

  it("counts the pair once on the removal card too, in either declaration order", () => {
    // The removal card is read beside the install card it undoes. If one said
    // one tab and the other said two, the comparison the reader is making —
    // "is this the thing I agreed to?" — would fail on a plugin that changed
    // nothing.
    const webviewFirst = manifestWithSurfaces([
      { kind: "webview", id: "focus-web", title: "Focus", panelId: "focus", entryHtml: "ui/index.html" },
      { kind: "tab", id: "focus-tab", title: "Focus", panelId: "focus" },
    ]);
    expect(describeManifestRemoves(webviewFirst).filter((line) => line.startsWith("Focus")))
      .toEqual(["Focus tab"]);
    const tabFirst = manifestWithSurfaces([
      { kind: "tab", id: "focus-tab", title: "Focus", panelId: "focus" },
      { kind: "webview", id: "focus-web", title: "Focus", panelId: "focus", entryHtml: "ui/index.html" },
    ]);
    expect(describeManifestRemoves(tabFirst).filter((line) => line.startsWith("Focus")))
      .toEqual(["Focus tab"]);
  });

  it("does not let two same-named tabs both claim one webview", () => {
    const manifest = manifestWithSurfaces([
      { kind: "tab", id: "focus-a", title: "Focus", panelId: "focus" },
      { kind: "tab", id: "focus-b", title: "Focus", panelId: "other" },
      { kind: "webview", id: "focus-web", title: "Focus", panelId: "focus", entryHtml: "ui/index.html" },
    ]);
    expect(describeManifestAdds(manifest)).toEqual([
      "Focus tab (custom UI on desktop; panel on other devices)",
      "Focus tab",
    ]);
  });
});
