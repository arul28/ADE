/* @vitest-environment jsdom */

import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ChatActionsDrawerPanel, type ChatActionsTab } from "./ChatActionsDrawerPanel";
import { pluginPanelSlotId } from "../plugins/sockets/panelSlotId";

/**
 * The `drawer-tab` socket, mounted on its real host.
 *
 * The drawer is where the socket's degradation rules are visible: a plugin tab
 * is a peer of Proof and Handoff, so it must appear AFTER them, its panel must
 * receive the chat it sits in, and a selection pointing at a plugin that is no
 * longer installed must land somewhere real rather than on an empty pane —
 * which is exactly what a persisted `chatActionsTab` will do after an uninstall.
 */

const PLUGIN_TAB = pluginPanelSlotId("linter", "rules") as ChatActionsTab;

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
          { socket: "drawer-tab", surface: "work", id: "rules", label: "Rules", panelId: "rules" },
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

function renderDrawer(tab: ChatActionsTab, onTabChange = vi.fn()) {
  const result = render(
    <ChatActionsDrawerPanel
      tab={tab}
      onTabChange={onTabChange}
      onClose={() => {}}
      agentsContent={<div>Agents body</div>}
      proofContent={<div>Proof body</div>}
      handoffContent={<div>Handoff body</div>}
      sessionId="chat-1"
      sessionTitle="A chat"
      sessionProvider="claude"
    />,
  );
  return { ...result, onTabChange };
}

describe("contributed drawer tabs", () => {
  it("adds the tab after the drawer's own, never among them", async () => {
    renderDrawer("agents");

    // The strip is icon-only in neutral mode, so the label lives on the
    // accessible name — which is also what a screen reader reads.
    const rules = await waitFor(() => screen.getByRole("button", { name: "Rules" }));
    const agents = screen.getByRole("button", { name: "Agents" });
    const handoff = screen.getByRole("button", { name: "Handoff" });
    // Placement is host-controlled and always after core content.
    expect(agents.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(handoff.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the plugin's panel, under its name, when its tab is selected", async () => {
    renderDrawer(PLUGIN_TAB);

    await waitFor(() => expect(screen.getByText("Lint Pilot")).toBeTruthy());
    // The drawer's own bodies are not rendered behind it.
    expect(screen.queryByText("Agents body")).toBeNull();
  });

  it("selects the contributed tab through the host's own handler", async () => {
    const { onTabChange } = renderDrawer("agents");

    const rules = await waitFor(() => screen.getByRole("button", { name: "Rules" }));
    await act(async () => {
      fireEvent.click(rules);
    });
    expect(onTabChange).toHaveBeenCalledWith(PLUGIN_TAB);
  });

  it("falls back to Agents for a persisted tab whose plugin is gone", async () => {
    // The shape a restored `chatActionsUiState` takes after an uninstall: a
    // well-formed slot id that nothing answers to.
    renderDrawer(pluginPanelSlotId("uninstalled", "panel") as ChatActionsTab);

    await waitFor(() => expect(screen.getByText("Agents body")).toBeTruthy());
  });
});
