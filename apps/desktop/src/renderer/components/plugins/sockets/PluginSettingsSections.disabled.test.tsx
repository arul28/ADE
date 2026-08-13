/* @vitest-environment jsdom */

import React from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { PLUGIN_SETTINGS_FALLBACK_TAB, PluginSettingsSections } from "./PluginSettingsSections";

/**
 * Install state, in its own file.
 *
 * The contribution stores are module-level and load once per surface — the perf
 * law that stops a hundred rows making a hundred IPC calls — so a registry that
 * has to answer differently needs a fresh module registry, which vitest gives
 * per file. Same fixture as `PluginSettingsSections.test.tsx`, one field apart.
 *
 * The row is the load-bearing half: `plugin_contributions` rows SYNC between
 * machines and outlive a disable, so a section whose plugin is off must stop
 * rendering even though its published row is still sitting in the table.
 */

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "jira",
          displayName: "Jira",
          enabled: false,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "jira",
        version: "1.0.0",
        sockets: [
          { socket: "settings-section", surface: "settings", id: "conn", label: "Jira connection", panelId: "connection" },
        ],
      }),
      listContributions: async () => [{
        pluginId: "jira",
        socket: "settings-section",
        socketId: "conn",
        surface: "settings",
        entityKind: "surface",
        entityId: "settings",
        payload: { panelId: "connection", title: "Jira connection" },
        updatedAt: "2026-08-13T00:00:00.000Z",
      }],
      invoke: async () => ({}),
      readPanel: async () => null,
    },
  };
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("contributed settings sections, plugin disabled", () => {
  it("renders nothing — not the section, and not the heading over it", async () => {
    render(<PluginSettingsSections tab={PLUGIN_SETTINGS_FALLBACK_TAB} />);

    await waitFor(() => {
      expect(screen.queryByText("Jira connection")).toBeNull();
      expect(screen.queryByText("FROM PLUGINS")).toBeNull();
    });
  });
});
