/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PluginPanelView, VocabularyBoundary } from "./VocabularyRenderer";
import type { VocabRenderContext } from "./vocabularyComponents";
import { PLUGIN_FIXTURES, pluginFixtureRows } from "./pluginFixtures";
import type { PluginCollectionRow } from "../../lib/pluginRuntimeBridge";
import { bindingKey } from "../../../shared/plugins/vocabulary";

/**
 * These cover the one promise the renderer makes that a type system cannot:
 * a panel is never blank and never takes the tab down with it. Everything else
 * about how a panel looks is the fixture page's job, not a test's — there are
 * no snapshot assertions here on purpose.
 */

function makeContext(overrides: Partial<VocabRenderContext> = {}): VocabRenderContext {
  return {
    pluginId: "test-plugin",
    rowsByBinding: new Map<string, PluginCollectionRow[]>(),
    dispatch: vi.fn(async () => {}),
    active: true,
    state: {},
    setStateValue: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PluginPanelView", () => {
  it("renders every fixture without throwing and never leaves the panel empty", () => {
    for (const fixture of PLUGIN_FIXTURES) {
      const { container, unmount } = render(
        <PluginPanelView
          schema={fixture.schema}
          context={makeContext({ rowsByBinding: pluginFixtureRows(fixture) })}
        />,
      );
      expect(container.textContent?.trim(), `fixture ${fixture.id} rendered blank`).toBeTruthy();
      unmount();
    }
  });

  it("falls back to the plugin's own words when the schema is unrenderable", () => {
    render(
      <PluginPanelView
        schema={{
          v: 99,
          fallback: { title: "Graph", text: "3 lanes, 1 conflict." },
          body: [],
        }}
        context={makeContext()}
      />,
    );

    expect(screen.getByText("Graph")).toBeTruthy();
    expect(screen.getByText("3 lanes, 1 conflict.")).toBeTruthy();
    // The diagnosis is available, but it is not what leads.
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(/vocabulary v1/)).toBeTruthy();
  });

  it("still says something when the schema declares no fallback at all", () => {
    const { container } = render(
      <PluginPanelView schema={{ v: 1, body: [] }} context={makeContext()} />,
    );
    expect(container.textContent).toContain("This panel can’t be shown");
  });

  it("degrades an unknown component in place without dropping its siblings", () => {
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [
            { component: "text", text: "before" },
            { component: "hologram" },
            { component: "text", text: "after" },
          ],
        }}
        context={makeContext()}
      />,
    );

    expect(screen.getByText("before")).toBeTruthy();
    expect(screen.getByText("after")).toBeTruthy();
    expect(screen.getByText("Not supported here")).toBeTruthy();
  });

  it("surfaces a failed action inline instead of leaving the button silent", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("The plugin refused that action.");
    });
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{ component: "button", label: "Run", onPress: { action: "run" } }],
        }}
        context={makeContext({ dispatch })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => {
      expect(screen.getByText("The plugin refused that action.")).toBeTruthy();
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("asks before running a list row's action, the way a button already does", async () => {
    // A row used to dispatch straight through, so the same destructive action
    // prompted behind a button and ran silently behind a row.
    const dispatch = vi.fn(async () => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const row = {
      title: "bc-1",
      onPress: { action: "delete-agent", confirm: "Delete this agent?" },
    };
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{ component: "list", items: [row] }],
        }}
        context={makeContext({ dispatch })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /bc-1/ }));
    expect(confirm).toHaveBeenCalledWith("Delete this agent?");
    expect(dispatch).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /bc-1/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  });

  it("makes a collection-driven row pressable only for an action its binding allowed", async () => {
    const dispatch = vi.fn(async () => {});
    const rowsByBinding = new Map<string, PluginCollectionRow[]>([
      [bindingKey({ collection: "fleet" }), [
        { key: "1", value: { title: "allowed row", onPress: { action: "open-agent" } } } as PluginCollectionRow,
        { key: "2", value: { title: "refused row", onPress: { action: "delete-everything" } } } as PluginCollectionRow,
      ]],
    ]);
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{ component: "list", bind: { collection: "fleet", allowActions: ["open-agent"] } }],
        }}
        context={makeContext({ dispatch, rowsByBinding })}
      />,
    );

    // Both rows render; only the allowed one is a control.
    expect(screen.getByText("refused row")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /refused row/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /allowed row/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "open-agent" }));
  });

  it("draws a rich row and keeps its trailing buttons out of the row's own press", async () => {
    const dispatch = vi.fn(async () => {});
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{
            component: "list",
            items: [{
              title: "bc-1",
              subtitle: "Fix the login redirect",
              mono: "origin/fix-login-redirect",
              badge: { text: "Running", tone: "accent" },
              onPress: { action: "open-agent" },
              actions: [{ action: "stop", label: "Stop" }],
            }],
          }],
        }}
        context={makeContext({ dispatch })}
      />,
    );

    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("origin/fix-login-redirect")).toBeTruthy();
    // The row's press and its trailing button are two separate controls. A
    // button nested inside the row button would not render at all.
    const rowPress = () => screen.getByRole("button", { name: /bc-1/ }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "stop" }));
    // One runner for the whole row: while an action is in flight the rest of
    // the row is held, so a reader cannot start a second action against data
    // the first one is already changing.
    expect(rowPress().disabled).toBe(true);

    await waitFor(() => expect(rowPress().disabled).toBe(false));
    fireEvent.click(rowPress());
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "open-agent" }));
  });

  it("asks before running a row's trailing action, the way the row's own press does", async () => {
    const dispatch = vi.fn(async () => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{
            component: "list",
            items: [{
              title: "bc-1",
              actions: [{ action: "delete-agent", label: "Delete", confirm: "Delete this agent?" }],
            }],
          }],
        }}
        context={makeContext({ dispatch })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(confirm).toHaveBeenCalledWith("Delete this agent?");
    expect(dispatch).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  });

  it("keeps a row's overflow actions behind a menu until it is opened", async () => {
    const dispatch = vi.fn(async () => {});
    render(
      <PluginPanelView
        schema={{
          v: 1,
          fallback: { title: "T", text: "B" },
          body: [{
            component: "list",
            items: [{
              title: "bc-1",
              overflow: [{ action: "archive", label: "Archive" }],
            }],
          }],
        }}
        context={makeContext({ dispatch })}
      />,
    );

    expect(screen.queryByRole("menuitem", { name: /Archive/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Archive/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: "archive" })));
    // Pressing an item closes the menu: one left open over the row below it
    // reads as belonging to the wrong row.
    expect(screen.queryByRole("menuitem", { name: /Archive/ })).toBeNull();
  });

  it("withholds a video source until the hosting surface is visible", () => {
    const schema = {
      v: 1,
      fallback: { title: "T", text: "B" },
      body: [{ component: "video", src: "https://cdn.example.com/clip.mp4" }],
    };

    const hidden = render(<PluginPanelView schema={schema} context={makeContext({ active: false })} />);
    expect(hidden.container.querySelector("video")?.getAttribute("src")).toBeNull();
    hidden.unmount();

    const visible = render(<PluginPanelView schema={schema} context={makeContext({ active: true })} />);
    expect(visible.container.querySelector("video")?.getAttribute("src"))
      .toBe("https://cdn.example.com/clip.mp4");
  });

  it("loads media only from schemes a panel is allowed to point at", () => {
    const image = (src: string) => ({
      v: 1,
      fallback: { title: "T", text: "B" },
      body: [{ component: "image", src, alt: "A screenshot" }],
    });

    for (const allowed of ["https://cdn.example.com/a.png", "data:image/png;base64,AAAA"]) {
      const view = render(<PluginPanelView schema={image(allowed)} context={makeContext()} />);
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe(allowed);
      view.unmount();
    }

    for (const refused of ["file:///etc/passwd", "javascript:alert(1)", "/relative.png", "HTTP://x/a.png"]) {
      const view = render(<PluginPanelView schema={image(refused)} context={makeContext()} />);
      expect(view.container.querySelector("img"), `${refused} was loaded`).toBeNull();
      // Refusing the fetch must not blank the node: the alt text still says
      // what was meant to be there.
      expect(view.container.textContent).toContain("A screenshot");
      view.unmount();
    }
  });
});

describe("VocabularyBoundary", () => {
  it("contains a throwing leaf instead of letting it blank the tab", () => {
    // React logs the caught error; silence it so the suite output stays readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = (): React.ReactElement => {
      throw new Error("leaf exploded");
    };

    const { container } = render(
      <VocabularyBoundary fallback={{ title: "Graph", text: "3 lanes, 1 conflict." }}>
        <Boom />
      </VocabularyBoundary>,
    );

    expect(container.textContent).toContain("3 lanes, 1 conflict.");
  });

  it("gives the panel another go once the schema or the plugin changes", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = (): React.ReactElement => {
      throw new Error("leaf exploded");
    };

    const { container, rerender } = render(
      <VocabularyBoundary fallback={{ title: "Graph", text: "3 lanes, 1 conflict." }} resetKey="a">
        <Boom />
      </VocabularyBoundary>,
    );
    expect(container.textContent).toContain("3 lanes, 1 conflict.");

    // Same identity: still broken, and deliberately so — re-running the same
    // failing schema on every registry poll would just re-throw.
    rerender(
      <VocabularyBoundary fallback={{ title: "Graph", text: "3 lanes, 1 conflict." }} resetKey="a">
        <p>fixed</p>
      </VocabularyBoundary>,
    );
    expect(container.textContent).not.toContain("fixed");

    rerender(
      <VocabularyBoundary fallback={{ title: "Graph", text: "3 lanes, 1 conflict." }} resetKey="b">
        <p>fixed</p>
      </VocabularyBoundary>,
    );
    expect(container.textContent).toContain("fixed");
  });
});
