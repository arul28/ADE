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
    run: vi.fn()
  } as any;
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  } as any;
}

describe("projectConfigService lane env init", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) break;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves extended overlay fields and merged lane env init in effective config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-lane-init-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    fs.writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n", "utf8");

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        automations: [],
        laneEnvInit: {
          envFiles: [{ source: ".env.template", dest: ".env" }]
        },
        laneOverlayPolicies: [
          {
            id: "backend-policy",
            name: "Backend policy",
            enabled: true,
            match: { tags: ["backend"] },
            overrides: {
              portRange: { start: 4100, end: 4199 },
              proxyHostname: "backend.localhost",
              computeBackend: "vps",
              envInit: {
                dependencies: [{ command: ["npm", "install"] }]
              }
            }
          }
        ]
      }),
      "utf8"
    );

    fs.writeFileSync(
      path.join(adeDir, "local.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        automations: [],
        laneEnvInit: {
          mountPoints: [{ source: "agent-profiles/default.json", dest: ".ade-agent/profile.json" }]
        },
        laneOverlayPolicies: [
          {
            id: "backend-policy",
            overrides: {
              envInit: {
                docker: { composePath: "docker-compose.yml" }
              }
            }
          }
        ]
      }),
      "utf8"
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger()
    });

    const snapshot = service.get();
    const policy = snapshot.effective.laneOverlayPolicies[0];

    expect(policy?.overrides.portRange).toEqual({ start: 4100, end: 4199 });
    expect(policy?.overrides.proxyHostname).toBe("backend.localhost");
    expect(policy?.overrides.computeBackend).toBe("vps");
    expect(policy?.overrides.envInit).toEqual({
      dependencies: [{ command: ["npm", "install"] }],
      docker: { composePath: "docker-compose.yml" }
    });
    expect(snapshot.effective.laneEnvInit).toEqual({
      envFiles: [{ source: ".env.template", dest: ".env" }],
      mountPoints: [{ source: "agent-profiles/default.json", dest: ".ade-agent/profile.json" }]
    });
  });

  it("flags invalid extended lane env init settings during validation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-lane-init-invalid-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger()
    });

    const validation = service.validate({
      shared: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        automations: [],
        laneEnvInit: {
          docker: { composePath: "missing-compose.yml" },
          dependencies: [{ command: ["npm", "install"], cwd: "missing-dir" }]
        },
        laneOverlayPolicies: [
          {
            id: "invalid-overlay",
            overrides: {
              portRange: { start: 4300, end: 4200 }
            }
          }
        ]
      },
      local: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: []
      }
    });

    expect(validation.ok).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "effective.laneOverlayPolicies[0].overrides.portRange" }),
        expect.objectContaining({ path: "effective.laneEnvInit.docker.composePath" }),
        expect.objectContaining({ path: "effective.laneEnvInit.dependencies[0].cwd" })
      ])
    );
  });

  it("deep merges nested docker config across shared and local lane env init", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-lane-init-docker-merge-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });
    fs.writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n", "utf8");

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger()
    });

    service.save({
      shared: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        automations: [],
        laneEnvInit: {
          docker: { composePath: "docker-compose.yml", projectPrefix: "shared" }
        },
        laneOverlayPolicies: []
      },
      local: {
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        automations: [],
        laneEnvInit: {
          docker: { services: ["api"] }
        },
        laneOverlayPolicies: []
      }
    });

    const effective = service.getEffective();
    expect(effective.laneEnvInit?.docker).toEqual({
      composePath: "docker-compose.yml",
      projectPrefix: "shared",
      services: ["api"]
    });
  });
});
