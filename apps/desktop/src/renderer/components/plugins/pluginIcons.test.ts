import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Claude, Codex, Cursor, Github, OpenAI } from "@lobehub/icons";
import { describe, expect, it } from "vitest";

import { MARKETPLACE_LOCAL_INDEX } from "./marketplaceLocalIndex";
import {
  DEFAULT_PLUGIN_ICON,
  PLUGIN_BRAND_ICON_NAMES,
  PLUGIN_ICON_NAMES,
  PLUGIN_IDENTITY_COLORS,
  PLUGIN_IDENTITY_GLYPHS,
  isPluginBrandIconName,
  officialPluginLogo,
  pluginIcon,
  pluginIdentity,
} from "./pluginIcons";

/**
 * An icon name is untrusted manifest text, and the glyph it resolves to is
 * rendered in the tab rail — which sits ABOVE the route's error boundary, so a
 * value React refuses to render takes the app chrome down rather than one page.
 */
describe("pluginIcon", () => {
  it("never resolves an inherited property to a component", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(pluginIcon(name), `${name} escaped the allowlist`).toBe(DEFAULT_PLUGIN_ICON);
    }
  });

  it("degrades an unknown or absent name instead of returning nothing", () => {
    expect(pluginIcon("no-such-glyph")).toBe(DEFAULT_PLUGIN_ICON);
    expect(pluginIcon(null)).toBe(DEFAULT_PLUGIN_ICON);
    expect(pluginIcon("   ")).toBe(DEFAULT_PLUGIN_ICON);
  });

  it("resolves every published name, case- and space-insensitively", () => {
    expect(PLUGIN_ICON_NAMES.length).toBeGreaterThan(0);
    for (const name of PLUGIN_ICON_NAMES) {
      expect(pluginIcon(name), `${name} is published but does not resolve`).toBeTruthy();
    }
    expect(pluginIcon("  GEAR ")).toBe(pluginIcon("gear"));
  });

  /**
   * A published name must resolve to a REAL glyph, not to the fallback.
   *
   * `toBeTruthy` above cannot tell the two apart — the fallback is a component
   * too — so a token could be advertised in `PLUGIN_ICON_NAMES`, documented in
   * the authoring skill, and still draw a puzzle piece. `puzzle` is excluded
   * because it legitimately IS the fallback glyph.
   */
  it("draws a real glyph for every published name, never the fallback", () => {
    for (const name of PLUGIN_ICON_NAMES) {
      if (name === "puzzle") continue;
      expect(pluginIcon(name), `${name} is published but draws the fallback`)
        .not.toBe(DEFAULT_PLUGIN_ICON);
    }
  });

  /**
   * `beer` by name, because it is the retrospective's literal example.
   *
   * The alpha test's plugin declared `"icon": "beer"`. That token has now been
   * wrong in both directions: first the two clients drew different pictures for
   * it, then desktop lost it entirely while the phone kept it — so the same
   * manifest rendered a mug on iOS and a puzzle piece here. Pinned by name
   * rather than left to the general sweep above, so the specific token the
   * report is written about cannot quietly go missing a third time.
   */
  it("resolves the token the plugin retrospective was written about", () => {
    expect(PLUGIN_ICON_NAMES).toContain("beer");
    expect(pluginIcon("beer")).not.toBe(DEFAULT_PLUGIN_ICON);
    expect(pluginIcon("BEER")).toBe(pluginIcon("beer"));
  });
});

/**
 * A derived identity is not a decoration: it is what a plugin is recognised by
 * in a list, in the tab rail, and on someone else's machine. The only way all
 * three agree is for it to be computed from the id and nothing else.
 */
describe("pluginIdentity", () => {
  it("gives the same plugin the same look every time", () => {
    const first = pluginIdentity({ pluginId: "ade-graph" });
    const second = pluginIdentity({ pluginId: "ade-graph" });
    expect(second.Icon).toBe(first.Icon);
    expect(second.color).toBe(first.color);
  });

  it("draws from the curated lists and never from the raw palette", () => {
    // A colour that is not a token would not invert with the theme, which is the
    // one failure the identity palette exists to prevent.
    const ids = ["ade-graph", "ade-log-viewer", "ade-theme-ink", "a", "zzzz", "ade-review"];
    for (const pluginId of ids) {
      const identity = pluginIdentity({ pluginId });
      expect(PLUGIN_IDENTITY_COLORS, pluginId).toContain(identity.color);
      expect(identity.Icon, pluginId).toBeTruthy();
    }
  });

  it("spreads ids across the palette rather than parking them on one colour", () => {
    const colors = new Set<string>();
    const glyphs = new Set<unknown>();
    for (let index = 0; index < 64; index += 1) {
      const identity = pluginIdentity({ pluginId: `plugin-${index}` });
      colors.add(identity.color);
      glyphs.add(identity.Icon);
    }
    expect(colors.size).toBe(PLUGIN_IDENTITY_COLORS.length);
    expect(glyphs.size).toBeGreaterThan(PLUGIN_IDENTITY_GLYPHS.length / 2);
  });

  it("lets a published glyph and colour win, and ignores a glyph it does not have", () => {
    const named = pluginIdentity({ pluginId: "ade-graph", icon: "graph", accent: "#7C6FF0" });
    expect(named.Icon).toBe(pluginIcon("graph"));
    expect(named.color).toBe("#7C6FF0");

    // An unknown name falls back to the DERIVED glyph rather than to the puzzle
    // piece: the plugin still gets an identity, it just does not get that one.
    const unknown = pluginIdentity({ pluginId: "ade-graph", icon: "no-such-glyph" });
    expect(unknown.Icon).toBe(pluginIdentity({ pluginId: "ade-graph" }).Icon);
  });

  it("carries a published image through and treats blank as absent", () => {
    expect(pluginIdentity({ pluginId: "x", iconUrl: "https://example.test/i.png" }).imageUrl)
      .toBe("https://example.test/i.png");
    expect(pluginIdentity({ pluginId: "x", iconUrl: "   " }).imageUrl).toBeNull();
    expect(pluginIdentity({ pluginId: "x" }).imageUrl).toBeNull();
  });
});

/**
 * The three officials that wear someone else's mark.
 *
 * These are the plugins a reader recognises by logo rather than by name, and
 * the Marketplace's first paint is served from the BUNDLED index — offline, on
 * a machine that has never reached the directory. So the mark has to be in the
 * build, and it has to survive being handed to an `<img>`.
 */
describe("officialPluginLogo", () => {
  const branded = ["ade-linear", "ade-ios-sim", "ade-app-control"];

  it("bundles a self-contained mark for each branded official", () => {
    for (const pluginId of branded) {
      const logo = officialPluginLogo(pluginId);
      expect(logo, pluginId).toBeTruthy();
      // A `data:` URL, so no fetch, no host, and nothing for the directory or
      // the network to be down for.
      expect(logo!.startsWith("data:image/svg+xml,"), pluginId).toBe(true);
      // Encoded, not raw: an unescaped `#` in a fill starts a fragment and
      // truncates the document at the first colour.
      expect(logo, pluginId).not.toContain("#");
      expect(decodeURIComponent(logo!.slice("data:image/svg+xml,".length)), pluginId)
        .toContain("<svg");
    }
  });

  it("gives every other plugin no image, including the officials drawn as glyphs", () => {
    expect(officialPluginLogo("ade-graph")).toBeNull();
    expect(officialPluginLogo("ade-theme-ink")).toBeNull();
    expect(officialPluginLogo("constructor")).toBeNull();
    expect(officialPluginLogo("")).toBeNull();
  });

  it("fills in for a branded official that published no image, and yields to one that did", () => {
    expect(pluginIdentity({ pluginId: "ade-linear" }).imageUrl)
      .toBe(officialPluginLogo("ade-linear"));
    // A directory entry can move a logo without shipping a build, so a
    // published URL still wins over the bundled copy.
    expect(pluginIdentity({ pluginId: "ade-linear", iconUrl: "https://example.test/l.png" }).imageUrl)
      .toBe("https://example.test/l.png");
  });
});

/**
 * The bundled set is the first thing anyone sees in the Marketplace, and it is
 * the one listing ADE controls end to end. Two officials that look alike is a
 * catalogue that reads as unfinished — which is what the derived-glyph fallback
 * produced when several manifests named a glyph this build did not have.
 */
describe("the official set's identities", () => {
  const officials = MARKETPLACE_LOCAL_INDEX.map((listing) => ({
    pluginId: listing.pluginId,
    icon: listing.icon,
    accent: listing.accent,
  }));

  it("names a glyph this build actually has", () => {
    for (const official of officials) {
      expect(official.icon, `${official.pluginId} names no glyph`).toBeTruthy();
      // Not `pluginIcon(icon) !== DEFAULT_PLUGIN_ICON` — `puzzle` is a legal
      // name. The published list is the allowlist.
      expect(PLUGIN_ICON_NAMES, `${official.pluginId} names an unknown glyph`)
        .toContain(official.icon!.toLowerCase());
    }
  });

  it("gives each one a colour of its own", () => {
    const byColor = new Map<string, string[]>();
    for (const official of officials) {
      expect(official.accent, `${official.pluginId} publishes no colour`).toBeTruthy();
      const ids = byColor.get(official.accent!) ?? [];
      ids.push(official.pluginId);
      byColor.set(official.accent!, ids);
    }
    const shared = [...byColor.entries()].filter(([, ids]) => ids.length > 1);
    expect(shared, `officials sharing a colour: ${JSON.stringify(shared)}`).toEqual([]);
  });

  it("never draws two of them the same way", () => {
    const glyphIds = new Map<unknown, number>();
    const looks = officials.map((official) => {
      const identity = pluginIdentity(official);
      if (!glyphIds.has(identity.Icon)) glyphIds.set(identity.Icon, glyphIds.size);
      return identity.imageUrl ?? `${identity.color}:glyph-${glyphIds.get(identity.Icon)!}`;
    });
    // Themes share the palette glyph on purpose, so the pair is what has to be
    // distinct — a reader tells them apart by colour.
    expect(new Set(looks).size).toBe(officials.length);
  });
});

/**
 * The brand tokens, and the one thing that makes them worth having: they draw
 * the SAME mark the rest of the product draws.
 *
 * A token that resolved to a hand-copied SVG would be a second source of truth
 * for a logo, and the two would drift the first time a vendor refreshed theirs.
 * These assertions compare the rendered output against the vendor component
 * `ToolLogos`/`ProviderLogos` already use, so a brand token can only ever be
 * that component.
 */
describe("brand icon tokens", () => {
  const MARKS = {
    "brand:claude": Claude,
    "brand:codex": Codex,
    "brand:cursor": Cursor,
    "brand:github": Github,
    "brand:openai": OpenAI,
  } as const;

  it("ships exactly the closed set, and publishes it for authors", () => {
    expect([...PLUGIN_BRAND_ICON_NAMES]).toEqual([
      "brand:claude",
      "brand:codex",
      "brand:cursor",
      "brand:github",
      "brand:openai",
    ]);
    for (const name of PLUGIN_BRAND_ICON_NAMES) {
      expect(PLUGIN_ICON_NAMES, `${name} is not offered to authors`).toContain(name);
      expect(isPluginBrandIconName(name)).toBe(true);
    }
  });

  it("draws the same mark the rest of the product draws", () => {
    for (const [token, Mark] of Object.entries(MARKS)) {
      const Token = pluginIcon(token);
      expect(renderToStaticMarkup(createElement(Token, { size: 18 })), token)
        .toContain(renderToStaticMarkup(createElement(Mark, { size: 18 })));
    }
  });

  it("takes Phosphor's props without leaking weight onto the svg", () => {
    // Every caller renders the result as `<Icon size weight color />`. `weight`
    // has no meaning for a logo and React warns if it reaches an element, so the
    // wrapper must swallow it rather than spread it.
    const markup = renderToStaticMarkup(
      createElement(pluginIcon("brand:cursor"), { size: 11, weight: "regular", color: "#fff" }),
    );
    expect(markup).not.toContain("weight");
    expect(markup).toContain("#fff");
  });

  it("degrades an unknown brand token exactly like any other unknown token", () => {
    for (const name of ["brand:linear", "brand:", "brand:nope", "brand", "cursor"]) {
      expect(pluginIcon(name), `${name} resolved to something`).toBe(DEFAULT_PLUGIN_ICON);
      expect(isPluginBrandIconName(name)).toBe(false);
    }
  });

  it("lets a manifest name one as its published identity", () => {
    const identity = pluginIdentity({ pluginId: "ade-cursor-cloud", icon: "brand:cursor" });
    expect(identity.Icon).toBe(pluginIcon("brand:cursor"));
    // Not the derived glyph: a named token that resolves must win, which is the
    // whole reason `pluginIdentity` has to know about this map too.
    expect(identity.Icon).not.toBe(pluginIdentity({ pluginId: "ade-cursor-cloud" }).Icon);
  });

  it("gives the Cursor Cloud plugin the Cursor mark in the bundled catalogue", () => {
    const listing = MARKETPLACE_LOCAL_INDEX.find((entry) => entry.pluginId === "ade-cursor-cloud");
    expect(listing?.icon).toBe("brand:cursor");
    expect(pluginIdentity(listing!).Icon).toBe(pluginIcon("brand:cursor"));
  });
});
