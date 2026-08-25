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
              // ADE's own accent, which the sanitizer accepts.
              color: "#7C6FF0",
              menu: [
                { label: "Sober up", actionId: "soberUp", icon: "beer" },
                // An icon token this build has never heard of. It must degrade
                // to the same puzzle piece an entry with no icon draws.
                { label: "Reset count", actionId: "reset", danger: true, icon: "not-a-real-token" },
              ],
            },
            {
              socket: "chat-header-action",
              surface: "work",
              id: "pour",
              label: "Pour",
              actionId: "pour",
              order: 2,
              // Pure yellow: legal hex, unreadable on the light background.
              color: "#FFFF00",
            },
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

  /**
   * The chevron read as a second, detached pill.
   *
   * The two halves are one control — one contribution, one busy key, one
   * primary press — and were drawn as siblings of the row's own `gap-1` flex,
   * so the product said "two buttons" while the code said "one". They now share
   * a wrapper with no gap, and the primary half carries only its LEFT corners so
   * the seam is a single hairline rather than two butted outlines.
   */
  it("draws the two halves as one joined control, not two spaced pills", async () => {
    render(<PluginChatHeaderActions session={SESSION} />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());

    const primary = screen.getByText("Drink").closest("button");
    const chevron = screen.getByRole("button", { name: "Drink — more actions" });
    if (!primary) throw new Error("expected a contributed button");

    // One parent, and it is not the row: a gap between them would be back.
    expect(primary.parentElement).toBe(chevron.parentElement);
    expect(primary.parentElement?.className ?? "").not.toContain("gap-");

    // Left corners and left edge on the primary; the seam belongs to the
    // chevron's own border, so the primary must not draw a right one.
    expect(primary.className).toContain("rounded-l-md");
    expect(primary.className).not.toContain("rounded-md");
    expect(primary.className).toContain("border-l");
    expect(chevron.className).toContain("rounded-r-md");

    // A button with no menu is untouched: all four corners, as before.
    const plain = screen.getByText("Pour").closest("button");
    expect(plain?.className).toContain("rounded-md");
    expect(plain?.className).not.toContain("rounded-l-md");
  });

  /**
   * A dropdown entry could not carry a glyph at all, so every row in every
   * plugin's menu drew the same puzzle piece. Asserted by comparing the drawn
   * paths rather than a class, because what went wrong was the picture.
   */
  it("draws a menu entry's own icon, and puzzle-pieces an unknown token", async () => {
    render(<PluginChatHeaderActions session={SESSION} />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());
    await openMenu("Drink");

    const glyph = (label: string) =>
      screen.getByText(label).closest("button")?.querySelector("svg")?.innerHTML ?? "";
    // "Pour" declares no icon, so it draws the default — the reference.
    const fallback = screen.getByText("Pour").closest("button")?.querySelector("svg")?.innerHTML ?? "";

    expect(fallback).not.toBe("");
    expect(glyph("Sober up")).not.toBe(fallback);
    // The unknown token degrades to the same default rather than throwing or
    // drawing nothing — the rule the primary button already followed.
    expect(glyph("Reset count")).toBe(fallback);
  });
});

/**
 * "A plugin can't even tint its own button without shipping a full theme."
 *
 * The tint is accepted only if it survives BOTH themes, because the payload
 * carries one colour and the user picks the theme. A refused colour leaves the
 * button wearing the platform's own tone — visibly not the plugin's choice,
 * which is the signal that sends the author to the rule.
 */
describe("a chat-header button's own colour", () => {
  it("wears a legible hex, and falls back rather than going invisible", async () => {
    render(<PluginChatHeaderActions session={SESSION} />);
    await waitFor(() => expect(screen.getByText("Drink")).toBeTruthy());

    // #7C6FF0 clears 3:1 against both backgrounds.
    const tinted = screen.getByText("Drink").closest("button");
    expect(tinted?.style.color).toBe("rgb(124, 111, 240)");

    // #FFFF00 does not — it vanishes on the light background — so nothing is
    // set inline and the button keeps its own class-driven colour.
    const plain = screen.getByText("Pour").closest("button");
    expect(plain?.style.color).toBe("");
  });

  /**
   * Inline styles outrank classes, so a tint painted while an action runs would
   * paint over the busy chrome — the one signal that says a minutes-long action
   * is still working. The platform takes the control back for the duration.
   */
  it("gives the control back to the busy state while an action runs", async () => {
    const pending: { release: () => void } = { release: () => {} };
    const inFlight = new Promise<void>((resolve) => {
      pending.release = resolve;
    });
    const ade = (window as unknown as { ade: { plugins: { invoke: unknown } } }).ade;
    const original = ade.plugins.invoke;
    ade.plugins.invoke = async () => {
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
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.style.color).toBe("");

      await act(async () => {
        pending.release();
        await inFlight;
      });
      await waitFor(() => expect(button.style.color).toBe("rgb(124, 111, 240)"));
    } finally {
      ade.plugins.invoke = original;
    }
  });
});
