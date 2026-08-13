/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS } from "../../../../shared/plugins/sockets";
import { usePluginPaletteCommands } from "./usePluginPaletteCommands";

/**
 * The `command-palette-action` socket, from a manifest declaration to a click.
 *
 * The load-bearing assertions are the two the palette itself cannot make: that
 * a contributed row is ATTRIBUTED (two plugins may both contribute "Refresh",
 * and the row has to say whose), and that the plugin receives a surface-only
 * `app` context rather than whatever tab happened to be behind the palette.
 */

const invoked: { pluginId: string; action: string; args: unknown; timeoutMs: unknown }[] = [];

let enabled = true;

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "prompts",
          displayName: "Prompt Library",
          enabled,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "prompts",
        version: "1.0.0",
        sockets: [
          { socket: "command-palette-action", surface: "app", id: "new", label: "New prompt", actionId: "new", order: 1 },
          // Declared disabled: the palette has no dimmed state, so it is absent
          // rather than selectable-and-inert.
          { socket: "command-palette-action", surface: "app", id: "off", label: "Unavailable", actionId: "off", order: 2 },
          // Another surface's palette entry must not leak into the window's.
          { socket: "command-palette-action", surface: "lanes", id: "lane", label: "Lane thing", actionId: "lane", order: 3 },
          // Another kind entirely, on the same surface.
          { socket: "activity-entry", surface: "app", id: "row", label: "A row", order: 4 },
        ],
      }),
      listContributions: async () => (enabled
        ? [{
          pluginId: "prompts",
          socket: "command-palette-action",
          socketId: "off",
          surface: "app",
          entityKind: "surface",
          entityId: "app",
          payload: { label: "Unavailable", actionId: "off", disabled: true },
          updatedAt: "2026-08-13T00:00:00.000Z",
        }]
        : []),
      invoke: async (args: { pluginId: string; action: string; args: unknown; timeoutMs: unknown }) => {
        invoked.push({
          pluginId: args.pluginId,
          action: args.action,
          args: args.args,
          timeoutMs: args.timeoutMs,
        });
        return {};
      },
    },
  };
});

beforeEach(() => {
  invoked.length = 0;
  enabled = true;
});

afterEach(() => cleanup());

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

function Harness({ open = true }: { open?: boolean }) {
  const commands = usePluginPaletteCommands(open);
  return (
    <ul>
      {commands.map((command) => (
        <li key={command.id}>
          <button type="button" onClick={command.run}>
            {command.title}
          </button>
          <span data-testid={`hint-${command.title}`}>{command.hint}</span>
          <span data-testid={`keywords-${command.title}`}>{command.keywords.join(",")}</span>
        </li>
      ))}
    </ul>
  );
}

describe("contributed command palette actions", () => {
  it("offers the app surface's entries, attributed to their plugin", async () => {
    render(<Harness />);

    await waitFor(() => expect(screen.getByText("New prompt")).toBeTruthy());
    // Attribution is what tells two plugins' identically-named rows apart.
    expect(screen.getByTestId("hint-New prompt").textContent).toBe("Prompt Library plugin");
    // Keywords never render, but typing the plugin's name must find its rows.
    expect(screen.getByTestId("keywords-New prompt").textContent)
      .toBe("plugin,prompts,Prompt Library");
  });

  it("leaves out another surface's entries and other socket kinds", async () => {
    render(<Harness />);

    await waitFor(() => expect(screen.getByText("New prompt")).toBeTruthy());
    expect(screen.queryByText("Lane thing")).toBeNull();
    expect(screen.queryByText("A row")).toBeNull();
  });

  it("drops a disabled entry rather than offering a row that does nothing", async () => {
    render(<Harness />);

    await waitFor(() => expect(screen.getByText("New prompt")).toBeTruthy());
    expect(screen.queryByText("Unavailable")).toBeNull();
  });

  it("invokes with the app surface context and the default round-trip budget", async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("New prompt")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("New prompt"));
    });

    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.pluginId).toBe("prompts");
    expect(invoked[0]?.action).toBe("new");
    // The palette belongs to the window, not to whatever tab is behind it.
    expect((invoked[0]?.args as { context: unknown }).context).toEqual({
      kind: "surface",
      surface: "app",
    });
    // A palette entry fires with no visible progress anywhere, so it keeps the
    // 60s default rather than the composer's minutes.
    expect(invoked[0]?.timeoutMs).toBe(PLUGIN_SOCKET_INVOKE_TIMEOUT_DEFAULT_MS);
  });

  it("reads nothing while the palette is closed", async () => {
    render(<Harness open={false} />);
    // Nothing to wait for — the assertion is that nothing ever arrives, which
    // is what keeps a permanently-mounted palette free until it is opened.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("New prompt")).toBeNull();
  });
});
