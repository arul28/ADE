/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PluginToolbarActions } from "./PluginToolbarActions";

/**
 * The toolbar socket on the surface that had no host until this round, plus the
 * split button the alpha retrospective asked for.
 *
 * `app` is the window's own surface — the top bar's trailing cluster. A plugin
 * could already declare a toolbar action on it, the parser accepted it, and the
 * phone even drew it; on desktop it drew nowhere. So the assertions here are
 * about a surface being genuinely reachable, not about a component that was
 * already proven elsewhere.
 */

const invoked: { pluginId: string; action: string; args: Record<string, unknown> }[] = [];

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        { pluginId: "tipsy", displayName: "Tipsy", enabled: true, accent: null, icon: null, disabledContributions: [] },
        // Installed and switched off: nothing it declares may draw anywhere.
        { pluginId: "ghost", displayName: "Ghost", enabled: false, accent: null, icon: null, disabledContributions: [] },
      ],
      getManifest: async (args: unknown) => {
        const pluginId = typeof args === "string"
          ? args
          : (args as { pluginId?: string } | null)?.pluginId;
        if (pluginId === "ghost") {
          return {
            name: "ghost",
            version: "1.0.0",
            sockets: [
              { socket: "toolbar-action", surface: "app", id: "haunt", label: "Haunt", actionId: "haunt" },
            ],
          };
        }
        return {
          name: "tipsy",
          version: "1.0.0",
          sockets: [
            {
              socket: "toolbar-action",
              surface: "app",
              id: "drink",
              label: "Drink",
              actionId: "takeDrink",
              order: 1,
              menu: [
                { label: "Sober up", actionId: "soberUp" },
                { label: "Reset count", actionId: "reset", danger: true },
              ],
            },
            { socket: "toolbar-action", surface: "app", id: "pour", label: "Pour", actionId: "pour", order: 2 },
            {
              socket: "toolbar-action",
              surface: "app",
              id: "spill",
              label: "Spill",
              actionId: "spill",
              order: 3,
              menu: [{ label: "Mop up", actionId: "mopUp" }],
            },
            // A different surface's declaration must not reach the window's bar.
            { socket: "toolbar-action", surface: "lanes", id: "elsewhere", label: "Elsewhere", actionId: "elsewhere" },
          ],
        };
      },
      listContributions: async () => [],
      invoke: async (args: { pluginId: string; action: string; args: Record<string, unknown> }) => {
        invoked.push({ pluginId: args.pluginId, action: args.action, args: args.args });
        return {};
      },
    },
  };
});

beforeEach(() => {
  invoked.length = 0;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("toolbar actions on the app surface", () => {
  it("draws the window's own contributions and not another surface's", async () => {
    render(<PluginToolbarActions surface="app" />);

    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());
    expect(screen.getByText("Pour")).toBeTruthy();
    expect(screen.queryByText("Elsewhere")).toBeNull();
  });

  // The window's chrome belongs to no tab, so the subject is the surface.
  it("invokes with the surface context, since the cluster belongs to no tab", async () => {
    render(<PluginToolbarActions surface="app" />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("Drink"));
    });

    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.pluginId).toBe("tipsy");
    expect(invoked[0]?.action).toBe("takeDrink");
    expect(invoked[0]?.args.context).toEqual({ kind: "surface", surface: "app" });
  });

  it("follows install state — a disabled plugin contributes nothing", async () => {
    render(<PluginToolbarActions surface="app" />);

    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());
    expect(screen.queryByText("Haunt")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "1 more plugin actions" }));
    });
    expect(screen.queryByText("Haunt")).toBeNull();
  });

  // `active: false` is the perf law the socket stores are built on: a surface
  // behind another tab must cost nothing, so it selects nothing.
  it("stays inert when its surface is not the visible one", async () => {
    const { container } = render(<PluginToolbarActions surface="app" active={false} />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});

describe("the split button on a toolbar action", () => {
  it("gives a button with a menu a chevron, and one without none", async () => {
    render(<PluginToolbarActions surface="app" />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());

    expect(screen.getByRole("button", { name: "Drink — more actions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pour — more actions" })).toBeNull();
  });

  it("invokes the menu entry's own action, not the button's", async () => {
    render(<PluginToolbarActions surface="app" />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Drink — more actions" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Sober up"));
    });

    expect(invoked.map((entry) => entry.action)).toEqual(["soberUp"]);
    expect(invoked[0]?.args.context).toEqual({ kind: "surface", surface: "app" });
  });

  it("draws a danger entry in the product's own red", async () => {
    render(<PluginToolbarActions surface="app" />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Drink — more actions" }));
    });
    expect(screen.getByText("Reset count").closest("button")?.dataset.danger).toBe("true");
    expect(screen.getByText("Sober up").closest("button")?.dataset.danger).toBeUndefined();
  });

  /**
   * A folded button took its chevron into the "+N" with it, so its extra
   * actions would vanish at exactly the width where the row got crowded.
   */
  it("keeps a folded button's menu reachable inside the overflow", async () => {
    render(<PluginToolbarActions surface="app" />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());

    expect(screen.queryByText("Mop up")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "1 more plugin actions" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Mop up"));
    });
    expect(invoked.map((entry) => entry.action)).toEqual(["mopUp"]);
  });
});

describe("the window header cluster", () => {
  it("shows every app-surface action instead of folding at two", async () => {
    render(<PluginToolbarActions surface="app" layout="header" />);

    await waitFor(() => expect(screen.getByLabelText("Reorder Drink")).toBeTruthy());
    expect(screen.getByLabelText("Reorder Pour")).toBeTruthy();
    expect(screen.getByLabelText("Reorder Spill")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "1 more plugin actions" })).toBeNull();
    expect(screen.queryByLabelText("More plugin actions")).toBeNull();
  });

  it("puts hidden buttons and Reorder behind a chevron only when something is clipped", async () => {
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        const node = this as HTMLElement;
        if (node.hasAttribute("data-plugin-toolbar-measure")) return 40;
        return offset?.get?.call(this) ?? 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        const node = this as HTMLElement;
        if (node.getAttribute("data-plugin-toolbar-layout") === "header") return 70;
        return client?.get?.call(this) ?? 0;
      },
    });

    try {
      render(<PluginToolbarActions surface="app" layout="header" />);
      await waitFor(() => expect(screen.getByLabelText("More plugin actions")).toBeTruthy());
      expect(screen.queryByRole("button", { name: "1 more plugin actions" })).toBeNull();

      await act(async () => {
        fireEvent.click(screen.getByLabelText("More plugin actions"));
      });
      expect(screen.getByText("Reorder")).toBeTruthy();
    } finally {
      if (offset) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offset);
      else delete (HTMLElement.prototype as { offsetWidth?: unknown }).offsetWidth;
      if (client) Object.defineProperty(HTMLElement.prototype, "clientWidth", client);
      else delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
    }
  });
});
