/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { PluginSlotPanel, usePluginPanelSlots, type PluginPanelSlot } from "./PluginPanelSlots";
import { pluginPanelSlotId } from "./panelSlotId";
import { pluginSessionContext } from "./surfaceContexts";

/**
 * The two panel-host sockets — `work-rail-pane` and `drawer-tab`.
 *
 * The audit's line for this pair is "makes the seven builtin panes a template
 * rather than a privilege", and the assertions follow it: a contributed pane
 * gets a real slot id the host can persist, gets its label and icon into the
 * strip, and gets its panel drawn under the plugin's own name. The last one is
 * not cosmetic — a rail pane sits where Git and Files sit, so an unattributed
 * third-party panel reads as part of ADE.
 *
 * Also asserted: the two kinds do NOT see each other's contributions despite
 * sharing a payload shape, which is the thing a shared payload makes easy to
 * get wrong.
 */

beforeAll(() => {
  (window as unknown as { ade: unknown }).ade = {
    plugins: {
      list: async () => [
        {
          pluginId: "linter",
          displayName: "Lint Pilot",
          enabled: true,
          accent: null,
          icon: null,
          disabledContributions: [],
        },
      ],
      getManifest: async () => ({
        name: "linter",
        version: "1.0.0",
        sockets: [
          { socket: "work-rail-pane", surface: "work", id: "rail", label: "Lint", panelId: "findings", icon: "bug" },
          { socket: "drawer-tab", surface: "work", id: "tab", label: "Rules", panelId: "rules" },
          // Another surface's pane must not reach the Work rail.
          { socket: "work-rail-pane", surface: "lanes", id: "elsewhere", label: "Nope", panelId: "nope" },
        ],
      }),
      listContributions: async () => [],
      invoke: async () => ({}),
      readPanel: async () => null,
    },
  };
});

afterEach(() => cleanup());

afterAll(() => {
  delete (window as unknown as { ade?: unknown }).ade;
});

function SlotList({ socket }: { socket: "work-rail-pane" | "drawer-tab" }) {
  const slots = usePluginPanelSlots("work", socket);
  return (
    <ul>
      {slots.map((slot) => (
        <li key={slot.key} data-testid={`slot-${slot.label}`} data-slot-id={slot.id}>
          {slot.label} · {slot.displayName} · {slot.panelId}
        </li>
      ))}
    </ul>
  );
}

describe("contributed panel slots", () => {
  it("gives a rail pane a persistable slot id built from plugin and panel", async () => {
    render(<SlotList socket="work-rail-pane" />);

    const row = await waitFor(() => screen.getByTestId("slot-Lint"));
    // The id is what the app store writes to localStorage, so it has to be
    // derived rather than positional — a reordered manifest must not move a
    // user's selected pane onto a different plugin's panel.
    expect(row.dataset.slotId).toBe(pluginPanelSlotId("linter", "findings"));
    expect(row.textContent).toContain("Lint Pilot");
  });

  it("keeps the two kinds apart even though they share a payload", async () => {
    const { rerender } = render(<SlotList socket="work-rail-pane" />);
    await waitFor(() => expect(screen.getByTestId("slot-Lint")).toBeTruthy());
    expect(screen.queryByTestId("slot-Rules")).toBeNull();

    rerender(<SlotList socket="drawer-tab" />);
    await waitFor(() => expect(screen.getByTestId("slot-Rules")).toBeTruthy());
    expect(screen.queryByTestId("slot-Lint")).toBeNull();
  });

  it("leaves another surface's pane out of the Work rail", async () => {
    render(<SlotList socket="work-rail-pane" />);

    await waitFor(() => expect(screen.getByTestId("slot-Lint")).toBeTruthy());
    expect(screen.queryByTestId("slot-Nope")).toBeNull();
  });

  it("names the owning plugin above the panel it draws", async () => {
    const slot: PluginPanelSlot = {
      id: pluginPanelSlotId("linter", "findings"),
      key: "linter/work-rail-pane/rail",
      pluginId: "linter",
      panelId: "findings",
      label: "Lint",
      icon: (() => null) as unknown as PluginPanelSlot["icon"],
      displayName: "Lint Pilot",
    };
    render(
      <PluginSlotPanel
        slot={slot}
        context={pluginSessionContext({ id: "chat-1", title: "A chat", provider: "claude" })}
      />,
    );

    // The attribution is drawn immediately, before the panel itself resolves —
    // a panel that is still loading must not be an anonymous box in the rail.
    expect(screen.getByText("Lint Pilot")).toBeTruthy();
  });
});
