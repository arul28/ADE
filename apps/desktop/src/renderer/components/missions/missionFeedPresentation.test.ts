import { describe, expect, it } from "vitest";
import type { MissionRunView, MissionRunViewProgressItem } from "../../../shared/types";
import { buildMissionStateNarrative, prepareMissionFeedItems } from "./missionFeedPresentation";

function makeProgressItem(overrides: Partial<MissionRunViewProgressItem> = {}): MissionRunViewProgressItem {
  return {
    id: "progress-1",
    at: "2026-03-11T14:00:00.000Z",
    kind: "worker",
    title: "Worker result",
    detail: "Finished implementation.",
    severity: "info",
    ...overrides,
  };
}

function makeRunView(overrides: Partial<MissionRunView> = {}): MissionRunView {
  return {
    missionId: "mission-1",
    runId: "run-1",
    lifecycle: {
      missionStatus: "in_progress",
      runStatus: "active",
      displayStatus: "running",
      summary: "Mission is actively running.",
      startedAt: "2026-03-11T13:30:00.000Z",
      completedAt: null,
    },
    active: {
      phaseKey: "validation",
      phaseName: "Validation",
      stepId: "step-1",
      stepKey: "validate-checkout",
      stepTitle: "Review checkout flow",
      featureLabel: "checkout",
    },
    coordinator: {
      available: true,
      mode: "continuation_required",
      summary: "Coordinator online",
      detail: null,
      updatedAt: "2026-03-11T14:05:00.000Z",
    },
    latestIntervention: null,
    haltReason: null,
    workers: [],
    progressLog: [],
    lastMeaningfulProgress: null,
    closeoutRequirements: [],
    ...overrides,
  };
}

describe("prepareMissionFeedItems", () => {
  it("suppresses repetitive low-signal internal tool chatter and humanizes kept entries", () => {
    const items = prepareMissionFeedItems([
      makeProgressItem({
        id: "tool-noise",
        at: "2026-03-11T14:00:00.000Z",
        kind: "system",
        title: "Tool call",
        detail: "linear.get_issue",
      }),
      makeProgressItem({
        id: "meaningful-1",
        at: "2026-03-11T14:01:00.000Z",
        title: "Worker result",
        detail: "Coordinator used posthog.query-run to inspect the conversion drop.",
      }),
      makeProgressItem({
        id: "meaningful-2",
        at: "2026-03-11T14:02:00.000Z",
        title: "Worker result",
        detail: "Coordinator used posthog.query-run to inspect the conversion drop.",
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toContain("PostHog Query Run");
    expect(items[0]?.detail).not.toContain("posthog.query-run");
  });

  it("drops internal lifecycle noise and non-feed items", () => {
    const items = prepareMissionFeedItems([
      makeProgressItem({
        id: "timeline-only",
        audience: "timeline",
        title: "Scheduler tick",
        detail: "Internal runtime loop.",
      }),
      makeProgressItem({
        id: "run-created",
        kind: "system",
        title: "Run created",
        detail: "start_run",
      }),
      makeProgressItem({
        id: "status-transition",
        kind: "system",
        title: "Mission update",
        detail: "Mission status changed to in_progress.",
      }),
      makeProgressItem({
        id: "keep",
        title: "Worker completed",
        detail: "Implemented the mission feed cleanup.",
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("keep");
  });

  it("drops validation bookkeeping and de-dupes repeated feed entries", () => {
    const items = prepareMissionFeedItems([
      makeProgressItem({
        id: "requires-self-validation",
        kind: "validation",
        title: "Validation signal",
        detail: 'Step "integration_phase_closeout" requires self-validation. Review output and call report_validation with verdict pass/fail.',
      }),
      makeProgressItem({
        id: "state-changed",
        kind: "validation",
        title: "Validation update",
        detail: "Validate: validation-worker validation changed.",
      }),
      makeProgressItem({
        id: "meaningful-validation",
        kind: "validation",
        title: "Validation signal",
        detail: "Dedicated validation passed. The throwaway implementation is confined to the fake lane.",
      }),
      makeProgressItem({
        id: "duplicate-validation",
        kind: "validation",
        title: "Validation signal",
        detail: "Dedicated validation passed. The throwaway implementation is confined to the fake lane.",
        at: "2026-03-11T14:10:00.000Z",
      }),
    ]);

    expect(items.map((item) => item.id)).toEqual(["meaningful-validation"]);
  });

  it("preserves readable worker result sections", () => {
    const items = prepareMissionFeedItems([
      makeProgressItem({
        id: "worker-result",
        title: "Worker result",
        detail: [
          "Created the smoke helper.",
          "",
          "Changed files:",
          "- apps/desktop/src/smoke.ts",
          "- apps/desktop/src/smoke.test.ts",
          "",
          "Tests:",
          "- npm test -- smoke.test.ts",
          "- 3 passed, 0 failed, 0 skipped",
        ].join("\n"),
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.detail).toContain("Changed files:\n- apps/desktop/src/smoke.ts");
    expect(items[0]?.detail).toContain("Tests:\n- npm test -- smoke.test.ts");
  });
});

describe("buildMissionStateNarrative", () => {
  it("builds a concise major-transition narrative from run view state and latest progress", () => {
    const narrative = buildMissionStateNarrative(
      makeRunView({
        progressLog: [
          makeProgressItem({
            id: "validation-signal",
            kind: "validation",
            title: "Validation signal",
            detail: "Browser screenshot captured.",
            at: "2026-03-11T14:07:00.000Z",
          }),
        ],
        lastMeaningfulProgress: makeProgressItem({
          id: "validation-signal",
          kind: "validation",
          title: "Validation signal",
          detail: "Browser screenshot captured.",
          at: "2026-03-11T14:07:00.000Z",
        }),
      }),
    );

    expect(narrative).toMatchObject({
      title: "Validation in progress",
      severity: "info",
      at: "2026-03-11T14:07:00.000Z",
    });
    expect(narrative?.detail).toContain("Working on Review checkout flow.");
    expect(narrative?.detail).toContain("Latest: Validation signal: Browser screenshot captured.");
  });
});
