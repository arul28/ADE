/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { PluginComposerContext } from "../../../../shared/plugins/context";
import { rootAppStoreApi } from "../../../state/appStore";
import { PluginChatMenuRows, usePluginChatMenuItems } from "./PluginChatMenuItems";
import { usePluginWebviewPopover } from "./pluginWebviewPopoverStore";

/**
 * Rows nested under the chat's `issue-context` submenu.
 *
 * The anchor assertion is the one that would otherwise rot silently: a page
 * opened from here hangs off the SUBMENU, which stays mounted behind it, and
 * anchoring to the pressed row instead would put the card at 0,0 the moment the
 * list re-rendered.
 */

const invoked: { pluginId: string; action: string; args: unknown }[] = [];

const INSTALLED = [{
  pluginId: "tracker",
  displayName: "Tracker",
  version: "1.0.0",
  enabled: true,
  icon: null,
  accent: "#F2994A",
  status: "none" as const,
  tabs: [{ id: "issues", title: "Issues", panelId: "issues", kind: "webview", entryHtml: "issues.html" }],
  theme: null,
}];

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [{
        pluginId: "tracker",
        displayName: "Tracker",
        enabled: true,
        accent: "#F2994A",
        icon: null,
        disabledContributions: [],
      }],
      getManifest: async () => ({
        name: "tracker",
        version: "1.0.0",
        sockets: [
          {
            socket: "chat-menu-item",
            surface: "work",
            id: "attach",
            label: "Tracker issue",
            actionId: "attachIssue",
            submenu: "issue-context",
            order: 1,
          },
          {
            socket: "chat-menu-item",
            surface: "work",
            id: "pick",
            label: "Pick an issue",
            actionId: "pickIssue",
            submenu: "issue-context",
            webviewSurfaceId: "issues",
            order: 2,
          },
          // No `submenu` — refused by the payload parser, so it never appears.
          {
            socket: "chat-menu-item",
            surface: "work",
            id: "homeless",
            label: "Nowhere",
            actionId: "nowhere",
            order: 3,
          },
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

const CONTEXT = (draft: string): PluginComposerContext => ({
  kind: "composer",
  sessionId: "chat-1",
  projectKey: null,
  projectRoot: null,
  laneId: "lane-1",
  draft,
  cursor: draft.length,
});

function Harness({ readContext }: { readContext: () => PluginComposerContext }) {
  const rows = usePluginChatMenuItems({
    submenu: "issue-context",
    sessionId: "chat-1",
    laneId: "lane-1",
    readContext,
  });
  const popover = usePluginWebviewPopover();
  return (
    <div>
      <span data-testid="count">{rows.length}</span>
      <span data-testid="anchor">
        {popover?.anchor ? `${popover.anchor.width}x${popover.anchor.height}` : ""}
      </span>
      <span data-testid="popover">{popover ? `${popover.pluginId}:${popover.surfaceId}:${popover.kind}` : ""}</span>
      {/* The real submenu carries this attribute; the anchor is read off it. */}
      <div data-issue-context-menu="true" role="menu" aria-label="Attach issue context">
        <PluginChatMenuRows rows={rows} />
      </div>
    </div>
  );
}

describe("contributed issue-context rows", () => {
  it("renders only rows that named this submenu", async () => {
    render(<Harness readContext={() => CONTEXT("")} />);

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    expect(screen.getByText("Tracker issue")).toBeTruthy();
    expect(screen.getByText("Pick an issue")).toBeTruthy();
    // The submenu-less declaration is refused by the payload parser, not here.
    expect(screen.queryByText("Nowhere")).toBeNull();
  });

  it("tints the row's icon square from the plugin's own accent", async () => {
    render(<Harness readContext={() => CONTEXT("")} />);

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("2"));
    const square = screen.getByText("Tracker issue").closest("button")?.querySelector("span");
    // jsdom normalises the hex; the `color-mix` background is dropped as an
    // unparseable value, which is why the colour is asserted rather than it.
    expect(square?.getAttribute("style")).toContain("rgb(242, 153, 74)");
  });

  it("invokes with the live composer context", async () => {
    let draft = "before";
    render(<Harness readContext={() => CONTEXT(draft)} />);

    await waitFor(() => expect(screen.getByText("Tracker issue")).toBeTruthy());
    draft = "after";
    await act(async () => {
      fireEvent.click(screen.getByText("Tracker issue"));
    });

    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.action).toBe("attachIssue");
    expect((invoked[0]?.args as { context: PluginComposerContext }).context.draft).toBe("after");
  });

  it("opens a declared page as a popover anchored to the submenu", async () => {
    // jsdom reports a zero rect for everything, so give the submenu a real one.
    const rect = { left: 40, top: 80, width: 260, height: 180 };
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function boundingRect(this: Element) {
      return this.hasAttribute("data-issue-context-menu")
        ? { ...rect, right: 300, bottom: 260, x: 40, y: 80, toJSON: () => rect } as DOMRect
        : original.call(this);
    };
    try {
      render(<Harness readContext={() => CONTEXT("")} />);
      await waitFor(() => expect(screen.getByText("Pick an issue")).toBeTruthy());
      await act(async () => {
        fireEvent.click(screen.getByText("Pick an issue"));
      });

      await waitFor(() => expect(screen.getByTestId("popover").textContent)
        .toBe("tracker:issues:popover"));
      expect(screen.getByTestId("anchor").textContent).toBe("260x180");
      expect(invoked).toHaveLength(0);
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it("invokes when the declared page cannot be resolved", async () => {
    rootAppStoreApi.setState({
      installedPlugins: [{ ...INSTALLED[0]!, enabled: false }] as never,
      pluginsLoaded: true,
    });
    render(<Harness readContext={() => CONTEXT("")} />);

    await waitFor(() => expect(screen.getByText("Pick an issue")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("Pick an issue"));
    });

    expect(invoked.map((entry) => entry.action)).toEqual(["pickIssue"]);
  });

  it("renders nothing with no rows", () => {
    const { container } = render(<PluginChatMenuRows rows={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
