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
    sync: {
      getSiteId: () => "00000000000000000000000000000000",
      getDbVersion: () => 0,
      exportChangesSince: () => [],
      applyChanges: () => ({ appliedCount: 0, dbVersion: 0, touchedTables: [], rebuiltFts: false }),
    },
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
        freshProject: false,
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

describe("onboardingService tour progress", () => {
  function buildService() {
    const db = createInMemoryAdeDb();
    const service = createOnboardingService({
      db,
      logger: createLogger(),
      projectRoot: "/tmp/ade-onboarding-tour",
      projectId: "proj",
      baseRef: "main",
      freshProject: false,
      laneService: { list: async () => [] } as any,
      projectConfigService: createInMemoryProjectConfigService()
    });
    return { service, db };
  }

  it("returns an empty progress snapshot by default", () => {
    const { service } = buildService();
    const progress = service.getTourProgress();
    expect(progress).toEqual({
      wizardCompletedAt: null,
      wizardDismissedAt: null,
      tours: {},
      glossaryTermsSeen: [],
    });
  });

  it("round-trips wizard completed and dismissed timestamps", () => {
    const { service } = buildService();
    const completed = service.markWizardCompleted();
    expect(completed.wizardCompletedAt).toBeTruthy();
    expect(completed.wizardDismissedAt).toBeNull();

    const dismissed = service.markWizardDismissed();
    expect(dismissed.wizardCompletedAt).toBe(completed.wizardCompletedAt);
    expect(dismissed.wizardDismissedAt).toBeTruthy();

    // Re-reading persists.
    const refetched = service.getTourProgress();
    expect(refetched.wizardCompletedAt).toBe(completed.wizardCompletedAt);
    expect(refetched.wizardDismissedAt).toBe(dismissed.wizardDismissedAt);
  });

  it("tracks per-tour completion, dismissal, and step index", () => {
    const { service } = buildService();
    service.updateTourStep("lanes", 3);
    service.markTourCompleted("lanes");
    const progress = service.getTourProgress();
    expect(progress.tours.lanes.lastStepIndex).toBe(3);
    expect(progress.tours.lanes.completedAt).toBeTruthy();
    expect(progress.tours.lanes.dismissedAt).toBeNull();

    service.markTourDismissed("work");
    const afterDismiss = service.getTourProgress();
    expect(afterDismiss.tours.work.dismissedAt).toBeTruthy();
    expect(afterDismiss.tours.work.completedAt).toBeNull();
  });

  it("records seen glossary terms without duplicates", () => {
    const { service } = buildService();
    service.markGlossaryTermSeen("Lane");
    service.markGlossaryTermSeen("Worktree");
    service.markGlossaryTermSeen("Lane");
    const progress = service.getTourProgress();
    expect(progress.glossaryTermsSeen).toEqual(["Lane", "Worktree"]);
  });

  it("resetTourProgress(tourId) clears only that tour", () => {
    const { service } = buildService();
    service.markWizardCompleted();
    service.markTourCompleted("lanes");
    service.markTourCompleted("work");

    const reset = service.resetTourProgress("lanes");
    expect(reset.tours.lanes).toBeUndefined();
    expect(reset.tours.work?.completedAt).toBeTruthy();
    expect(reset.wizardCompletedAt).toBeTruthy();
  });

  it("resetTourProgress() with no arg clears wizard + all tours", () => {
    const { service } = buildService();
    service.markWizardCompleted();
    service.markTourCompleted("lanes");
    service.markGlossaryTermSeen("Lane");

    const reset = service.resetTourProgress();
    expect(reset).toEqual({
      wizardCompletedAt: null,
      wizardDismissedAt: null,
      tours: {},
      glossaryTermsSeen: [],
    });
  });
});
