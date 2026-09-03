/* @vitest-environment jsdom */

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AutomationTrigger } from "../../../../shared/types";
// Type-only: the VALUE is imported per test through `loadCard`, because the
// socket caches are module-level and each case needs its own module graph.
import type { TriggerCard } from "./TriggerCard";

/**
 * The `automation-trigger-tile` socket, as the rule builder draws it.
 *
 * The case that matters most is the LAST one: a plugin that declares a tile
 * must not also appear inside the generic "Plugins" picker. The tile and the
 * picker build the identical rule, so a machine that offered both would show
 * the same five triggers twice under two different names, and nothing on screen
 * would tell the reader they were the same thing. The generic tile survives
 * only for the plugins that declare no tile of their own — including a plugin
 * that is no longer installed, which is what the saved-rule case pins.
 *
 * Every case installs its own host and its own registry and then re-imports the
 * module graph, because the socket caches are module-level by design (see
 * `contributionStores`): a roster seeded in one test would otherwise be the
 * roster every later test saw.
 */

type Plugin = {
  pluginId: string;
  displayName: string;
  automationTriggers?: { id: string; label: string; description?: string }[];
};

const TILE_SOCKET = {
  socket: "automation-trigger-tile",
  surface: "automations",
  id: "issues",
  label: "Graph",
  triggers: [
    { id: "issueCreated", label: "Issue created", description: "Any new issue" },
    { id: "issueMoved", label: "Issue moved" },
  ],
  filters: [
    { key: "teamId", kind: "select", label: "Team", collection: "teams" },
    { key: "titlePattern", kind: "text", label: "Title contains" },
  ],
  webhook: { statusAction: "webhookStatus", registerAction: "registerWebhook" },
};

const invoked: { action: string }[] = [];

/**
 * Publish a plugin host. `collectionRows` of `null` is the UNREADABLE
 * collection — the web client's normal answer for a surface that has no panel
 * open — as opposed to `[]`, which is a collection that is simply empty.
 */
function installHost(options: {
  sockets?: unknown[];
  collectionRows?: { key: string; value: unknown }[] | null;
  statuses?: unknown[];
} = {}): void {
  const statuses = [...(options.statuses ?? [{ state: "unconfigured" }])];
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
      getManifest: async () => ({ name: "graph", version: "1.0.0", sockets: options.sockets ?? [] }),
      listContributions: async () => [],
      getCollection: async () => {
        if (options.collectionRows == null) throw new Error("no panel snapshot");
        return options.collectionRows.map((row) => ({
          collection: "teams",
          key: row.key,
          value: row.value,
          updatedAt: "2026-09-03T00:00:00.000Z",
        }));
      },
      invoke: async (args: { action: string }) => {
        invoked.push({ action: args.action });
        if (args.action === "webhookStatus") return statuses.shift() ?? { state: "ready" };
        return {};
      },
      onChanged: () => () => {},
    },
  };
}

/** A fresh module graph, then the registry the picker and the icons read. */
async function loadCard(plugins: Plugin[]) {
  vi.resetModules();
  const bridge = await import("../../../lib/pluginRuntimeBridge");
  bridge.resetPluginBridgeAvailability();
  const { rootAppStoreApi } = await import("../../../state/appStore");
  rootAppStoreApi.setState({
    installedPlugins: plugins.map((plugin) => ({
      version: "1.0.0",
      enabled: true,
      icon: null,
      accent: "#44AA88",
      status: "none",
      tabs: [],
      theme: null,
      ...plugin,
    })) as never,
    pluginsLoaded: true,
  });
  return (await import("./TriggerCard")).TriggerCard;
}

/** The card is controlled; the harness holds the trigger so a press sticks. */
function Harness({
  Card,
  initial,
  onChange,
}: {
  Card: typeof TriggerCard;
  initial: AutomationTrigger;
  onChange?: (next: AutomationTrigger) => void;
}) {
  const [trigger, setTrigger] = React.useState(initial);
  return (
    <MemoryRouter>
      <Card
        trigger={trigger}
        ingressStatus={null}
        onChange={(next) => {
          setTrigger(next);
          onChange?.(next);
        }}
      />
    </MemoryRouter>
  );
}

const GRAPH_TILE_TRIGGER: AutomationTrigger = {
  type: "plugin",
  pluginId: "graph",
  pluginTrigger: "issueCreated",
};

afterEach(() => {
  cleanup();
  invoked.length = 0;
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("a plugin's trigger tile in the grid", () => {
  it("draws a tile with the plugin's own label, after ADE's own sources", async () => {
    installHost({ sockets: [TILE_SOCKET] });
    const Card = await loadCard([{ pluginId: "graph", displayName: "Graph" }]);

    render(<Harness Card={Card} initial={{ type: "schedule", cron: "0 9 * * 1-5" }} />);

    const tile = await screen.findByRole("button", { name: "Graph" });
    const grid = tile.parentElement!;
    const labels = [...grid.children].map((child) => child.textContent);
    // Never interleaved: the plugin's cell is last, after every ADE source.
    expect(labels[labels.length - 1]).toBe("Graph");
    expect(labels).toContain("GitHub");
  });

  it("selects the tile's first trigger on one press, so the rule is saveable", async () => {
    installHost({ sockets: [TILE_SOCKET] });
    const Card = await loadCard([{ pluginId: "graph", displayName: "Graph" }]);
    const onChange = vi.fn();

    render(<Harness Card={Card} initial={{ type: "schedule", cron: "0 9 * * 1-5" }} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Graph" }));

    expect(onChange).toHaveBeenCalledWith({
      type: "plugin",
      pluginId: "graph",
      pluginTrigger: "issueCreated",
    });
  });
});

describe("a selected plugin tile's radios", () => {
  it("draws one radio per declared trigger, with its description", async () => {
    installHost({ sockets: [TILE_SOCKET] });
    const Card = await loadCard([{ pluginId: "graph", displayName: "Graph" }]);

    render(<Harness Card={Card} initial={GRAPH_TILE_TRIGGER} />);

    const group = await screen.findByRole("radiogroup", { name: "Graph event" });
    const radios = screen.getAllByRole("radio");
    expect(group.contains(radios[0]!)).toBe(true);
    expect(radios).toHaveLength(2);
    expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
    expect(radios[1]!.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Any new issue")).toBeTruthy();
  });

  it("writes the trigger id when a radio is pressed", async () => {
    installHost({ sockets: [TILE_SOCKET] });
    const Card = await loadCard([{ pluginId: "graph", displayName: "Graph" }]);
    const onChange = vi.fn();

    render(<Harness Card={Card} initial={GRAPH_TILE_TRIGGER} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("radio", { name: /Issue moved/ }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pluginTrigger: "issueMoved" }));
  });

  it("moves the selection with the arrow keys and keeps one member tabbable", async () => {
    installHost({ sockets: [TILE_SOCKET] });
    const Card = await loadCard([{ pluginId: "graph", displayName: "Graph" }]);
    const onChange = vi.fn();

    render(<Harness Card={Card} initial={GRAPH_TILE_TRIGGER} onChange={onChange} />);
    const radios = await screen.findAllByRole("radio");
    expect(radios[0]!.getAttribute("tabindex")).toBe("0");
    expect(radios[1]!.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(radios[0]!, { key: "ArrowDown" });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pluginTrigger: "issueMoved" }));
    // Roving: the newly selected radio is the one Tab now lands on.
    await waitFor(() => expect(screen.getAllByRole("radio")[1]!.getAttribute("tabindex")).toBe("0"));

    // And it wraps, which is what makes a two-item group navigable in one key.
    fireEvent.keyDown(screen.getAllByRole("radio")[1]!, { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ pluginTrigger: "issueCreated" }));
  });
});

describe("a selected plugin tile's filters", () => {
  it("fills a select from the named plugin collection", async () => {
    installHost({
      sockets: [TILE_SOCKET],
      collectionRows: [
        { key: "team-1", value: { name: "Engineering" } },
        { key: "team-2", value: { name: "Design" } },
      ],
    });
    const Card = await loadCard([{ pluginId: "graph", displayName: "Graph" }]);

    render(<Harness Card={Card} initial={GRAPH_TILE_TRIGGER} />);

    const select = await screen.findByLabelText("Team") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect([...select.options].map((option) => option.textContent))
      .toEqual(["Any", "Engineering", "Design"]);
  });

  it("writes the chosen row's key onto the rule", async () => {
    installHost({
      sockets: [TILE_SOCKET],
      collectionRows: [{ key: "team-1", value: { name: "Engineering" } }],
    });
    const Card = await loadCard([{ pluginId: "graph", displayName: "Graph" }]);
    const onChange = vi.fn();

    render(<Harness Card={Card} initial={GRAPH_TILE_TRIGGER} onChange={onChange} />);
    const select = await screen.findByLabelText("Team") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "team-1" } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      pluginFilters: { teamId: "team-1" },
    }));
  });

  it("degrades an unreadable collection to a text box and says why", async () => {
    // The routine case, not an error case: the web client serves collection
    // rows out of panel snapshots, and a trigger grid opens no panel.
    installHost({ sockets: [TILE_SOCKET], collectionRows: null });
    const Card = await loadCard([{ pluginId: "graph", displayName: "Graph" }]);

    render(<Harness Card={Card} initial={GRAPH_TILE_TRIGGER} />);

    await waitFor(() => {
      const field = screen.getByLabelText("Team");
      expect(field.tagName).toBe("INPUT");
    });
    expect(screen.getByText(/Couldn't read teams/)).toBeTruthy();
  });

  it("degrades an EMPTY collection the same way", async () => {
    installHost({ sockets: [TILE_SOCKET], collectionRows: [] });
    const Card = await loadCard([{ pluginId: "graph", displayName: "Graph" }]);

    render(<Harness Card={Card} initial={GRAPH_TILE_TRIGGER} />);

    await waitFor(() => expect(screen.getByLabelText("Team").tagName).toBe("INPUT"));
    expect(screen.getByText(/Nothing synced in teams yet/)).toBeTruthy();
  });

  it("writes a text filter's value", async () => {
    installHost({ sockets: [TILE_SOCKET], collectionRows: [] });
    const Card = await loadCard([{ pluginId: "graph", displayName: "Graph" }]);
    const onChange = vi.fn();

    render(<Harness Card={Card} initial={GRAPH_TILE_TRIGGER} onChange={onChange} />);
    fireEvent.change(await screen.findByLabelText("Title contains"), { target: { value: "flaky" } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      pluginFilters: { titlePattern: "flaky" },
    }));
  });
});

describe("a selected plugin tile's webhook block", () => {
  it("renders the plugin's status, then re-reads it after one Register", async () => {
    installHost({
      sockets: [TILE_SOCKET],
      collectionRows: [],
      statuses: [{ state: "unconfigured" }, { state: "ready", lastReceivedAt: "2026-09-03T00:00:00.000Z" }],
    });
    const Card = await loadCard([{ pluginId: "graph", displayName: "Graph" }]);

    render(<Harness Card={Card} initial={GRAPH_TILE_TRIGGER} />);

    await screen.findByText(/Not registered yet/);
    fireEvent.click(screen.getByRole("button", { name: "Register" }));

    await screen.findByText("Registered, and events are arriving.");
    // One register, and one status read per state the line showed.
    expect(invoked.filter((entry) => entry.action === "registerWebhook")).toHaveLength(1);
    expect(invoked.filter((entry) => entry.action === "webhookStatus")).toHaveLength(2);
  });

  it("reports a failed Register in place rather than claiming success", async () => {
    installHost({ sockets: [TILE_SOCKET], collectionRows: [] });
    const Card = await loadCard([{ pluginId: "graph", displayName: "Graph" }]);
    (window as unknown as { ade: { plugins: { invoke: unknown } } }).ade.plugins.invoke = async (
      args: { action: string },
    ) => {
      invoked.push({ action: args.action });
      if (args.action === "registerWebhook") throw new Error("relay refused");
      return { state: "unconfigured" };
    };

    render(<Harness Card={Card} initial={GRAPH_TILE_TRIGGER} />);
    await screen.findByText(/Not registered yet/);
    fireEvent.click(screen.getByRole("button", { name: "Register" }));

    await screen.findByText("relay refused");
  });
});

describe("the generic Plugins tile", () => {
  it("disappears when every plugin with triggers declares a tile", async () => {
    installHost({ sockets: [TILE_SOCKET], collectionRows: [] });
    const Card = await loadCard([{
      pluginId: "graph",
      displayName: "Graph",
      automationTriggers: [{ id: "issueCreated", label: "Issue created" }],
    }]);

    render(<Harness Card={Card} initial={{ type: "schedule", cron: "0 9 * * 1-5" }} />);

    await screen.findByRole("button", { name: "Graph" });
    expect(screen.queryByRole("button", { name: "Plugins" })).toBeNull();
  });

  it("stays for a plugin that declares triggers and no tile", async () => {
    installHost({ sockets: [TILE_SOCKET], collectionRows: [] });
    const Card = await loadCard([
      { pluginId: "graph", displayName: "Graph", automationTriggers: [{ id: "issueCreated", label: "Issue created" }] },
      { pluginId: "costguard", displayName: "Cost Guard", automationTriggers: [{ id: "capped", label: "Cap reached" }] },
    ]);

    render(<Harness Card={Card} initial={{ type: "schedule", cron: "0 9 * * 1-5" }} />);

    await screen.findByRole("button", { name: "Graph" });
    expect(screen.getByRole("button", { name: "Plugins" })).toBeTruthy();
  });

  it("stays on a machine with no plugins at all, as the empty state", async () => {
    installHost({ sockets: [] });
    const Card = await loadCard([]);

    render(<Harness Card={Card} initial={{ type: "schedule", cron: "0 9 * * 1-5" }} />);

    expect(screen.getByRole("button", { name: "Plugins" })).toBeTruthy();
  });

  it("keeps a tile-declaring plugin out of the generic picker's select", async () => {
    installHost({ sockets: [TILE_SOCKET], collectionRows: [] });
    const Card = await loadCard([
      { pluginId: "graph", displayName: "Graph", automationTriggers: [{ id: "issueCreated", label: "Issue created" }] },
      { pluginId: "costguard", displayName: "Cost Guard", automationTriggers: [{ id: "capped", label: "Cap reached" }] },
    ]);

    render(<Harness Card={Card} initial={{ type: "plugin" }} />);

    await screen.findByRole("button", { name: "Graph" });
    const select = screen.getByLabelText("Plugin event") as HTMLSelectElement;
    const rows = [...select.options].map((option) => option.textContent);
    expect(rows).toContain("Cost Guard — Cap reached");
    expect(rows).not.toContain("Graph — Issue created");
  });

  it("stays for a saved rule pointing at a plugin that is no longer installed", async () => {
    installHost({ sockets: [TILE_SOCKET], collectionRows: [] });
    const Card = await loadCard([{
      pluginId: "graph",
      displayName: "Graph",
      automationTriggers: [{ id: "issueCreated", label: "Issue created" }],
    }]);

    render(<Harness Card={Card} initial={{ type: "plugin", pluginId: "gone", pluginTrigger: "vanished" }} />);

    await screen.findByRole("button", { name: "Graph" });
    expect(screen.getByRole("button", { name: "Plugins" })).toBeTruthy();
    expect(screen.getByText(/isn't installed on this machine/)).toBeTruthy();
  });
});
