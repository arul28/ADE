import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOnboardingService } from "./onboardingService";
import type { AdeDb } from "../state/kvDb";
import type { ProjectConfigFile } from "../../../shared/types";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

function createInMemoryAdeDb(): AdeDb {
  const kv = new Map<string, unknown>();
  return {
    getJson: <T,>(key: string) => (kv.has(key) ? (kv.get(key) as T) : null),
    setJson: (key: string, value: unknown) => {
      kv.set(key, value);
    },
    run: () => {},
    get: () => null,
    all: () => [],
    flushNow: () => {},
    close: () => {}
  };
}

function createInMemoryProjectConfigService() {
  const empty: ProjectConfigFile = {
    version: 1,
    processes: [],
    stackButtons: [],
    testSuites: [],
    laneOverlayPolicies: [],
    automations: []
  };

  let shared: ProjectConfigFile = { ...empty };
  let local: ProjectConfigFile = { ...empty };

  return {
    get: () => ({ shared, local }),
    save: ({ shared: nextShared, local: nextLocal }: { shared: ProjectConfigFile; local: ProjectConfigFile }) => {
      shared = nextShared;
      local = nextLocal;
      return { shared, local };
    }
  } as any;
}

describe("onboardingService integration", () => {
  it("detects node defaults and produces a suggested config", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-onboarding-"));
    try {
      fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "demo" }), "utf8");

      const service = createOnboardingService({
        db: createInMemoryAdeDb(),
        logger: createLogger(),
        projectRoot,
        projectId: "proj",
        baseRef: "main",
        laneService: { list: async () => [] } as any,
        projectConfigService: createInMemoryProjectConfigService()
      });

      const res = await service.detectDefaults();
      expect(res.indicators.some((i) => i.type === "node")).toBe(true);
      const suggested = res.suggestedConfig;
      const procIds = new Set((suggested.processes ?? []).map((p) => p.id));
      const suiteIds = new Set((suggested.testSuites ?? []).map((t) => t.id));
      expect(procIds.has("install")).toBe(true);
      expect(procIds.has("build")).toBe(true);
      expect(suiteIds.has("unit")).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
