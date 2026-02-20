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

describe("projectConfigService legacy AI mode migration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) break;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps legacy providers.mode to ai.mode and removes providers.mode on save", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    const localPath = path.join(adeDir, "local.yaml");
    fs.writeFileSync(
      localPath,
      YAML.stringify({
        version: 1,
        processes: [],
        stackButtons: [],
        testSuites: [],
        laneOverlayPolicies: [],
        automations: [],
        providers: {
          mode: "hosted",
          contextTools: {
            conflictResolvers: {
              claude: { command: ["node", "resolver.js"] }
            }
          }
        }
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
    expect(snapshot.effective.providerMode).toBe("subscription");
    expect(snapshot.local.ai?.mode).toBe("subscription");
    expect((snapshot.local.providers as Record<string, unknown> | undefined)?.mode).toBeUndefined();
    expect((snapshot.local.providers as Record<string, unknown> | undefined)?.contextTools).toBeDefined();

    service.save({
      shared: snapshot.shared,
      local: snapshot.local
    });

    const persisted = YAML.parse(fs.readFileSync(localPath, "utf8")) as Record<string, unknown>;
    const persistedAi = persisted.ai as Record<string, unknown>;
    const persistedProviders = persisted.providers as Record<string, unknown> | undefined;

    expect(persistedAi.mode).toBe("subscription");
    expect(persistedProviders?.mode).toBeUndefined();
    expect((persistedProviders?.contextTools as Record<string, unknown> | undefined)).toBeDefined();
  });
});
