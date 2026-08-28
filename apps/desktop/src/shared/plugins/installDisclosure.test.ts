import { describe, expect, it } from "vitest";

import {
  PLUGIN_SOCKET_KIND_LABELS,
  PLUGIN_SURFACE_LABELS,
  describePluginContributionPlacement,
} from "./installDisclosure";
import { PLUGIN_SOCKET_KINDS, PLUGIN_SURFACE_IDS } from "./sockets";

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
});
