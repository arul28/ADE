/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS,
  PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS,
} from "../../../../shared/plugins/sockets";
import { pluginSessionContext } from "./surfaceContexts";
import { PluginChatHeaderActions } from "./PluginChatHeaderActions";

/**
 * The chat-header socket, end to end.
 *
 * This is the placement the plugin alpha test asked for and did not get, so the
 * assertions are written against what actually went wrong then rather than
 * against the component's own shape: the plugin must reach the chat that is
 * open (not only a fresh pane), it must receive THAT chat as its subject rather
 * than the tab, and the split-button arrow the user described has to be there
 * and has to invoke the second action.
 */

const invoked: { pluginId: string; action: string; args: Record<string, unknown> }[] = [];

const SESSION = pluginSessionContext({
  id: "chat-1",
  title: "Refactor the parser",
  provider: "claude",
  status: "idle",
});

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
        // Installed but switched OFF. Nothing it declares may draw — the alpha
        // test's other confusion was not being able to tell "the plugin is off"
        // from "this client does not draw that kind".
        {
          pluginId: "ghost",
          displayName: "Ghost",
          enabled: false,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
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
              { socket: "chat-header-action", surface: "work", id: "haunt", label: "Haunt", actionId: "haunt" },
            ],
          };
        }
        return {
          name: "tipsy",
          version: "1.0.0",
          sockets: [
            {
              socket: "chat-header-action",
              surface: "work",
              id: "drink",
              label: "Drink",
              actionId: "takeDrink",
              order: 1,
              menu: [
                { label: "Sober up", actionId: "soberUp" },
                { label: "Reset count", actionId: "reset", danger: true },
              ],
            },
            { socket: "chat-header-action", surface: "work", id: "pour", label: "Pour", actionId: "pour", order: 2 },
            {
              socket: "chat-header-action",
              surface: "work",
              id: "spill",
              label: "Spill",
              actionId: "spill",
              order: 3,
              menu: [{ label: "Mop up", actionId: "mopUp" }],
            },
            // Another kind on the same surface, and the same kind on another
            // surface. Neither may leak into this row.
            { socket: "toolbar-action", surface: "work", id: "tool", label: "Toolbar", actionId: "tool" },
            { socket: "chat-header-action", surface: "lanes", id: "elsewhere", label: "Elsewhere", actionId: "elsewhere" },
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

afterEach(() => cleanup());

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("contributed chat-header buttons", () => {
  it("draws two and folds the rest behind the overflow", async () => {
    render(<PluginChatHeaderActions session={SESSION} />);

    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());
    expect(screen.getByText("Pour")).toBeTruthy();
    expect(screen.queryByText("Spill")).toBeNull();
    expect(screen.getByRole("button", { name: "1 more plugin actions" })).toBeTruthy();
  });

  it("takes neither another kind on this surface nor its own kind on another", async () => {
    render(<PluginChatHeaderActions session={SESSION} />);

    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());
    expect(screen.queryByText("Toolbar")).toBeNull();
    expect(screen.queryByText("Elsewhere")).toBeNull();
  });

  // The whole reason this is a kind and not a second toolbar action.
  it("hands the plugin the chat it sits above, not the tab", async () => {
    render(<PluginChatHeaderActions session={SESSION} />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("Drink"));
    });

    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.pluginId).toBe("tipsy");
    expect(invoked[0]?.action).toBe("takeDrink");
    expect(invoked[0]?.args.context).toEqual({
      kind: "session",
      id: "chat-1",
      title: "Refactor the parser",
      provider: "claude",
      status: "idle",
    });
  });

  /**
   * A disabled plugin's declarations must not draw. The user in the alpha test
   * could not distinguish "off" from "this client does not draw that kind", and
   * the only way that stays true is if disabling is total.
   */
  it("follows install state — a disabled plugin contributes nothing", async () => {
    render(<PluginChatHeaderActions session={SESSION} />);

    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());
    expect(screen.queryByText("Haunt")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "1 more plugin actions" }));
    });
    expect(screen.queryByText("Haunt")).toBeNull();
  });

  /**
   * A header with no chat has no subject. Invoking against nothing would hand
   * the plugin a session id it could not act on, so the row stays absent —
   * which is also what stops it warming the socket stores on a fresh pane.
   */
  it("renders nothing on a surface that has not started a chat", async () => {
    const { container } = render(<PluginChatHeaderActions session={null} />);
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(invoked).toHaveLength(0);
  });

  // The socket carries the long budget because the button carries the busy
  // state that pays for it; a 60s cap would report a working action as a fault.
  it("asks for the long round-trip budget, not the row default", async () => {
    const seen: unknown[] = [];
    const ade = (window as unknown as { ade: { plugins: { invoke: unknown } } }).ade;
    const original = ade.plugins.invoke;
    ade.plugins.invoke = async (args: Record<string, unknown>) => {
      seen.push(args.timeoutMs);
      return {};
    };

    try {
      render(<PluginChatHeaderActions session={SESSION} />);
      await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());
      await act(async () => {
        fireEvent.click(screen.getByText("Drink"));
      });
      expect(seen).toEqual([PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS]);
      expect(PLUGIN_COMPOSER_ACTION_INVOKE_TIMEOUT_MS)
        .toBeGreaterThan(PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS);
    } finally {
      ade.plugins.invoke = original;
    }
  });

  /**
   * The busy contract, inherited from the composer button and load-bearing for
   * the same reason: a control greyed out for the two minutes it is legitimately
   * working reads as broken, so it stays enabled, says so, and refuses re-entry.
   */
  it("stays visibly active and enabled while a long action runs, and will not re-fire", async () => {
    const pending: { release: () => void } = { release: () => {} };
    const inFlight = new Promise<void>((resolve) => {
      pending.release = resolve;
    });
    const ade = (window as unknown as { ade: { plugins: { invoke: unknown } } }).ade;
    const original = ade.plugins.invoke;
    ade.plugins.invoke = async (args: { pluginId: string; action: string; args: Record<string, unknown> }) => {
      invoked.push({ pluginId: args.pluginId, action: args.action, args: args.args });
      await inFlight;
      return {};
    };

    try {
      render(<PluginChatHeaderActions session={SESSION} />);
      await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());
      const button = screen.getByText("Drink").closest("button");
      if (!button) throw new Error("expected a contributed button");

      await act(async () => {
        fireEvent.click(button);
      });

      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.dataset.busy).toBe("true");
      expect(screen.getByText("Drink")).toBeTruthy();

      fireEvent.click(button);
      fireEvent.click(button);
      expect(invoked).toHaveLength(1);

      await act(async () => {
        pending.release();
        await inFlight;
      });
      await waitFor(() => expect(button.getAttribute("aria-busy")).toBeNull());
    } finally {
      ade.plugins.invoke = original;
    }
  });
});

/**
 * "A small arrow on the drink button."
 *
 * The retrospective's most concrete miss, and the easiest to verify: the user
 * did not ask whether the sober-up action existed, they asked for it to hang off
 * the button they could see.
 */
describe("the split button on a chat-header action", () => {
  const openMenu = async (label: string) => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `${label} — more actions` }));
    });
  };

  it("gives a button with a menu a chevron, and one without none", async () => {
    render(<PluginChatHeaderActions session={SESSION} />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());

    expect(screen.getByRole("button", { name: "Drink — more actions" })).toBeTruthy();
    // "Pour" declares no menu, so it is the plain button it always was.
    expect(screen.queryByRole("button", { name: "Pour — more actions" })).toBeNull();
  });

  it("invokes the menu entry's own action against the same chat", async () => {
    render(<PluginChatHeaderActions session={SESSION} />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());

    await openMenu("Drink");
    await act(async () => {
      fireEvent.click(screen.getByText("Sober up"));
    });

    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.action).toBe("soberUp");
    expect((invoked[0]?.args.context as { id: string }).id).toBe("chat-1");
  });

  it("draws a danger entry in the product's own red", async () => {
    render(<PluginChatHeaderActions session={SESSION} />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());

    await openMenu("Drink");
    expect(screen.getByText("Reset count").closest("button")?.dataset.danger).toBe("true");
    expect(screen.getByText("Sober up").closest("button")?.dataset.danger).toBeUndefined();
  });

  /**
   * A button that folded into "+N" took its chevron with it, so its extra
   * actions would simply vanish at the width where the overflow appears. They
   * are drawn as rows under their primary instead.
   */
  it("keeps a folded button's menu reachable inside the overflow", async () => {
    render(<PluginChatHeaderActions session={SESSION} />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());

    // "Spill" is third by host order, so it starts inside the "+N" — and it
    // declares a menu, which has nowhere to hang without the chevron it lost.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "1 more plugin actions" }));
    });
    expect(screen.getByText("Mop up")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText("Mop up"));
    });
    expect(invoked.map((entry) => entry.action)).toEqual(["mopUp"]);
    expect((invoked[0]?.args.context as { id: string }).id).toBe("chat-1");
  });
});
