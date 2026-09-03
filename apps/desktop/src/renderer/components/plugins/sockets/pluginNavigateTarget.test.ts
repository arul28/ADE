import { describe, expect, it } from "vitest";

import { resolvePluginNavigateTarget } from "./pluginNavigateTarget";

/**
 * Where a plugin's `{navigate}` lands, and when it refuses to land at all.
 *
 * The table this pins is the fix for the two failures the HN dogfood run hit in
 * one press: a header button inside a chat took the whole tab away from the
 * chat, and a navigation that could not mount did nothing at all.
 */

function input(overrides: Partial<Parameters<typeof resolvePluginNavigateTarget>[0]> = {}) {
  return {
    pluginId: "hn",
    navigation: { panelId: "stories" },
    socket: "chat-header-action" as const,
    registryLoaded: true,
    plugin: { displayName: "Hacker News", enabled: true, surfacePanelIds: ["stories"] },
    railPanelIds: ["stories"],
    declaredPanelIds: ["stories"],
    ...overrides,
  };
}

describe("a press inside a conversation", () => {
  it("opens the plugin's Work pane rather than leaving the chat", () => {
    const result = resolvePluginNavigateTarget(input());
    expect(result).toMatchObject({
      kind: "tools-pane",
      slotId: "plugin:hn:stories",
      panelId: "stories",
    });
  });

  it("does the same for a composer button, which also receives the chat", () => {
    const result = resolvePluginNavigateTarget(input({ socket: "composer-action" }));
    expect(result.kind).toBe("tools-pane");
  });

  it("carries the navigation's own context to the pane", () => {
    const result = resolvePluginNavigateTarget(input({
      navigation: { panelId: "stories", context: { feed: "ask" } },
    }));
    expect(result).toMatchObject({ kind: "tools-pane", context: { feed: "ask" } });
  });

  it("falls back to the tab when the plugin declares no pane for that panel", () => {
    // A plugin with a tab and no rail pane is the common shape, and the tab is
    // where its panel has always opened. Preferring the pane must not invent one.
    const result = resolvePluginNavigateTarget(input({ railPanelIds: [] }));
    expect(result).toMatchObject({ kind: "tab", panelId: "stories" });
  });

  it("falls back to the tab when the pane it declares draws a different panel", () => {
    const result = resolvePluginNavigateTarget(input({ railPanelIds: ["settings"] }));
    expect(result.kind).toBe("tab");
  });
});

describe("a press from anywhere else", () => {
  it("keeps the tab route, pane or no pane", () => {
    for (const socket of ["toolbar-action", "row-menu-item", "command-palette-action"] as const) {
      expect(resolvePluginNavigateTarget(input({ socket })).kind).toBe("tab");
    }
  });

  it("keeps the tab route when no socket is named at all", () => {
    const { socket: _socket, ...rest } = input();
    expect(resolvePluginNavigateTarget(rest).kind).toBe("tab");
  });
});

describe("an explicit target", () => {
  it('sends a chat press to the tab when the plugin asks for "tab"', () => {
    const result = resolvePluginNavigateTarget(input({
      navigation: { panelId: "stories", target: "tab" },
    }));
    expect(result.kind).toBe("tab");
  });

  it('sends a toolbar press to the pane when the plugin asks for "tools-pane"', () => {
    const result = resolvePluginNavigateTarget(input({
      socket: "toolbar-action",
      navigation: { panelId: "stories", target: "tools-pane" },
    }));
    expect(result.kind).toBe("tools-pane");
  });

  it('falls back to the tab when "tools-pane" names a place this plugin does not have', () => {
    const result = resolvePluginNavigateTarget(input({
      railPanelIds: [],
      navigation: { panelId: "stories", target: "tools-pane" },
    }));
    expect(result.kind).toBe("tab");
  });
});

describe("a navigation that cannot land says so", () => {
  it("refuses a panel the plugin does not declare", () => {
    const result = resolvePluginNavigateTarget(input({
      navigation: { panelId: "typo" },
      railPanelIds: [],
      plugin: { displayName: "Hacker News", enabled: true, surfacePanelIds: ["stories"] },
    }));
    expect(result).toMatchObject({ kind: "unreachable", displayName: "Hacker News" });
    expect((result as { reason: string }).reason).toContain("typo");
  });

  it("refuses a plugin that is no longer installed", () => {
    const result = resolvePluginNavigateTarget(input({ plugin: null }));
    expect(result).toMatchObject({ kind: "unreachable", displayName: "hn" });
    expect((result as { reason: string }).reason).toContain("installed");
  });

  it("refuses a plugin the reader switched off", () => {
    const result = resolvePluginNavigateTarget(input({
      plugin: { displayName: "Hacker News", enabled: false, surfacePanelIds: ["stories"] },
    }));
    expect(result).toMatchObject({ kind: "unreachable" });
    expect((result as { reason: string }).reason).toContain("switched off");
  });

  it("does not judge anything before the registry has resolved", () => {
    // An empty `installedPlugins` is what a not-yet-loaded registry looks like,
    // and refusing on it would break a press made during startup.
    const result = resolvePluginNavigateTarget(input({
      registryLoaded: false,
      plugin: null,
      railPanelIds: [],
      declaredPanelIds: null,
    }));
    expect(result.kind).toBe("tab");
  });

  it("does not judge a panel when the manifest could not be read", () => {
    // Null is "nobody knows", and refusing on it would break every navigation
    // made before the manifest read lands — a worse bug than the silence.
    const result = resolvePluginNavigateTarget(input({
      navigation: { panelId: "anything" },
      railPanelIds: [],
      declaredPanelIds: null,
    }));
    expect(result.kind).toBe("tab");
  });

  it("trusts a live rail pane over a manifest that does not mention the panel", () => {
    // A dynamically published `work-rail-pane` row is proof the panel exists,
    // whatever a stale manifest snapshot says.
    const result = resolvePluginNavigateTarget(input({
      navigation: { panelId: "live" },
      railPanelIds: ["live"],
      declaredPanelIds: ["stories"],
    }));
    expect(result).toMatchObject({ kind: "tools-pane", slotId: "plugin:hn:live" });
  });
});

describe("the popover placement", () => {
  it("resolves whatever socket the press came from", () => {
    // Unlike `tools-pane`, this needs no container to exist: the host is
    // mounted once for the whole app, so a top-bar button — the case the
    // placement was added for — can have one with no chat in sight.
    const fromToolbar = resolvePluginNavigateTarget(input({
      socket: "toolbar-action",
      navigation: { panelId: "stories", target: "popover" },
      railPanelIds: [],
    }));
    expect(fromToolbar).toMatchObject({ kind: "popover", pluginId: "hn", panelId: "stories" });

    const fromChat = resolvePluginNavigateTarget(input({
      navigation: { panelId: "stories", target: "popover" },
    }));
    expect(fromChat.kind).toBe("popover");
  });

  it("carries the navigation's own context into the card", () => {
    const result = resolvePluginNavigateTarget(input({
      socket: "toolbar-action",
      navigation: { panelId: "stories", target: "popover", context: { feed: "ask" } },
    }));
    expect(result).toMatchObject({ kind: "popover", context: { feed: "ask" } });
  });

  it("is never derived — a toolbar press with no target still opens the tab", () => {
    const result = resolvePluginNavigateTarget(input({
      socket: "toolbar-action",
      railPanelIds: [],
    }));
    expect(result).toMatchObject({ kind: "tab" });
  });

  it("still refuses a panel the plugin does not have", () => {
    // The placement is decided after the reachability checks, so asking for a
    // popover cannot get a plugin past them.
    const result = resolvePluginNavigateTarget(input({
      socket: "toolbar-action",
      navigation: { panelId: "ghost", target: "popover" },
      railPanelIds: [],
      declaredPanelIds: ["stories"],
      plugin: { displayName: "Hacker News", enabled: true, surfacePanelIds: ["stories"] },
    }));
    expect(result).toMatchObject({ kind: "unreachable", panelId: "ghost" });
  });

  it("still refuses a plugin the reader switched off", () => {
    const result = resolvePluginNavigateTarget(input({
      socket: "toolbar-action",
      navigation: { panelId: "stories", target: "popover" },
      plugin: { displayName: "Hacker News", enabled: false, surfacePanelIds: ["stories"] },
    }));
    expect(result.kind).toBe("unreachable");
  });
});
