/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { parsePluginContributionPayload } from "../../../../shared/plugins/sockets";
import { rootAppStoreApi } from "../../../state/appStore";
import { PluginSettingsSections } from "./PluginSettingsSections";

/**
 * A settings section that names a page, and the one thing the page may resize.
 *
 * Everything else in this socket is unchanged: the section still names a
 * `panelId`, the panel is still what a client without a page host draws, and
 * `webviewSurfaceId` is the second name that upgrades the rendering where it
 * can be upgraded. The section body is the only placement with no frame of its
 * own, so it is the only one that listens to a page's own height — capped,
 * because a page reporting forty thousand pixels would push every section under
 * it off a scrollbar nobody can use.
 *
 * Its own file rather than an addition to `PluginSettingsSections.test.tsx` for
 * the reason that file states: the contribution stores are module-level and
 * load once per surface, so a fixture that has to differ gets its own file.
 */

vi.mock("../../../lib/pluginRuntimeBridge", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pluginWebviewRelayBridge: () => null,
}));

const { webClientMode } = vi.hoisted(() => ({ webClientMode: { web: false } }));
vi.mock("../../../lib/webClientMode", () => ({ isWebClientMode: () => webClientMode.web }));

vi.mock("../PluginPanelHost", () => ({
  PluginPanelHost: ({ pluginId, panelId }: { pluginId: string; panelId: string }) => (
    <div data-testid={`panel-${panelId}`}>{`${pluginId}:${panelId}`}</div>
  ),
}));

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "acme",
          displayName: "Acme",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "acme",
        version: "1.0.0",
        sockets: [
          // The ordinary section: a panel and nothing else.
          {
            socket: "settings-section",
            surface: "settings",
            id: "conn",
            panelId: "connection",
            title: "Connection",
            section: "integrations",
          },
          // The upgraded one: the same required `panelId`, plus the page.
          {
            socket: "settings-section",
            surface: "settings",
            id: "sync",
            panelId: "sync",
            title: "Sync",
            section: "integrations",
            webviewSurfaceId: "sync-page",
          },
        ],
      }),
      listContributions: async () => [],
      invoke: async () => ({}),
      readPanel: async () => null,
    },
  };
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

beforeEach(() => {
  webClientMode.web = false;
  rootAppStoreApi.setState({
    installedPlugins: [
      {
        pluginId: "acme",
        displayName: "Acme",
        version: "1.0.0",
        enabled: true,
        icon: "puzzle",
        accent: "#fff",
        status: "running",
        tabs: [
          {
            id: "sync-page",
            title: "Sync",
            kind: "webview",
            panelId: "sync",
            entryHtml: "dist/settings.html",
          },
        ],
        theme: null,
      },
    ],
  } as never);
});

afterEach(() => cleanup());

describe("parsePluginContributionPayload", () => {
  it("keeps a webviewSurfaceId beside the panel it upgrades", () => {
    expect(parsePluginContributionPayload("settings-section", {
      panelId: "connection",
      webviewSurfaceId: "sync-page",
    })).toEqual({ panelId: "connection", webviewSurfaceId: "sync-page" });
  });

  it("still requires the panel, whatever page is named", () => {
    expect(parsePluginContributionPayload("settings-section", { webviewSurfaceId: "sync-page" }))
      .toBeNull();
  });

  it("carries one on an action button and a row badge too", () => {
    expect(parsePluginContributionPayload("composer-action", {
      label: "Issues",
      actionId: "pick",
      webviewSurfaceId: "issues",
    })).toMatchObject({ webviewSurfaceId: "issues" });
    expect(parsePluginContributionPayload("row-badge", {
      text: "3",
      webviewSurfaceId: "issues",
    })).toMatchObject({ webviewSurfaceId: "issues" });
  });
});

describe("PluginSettingsSections with a page", () => {
  it("draws the page for the section that names one and the panel for the one that does not", async () => {
    const view = render(<PluginSettingsSections tab="integrations" />);
    await waitFor(() => expect(view.container.querySelectorAll("webview")).toHaveLength(1));
    expect(view.getByTestId("panel-connection").textContent).toBe("acme:connection");
    expect(view.queryByTestId("panel-sync")).toBeNull();
  });

  it("falls back to the panel on a client with no page host", async () => {
    webClientMode.web = true;
    const view = render(<PluginSettingsSections tab="integrations" />);
    await waitFor(() => expect(view.getByTestId("panel-sync")).toBeTruthy());
    expect(view.container.querySelectorAll("webview")).toHaveLength(0);
  });

  it("grows to the height the page reports and no further", async () => {
    const view = render(<PluginSettingsSections tab="integrations" />);
    await waitFor(() => expect(view.container.querySelector("webview")).toBeTruthy());
    const guest = view.container.querySelector("webview") as HTMLElement;
    const box = guest.closest("section")?.querySelector("div[style*='height']") as HTMLElement;
    const resize = (height: number) => {
      const event = new Event("ipc-message") as Event & { channel?: string; args?: unknown[] };
      event.channel = "ade:plugin-webview:resize";
      event.args = [{ height }];
      act(() => {
        guest.dispatchEvent(event);
      });
    };
    resize(420);
    expect(box.style.height).toBe("420px");
    resize(99_000);
    expect(box.style.height).toBe("2000px");
  });
});
