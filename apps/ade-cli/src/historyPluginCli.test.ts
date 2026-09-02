import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PLUGIN_BUILTIN_SURFACE_OWNER_IDS } from "../../desktop/src/shared/plugins/builtinSurfaceRegistry";
import { buildCliPlan } from "./cli";

const HISTORY_PLUGIN_ID = PLUGIN_BUILTIN_SURFACE_OWNER_IDS.history;

let adeHome: string;
let previousAdeHome: string | undefined;

function writeHistoryPlugin(options: { enabled?: boolean } = {}): void {
  const root = path.join(adeHome, "plugins", HISTORY_PLUGIN_ID);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({
    name: HISTORY_PLUGIN_ID,
    version: "1.1.0",
    displayName: "History",
    description: "History fixture",
    vocabVersion: 1,
    entry: "index.js",
    surfaces: [{ kind: "tab", id: "commits", title: "History", panelId: "commits" }],
    panels: [{ id: "commits", schemaFile: "panels/commits.json" }],
    cli: ["activity"],
  }, null, 2), "utf8");
  const statePath = path.join(adeHome, "plugins", "state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    plugins: {
      [HISTORY_PLUGIN_ID]: {
        pluginId: HISTORY_PLUGIN_ID,
        version: "1.1.0",
        enabled: options.enabled !== false,
        source: { kind: "local", path: root },
        installedAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
      },
    },
  }), "utf8");
}

beforeEach(() => {
  previousAdeHome = process.env.ADE_HOME;
  adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-history-cli-"));
  process.env.ADE_HOME = adeHome;
});

afterEach(() => {
  if (previousAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = previousAdeHome;
  fs.rmSync(adeHome, { recursive: true, force: true });
});

describe("ADE CLI history plugin alias", () => {
  it("keeps compiled history list when the plugin is not installed", () => {
    const plan = buildCliPlan(["history", "list"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("history list");
  });

  it("refuses activity until the plugin is installed", () => {
    expect(() => buildCliPlan(["history", "activity"])).toThrowError(/history supports list/);
  });

  it("routes ade history activity through plugin invoke when the plugin is installed", () => {
    writeHistoryPlugin();
    const plan = buildCliPlan(["history", "activity"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe(`plugin ${HISTORY_PLUGIN_ID} activity`);
    expect(plan.steps).toEqual([
      {
        key: "result",
        method: "ade/actions/call",
        params: {
          name: "run_ade_action",
          arguments: {
            domain: "plugin",
            action: "invoke",
            args: {
              pluginId: HISTORY_PLUGIN_ID,
              action: "activity",
              argv: ["activity"],
            },
          },
        },
        unwrapToolResult: true,
      },
    ]);
  });

  it("still lists operations through the compiled command when the plugin is installed", () => {
    writeHistoryPlugin();
    const plan = buildCliPlan(["history", "list"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe("history list");
  });

  it("keeps compiled history when the plugin is installed but disabled", () => {
    writeHistoryPlugin({ enabled: false });
    expect(() => buildCliPlan(["history", "activity"])).toThrowError(/history supports list/);
  });
});
