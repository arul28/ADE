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

describe("projectConfigService notifications", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) break;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deep-merges APNs local overrides with shared notification config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-notifications-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    fs.writeFileSync(
      path.join(adeDir, "ade.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        notifications: {
          apns: {
            enabled: true,
            env: "production",
            keyId: "KEY_SHARED",
            teamId: "TEAM_SHARED",
            bundleId: "com.ade.shared",
            keyStored: true,
          },
        },
      }),
      "utf8",
    );

    fs.writeFileSync(
      path.join(adeDir, "local.yaml"),
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        notifications: {
          apns: {
            keyId: "KEY_LOCAL",
          },
        },
      }),
      "utf8",
    );

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-notifications",
      db: makeDb(),
      logger: makeLogger(),
    });

    expect(service.get().effective.notifications?.apns).toEqual({
      enabled: true,
      env: "production",
      keyId: "KEY_LOCAL",
      teamId: "TEAM_SHARED",
      bundleId: "com.ade.shared",
      keyStored: true,
    });
  });
});
