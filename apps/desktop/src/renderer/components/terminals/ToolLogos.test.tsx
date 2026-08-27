/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";

import { ToolLogo } from "./ToolLogos";
import { DEFAULT_PLUGIN_ICON, pluginIcon } from "../plugins/pluginIcons";

/**
 * A plugin-owned chat has exactly one tool type — `"other"` — because there is
 * one for every plugin. So the only thing that can say WHICH plugin a chat
 * belongs to is the runtime's declared icon token, and `ToolLogo` has to draw
 * it. The rule this file protects: an unknown token degrades to the same
 * puzzle-piece a socket would draw, and never to another provider's mark.
 */

afterEach(cleanup);

/**
 * Phosphor renders an inline `<svg>` and lobehub's provider avatars render
 * their own markup, so the honest comparison is "did this draw the same thing
 * that component draws on its own", not a brittle assertion about paths.
 */
function markupOf(node: React.ReactElement): string {
  const { container, unmount } = render(node);
  const html = container.innerHTML;
  unmount();
  return html;
}

function iconMarkup(Icon: ReturnType<typeof pluginIcon>, size: number): string {
  return markupOf(<Icon size={size} weight="regular" />);
}

describe("ToolLogo plugin icon path", () => {
  it("draws the runtime's declared icon for a plugin-owned session", () => {
    const html = markupOf(<ToolLogo toolType="other" pluginIconName="cloud" size={10} />);
    // Resolved through `pluginIcon`, the SAME token list the socket renderers
    // use — not a second table that could drift from it.
    expect(html).toContain(iconMarkup(pluginIcon("cloud"), 10));
  });

  it("takes the token case-insensitively, as the shared resolver does", () => {
    const lower = markupOf(<ToolLogo toolType="other" pluginIconName="cloud" size={10} />);
    const upper = markupOf(<ToolLogo toolType="other" pluginIconName="CLOUD" size={10} />);
    expect(upper).toBe(lower);
  });

  it("falls back to the puzzle piece for a token nobody declared", () => {
    const html = markupOf(
      <ToolLogo toolType="other" pluginIconName="not-a-real-icon-token" size={10} />,
    );
    // The default a socket draws, never a borrowed provider mark.
    expect(html).toContain(iconMarkup(DEFAULT_PLUGIN_ICON, 10));
  });

  it("does not resolve a prototype key into something React cannot render", () => {
    // `pluginIcon` uses `Object.hasOwn` because the token comes from an
    // untrusted manifest, and a header glyph renders above the route's error
    // boundary — so one word could otherwise take the app chrome down.
    for (const token of ["constructor", "toString", "__proto__"]) {
      const html = markupOf(<ToolLogo toolType="other" pluginIconName={token} size={10} />);
      expect(html, token).toContain(iconMarkup(DEFAULT_PLUGIN_ICON, 10));
    }
  });

  it("leaves an ordinary provider session on its own logo", () => {
    // The reservation must cost a built-in runtime nothing: with no plugin
    // token, every existing call site behaves exactly as it did before.
    for (const toolType of ["claude-chat", "codex-chat", "cursor", "droid-chat"] as const) {
      const withoutToken = markupOf(<ToolLogo toolType={toolType} size={16} />);
      const withNullToken = markupOf(
        <ToolLogo toolType={toolType} pluginIconName={null} size={16} />,
      );
      expect(withNullToken, toolType).toBe(withoutToken);
      // And it is emphatically not the puzzle piece.
      expect(withoutToken, toolType).not.toContain(iconMarkup(DEFAULT_PLUGIN_ICON, 16));
    }
  });

  it("still falls back to the shell mark for an unmapped tool type", () => {
    // `"other"` is what a plugin-owned row carries, and with no token in hand
    // the old behaviour stands rather than a puzzle piece appearing on a
    // terminal row that has nothing to do with plugins.
    const other = markupOf(<ToolLogo toolType="other" size={16} />);
    const shell = markupOf(<ToolLogo toolType="shell" size={16} />);
    expect(other).toBe(shell);
  });

  it("ignores an empty token rather than drawing a default over a real logo", () => {
    const empty = markupOf(<ToolLogo toolType="claude-chat" pluginIconName="" size={16} />);
    expect(empty).toBe(markupOf(<ToolLogo toolType="claude-chat" size={16} />));
  });
});
