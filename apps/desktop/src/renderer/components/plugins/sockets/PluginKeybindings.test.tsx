/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useAppStore } from "../../../state/appStore";
import type { InstalledPlugin } from "../../../lib/pluginRuntimeBridge";
import {
  dispatchPluginKeybindingEvent,
  formatPluginChordForDisplay,
  usePluginKeybindings,
} from "./usePluginKeybindings";
import { usePluginPaletteCommands } from "./usePluginPaletteCommands";

/**
 * A plugin's declared shortcut, from the install registry to a keystroke.
 *
 * The assertions that matter are the negative ones. A shortcut that fires when
 * it should not is a data-loss bug — it runs while someone is mid-sentence in a
 * composer — and a shortcut that is ADVERTISED but refused is a lie the palette
 * would be telling on the plugin's behalf. Both are invisible in the happy path,
 * so they are what this file is mostly about.
 */

const invoked: { pluginId: string; action: string }[] = [];

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      // The socket layer reads its own list for manifests; the keybinding
      // matrix reads the store's registry. Both describe the same plugin.
      list: async () => [{
        pluginId: "prompts",
        displayName: "Prompt Library",
        enabled: true,
        accent: null,
        icon: null,
        disabledContributions: [],
      }],
      getManifest: async () => ({
        name: "prompts",
        version: "1.0.0",
        sockets: [
          { socket: "command-palette-action", surface: "app", id: "new", label: "New prompt", actionId: "new", order: 1 },
          { socket: "command-palette-action", surface: "app", id: "open", label: "Open palette", actionId: "open", order: 2 },
        ],
      }),
      listContributions: async () => [],
      invoke: async (args: { pluginId: string; action: string }) => {
        invoked.push({ pluginId: args.pluginId, action: args.action });
        return {};
      },
    },
  };
});

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    pluginId: "prompts",
    displayName: "Prompt Library",
    version: "1.0.0",
    enabled: true,
    icon: null,
    accent: null,
    status: "running",
    tabs: [],
    theme: null,
    disabledContributions: [],
    installedAt: "2026-01-01T00:00:00.000Z",
    keybindings: [
      { action: "new", binding: "Alt+Shift+P", label: "New prompt" },
      // Loses to the command palette, which ADE ships on Mod+K.
      { action: "open", binding: "Mod+K", label: "Open palette" },
    ],
    ...overrides,
  } as InstalledPlugin;
}

beforeEach(() => {
  invoked.length = 0;
  useAppStore.setState({ installedPlugins: [plugin()], keybindings: null });
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ installedPlugins: [], keybindings: null });
});

/**
 * The same three pieces `AppShell` wires: the resolution, the one dispatch
 * decision, and the socket invoke path. Rendered with a text input so the
 * typing guard has something real to refuse.
 */
function Harness() {
  const { bindings, refusals } = usePluginKeybindings();
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      dispatchPluginKeybindingEvent(event, bindings, (pluginId, actionId) => {
        invoked.push({ pluginId, action: actionId });
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings]);
  return (
    <div>
      <input aria-label="composer" />
      <span data-testid="bound">{bindings.map((binding) => `${binding.action}=${binding.binding}`).join(",")}</span>
      <span data-testid="refused">{refusals.map((refusal) => `${refusal.action}:${refusal.reason}`).join(",")}</span>
    </div>
  );
}

function PaletteHarness() {
  const commands = usePluginPaletteCommands(true);
  return (
    <ul>
      {commands.map((command) => (
        <li key={command.id}>
          <span data-testid={`title-${command.title}`}>{command.title}</span>
          <span data-testid={`shortcut-${command.title}`}>{command.shortcut ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

describe("plugin keybindings on the desktop", () => {
  it("binds what survived the matrix and refuses what core already owns", () => {
    render(<Harness />);
    expect(screen.getByTestId("bound").textContent).toBe("new=Alt+Shift+P");
    expect(screen.getByTestId("refused").textContent).toBe("open:core-conflict");
  });

  it("runs the plugin's action when the resolved chord is pressed", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: "P", altKey: true, shiftKey: true });
    expect(invoked).toEqual([{ pluginId: "prompts", action: "new" }]);
  });

  it("does nothing for a chord the plugin asked for and lost", () => {
    render(<Harness />);
    // jsdom reports a non-mac platform, so `Mod` resolves to Ctrl here.
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(invoked).toEqual([]);
  });

  it("stays out of the way while the user is typing", () => {
    render(<Harness />);
    const composer = screen.getByLabelText("composer");
    composer.focus();
    fireEvent.keyDown(composer, { key: "P", altKey: true, shiftKey: true });
    expect(invoked).toEqual([]);
    // …and fires again the moment focus is not in a field.
    fireEvent.keyDown(window, { key: "P", altKey: true, shiftKey: true });
    expect(invoked).toHaveLength(1);
  });

  it("leaves a chord alone once something else has claimed the event", () => {
    render(<Harness />);
    const event = new KeyboardEvent("keydown", { key: "P", altKey: true, shiftKey: true, cancelable: true });
    event.preventDefault();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(invoked).toEqual([]);
  });

  it("binds nothing for a plugin the user switched off", () => {
    useAppStore.setState({ installedPlugins: [plugin({ enabled: false })] });
    render(<Harness />);
    expect(screen.getByTestId("bound").textContent).toBe("");
    fireEvent.keyDown(window, { key: "P", altKey: true, shiftKey: true });
    expect(invoked).toEqual([]);
  });

  it("treats a chord the user rebound onto as core's", () => {
    useAppStore.setState({
      installedPlugins: [plugin({
        keybindings: [{ action: "new", binding: "Alt+Shift+J", label: "New prompt" }],
      })],
      keybindings: {
        definitions: [],
        overrides: [{ id: "commandPalette.open", binding: "Alt+Shift+J" }],
      },
    });
    render(<Harness />);
    expect(screen.getByTestId("bound").textContent).toBe("");
    expect(screen.getByTestId("refused").textContent).toBe("new:core-conflict");
  });

  /**
   * The per-contribution switch reaches registrations too. The key is
   * kind-qualified so a chord cannot be turned off by a socket that happens to
   * share its name — see `shared/plugins/disabledContributions.ts`.
   */
  it("binds nothing for a chord the user switched off on its own", () => {
    useAppStore.setState({
      installedPlugins: [plugin({ disabledContributions: ["keybinding:new"] })],
    });
    render(<Harness />);
    expect(screen.getByTestId("bound").textContent).toBe("");
    fireEvent.keyDown(window, { key: "P", altKey: true, shiftKey: true });
    expect(invoked).toEqual([]);
  });

  it("keeps binding a chord whose action merely shares a name with a disabled socket", () => {
    // "new" is also this plugin's command-palette socket id. A flat id match
    // would take the chord away with it.
    useAppStore.setState({ installedPlugins: [plugin({ disabledContributions: ["new"] })] });
    render(<Harness />);
    expect(screen.getByTestId("bound").textContent).toBe("new=Alt+Shift+P");
  });

  it("keeps its answer stable when the registry poll hands back an equal list", () => {
    const { rerender } = render(<Harness />);
    const first = screen.getByTestId("bound").textContent;
    act(() => {
      // A fresh array with identical contents — what every poll produces.
      useAppStore.setState({ installedPlugins: [plugin()] });
    });
    rerender(<Harness />);
    expect(screen.getByTestId("bound").textContent).toBe(first);
    fireEvent.keyDown(window, { key: "P", altKey: true, shiftKey: true });
    // One listener, one dispatch — a resolution that changed identity on every
    // poll would have reinstalled and could have double-fired.
    expect(invoked).toHaveLength(1);
  });
});

describe("the palette's shortcut chip", () => {
  it("shows the chord only for the binding that actually works", async () => {
    render(<PaletteHarness />);
    await waitFor(() => expect(screen.getByTestId("title-New prompt")).toBeTruthy());
    expect(screen.getByTestId("shortcut-New prompt").textContent).toBe("Alt+Shift+P");
    // Declared, refused, and therefore unadvertised: a chip here would promise
    // a keystroke that opens the command palette instead.
    expect(screen.getByTestId("shortcut-Open palette").textContent).toBe("");
  });
});

describe("chord display", () => {
  it("reads back a chord the way the reader's platform writes it", () => {
    // jsdom's navigator is not a Mac, so `Mod` draws as Ctrl.
    expect(formatPluginChordForDisplay("Mod+Shift+P")).toBe("Ctrl+Shift+P");
    expect(formatPluginChordForDisplay("Alt+ArrowUp")).toBe("Alt+↑");
    expect(formatPluginChordForDisplay("not a chord")).toBeNull();
  });
});
