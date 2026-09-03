/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { PluginComposerContext } from "../../../../shared/plugins/context";
import { rootAppStoreApi } from "../../../state/appStore";
import {
  PLUGIN_COMPOSER_MENU_ITEM_ID_PREFIX,
  usePluginComposerMenuItems,
} from "./PluginComposerMenuItems";
import { usePluginWebviewPopover } from "./pluginWebviewPopoverStore";

/**
 * Rows in the composer's three-dot menu, from a manifest declaration to a press.
 *
 * The draft-at-press-time assertion is the same one `PluginComposerActions`
 * carries and for the same reason: a menu row is built once and pressed later,
 * and a context captured at build time would hand the plugin whatever was in
 * the box when the menu opened.
 */

const invoked: { pluginId: string; action: string; args: unknown }[] = [];

const INSTALLED = [{
  pluginId: "prompts",
  displayName: "Prompts",
  version: "1.0.0",
  enabled: true,
  icon: null,
  accent: "#6E56CF",
  status: "none" as const,
  tabs: [{ id: "picker", title: "Picker", panelId: "picker", kind: "webview", entryHtml: "picker.html" }],
  theme: null,
}];

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [{
        pluginId: "prompts",
        displayName: "Prompts",
        enabled: true,
        accent: "#6E56CF",
        icon: null,
        disabledContributions: [],
      }],
      getManifest: async () => ({
        name: "prompts",
        version: "1.0.0",
        sockets: [
          {
            socket: "composer-menu-item",
            surface: "work",
            id: "stash",
            label: "Save to stash",
            actionId: "stash",
            icon: "brand:linear",
            order: 1,
          },
          {
            socket: "composer-menu-item",
            surface: "work",
            id: "browse",
            label: "Browse prompts",
            actionId: "browse",
            webviewSurfaceId: "picker",
            order: 2,
          },
          // Another kind on the same surface must not leak into this menu.
          { socket: "composer-action", surface: "work", id: "bug", label: "Bug report", actionId: "bug" },
        ],
      }),
      listContributions: async () => [],
      invoke: async (args: { pluginId: string; action: string; args: unknown }) => {
        invoked.push({ pluginId: args.pluginId, action: args.action, args: args.args });
        return {};
      },
    },
  };
});

beforeEach(() => {
  invoked.length = 0;
  rootAppStoreApi.setState({ installedPlugins: INSTALLED as never, pluginsLoaded: true });
});

afterEach(() => {
  cleanup();
  rootAppStoreApi.setState({ installedPlugins: [], pluginsLoaded: false });
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

function Harness({ readContext }: { readContext: () => PluginComposerContext }) {
  const items = usePluginComposerMenuItems({ sessionId: "chat-1", laneId: "lane-1", readContext });
  const popover = usePluginWebviewPopover();
  return (
    <div>
      <span data-testid="count">{items.length}</span>
      <span data-testid="popover">{popover ? `${popover.pluginId}:${popover.surfaceId}:${popover.kind}` : ""}</span>
      {items.map((item) => (
        <button key={item.id} type="button" data-id={item.id} onClick={item.onSelect}>
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

const CONTEXT = (draft: string): PluginComposerContext => ({
  kind: "composer",
  sessionId: "chat-1",
  projectKey: null,
  projectRoot: null,
  laneId: "lane-1",
  draft,
  cursor: draft.length,
});

describe("contributed composer menu rows", () => {
  it("renders one row per declaration, and only this kind", async () => {
    render(<Harness readContext={() => CONTEXT("")} />);

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    expect(screen.getByText("Save to stash")).toBeTruthy();
    expect(screen.getByText("Browse prompts")).toBeTruthy();
    expect(screen.queryByText("Bug report")).toBeNull();
  });

  it("namespaces the row id so it cannot collide with a core entry", async () => {
    render(<Harness readContext={() => CONTEXT("")} />);

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    const ids = Array.from(document.querySelectorAll("[data-id]"))
      .map((node) => node.getAttribute("data-id") ?? "");
    expect(ids.every((id) => id.startsWith(PLUGIN_COMPOSER_MENU_ITEM_ID_PREFIX))).toBe(true);
    expect(ids.some((id) => id === "issue-context" || id === "app-control")).toBe(false);
  });

  it("hands the plugin the draft as it reads at press time", async () => {
    let draft = "first";
    render(<Harness readContext={() => CONTEXT(draft)} />);

    await waitFor(() => expect(screen.getByText("Save to stash")).toBeTruthy());
    draft = "typed some more";
    await act(async () => {
      fireEvent.click(screen.getByText("Save to stash"));
    });

    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.action).toBe("stash");
    expect((invoked[0]?.args as { context: PluginComposerContext }).context.draft)
      .toBe("typed some more");
  });

  it("opens a declared page as a picker instead of invoking", async () => {
    render(<Harness readContext={() => CONTEXT("")} />);

    await waitFor(() => expect(screen.getByText("Browse prompts")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("Browse prompts"));
    });

    await waitFor(() => expect(screen.getByTestId("popover").textContent)
      .toBe("prompts:picker:composer-picker"));
    // The declaration REPLACES the invoke — a plugin whose action also answers
    // `{openWebview}` would otherwise open and immediately close the card.
    expect(invoked).toHaveLength(0);
  });

  it("invokes when the declared page cannot be resolved", async () => {
    rootAppStoreApi.setState({
      installedPlugins: [{ ...INSTALLED[0]!, enabled: false }] as never,
      pluginsLoaded: true,
    });
    render(<Harness readContext={() => CONTEXT("")} />);

    await waitFor(() => expect(screen.getByText("Browse prompts")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("Browse prompts"));
    });

    expect(invoked.map((entry) => entry.action)).toEqual(["browse"]);
  });
});
