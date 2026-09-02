import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PLUGIN_BUILTIN_SURFACE_OWNER_IDS } from "../../desktop/src/shared/plugins/builtinSurfaceRegistry";
import { buildCliPlan } from "./cli";

const REVIEW_PLUGIN_ID = PLUGIN_BUILTIN_SURFACE_OWNER_IDS.review;

let adeHome: string;
let previousAdeHome: string | undefined;

function writeReviewPlugin(options: { enabled?: boolean } = {}): void {
  const root = path.join(adeHome, "plugins", REVIEW_PLUGIN_ID);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({
    name: REVIEW_PLUGIN_ID,
    version: "1.1.0",
    displayName: "Review",
    description: "Review fixture",
    vocabVersion: 1,
    entry: "index.js",
    surfaces: [{ kind: "tab", id: "runs", title: "Review", panelId: "runs" }],
    panels: [{ id: "runs", schemaFile: "panels/runs.json" }],
    cli: ["runs", "launch", "learnings"],
  }, null, 2), "utf8");
  const statePath = path.join(adeHome, "plugins", "state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    plugins: {
      [REVIEW_PLUGIN_ID]: {
        pluginId: REVIEW_PLUGIN_ID,
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
  adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-review-cli-"));
  process.env.ADE_HOME = adeHome;
});

afterEach(() => {
  if (previousAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = previousAdeHome;
  fs.rmSync(adeHome, { recursive: true, force: true });
});

describe("ADE CLI review plugin alias", () => {
  it("stays unknown when the plugin is not installed", () => {
    expect(() => buildCliPlan(["review", "runs"])).toThrowError(/Unknown command 'review'/);
  });

  it("routes ade review runs through plugin invoke when the plugin is installed", () => {
    writeReviewPlugin();
    const plan = buildCliPlan(["review", "runs"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe(`plugin ${REVIEW_PLUGIN_ID} runs`);
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
              pluginId: REVIEW_PLUGIN_ID,
              action: "runs",
              argv: ["runs"],
            },
          },
        },
        unwrapToolResult: true,
      },
    ]);
  });

  it("prints plugin usage as ade review when the plugin is installed", () => {
    writeReviewPlugin();
    const bare = buildCliPlan(["review"]);
    expect(bare.kind).toBe("help");
    if (bare.kind !== "help") return;
    expect(bare.text).toContain("ade review runs");
    expect(bare.text).not.toContain(`ade ${REVIEW_PLUGIN_ID} runs`);

    const flagged = buildCliPlan(["review", "--help"]);
    expect(flagged.kind).toBe("help");
    if (flagged.kind !== "help") return;
    expect(flagged.text).toContain("ade review launch");
  });

  it("keeps the unknown path when the plugin is installed but disabled", () => {
    writeReviewPlugin({ enabled: false });
    expect(() => buildCliPlan(["review", "launch"])).toThrowError(/Unknown command 'review'/);
  });
});
