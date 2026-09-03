/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdeCardPayload } from "../../../../shared/adeCard";
import { rootAppStoreApi } from "../../../state/appStore";
import { PluginChatCard } from "./PluginChatCard";
import { PluginChatHeaderActions } from "./PluginChatHeaderActions";
import { PluginComposerActions } from "./PluginComposerActions";
import { PluginRowBadges } from "./PluginRowBadges";
import { PluginToolbarActions } from "./PluginToolbarActions";
import {
  getPluginWebviewPopover,
  resetPluginWebviewPopover,
} from "./pluginWebviewPopoverStore";
import {
  closePluginWebviewOverlay,
  getPluginWebviewOverlay,
} from "./pluginWebviewOverlayStore";
import { usePluginPaletteCommands } from "./usePluginPaletteCommands";

/**
 * `webviewSurfaceId` on a control, honoured without the action returning
 * `{openWebview}`.
 *
 * The declaration was inert everywhere but the settings section: a manifest
 * said "this button opens this page" and the button invoked an action instead,
 * so a plugin had to say the same thing twice — once in the manifest, once in
 * the answer — and a plugin that said it only in the manifest had a button that
 * appeared to do nothing.
 *
 * The other half of the assertion is what does NOT happen: a press that opens a
 * declared page does not also invoke. That is what stops a plugin whose action
 * still answers `{openWebview}` from opening the page twice — which, with the
 * popover store's toggle, means opening it and immediately closing it again.
 */

vi.mock("../../../lib/pluginRuntimeBridge", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pluginWebviewRelayBridge: () => null,
}));

vi.mock("../../../lib/webClientMode", () => ({ isWebClientMode: () => false }));

vi.mock("../PluginPanelHost", () => ({
  PluginPanelHost: ({ pluginId, panelId }: { pluginId: string; panelId: string }) => (
    <div data-testid={`panel-${panelId}`}>{`${pluginId}:${panelId}`}</div>
  ),
}));

const invoked: { pluginId: string; action: string }[] = [];

const SESSION = {
  kind: "session" as const,
  id: "s1",
  title: "Chat",
  provider: "claude",
  status: null,
};

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        { pluginId: "acme", displayName: "Acme", enabled: true, accent: null, icon: null, disabledContributions: [] },
      ],
      getManifest: async () => ({
        name: "acme",
        version: "1.0.0",
        sockets: [
          // Declares a page: the press opens it.
          { socket: "toolbar-action", surface: "app", id: "quick", label: "Quick", actionId: "openQuick", webviewSurfaceId: "page" },
          // Declares none: the press invokes, exactly as before.
          { socket: "toolbar-action", surface: "app", id: "plain", label: "Plain", actionId: "plainAction" },
          { socket: "command-palette-action", surface: "app", id: "palette", label: "Browse", actionId: "browse", webviewSurfaceId: "page" },
          { socket: "composer-action", surface: "work", id: "attach", label: "Attach", actionId: "attachIssue", webviewSurfaceId: "page" },
          { socket: "chat-header-action", surface: "work", id: "header", label: "Issue", actionId: "openIssue", webviewSurfaceId: "page" },
          { socket: "chat-card", surface: "work", id: "card", label: "Issue", panelId: "issue", webviewSurfaceId: "card-page" },
          { socket: "row-badge", surface: "lanes", id: "badge", label: "Issue", webviewSurfaceId: "page" },
        ],
      }),
      listContributions: async (input: { surface: string; entityKind?: string }) => {
        // A row badge only ever renders from a PUBLISHED row: the manifest
        // declaration is what a published one is matched against, so the badge
        // under test has to be published against the lane it sits on.
        if (input.surface !== "lanes" || input.entityKind !== "lane") return [];
        return [
          {
            entityKind: "lane",
            entityId: "lane-1",
            pluginId: "acme",
            socket: "row-badge",
            socketId: "badge",
            surface: "lanes",
            payload: { text: "ADE-1", tone: "neutral", webviewSurfaceId: "page" },
            updatedAt: "2026-09-03T00:00:00.000Z",
          },
        ];
      },
      invoke: async (args: { pluginId: string; action: string }) => {
        invoked.push({ pluginId: args.pluginId, action: args.action });
        return {};
      },
      readPanel: async () => null,
    },
  };
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

beforeEach(() => {
  invoked.length = 0;
  resetPluginWebviewPopover();
  closePluginWebviewOverlay();
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
          { id: "page", title: "Acme", kind: "webview", panelId: "issues", entryHtml: "dist/index.html" },
          { id: "card-page", title: "Issue", kind: "webview", panelId: "issue", entryHtml: "dist/issue.html" },
        ],
        theme: null,
      },
    ],
  } as never);
});

afterEach(() => cleanup());

describe("an action button that declared a page", () => {
  it("opens it as a popover from the toolbar, and does not invoke", async () => {
    render(<PluginToolbarActions surface="app" />);
    await waitFor(() => expect(screen.getByText("Quick")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("Quick"));
    });
    expect(getPluginWebviewPopover()).toMatchObject({
      pluginId: "acme",
      surfaceId: "page",
      kind: "popover",
    });
    expect(invoked).toEqual([]);
  });

  it("still invokes the button that declared none", async () => {
    render(<PluginToolbarActions surface="app" />);
    await waitFor(() => expect(screen.getByText("Plain")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("Plain"));
    });
    expect(getPluginWebviewPopover()).toBeNull();
    expect(invoked).toEqual([{ pluginId: "acme", action: "plainAction" }]);
  });

  it("opens a chat-header page as a popover carrying the chat", async () => {
    render(<PluginChatHeaderActions surface="work" session={SESSION} />);
    await waitFor(() => expect(screen.getByText("Issue")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("Issue"));
    });
    expect(getPluginWebviewPopover()).toMatchObject({
      surfaceId: "page",
      kind: "popover",
      subject: { kind: "session", id: "s1" },
    });
    expect(invoked).toEqual([]);
  });

  it("opens a composer page as a picker over the composer", async () => {
    render(
      <PluginComposerActions
        surface="work"
        sessionId="s1"
        readDraft={() => ({ draft: "", cursor: null })}
      />,
    );
    await waitFor(() => expect(screen.getByText("Attach")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("Attach"));
    });
    expect(getPluginWebviewPopover()).toMatchObject({
      surfaceId: "page",
      kind: "composer-picker",
    });
    expect(invoked).toEqual([]);
  });

  it("opens a palette page as an overlay, since ⌘K has nowhere to anchor", async () => {
    function Palette() {
      const commands = usePluginPaletteCommands(true);
      return (
        <div>
          {commands.map((command) => (
            <button key={command.id} type="button" onClick={command.run}>{command.title}</button>
          ))}
        </div>
      );
    }
    render(<Palette />);
    await waitFor(() => expect(screen.getByText("Browse")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("Browse"));
    });
    expect(getPluginWebviewOverlay()).toMatchObject({ pluginId: "acme", surfaceId: "page" });
    expect(getPluginWebviewPopover()).toBeNull();
    expect(invoked).toEqual([]);
  });
});

describe("a row badge that declared a page", () => {
  it("opens the card under the badge it was pressed on", async () => {
    render(
      <PluginRowBadges
        surface="lanes"
        context={{
          kind: "lane",
          id: "lane-1",
          name: "lane",
          branch: null,
          machineKey: null,
          dirty: false,
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText("ADE-1")).toBeTruthy());
    const control = document.querySelector("[data-plugin-badge-webview]") as HTMLElement;
    expect(control).toBeTruthy();
    await act(async () => {
      fireEvent.click(control);
    });
    expect(getPluginWebviewPopover()).toMatchObject({
      pluginId: "acme",
      surfaceId: "page",
      kind: "popover",
      subject: { kind: "lane", id: "lane-1" },
    });
  });
});

describe("a chat card whose plugin declared a page", () => {
  const card: AdeCardPayload = {
    v: 1,
    cardId: "issue-1",
    variant: "plugin_panel",
    state: "terminal",
    title: "ADE-1",
    fallbackText: "ADE-1",
    authoredBy: { pluginId: "acme", displayName: "Acme" },
    panel: { panelId: "issue" },
  } as unknown as AdeCardPayload;

  it("draws the page instead of the vocabulary panel", async () => {
    const view = render(<PluginChatCard card={card} sessionId="s1" />);
    await waitFor(() => expect(view.container.querySelector("webview")).toBeTruthy());
    expect(view.queryByTestId("panel-issue")).toBeNull();
  });

  it("keeps the panel when the plugin declares no page", async () => {
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
          // The declared surface is gone: the card falls back to the panel the
          // manifest always promised, and says nothing about it.
          tabs: [],
          theme: null,
        },
      ],
    } as never);
    const view = render(<PluginChatCard card={card} sessionId="s1" />);
    await waitFor(() => expect(view.getByTestId("panel-issue")).toBeTruthy());
    expect(view.container.querySelector("webview")).toBeNull();
  });
});
