import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectConfigService } from "./projectConfigService";

function makeDb() {
  const store = new Map<string, unknown>();
  return {
    getJson: vi.fn((key: string) => (store.has(key) ? store.get(key) : null)),
    setJson: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
    }),
    run: vi.fn(),
  } as any;
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

describe("projectConfigService process groups", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) break;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges processGroups by id with local overriding shared", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-groups-merge-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        processGroups: [
          { id: "backend", name: "Backend" },
          { id: "frontend", name: "Frontend" },
        ],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    fs.writeFileSync(
      path.join(adeDir, "local.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        processGroups: [{ id: "frontend", name: "Web" }],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-groups-merge",
      db: makeDb(),
      logger: makeLogger(),
    });

    const groups = service.get().effective.processGroups;
    const byId = new Map(groups.map((g) => [g.id, g]));
    expect(byId.has("backend")).toBe(true);
    expect(byId.has("frontend")).toBe(true);
    expect(byId.get("backend")!.name).toBe("Backend");
    expect(byId.get("frontend")!.name).toBe("Web");
  });

  it("falls back to id when an effective processGroup has no name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-groups-fallback-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        processGroups: [{ id: "infra" }],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-groups-fallback",
      db: makeDb(),
      logger: makeLogger(),
    });

    const groups = service.get().effective.processGroups;
    const infra = groups.find((g) => g.id === "infra");
    expect(infra).toBeTruthy();
    expect(infra!.name).toBe("infra");
  });

  it("round-trips ProcessDefinition.groupIds with local overriding shared", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-groupids-override-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [
          {
            id: "api",
            name: "API",
            command: ["npm", "run", "api"],
            groupIds: ["backend"],
          },
        ],
        processGroups: [
          { id: "backend", name: "Backend" },
          { id: "frontend", name: "Frontend" },
        ],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    fs.writeFileSync(
      path.join(adeDir, "local.yaml"),
      YAML.stringify({
        version: 1,
        processes: [{ id: "api", groupIds: ["frontend"] }],
        processGroups: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-groupids-override",
      db: makeDb(),
      logger: makeLogger(),
    });

    const api = service.get().effective.processes.find((p) => p.id === "api");
    expect(api).toBeTruthy();
    expect(api!.groupIds).toEqual(["frontend"]);
  });

  it("preserves shared groupIds when local does not override them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-groupids-preserve-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [
          {
            id: "api",
            name: "API",
            command: ["npm", "run", "api"],
            groupIds: ["backend"],
          },
        ],
        processGroups: [{ id: "backend", name: "Backend" }],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    fs.writeFileSync(
      path.join(adeDir, "local.yaml"),
      YAML.stringify({
        version: 1,
        processes: [{ id: "api", cwd: "./server" }],
        processGroups: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-groupids-preserve",
      db: makeDb(),
      logger: makeLogger(),
    });

    const api = service.get().effective.processes.find((p) => p.id === "api");
    expect(api).toBeTruthy();
    expect(api!.groupIds).toEqual(["backend"]);
  });

  it("returns an empty array when processGroups section is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-groups-empty-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    fs.writeFileSync(
      path.join(adeDir, "local.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-groups-empty",
      db: makeDb(),
      logger: makeLogger(),
    });

    const groups = service.get().effective.processGroups;
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBe(0);
  });
});
