import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../logging/logger";
import { parsePluginManifestJson, type PluginManifest } from "../../../shared/plugins/manifest";
import {
  collectVocabStateDeclarations,
  parsePluginPanel,
  vocabSchemaBytes,
} from "../../../shared/plugins/vocabulary";
import {
  VOCAB_LIMITS,
  coerceBoundListItem,
  filterVocabRows,
  vocabInitialPanelState,
  type VocabListNode,
  type VocabNode,
} from "../../../shared/plugins/vocabularyNodes";
import {
  PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN,
  PLUGIN_COLLECTION_VALUE_MAX_BYTES,
} from "../../../shared/plugins/sdk";
import { PLUGIN_PROVIDER_KEY_IDS } from "../../../shared/plugins/manifest";
import { createPluginInstallService } from "./pluginInstallService";

/**
 * `ade-cursor-cloud` against the REAL parsers it has to satisfy.
 *
 * `pilotPackages.test.ts` already proves the manifest on disk parses. What it
 * cannot prove is the half this plugin computes at runtime: the fleet panel it
 * publishes with a hundred rows in it, the rows themselves as the vocabulary
 * coerces them, and the filter those rows are compared against. Every one of
 * those is a shape the plugin invents on a machine nobody is watching, so it is
 * checked here against the same code four clients run.
 *
 * The plugin's own logic is covered by `plugins/ade-cursor-cloud/test/*.test.js`
 * under `node --test` — CommonJS, exactly as the child bootstrap loads it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const pluginRoot = path.join(repoRoot, "plugins/ade-cursor-cloud");
const require_ = createRequire(import.meta.url);

// Loaded through `require` on purpose: this is CommonJS plugin code, exactly as
// the child bootstrap loads it, so a syntax error or a missing export fails
// here rather than at install time.
const panels = require_(path.join(pluginRoot, "panels.js")) as {
  buildFleetPanel: (input?: Record<string, unknown>) => unknown;
  buildAgentPanel: (input?: Record<string, unknown>) => unknown;
  buildLaunchPanel: (input?: Record<string, unknown>) => unknown;
  FLEET_ROW_ACTIONS: string[];
};
const fleet = require_(path.join(pluginRoot, "fleet.js")) as {
  fleetRow: (entry: unknown, options?: Record<string, unknown>) => Record<string, unknown>;
  fleetRowKey: (group: string, index: number, agentId: string) => string;
};

function manifest(): PluginManifest {
  const parsed = parsePluginManifestJson(fs.readFileSync(path.join(pluginRoot, "plugin.json"), "utf8"));
  expect(parsed.errors).toEqual([]);
  expect(parsed.manifest).not.toBeNull();
  return parsed.manifest!;
}

function entryFor(index: number, over: Record<string, unknown> = {}) {
  return {
    agent: {
      agentId: `bc_${String(index).padStart(12, "0")}`,
      name: `Fix the flaky sync test number ${index}`,
      summary: "",
      archived: over.archived === true,
      status: "running",
      createdAt: 1_756_000_000_000,
      lastModified: 1_756_000_000_000,
      repos: ["https://github.com/acme/app"],
      webUrl: `https://cursor.com/agents?id=bc_${index}`,
      latestRunId: `r${index}`,
    },
    runStatus: over.runStatus ?? "running",
    latestRunId: `r${index}`,
    branch: `ade/fix-flaky-sync-${index}`,
    prUrl: null,
    modelId: "composer-2",
    matchedBy: "repo",
    ownership: {
      sessionId: null,
      sessionTitle: null,
      laneId: over.laneId ?? `lane-${index % 3}`,
      laneName: `Lane ${index % 3}`,
      linearIssueId: `ADE-${index}`,
    },
  };
}

describe("the fleet panel the plugin publishes", () => {
  const schema = panels.buildFleetPanel({
    state: "list",
    counts: { active: 40, lanes: 3, unlinked: 57, total: 100, archived: 6 },
    laneOptions: [
      { id: "lane-0", name: "Lane 0" },
      { id: "lane-1", name: "Lane 1" },
      { id: "lane-2", name: "Lane 2" },
    ],
    footer: "100 agents · updated just now",
  });

  it("parses with no warnings, which means nothing was silently dropped", () => {
    const parsed = parsePluginPanel(schema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.warnings).toEqual([]);
  });

  it("declares its filter keys within the panel-state ceilings", () => {
    const parsed = parsePluginPanel(schema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const declarations = collectVocabStateDeclarations(parsed.panel.body);
    expect(declarations.map((entry) => entry.stateKey)).toEqual(["status", "lane", "archived"]);
    expect(declarations.length).toBeLessThanOrEqual(VOCAB_LIMITS.maxStateKeys);
    for (const declaration of declarations) {
      expect(declaration.options.length).toBeLessThanOrEqual(VOCAB_LIMITS.maxStateOptions);
    }
    // The panel opens unfiltered on status and lane, and hiding archived — the
    // list a reader expects to see before they have touched anything.
    expect(vocabInitialPanelState(declarations)).toEqual({ status: "", lane: "", archived: "hide" });
  });

  it("keeps every `where` clause the parser accepted", () => {
    const parsed = parsePluginPanel(schema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const lists = parsed.panel.body.filter(
      (node: VocabNode): node is VocabListNode => node.component === "list",
    );
    expect(lists).toHaveLength(3);
    for (const list of lists) {
      // Three clauses in, three out. A clause the parser refused would leave a
      // filter that silently does nothing — the failure this asserts against.
      expect(list.bind?.where).toHaveLength(3);
      expect(list.bind?.allowActions).toEqual(panels.FLEET_ROW_ACTIONS);
    }
  });
});

describe("a hundred fleet rows", () => {
  const rows = Array.from({ length: 100 }, (_, index) => fleet.fleetRow(entryFor(index)));

  it("is one node's worth of budget, not seven hundred", () => {
    const schema = panels.buildFleetPanel({
      state: "list",
      counts: { active: 100, lanes: 3, unlinked: 0, total: 100, archived: 0 },
      laneOptions: [{ id: "lane-0", name: "Lane 0" }],
    });
    const parsed = parsePluginPanel(schema);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Rows live in a collection, not in the schema, so a hundred of them cost
    // the panel three list nodes. That is the whole argument for the rich row.
    expect(parsed.panel.body.filter((node: VocabNode) => node.component === "list")).toHaveLength(3);
  });

  it("fits the panel itself far under the schema byte budget, rows and all", () => {
    // The rows are stored per collection key rather than inline, so the panel's
    // own size does not grow with the fleet. That is what a `bind` buys, and it
    // is why a hundred-agent fleet is not a schema this plugin cannot publish.
    const schema = panels.buildFleetPanel({
      state: "list",
      counts: { active: 100, lanes: 3, unlinked: 0, total: 100, archived: 4 },
      laneOptions: [{ id: "lane-0", name: "Lane 0" }],
    });
    expect(vocabSchemaBytes(schema)).toBeLessThanOrEqual(VOCAB_LIMITS.maxSchemaBytes);
    expect(rows.length).toBeLessThanOrEqual(VOCAB_LIMITS.maxListItems);
  });

  it("keeps one row well under the per-value cap and the fleet under the plugin's", () => {
    // The two budgets that actually apply to a stored row. One fat row is
    // refused by the writer; a hundred of them must still leave the plugin room
    // for its session links, its lane secrets and its delivery ledger.
    for (const row of rows) {
      expect(vocabSchemaBytes(row)).toBeLessThanOrEqual(PLUGIN_COLLECTION_VALUE_MAX_BYTES);
    }
    const total = rows.reduce((sum, row) => sum + vocabSchemaBytes(row), 0);
    expect(total).toBeLessThanOrEqual(PLUGIN_COLLECTIONS_MAX_BYTES_PER_PLUGIN / 4);
  });

  it("survives the bound-row coercion with every action intact", () => {
    for (const row of rows) {
      const item = coerceBoundListItem(row, panels.FLEET_ROW_ACTIONS);
      expect(item).not.toBeNull();
      expect(item!.title).toBe(row.title);
      expect(item!.badge?.text).toBe("RUNNING");
      expect(item!.mono).toBeDefined();
      // A refused action would silently take the slot of one the panel allowed,
      // so the count is what proves the allowlist and the row agree.
      expect(item!.actions).toHaveLength((row.actions as unknown[]).length);
      expect(item!.overflow).toHaveLength((row.overflow as unknown[]).length);
      expect(item!.onPress?.action).toBe("openAgentDetail");
    }
  });

  it("drops a row action the panel never declared", () => {
    const row = { ...rows[0], actions: [{ action: "rm-rf", label: "Delete everything" }] };
    const item = coerceBoundListItem(row, panels.FLEET_ROW_ACTIONS);
    expect(item!.actions).toBeUndefined();
  });

  it("keys rows so each group binds by prefix and sorts in order", () => {
    const keys = rows.map((_, index) => fleet.fleetRowKey("active", index, `bc_${index}`));
    expect([...keys].sort()).toEqual(keys);
    expect(keys.every((key) => key.startsWith("active:"))).toBe(true);
  });
});

describe("the filter, evaluated the way every client evaluates it", () => {
  const rows = [
    fleet.fleetRow(entryFor(1, { runStatus: "running", laneId: "lane-1" })),
    fleet.fleetRow(entryFor(2, { runStatus: "finished", laneId: "lane-1" })),
    fleet.fleetRow(entryFor(3, { runStatus: "error", laneId: "lane-2" })),
    fleet.fleetRow(entryFor(4, { runStatus: "finished", laneId: "lane-2", archived: true })),
  ];
  const schema = panels.buildFleetPanel({
    state: "list",
    counts: { active: 1, lanes: 2, unlinked: 0, total: 4, archived: 1 },
    laneOptions: [{ id: "lane-1", name: "Lane 1" }, { id: "lane-2", name: "Lane 2" }],
  });
  const parsed = parsePluginPanel(schema);
  const where = parsed.ok
    ? (parsed.panel.body.find((node: VocabNode) => node.component === "list") as VocabListNode).bind?.where
    : undefined;

  it("shows every live agent when nothing is chosen", () => {
    expect(filterVocabRows(where, rows, { status: "", lane: "", archived: "hide" })).toHaveLength(3);
  });

  it("shows the archived one AS WELL when the toggle is flipped", () => {
    // The bug this pins: an option spelled `"show"` would have filtered every
    // LIVE row away and shown only the archived one.
    expect(filterVocabRows(where, rows, { status: "", lane: "", archived: "" })).toHaveLength(4);
  });

  it("narrows to one status without asking the plugin anything", () => {
    const active = filterVocabRows(where, rows, { status: "active", lane: "", archived: "hide" });
    expect(active.map((row) => (row as { agentId: string }).agentId)).toEqual([
      "bc_000000000001",
    ]);
    expect(filterVocabRows(where, rows, { status: "failed", lane: "", archived: "hide" })).toHaveLength(1);
  });

  it("combines status and lane", () => {
    expect(filterVocabRows(where, rows, { status: "finished", lane: "lane-1", archived: "hide" }))
      .toHaveLength(1);
    expect(filterVocabRows(where, rows, { status: "finished", lane: "lane-2", archived: "hide" }))
      .toHaveLength(0);
  });

  it("shows too much rather than too little when a key is unknown", () => {
    // A filter that failed must never hide rows a reader cannot see it hiding.
    expect(filterVocabRows(where, rows, {})).toHaveLength(4);
  });
});

describe("the agent and launch panels", () => {
  it("parse with the shapes the plugin actually publishes", () => {
    const agent = panels.buildAgentPanel({
      entry: entryFor(1),
      agentId: "bc_000000000001",
      status: "running",
      active: true,
      usage: { totalTokens: 41_200, costCents: 184 },
    });
    const launch = panels.buildLaunchPanel({
      lanes: [{ id: "lane-1", name: "Lane one" }],
      models: ["composer-2", "sonnet-4.5"],
      secretNames: ["DATABASE_URL", "STRIPE_KEY"],
      selectedSecrets: ["DATABASE_URL"],
      rememberSecretNames: true,
      draft: "fix the flaky sync test",
    });

    for (const [name, schema] of [["agent", agent], ["launch", launch]] as const) {
      const parsed = parsePluginPanel(schema);
      expect(parsed.ok, name).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.warnings, name).toEqual([]);
    }
  });

  it("never puts a secret's value in a schema, only its name", () => {
    const launch = JSON.stringify(panels.buildLaunchPanel({
      lanes: [{ id: "lane-1", name: "Lane one" }],
      secretNames: ["DATABASE_URL"],
      selectedSecrets: ["DATABASE_URL"],
    }));
    expect(launch).toContain("DATABASE_URL");
    expect(launch).not.toMatch(/postgres|sk_live|Bearer/);
  });
});

describe("what the manifest promises the platform", () => {
  const parsed = manifest();

  it("asks for the Cursor key by a provider id the key store actually holds", () => {
    expect(parsed.providerKeys).toEqual(["cursor"]);
    expect(PLUGIN_PROVIDER_KEY_IDS).toContain("cursor");
  });

  it("declares the one host it calls, and nothing wildcard", () => {
    expect(parsed.network?.hosts).toEqual(["api.cursor.com"]);
  });

  it("declares one webhook channel and no second signature check", () => {
    expect(parsed.webhookIngress).toHaveLength(1);
    expect(parsed.webhookIngress[0].id).toBe("cursor");
    // ADE generates the relay secret and Cursor signs with it, so the relay's
    // own `x-webhook-signature` check IS the verification. A `verify` block here
    // would demand a second secret the user has no way to produce.
    expect(parsed.webhookIngress[0].verify).toBeUndefined();
  });

  it("declares every capability its chat runtime actually implements", () => {
    expect(parsed.chatRuntimes).toHaveLength(1);
    expect(parsed.chatRuntimes![0]).toMatchObject({
      id: "cloud-agent",
      displayName: "Cursor Cloud",
      capabilities: { followUp: true, interrupt: true, hydrate: true, artifacts: true },
    });
  });

  it("names an action handler for every socket, tool, step and CLI word", () => {
    const entry = require_(path.join(pluginRoot, "index.js")) as {
      actions: Record<string, unknown>;
    };
    const declared = new Set<string>([
      ...parsed.sockets.flatMap((socket) => [
        ...(socket.actionId ? [socket.actionId] : []),
        ...(socket.menu ?? []).map((item) => item.actionId),
      ]),
      ...parsed.panels.flatMap((panel) => [
        ...(panel.refreshAction ? [panel.refreshAction] : []),
        ...(panel.viewAction ? [panel.viewAction] : []),
      ]),
      ...parsed.tools.map((tool) => tool.action ?? tool.name),
      ...parsed.automationSteps.map((step) => step.action),
      ...parsed.searchProviders.map((provider) => provider.action),
      ...parsed.cli,
    ]);
    // A declaration naming a handler that does not exist is a control the user
    // can press that answers `plugin_no_entry`, which reads as a broken plugin.
    for (const action of declared) {
      expect(typeof entry.actions[action], action).toBe("function");
    }
  });

  it("declares every collection it writes to", () => {
    // `collections.put` refuses an undeclared name, so an omission here is a
    // write that fails at runtime and nowhere earlier.
    expect(Object.keys(parsed.collections).sort()).toEqual([
      "deliveries",
      "fleet",
      "laneSecrets",
      "sessions",
      // The page's own view state — chosen filter, chosen sort. Declared with
      // `sync: false` so one reader's choice never travels to another machine.
      "ui-state",
    ]);
  });

  it("keeps every fleet-row action inside the binding allowlist", () => {
    const rows = [
      fleet.fleetRow(entryFor(1, { runStatus: "running" })),
      fleet.fleetRow(entryFor(2, { runStatus: "finished" })),
      fleet.fleetRow(entryFor(3, { archived: true, runStatus: "finished" })),
    ];
    for (const row of rows) {
      const named = [
        (row.onPress as { action: string }).action,
        ...(row.actions as { action: string }[]).map((action) => action.action),
        ...(row.overflow as { action: string }[]).map((action) => action.action),
      ];
      for (const action of named) expect(panels.FLEET_ROW_ACTIONS).toContain(action);
    }
  });
});

describe("installing it the way a user does", () => {
  const scratch: string[] = [];

  afterEach(() => {
    while (scratch.length) fs.rmSync(scratch.pop()!, { recursive: true, force: true });
  });

  function scratchRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-cloud-"));
    scratch.push(dir);
    return path.join(dir, "plugins");
  }

  const logger = (): Logger =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger);

  it("installs from the bundled directory with every surface and socket intact", async () => {
    const root = scratchRoot();
    const install = createPluginInstallService({
      logger: logger(),
      pluginsRoot: root,
      builtinPluginsRoot: path.join(repoRoot, "plugins"),
    });

    const installed = await install.install({ source: "ade-cursor-cloud" });

    expect(installed.errors).toEqual([]);
    expect(installed.warnings).toEqual([]);
    expect(installed.record.pluginId).toBe("ade-cursor-cloud");
    expect(installed.record.source.kind).toBe("builtin");
    expect(installed.record.enabled).toBe(true);

    expect(installed.manifest?.surfaces.map((surface) => surface.id)).toEqual([
      "fleet",
      // One agent's own page, drawn where the compiled Cursor Cloud detail used
      // to be. Its own surface rather than a mode of `fleet`: the fleet lists
      // and this one follows a single run.
      "agent",
      // The launch popover, drawn inside the machine picker.
      "launch",
    ]);
    expect(installed.manifest?.surfaces.every((surface) => Boolean(surface.panelId))).toBe(true);
    expect(installed.manifest?.sockets.map((socket) => socket.socket)).toEqual([
      // The launch row in the machine picker. `machine-entry` replaced the
      // composer button: launching a cloud agent is choosing where work runs,
      // and that question is asked once, in the picker.
      "machine-entry",
      "command-palette-action",
      "row-badge",
      // The Automations grid tile carrying the cloud run triggers.
      "automation-trigger-tile",
    ]);
    // Nothing here gates a compiled-in tab: the whole point of the extraction
    // is that a community author could have written this package.
    expect(installed.manifest?.surfaces.every((surface) => surface.builtin === undefined)).toBe(true);

    // The entry, the panels and the skill all have to be on disk after a copy.
    const installedRoot = path.join(root, "ade-cursor-cloud");
    expect(fs.existsSync(path.join(installedRoot, "index.js"))).toBe(true);
    for (const panel of installed.manifest?.panels ?? []) {
      if (!panel.schemaFile) continue;
      expect(fs.existsSync(path.join(installedRoot, panel.schemaFile)), panel.schemaFile).toBe(true);
    }
    expect(fs.existsSync(path.join(installedRoot, "skills/ade-cursor-cloud/SKILL.md"))).toBe(true);
  });

  it("ships no dependencies", () => {
    expect(fs.existsSync(path.join(pluginRoot, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(pluginRoot, "package.json"))).toBe(false);
  });
});
