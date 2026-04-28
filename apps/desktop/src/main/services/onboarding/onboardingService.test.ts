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
      tourVariants: {},
      tutorial: {
        completedAt: null,
        dismissedAt: null,
        silenced: false,
        inProgress: false,
        lastActIndex: 0,
        ctxSnapshot: {},
      },
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
      tourVariants: {},
      tutorial: {
        completedAt: null,
        dismissedAt: null,
        silenced: false,
        inProgress: false,
        lastActIndex: 0,
        ctxSnapshot: {},
      },
      glossaryTermsSeen: [],
    });
  });
});

describe("onboardingService tutorial state", () => {
  function buildService() {
    const db = createInMemoryAdeDb();
    const service = createOnboardingService({
      db,
      logger: createLogger(),
      projectRoot: "/tmp/ade-onboarding-tutorial",
      projectId: "proj",
      baseRef: "main",
      freshProject: false,
      laneService: { list: async () => [] } as any,
      projectConfigService: createInMemoryProjectConfigService(),
    });
    return { service, db };
  }

  it("shouldPromptTutorial is true by default", () => {
    const { service } = buildService();
    expect(service.shouldPromptTutorial()).toBe(true);
  });

  it("markTutorialDismissed(false) records 'Not now' but does not silence; prompt still suppressed in-session", () => {
    const { service } = buildService();
    const progress = service.markTutorialDismissed(false);
    expect(progress.tutorial?.dismissedAt).toBeTruthy();
    expect(progress.tutorial?.silenced).toBe(false);
    // With dismissedAt set but not silenced, same-session prompt is suppressed.
    expect(service.shouldPromptTutorial()).toBe(false);
    // Bootstrap clears session dismissal on launch -> prompt re-shows.
    service.clearTutorialSessionDismissal();
    expect(service.shouldPromptTutorial()).toBe(true);
  });

  it("markTutorialDismissed(true) silences permanently", () => {
    const { service } = buildService();
    const progress = service.markTutorialDismissed(true);
    expect(progress.tutorial?.silenced).toBe(true);
    expect(service.shouldPromptTutorial()).toBe(false);
    // Clearing session dismissal does NOT un-silence.
    service.clearTutorialSessionDismissal();
    expect(service.shouldPromptTutorial()).toBe(false);
  });

  it("markTutorialCompleted suppresses future prompts", () => {
    const { service } = buildService();
    const progress = service.markTutorialCompleted();
    expect(progress.tutorial?.completedAt).toBeTruthy();
    expect(progress.tutorial?.inProgress).toBe(false);
    expect(service.shouldPromptTutorial()).toBe(false);
  });

  it("updateTutorialAct persists index and snapshot; clamps to [0, 12]", () => {
    const { service } = buildService();
    const progress = service.updateTutorialAct(5, { laneName: "test" });
    expect(progress.tutorial?.lastActIndex).toBe(5);
    expect(progress.tutorial?.ctxSnapshot).toEqual({ laneName: "test" });
    expect(progress.tutorial?.inProgress).toBe(true);

    const clampedHigh = service.updateTutorialAct(999);
    expect(clampedHigh.tutorial?.lastActIndex).toBe(12);
    const clampedLow = service.updateTutorialAct(-3);
    expect(clampedLow.tutorial?.lastActIndex).toBe(0);
  });

  it("setTutorialSilenced toggles the silenced flag directly", () => {
    const { service } = buildService();
    service.setTutorialSilenced(true);
    expect(service.shouldPromptTutorial()).toBe(false);
    service.setTutorialSilenced(false);
    expect(service.shouldPromptTutorial()).toBe(true);
  });

  it("markTutorialStarted clears any prior session dismissal", () => {
    const { service } = buildService();
    service.markTutorialDismissed(false);
    const started = service.markTutorialStarted();
    expect(started.tutorial?.inProgress).toBe(true);
    expect(started.tutorial?.dismissedAt).toBeNull();
  });
});

describe("onboardingService tour variants", () => {
  function buildService() {
    const db = createInMemoryAdeDb();
    const service = createOnboardingService({
      db,
      logger: createLogger(),
      projectRoot: "/tmp/ade-onboarding-variants",
      projectId: "proj",
      baseRef: "main",
      freshProject: false,
      laneService: { list: async () => [] } as any,
      projectConfigService: createInMemoryProjectConfigService(),
    });
    return { service, db };
  }

  it("markTourCompleted with 'full' does not affect 'highlights'", () => {
    const { service } = buildService();
    service.markTourCompleted("lanes", "full");
    const progress = service.getTourProgress();
    expect(progress.tourVariants?.lanes?.full.completedAt).toBeTruthy();
    expect(progress.tourVariants?.lanes?.highlights.completedAt).toBeNull();
  });

  it("markTourCompleted with 'highlights' does not affect 'full'", () => {
    const { service } = buildService();
    service.markTourCompleted("lanes", "highlights");
    const progress = service.getTourProgress();
    expect(progress.tourVariants?.lanes?.highlights.completedAt).toBeTruthy();
    expect(progress.tourVariants?.lanes?.full.completedAt).toBeNull();
  });

  it("updateTourStep supports (tourId, variant, index) and (tourId, index) signatures", () => {
    const { service } = buildService();
    // New signature.
    service.updateTourStep("lanes", "highlights", 4);
    let progress = service.getTourProgress();
    expect(progress.tourVariants?.lanes?.highlights.lastStepIndex).toBe(4);
    expect(progress.tourVariants?.lanes?.full.lastStepIndex).toBe(0);

    // Legacy 2-arg signature defaults to "full".
    service.updateTourStep("lanes", 2);
    progress = service.getTourProgress();
    expect(progress.tourVariants?.lanes?.full.lastStepIndex).toBe(2);
    expect(progress.tourVariants?.lanes?.highlights.lastStepIndex).toBe(4);
    // Legacy flat mirror reflects the "full" write.
    expect(progress.tours.lanes.lastStepIndex).toBe(2);
  });

  it("markTourDismissed is variant-scoped", () => {
    const { service } = buildService();
    service.markTourDismissed("work", "highlights");
    const progress = service.getTourProgress();
    expect(progress.tourVariants?.work?.highlights.dismissedAt).toBeTruthy();
    expect(progress.tourVariants?.work?.full.dismissedAt).toBeNull();
  });
});

describe("onboardingService legacy normalization", () => {
  it("normalizes a legacy flat tour entry into the new variant shape", () => {
    const db = createInMemoryAdeDb();
    // Pre-seed storage with the OLD flat schema to simulate an upgrade.
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
      glossaryTermsSeen: ["Lane"],
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

    const progress = service.getTourProgress();
    // Legacy field preserved.
    expect(progress.tours.lanes.completedAt).toBe("2026-01-02T00:00:00Z");
    // Mirrored to variant.full with highlights at defaults.
    expect(progress.tourVariants?.lanes?.full.completedAt).toBe("2026-01-02T00:00:00Z");
    expect(progress.tourVariants?.lanes?.full.lastStepIndex).toBe(3);
    expect(progress.tourVariants?.lanes?.highlights.completedAt).toBeNull();
    // Tutorial defaults populated.
    expect(progress.tutorial).toEqual({
      completedAt: null,
      dismissedAt: null,
      silenced: false,
      inProgress: false,
      lastActIndex: 0,
      ctxSnapshot: {},
    });
    // Wizard + glossary fields preserved unchanged.
    expect(progress.wizardCompletedAt).toBe("2026-01-01T00:00:00Z");
    expect(progress.glossaryTermsSeen).toEqual(["Lane"]);
  });
});
