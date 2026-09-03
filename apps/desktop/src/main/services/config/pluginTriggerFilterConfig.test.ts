import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProjectConfigService } from "./projectConfigService";

/**
 * `AutomationTrigger.pluginFilters` through the project config.
 *
 * The bag exists because a trigger tile's filter KEYS are the plugin's own
 * vocabulary, so ADE cannot grow a typed column for each. What it can do is
 * bound them, and this is the proof that the same bounds apply on the way out of
 * the YAML and on the way into the effective config: a pair of coercers that
 * disagreed would rewrite a user's shared config file with fields the reader had
 * already dropped, every time anything else in it was saved.
 */

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function serviceWithTrigger(trigger: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plugin-trigger-filters-"));
  tempDirs.push(root);
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  fs.writeFileSync(
    path.join(adeDir, "ade.yaml"),
    YAML.stringify({
      version: 1,
      testSuites: [],
      laneOverlayPolicies: [],
      automations: [{ id: "plugin-rule", name: "Plugin rule", trigger }],
    }),
    "utf8",
  );
  const store = new Map<string, unknown>();
  return createProjectConfigService({
    projectRoot: root,
    adeDir,
    projectId: "project-1",
    db: {
      getJson: vi.fn((key: string) => (store.has(key) ? store.get(key) : null)),
      setJson: vi.fn((key: string, value: unknown) => void store.set(key, value)),
      run: vi.fn(),
    } as never,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never,
  });
}

function filtersFrom(trigger: Record<string, unknown>): Record<string, string> | undefined {
  const rule = serviceWithTrigger(trigger).get().effective.automations[0]!;
  return rule.triggers[0]!.pluginFilters;
}

describe("pluginFilters in the project config", () => {
  it("round-trips a tile's filter values onto the effective trigger", () => {
    expect(filtersFrom({
      type: "plugin",
      pluginId: "graph",
      pluginTrigger: "issueMoved",
      pluginFilters: { teamId: "team-1", titlePattern: "flaky" },
    })).toEqual({ teamId: "team-1", titlePattern: "flaky" });
  });

  it("drops blanks and non-strings — an empty filter is the absence of a filter", () => {
    expect(filtersFrom({
      type: "plugin",
      pluginId: "graph",
      pluginTrigger: "issueMoved",
      pluginFilters: { teamId: "  ", projectId: "p1", count: 3, nested: { a: 1 } },
    })).toEqual({ projectId: "p1" });
  });

  it("caps the bag at the number of filters a tile may draw", () => {
    const wide: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) wide[`k${index}`] = `v${index}`;
    const filters = filtersFrom({
      type: "plugin",
      pluginId: "graph",
      pluginTrigger: "issueMoved",
      pluginFilters: wide,
    })!;
    expect(Object.keys(filters)).toHaveLength(6);
  });

  it("keeps the bag off a trigger that carries none", () => {
    expect(filtersFrom({ type: "plugin", pluginId: "graph", pluginTrigger: "issueMoved" }))
      .toBeUndefined();
    expect(filtersFrom({ type: "manual" })).toBeUndefined();
  });

  it("keeps the filters on a half-written plugin trigger, so validation sees what was written", () => {
    expect(filtersFrom({ type: "plugin", pluginFilters: { teamId: "team-1" } }))
      .toEqual({ teamId: "team-1" });
  });
});
