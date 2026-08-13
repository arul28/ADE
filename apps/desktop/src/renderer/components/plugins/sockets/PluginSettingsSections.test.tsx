/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  PLUGIN_SETTINGS_FALLBACK_TAB,
  PluginSettingsSections,
  resolvePluginSettingsTab,
} from "./PluginSettingsSections";

/**
 * The `settings-section` socket.
 *
 * Two things are being proved. That a section lands on the page its payload
 * names — through any of the three forms a plugin author plausibly writes —
 * and that a name this build has never heard of lands SOMEWHERE rather than
 * vanishing, because settings page ids are ADE's own furniture and they move.
 *
 * The registry fixture is CONSTANT for the whole file, deliberately: the
 * contribution stores are module-level and load once per surface, which is the
 * perf law that keeps a hundred rows from making a hundred IPC calls. Install
 * state that has to differ gets its own file — see
 * `PluginSettingsSections.disabled.test.tsx`.
 */

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "jira",
          displayName: "Jira",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "jira",
        version: "1.0.0",
        sockets: [
          // Omits `section`, so it lands in the fallback area — the documented
          // behaviour of an absent target, and the common case.
          { socket: "settings-section", surface: "settings", id: "conn", label: "Jira connection", panelId: "connection" },
          // Names a page statically, which the manifest carries as of the
          // `section` field landing beside `command` and `dialog`.
          { socket: "settings-section", surface: "settings", id: "issues", label: "Jira issue sync", panelId: "issues", section: "integrations" },
          // Declared here, then filled in by the published row below — the
          // dynamic path, which targets a page the same way.
          { socket: "settings-section", surface: "settings", id: "notify", label: "Jira notifications", panelId: "notify" },
          // Another kind on the same surface must not leak in.
          { socket: "toolbar-action", surface: "settings", id: "tool", label: "Toolbar", actionId: "tool" },
        ],
      }),
      listContributions: async () => [{
        pluginId: "jira",
        socket: "settings-section",
        socketId: "notify",
        surface: "settings",
        entityKind: "surface",
        entityId: "settings",
        payload: { panelId: "notify", title: "Jira notifications", section: "notifications" },
        updatedAt: "2026-08-13T00:00:00.000Z",
      }],
      invoke: async () => ({}),
      readPanel: async () => null,
    },
  };
});

afterEach(() => cleanup());

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("resolvePluginSettingsTab", () => {
  it("takes a live tab id", () => {
    expect(resolvePluginSettingsTab("integrations")).toBe("integrations");
    expect(resolvePluginSettingsTab("notifications")).toBe("notifications");
  });

  it("takes a tab id ADE has since renamed", () => {
    // `providers` was a top-level tab before the nine-tab split; the manifest
    // still resolves it, so a plugin written against the old name still lands.
    expect(resolvePluginSettingsTab("providers")).toBe("agents");
    expect(resolvePluginSettingsTab("github")).toBe("integrations");
  });

  it("takes the anchor of one card, which is what a copied deeplink carries", () => {
    expect(resolvePluginSettingsTab("github-connection")).toBe("integrations");
    expect(resolvePluginSettingsTab("quiet-hours")).toBe("notifications");
  });

  it("falls back rather than failing to parse", () => {
    // The promise the opaque-string payload makes: a page this build has never
    // heard of is not a reason for the plugin to disappear.
    expect(resolvePluginSettingsTab("a-page-from-2027")).toBe(PLUGIN_SETTINGS_FALLBACK_TAB);
    expect(resolvePluginSettingsTab(undefined)).toBe(PLUGIN_SETTINGS_FALLBACK_TAB);
    expect(resolvePluginSettingsTab("")).toBe(PLUGIN_SETTINGS_FALLBACK_TAB);
  });
});

describe("contributed settings sections", () => {
  it("renders an unrouted declaration in the fallback page", async () => {
    render(<PluginSettingsSections tab={PLUGIN_SETTINGS_FALLBACK_TAB} />);

    await waitFor(() => expect(screen.getByText("Jira connection")).toBeTruthy());
    expect(screen.getByText("FROM PLUGINS")).toBeTruthy();
    // The routed ones belong to other pages, not this one.
    expect(screen.queryByText("Jira issue sync")).toBeNull();
    expect(screen.queryByText("Jira notifications")).toBeNull();
    // And a kind that is not a settings section never appears here.
    expect(screen.queryByText("Toolbar")).toBeNull();
  });

  it("routes a static declaration to the page its `section` names", async () => {
    // The whole path is load-bearing and spans three owners: the manifest
    // carries `section`, the parser emits it into the socket record, the
    // payload arm maps it, and this resolves it. Any one of them dropping it
    // silently lands the section in General, which looks like a plugin bug.
    render(<PluginSettingsSections tab="integrations" />);

    await waitFor(() => expect(screen.getByText("Jira issue sync")).toBeTruthy());
    expect(screen.queryByText("Jira connection")).toBeNull();
  });

  it("routes a published row to the page its `section` names", async () => {
    render(<PluginSettingsSections tab="notifications" />);

    await waitFor(() => expect(screen.getByText("Jira notifications")).toBeTruthy());
    expect(screen.queryByText("Jira connection")).toBeNull();
  });

  it("keeps an over-long `section` in the fallback rather than treating it as an error", async () => {
    // `bounded` REFUSES an over-length value rather than truncating it, so a
    // `section` past 64 chars arrives absent. Indistinguishable from a plugin
    // that named no page, and it must degrade the same way — not disappear.
    expect(resolvePluginSettingsTab(undefined)).toBe(PLUGIN_SETTINGS_FALLBACK_TAB);
    expect(resolvePluginSettingsTab("x".repeat(200))).toBe(PLUGIN_SETTINGS_FALLBACK_TAB);
  });

  it("renders nothing at all on a page nobody targeted", async () => {
    render(<PluginSettingsSections tab="secrets" />);

    // Nothing to wait for; the assertion is that no heading appears over an
    // empty block once the registry has settled.
    await waitFor(() => expect(screen.queryByText("Jira connection")).toBeNull());
    expect(screen.queryByText("FROM PLUGINS")).toBeNull();
  });

  it("hides itself from the settings search filter rather than standing alone", async () => {
    const { container } = render(<PluginSettingsSections tab={PLUGIN_SETTINGS_FALLBACK_TAB} />);

    await waitFor(() => expect(screen.getByText("Jira connection")).toBeTruthy());
    // The page's search filter only touches elements carrying this attribute;
    // without it the block would survive a query that emptied the page around it.
    expect(container.querySelector("[data-settings-anchor]")).toBeTruthy();
  });
});
