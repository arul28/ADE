/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PluginToolbarActions } from "./PluginToolbarActions";
import { PluginPanelPopoverHost } from "./PluginPanelPopoverHost";
import {
  closePluginPanelPopover,
  getPluginPanelPopover,
  openPluginPanelPopover,
} from "./pluginPanelPopoverStore";
import { rootAppStoreApi } from "../../../state/appStore";
import { getToasts } from "../../app/toast/toastStore";

/**
 * The third place a `{navigate}` can land, end to end from the press.
 *
 * The whole point of the placement is the surface these tests use: a
 * `toolbar-action` on `app` draws in the window's top bar, which belongs to no
 * chat, so its two older answers were "take the whole window away" and "open a
 * Work rail that is not on screen". These assert the press produces a card at
 * the button with the plugin's real panel in it, and that Escape puts it away.
 */

/** What the pressed action answers. Swapped per test. */
let actionResult: unknown = {};
const invoked: { pluginId: string; action: string }[] = [];

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "tipsy",
          displayName: "Tipsy",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "tipsy",
        version: "1.0.0",
        panels: [{ id: "count", title: "Count" }, { id: "history", title: "History" }],
        sockets: [
          {
            socket: "toolbar-action",
            surface: "app",
            id: "drink",
            label: "Drink",
            actionId: "takeDrink",
          },
        ],
      }),
      listContributions: async () => [],
      getPanel: async ({ panelId }: { panelId: string }) => ({
        pluginId: "tipsy",
        panelId,
        title: panelId === "history" ? "History" : "Count",
        schema: {
          v: 1,
          fallback: { title: "Tipsy", text: "Open ADE." },
          body: panelId === "history"
            ? [{ component: "text", text: "Three drinks on Tuesday." }]
            : [
              { component: "text", text: "Two drinks today." },
              { component: "button", label: "See history", onPress: { action: "showHistory" } },
            ],
        },
        vocabVersion: 1,
        updatedAt: null,
      }),
      getCollection: async () => [],
      invoke: async (args: { pluginId: string; action: string }) => {
        invoked.push({ pluginId: args.pluginId, action: args.action });
        return actionResult;
      },
      onChanged: () => () => {},
    },
  };
});

beforeEach(() => {
  invoked.length = 0;
  actionResult = {};
  closePluginPanelPopover();
  // The placement rule reads the registry to decide whether a navigation can
  // land at all, and an unresolved registry is an empty array.
  rootAppStoreApi.setState({
    pluginsLoaded: true,
    installedPlugins: [{
      pluginId: "tipsy",
      displayName: "Tipsy",
      enabled: true,
      accent: null,
      icon: null,
      tabs: [],
      disabledContributions: [],
    }] as never,
  });
});

afterEach(() => {
  cleanup();
  closePluginPanelPopover();
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

async function pressDrink() {
  render(
    <>
      <PluginToolbarActions surface="app" />
      <PluginPanelPopoverHost />
    </>,
  );
  await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());
  await act(async () => {
    fireEvent.click(screen.getByText("Drink"));
  });
}

describe("a top-bar press that answers with a popover", () => {
  it("opens the plugin's own panel in a card at the button", async () => {
    actionResult = { navigate: { panelId: "count", target: "popover" } };
    await pressDrink();

    const card = await screen.findByRole("dialog", { name: "Tipsy" });
    // The panel itself, not a summary of it: the text node AND the button the
    // schema declares are both live inside the card.
    expect(await screen.findByText("Two drinks today.")).toBeTruthy();
    expect(card.getAttribute("data-plugin-popover")).toBe("tipsy");
    expect(screen.getByRole("button", { name: "See history" })).toBeTruthy();
  });

  it("closes on Escape", async () => {
    actionResult = { navigate: { panelId: "count", target: "popover" } };
    await pressDrink();
    await screen.findByRole("dialog", { name: "Tipsy" });

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(getPluginPanelPopover()).toBeNull();
  });

  it("closes on a click outside the card", async () => {
    actionResult = { navigate: { panelId: "count", target: "popover" } };
    await pressDrink();
    const card = await screen.findByRole("dialog", { name: "Tipsy" });

    // Inside first: a press on the panel must not dismiss the panel.
    await act(async () => {
      fireEvent.mouseDown(card);
    });
    expect(screen.queryByRole("dialog")).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(card.parentElement as HTMLElement);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("still shows the action's own sentence beside the card", async () => {
    actionResult = {
      message: "Counted.",
      navigate: { panelId: "count", target: "popover" },
    };
    await pressDrink();

    await screen.findByRole("dialog", { name: "Tipsy" });
    // A socket press has no inline place for `{message}`, so the sentence is a
    // toast — drawn by a host this test does not mount, so the store is what
    // proves it was not dropped on the way to the popover.
    await waitFor(() => expect(getToasts().some((toast) => toast.message === "Counted.")).toBe(true));
  });

  it("navigates to another panel INSIDE the card rather than leaving it", async () => {
    actionResult = { navigate: { panelId: "count", target: "popover" } };
    await pressDrink();
    await screen.findByText("Two drinks today.");

    // The panel's own button answers with a plain navigate — no target — and
    // the card is where it lands, because the card is the host that received it.
    actionResult = { navigate: { panelId: "history" } };
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "See history" }));
    });

    expect(await screen.findByText("Three drinks on Tuesday.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeTruthy();
    expect(getPluginPanelPopover()?.panelId).toBe("history");
    // The card the reader opened, still: navigating inside it must not count as
    // a second open, or a press of the top-bar button would stop toggling.
    expect(getPluginPanelPopover()?.originPanelId).toBe("count");
  });

  it("toggles shut on a second press of the same button", async () => {
    actionResult = { navigate: { panelId: "count", target: "popover" } };
    await pressDrink();
    await screen.findByRole("dialog", { name: "Tipsy" });

    await act(async () => {
      fireEvent.click(screen.getByText("Drink"));
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoked).toHaveLength(2);
  });
});

describe("the store's one-at-a-time rule", () => {
  const request = (panelId: string) => ({
    pluginId: "tipsy",
    panelId,
    context: null,
    anchor: null,
  });

  it("replaces a standing card when a different panel is asked for", () => {
    const first = openPluginPanelPopover(request("count"));
    const second = openPluginPanelPopover(request("history"));
    expect(second).not.toBe(0);
    expect(second).not.toBe(first);
    expect(getPluginPanelPopover()?.panelId).toBe("history");
  });

  it("closes rather than reopening when the same origin is asked for again", () => {
    openPluginPanelPopover(request("count"));
    expect(openPluginPanelPopover(request("count"))).toBe(0);
    expect(getPluginPanelPopover()).toBeNull();
  });

  it("compares a second press against the origin, not the panel on screen", () => {
    // A reader who followed a row into another panel and pressed the button
    // again means "put this away", not "go back to where I started".
    openPluginPanelPopover(request("count"));
    expect(openPluginPanelPopover(request("count"))).toBe(0);
    openPluginPanelPopover(request("count"));
    expect(getPluginPanelPopover()?.originPanelId).toBe("count");
  });
});
