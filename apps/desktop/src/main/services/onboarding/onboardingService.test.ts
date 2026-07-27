import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOnboardingService } from "./onboardingService";
import { buildSuggestedConfig } from "./onboardingSuggestedConfig";
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
    sync: {
      getSiteId: () => "00000000000000000000000000000000",
      getDbVersion: () => 0,
      exportChangesSince: () => [],
      applyChanges: () => ({ appliedCount: 0, dbVersion: 0, touchedTables: [], rebuiltFts: false }),
      discardUnpublishedChangesForTables: () => {},
    },
    flushNow: () => {},
    close: () => {}
  };
}

function createInMemoryProjectConfigService() {
  const empty: ProjectConfigFile = {
    version: 1,
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
        freshProject: false,
        laneService: { list: async () => [] } as any,
        projectConfigService: createInMemoryProjectConfigService()
      });

      const res = await service.detectDefaults();
      expect(res.indicators.some((i) => i.type === "node")).toBe(true);
      const suggested = res.suggestedConfig;
      const suiteIds = new Set((suggested.testSuites ?? []).map((t) => t.id));
      expect(suiteIds.has("unit")).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("preserves quoted CI command arguments in suggested tests", () => {
    const suggested = buildSuggestedConfig({
      projectRoot: "/tmp/ade-onboarding-ci",
      indicators: [],
      suggestedWorkflowCommands: ["npm test -- --grep \"a b\""],
    });

    expect(suggested.testSuites?.find((suite) => suite.id === "ci-1")?.command).toEqual([
      "npm",
      "test",
      "--",
      "--grep",
      "a b",
    ]);
  });
});

describe("onboardingService help state", () => {
  function buildService() {
    const db = createInMemoryAdeDb();
    const service = createOnboardingService({
      db,
      logger: createLogger(),
      projectRoot: "/tmp/ade-onboarding-help",
      projectId: "proj",
      baseRef: "main",
      freshProject: false,
      laneService: { list: async () => [] } as any,
      projectConfigService: createInMemoryProjectConfigService()
    });
    return { service, db };
  }

  it("returns an empty help snapshot by default", () => {
    const { service } = buildService();
    expect(service.getHelpState()).toEqual({
      glossaryTermsSeen: [],
    });
  });

  it("records seen glossary terms without duplicates", () => {
    const { service } = buildService();
    service.markGlossaryTermSeen("Lane");
    service.markGlossaryTermSeen("Worktree");
    service.markGlossaryTermSeen(" Lane ");
    expect(service.getHelpState().glossaryTermsSeen).toEqual(["Lane", "Worktree"]);
  });

  it("preserves glossary terms from legacy tour-progress storage", () => {
    const db = createInMemoryAdeDb();
    db.setJson("onboarding:tourProgress", {
      wizardCompletedAt: "2026-01-01T00:00:00Z",
      wizardDismissedAt: null,
      tours: {
        lanes: {
          completedAt: "2026-01-02T00:00:00Z",
          dismissedAt: null,
          lastStepIndex: 3,
        },
      },
      glossaryTermsSeen: [" Lane ", "", "Lane"],
    });

    const service = createOnboardingService({
      db,
      logger: createLogger(),
      projectRoot: "/tmp/ade-onboarding-legacy",
      projectId: "proj",
      baseRef: "main",
      freshProject: false,
      laneService: { list: async () => [] } as any,
      projectConfigService: createInMemoryProjectConfigService(),
    });

    expect(service.getHelpState()).toEqual({ glossaryTermsSeen: ["Lane"] });
  });
});
