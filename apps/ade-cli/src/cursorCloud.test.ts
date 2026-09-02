import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PLUGIN_BUILTIN_SURFACE_OWNER_IDS } from "../../desktop/src/shared/plugins/builtinSurfaceRegistry";
import { buildCliPlan } from "./cli";
import { CursorCloudUsageError, parseCursorCloudCommand, runCursorCloud } from "./cursorCloud";

const cursorModelsListMock = vi.hoisted(() => vi.fn());

vi.mock("@cursor/sdk", () => ({
  Cursor: {
    models: {
      list: (...args: unknown[]) => cursorModelsListMock(...args),
    },
  },
}));

const CURSOR_CLOUD_PLUGIN_ID = PLUGIN_BUILTIN_SURFACE_OWNER_IDS["cursor-cloud"];

let adeHome: string;
let previousAdeHome: string | undefined;

function writeCursorCloudPlugin(options: { enabled?: boolean } = {}): void {
  const root = path.join(adeHome, "plugins", CURSOR_CLOUD_PLUGIN_ID);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({
    name: CURSOR_CLOUD_PLUGIN_ID,
    version: "1.0.0",
    displayName: "Cursor Cloud",
    description: "Cursor Cloud fixture",
    vocabVersion: 1,
    entry: "index.js",
    surfaces: [{ kind: "tab", id: "fleet", title: "Cursor Cloud", panelId: "fleet" }],
    panels: [{ id: "fleet", schemaFile: "panels/fleet.json" }],
    cli: ["agents", "runs", "artifacts", "repos", "me"],
  }, null, 2), "utf8");
  const statePath = path.join(adeHome, "plugins", "state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    plugins: {
      [CURSOR_CLOUD_PLUGIN_ID]: {
        pluginId: CURSOR_CLOUD_PLUGIN_ID,
        version: "1.0.0",
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
  adeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-cli-"));
  process.env.ADE_HOME = adeHome;
});

afterEach(() => {
  cursorModelsListMock.mockReset();
  if (previousAdeHome === undefined) delete process.env.ADE_HOME;
  else process.env.ADE_HOME = previousAdeHome;
  fs.rmSync(adeHome, { recursive: true, force: true });
});

describe("ADE CLI cursor cloud surface", () => {
  it("routes 'cursor cloud' to a cursor-cloud plan", () => {
    const plan = buildCliPlan(["cursor", "cloud", "agents", "list", "--archived"]);
    expect(plan.kind).toBe("cursor-cloud");
    if (plan.kind !== "cursor-cloud") return;
    expect(plan.rest).toEqual(["agents", "list", "--archived"]);
  });

  it("renders top-level cursor help via --help", () => {
    const plan = buildCliPlan(["cursor", "--help"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("Cursor Cloud");
    expect(plan.text).toContain("ade cursor cloud agents");
  });

  it("renders group-level cursor help via --help", () => {
    const plan = buildCliPlan(["cursor", "cloud", "agents", "--help"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("Cursor Cloud: agents");
  });

  it("resolves help via 'help cursor cloud runs' too", () => {
    const plan = buildCliPlan(["help", "cursor", "cloud", "runs"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("Cursor Cloud: runs");
  });

  it("rejects an unknown ade cursor surface", () => {
    expect(() => buildCliPlan(["cursor", "local", "agents", "list"])).toThrow(/'ade cursor' surface 'local'/);
  });

  it("routes declared words through the plugin when it is installed", () => {
    writeCursorCloudPlugin();
    const plan = buildCliPlan(["cursor", "cloud", "agents", "list", "--archived"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe(`plugin ${CURSOR_CLOUD_PLUGIN_ID} agents`);
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
              pluginId: CURSOR_CLOUD_PLUGIN_ID,
              action: "agents",
              argv: ["agents", "list", "--archived"],
            },
          },
        },
        unwrapToolResult: true,
      },
    ]);
  });

  it("maps singular compiled aliases onto the plugin's declared words", () => {
    writeCursorCloudPlugin();
    const plan = buildCliPlan(["cursor", "cloud", "agent", "list"]);
    expect(plan.kind).toBe("execute");
    if (plan.kind !== "execute") return;
    expect(plan.label).toBe(`plugin ${CURSOR_CLOUD_PLUGIN_ID} agents`);
    expect(plan.steps[0]).toMatchObject({
      params: {
        arguments: {
          args: {
            action: "agents",
            argv: ["agents", "list"],
          },
        },
      },
    });
  });

  it("prints plugin usage for ade cursor cloud when the plugin is installed", () => {
    writeCursorCloudPlugin();
    const plan = buildCliPlan(["cursor", "cloud", "--help"]);
    expect(plan.kind).toBe("help");
    if (plan.kind !== "help") return;
    expect(plan.text).toContain("ade cursor cloud agents");
    expect(plan.text).not.toContain(`ade ${CURSOR_CLOUD_PLUGIN_ID} agents`);
    expect(plan.text).toContain("ade cursor cloud models");
  });

  it("keeps models on the compiled SDK path because the plugin does not declare that word", () => {
    writeCursorCloudPlugin();
    const plan = buildCliPlan(["cursor", "cloud", "models", "list"]);
    expect(plan.kind).toBe("cursor-cloud");
    if (plan.kind !== "cursor-cloud") return;
    expect(plan.rest).toEqual(["models", "list"]);
  });

  it("keeps the compiled path when the plugin is installed but disabled", () => {
    writeCursorCloudPlugin({ enabled: false });
    const plan = buildCliPlan(["cursor", "cloud", "agents", "list"]);
    expect(plan.kind).toBe("cursor-cloud");
  });
});

describe("parseCursorCloudCommand", () => {
  it("normalizes plural and singular group aliases", () => {
    const parsed = parseCursorCloudCommand(["agents", "list"]);
    expect(parsed?.group).toBe("agents");
    expect(parsed?.sub).toBe("list");

    const singular = parseCursorCloudCommand(["repo", "list"]);
    expect(singular?.group).toBe("repos");
  });

  it("defaults runtime sub to 'list' when missing", () => {
    const parsed = parseCursorCloudCommand(["agents"]);
    expect(parsed?.group).toBe("agents");
    expect(parsed?.sub).toBe("list");
  });

  it("handles 'me' as a single-shot group", () => {
    const parsed = parseCursorCloudCommand(["me"]);
    expect(parsed?.group).toBe("me");
    expect(parsed?.sub).toBe("show");
  });

  it("rejects an unknown group", () => {
    expect(() => parseCursorCloudCommand(["bogus", "list"])).toThrow(CursorCloudUsageError);
  });
});

describe("runCursorCloud", () => {
  it("renders current Cursor SDK model list entries in text mode", async () => {
    cursorModelsListMock.mockResolvedValue([
      { id: "cursor/claude-sonnet-5", displayName: "Claude Sonnet 5" },
      { model: { id: "legacy/composer" }, displayName: "Legacy Composer" },
    ]);

    const result = await runCursorCloud(["models", "list"], "text");

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Claude Sonnet 5 (cursor/claude-sonnet-5)");
    expect(result.output).toContain("Legacy Composer (legacy/composer)");
    expect(cursorModelsListMock).toHaveBeenCalledWith({ apiKey: undefined });
  });
});
