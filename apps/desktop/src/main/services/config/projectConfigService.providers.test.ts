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

function writeLocalYaml(adeDir: string, providers: Record<string, unknown>) {
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
      ai: {
        permissions: {
          providers
        }
      }
    }),
    "utf8"
  );
  return localPath;
}

describe("projectConfigService permissions.providers coercion", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) break;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses permissions.providers fields into effective config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-providers-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    writeLocalYaml(adeDir, {
      claude: "edit",
      codex: "plan",
      cursor: "full-auto",
      opencode: "default",
      codexSandbox: "workspace-write",
      writablePaths: ["/tmp/a", "/tmp/b"],
      allowedTools: ["Read", "Write"]
    });

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger()
    });

    const providers = service.get().effective.ai?.permissions?.providers;
    expect(providers).toMatchObject({
      claude: "edit",
      codex: "plan",
      cursor: "full-auto",
      opencode: "default",
      codexSandbox: "workspace-write",
      writablePaths: ["/tmp/a", "/tmp/b"],
      allowedTools: ["Read", "Write"]
    });
  });

  it("drops invalid provider modes and keeps valid ones", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-providers-invalid-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    writeLocalYaml(adeDir, {
      claude: "bogus",
      codex: "plan"
    });

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger()
    });

    const providers = service.get().effective.ai?.permissions?.providers;
    expect(providers).toBeDefined();
    expect(providers?.codex).toBe("plan");
    expect(providers?.claude).toBeUndefined();
  });

  it("ignores empty writablePaths/allowedTools arrays", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-config-providers-empty-"));
    tempDirs.push(root);

    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });

    writeLocalYaml(adeDir, {
      codex: "full-auto",
      writablePaths: [],
      allowedTools: []
    });

    const service = createProjectConfigService({
      projectRoot: root,
      adeDir,
      projectId: "project-1",
      db: makeDb(),
      logger: makeLogger()
    });

    const providers = service.get().effective.ai?.permissions?.providers;
    expect(providers).toBeDefined();
    expect(providers?.codex).toBe("full-auto");
    expect(providers).not.toHaveProperty("writablePaths");
    expect(providers).not.toHaveProperty("allowedTools");
  });
});
