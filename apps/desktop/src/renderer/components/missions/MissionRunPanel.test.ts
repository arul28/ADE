// @vitest-environment jsdom

import { createElement } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import type { MissionIntervention, MissionRunViewLatestIntervention, MissionRunViewProgressItem, MissionRunViewWorkerSummary } from "../../../shared/types";
import { MissionRunPanel, selectOpenInterventions, selectRecentProgress, sortWorkers } from "./MissionRunPanel";

afterEach(() => {
  cleanup();
});

function makeWorker(overrides: Partial<MissionRunViewWorkerSummary> = {}): MissionRunViewWorkerSummary {
  return {
    attemptId: "attempt-1",
    stepId: "step-1",
    stepKey: "step-key-1",
    stepTitle: "Step 1",
    laneId: "lane-1",
    sessionId: "session-1",
    executorKind: "unified",
    state: "working",
    status: "active",
    lastHeartbeatAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("MissionRunPanel worker sorting", () => {
  it("places active workers before completed and failed", () => {
    const workers = [
      makeWorker({ attemptId: "a1", status: "failed", state: "failed" }),
      makeWorker({ attemptId: "a2", status: "active", state: "working" }),
      makeWorker({ attemptId: "a3", status: "completed", state: "completed" }),
    ];

    const sorted = sortWorkers(workers);

    expect(sorted[0]!.attemptId).toBe("a2"); // active first
    expect(sorted[1]!.attemptId).toBe("a3"); // completed second
    expect(sorted[2]!.attemptId).toBe("a1"); // failed last
  });

  it("sorts completed workers by most recently completed first", () => {
    const workers = [
      makeWorker({ attemptId: "c1", status: "completed", completedAt: "2026-03-01T10:00:00Z" }),
      makeWorker({ attemptId: "c2", status: "completed", completedAt: "2026-03-01T12:00:00Z" }),
      makeWorker({ attemptId: "c3", status: "completed", completedAt: "2026-03-01T11:00:00Z" }),
    ];

    const sorted = sortWorkers(workers);

    expect(sorted[0]!.attemptId).toBe("c2"); // most recent
    expect(sorted[1]!.attemptId).toBe("c3");
    expect(sorted[2]!.attemptId).toBe("c1"); // oldest
  });

  it("handles empty array", () => {
    expect(sortWorkers([])).toEqual([]);
  });

  it("places blocked workers after active but before completed", () => {
    const workers = [
      makeWorker({ attemptId: "b1", status: "completed", state: "completed" }),
      makeWorker({ attemptId: "b2", status: "blocked", state: "blocked" }),
      makeWorker({ attemptId: "b3", status: "active", state: "working" }),
    ];

    const sorted = sortWorkers(workers);

    expect(sorted[0]!.status).toBe("active");
    expect(sorted[1]!.status).toBe("blocked");
    expect(sorted[2]!.status).toBe("completed");
  });
});

describe("MissionRunPanel progress log ordering", () => {
  it("keeps the newest progress items first when runView already arrives sorted newest-first", () => {
    const items: MissionRunViewProgressItem[] = [
      { id: "p8", at: "2026-03-01T10:35:00Z", kind: "worker", title: "Most recent", detail: "", severity: "success" },
      { id: "p7", at: "2026-03-01T10:30:00Z", kind: "worker", title: "Next", detail: "", severity: "info" },
      { id: "p6", at: "2026-03-01T10:25:00Z", kind: "worker", title: "Older 1", detail: "", severity: "info" },
      { id: "p5", at: "2026-03-01T10:20:00Z", kind: "worker", title: "Older 2", detail: "", severity: "info" },
      { id: "p4", at: "2026-03-01T10:15:00Z", kind: "worker", title: "Older 3", detail: "", severity: "info" },
      { id: "p3", at: "2026-03-01T10:10:00Z", kind: "worker", title: "Older 4", detail: "", severity: "info" },
      { id: "p2", at: "2026-03-01T10:05:00Z", kind: "worker", title: "Oldest visible bug", detail: "", severity: "info" },
      { id: "p1", at: "2026-03-01T10:00:00Z", kind: "system", title: "Oldest", detail: "", severity: "info" },
    ];

    const recent = selectRecentProgress(items);

    expect(recent).toHaveLength(6);
    expect(recent[0]!.id).toBe("p8");
    expect(recent[5]!.id).toBe("p3");
    expect(recent.find((item) => item.id === "p2")).toBeUndefined();
  });
});

describe("MissionRunPanel intervention selection", () => {
  it("shows all open interventions from mission detail in newest-first order", () => {
    const interventions: MissionIntervention[] = [
      {
        id: "older-open",
        missionId: "mission-1",
        interventionType: "approval_required",
        status: "open",
        title: "Approve the plan",
        body: "",
        requestedAction: null,
        resolutionNote: null,
        laneId: null,
        createdAt: "2026-03-01T10:00:00Z",
        updatedAt: "2026-03-01T10:05:00Z",
        resolvedAt: null,
        metadata: null,
      },
      {
        id: "resolved",
        missionId: "mission-1",
        interventionType: "manual_input",
        status: "resolved",
        title: "Resolved question",
        body: "",
        requestedAction: null,
        resolutionNote: "done",
        laneId: null,
        createdAt: "2026-03-01T10:01:00Z",
        updatedAt: "2026-03-01T10:02:00Z",
        resolvedAt: "2026-03-01T10:03:00Z",
        metadata: null,
      },
      {
        id: "newer-open",
        missionId: "mission-1",
        interventionType: "policy_block",
        status: "open",
        title: "Resolve blocker",
        body: "",
        requestedAction: null,
        resolutionNote: null,
        laneId: null,
        createdAt: "2026-03-01T10:06:00Z",
        updatedAt: "2026-03-01T10:07:00Z",
        resolvedAt: null,
        metadata: null,
      },
    ];

    const selected = selectOpenInterventions({ interventions });

    expect(selected.map((entry) => entry.id)).toEqual(["newer-open", "older-open"]);
  });

  it("falls back to the latest runView intervention when mission detail is unavailable", () => {
    const latestIntervention: MissionRunViewLatestIntervention = {
      id: "latest-open",
      title: "Provide missing input",
      body: "",
      interventionType: "manual_input",
      status: "open",
      requestedAction: "Answer question",
      createdAt: "2026-03-01T10:08:00Z",
    };

    const selected = selectOpenInterventions({ interventions: null, latestIntervention });

    expect(selected.map((entry) => entry.id)).toEqual(["latest-open"]);
  });

  it("renders the fallback latest intervention banner and opens it from the panel", () => {
    const onOpenIntervention = vi.fn();

    render(
      createElement(MissionRunPanel, {
        runView: {
          lifecycle: {
            displayStatus: "active",
            summary: "Waiting on user input",
            startedAt: "2026-03-01T10:00:00Z",
          },
          active: {
            stepTitle: "Planning",
            phaseName: null,
            featureLabel: null,
          },
          coordinator: {
            available: true,
            mode: "online",
            summary: "Waiting for the next instruction",
          },
          haltReason: null,
          workers: [],
          progressLog: [],
          latestIntervention: {
            id: "latest-open",
            title: "Provide missing input",
            body: "",
            interventionType: "manual_input",
            status: "open",
            requestedAction: "Answer question",
            createdAt: "2026-03-01T10:08:00Z",
          },
        } as any,
        interventions: null,
        onOpenIntervention,
      }),
    );

    expect(screen.getByText("Intervention required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OPEN" }));
    expect(onOpenIntervention).toHaveBeenCalledWith("latest-open");
  });

  it("renders mission computer-use monitoring when proof state is available", () => {
    render(
      createElement(MissionRunPanel, {
        runView: {
          lifecycle: {
            displayStatus: "active",
            summary: "Collecting proof",
            startedAt: "2026-03-01T10:00:00Z",
          },
          active: {
            stepTitle: "Verification",
            phaseName: "Ship",
            featureLabel: "settings",
          },
          coordinator: {
            available: true,
            mode: "online",
            summary: "Watching proof artifacts",
          },
          haltReason: null,
          workers: [],
          progressLog: [],
          latestIntervention: null,
          computerUse: {
            owner: { kind: "mission", id: "mission-1" },
            policy: {
              mode: "enabled",
              allowLocalFallback: false,
              retainArtifacts: true,
              preferredBackend: "Ghost OS",
            },
            backendStatus: {
              backends: [],
              localFallback: {
                available: false,
                detail: "Fallback unavailable",
                supportedKinds: [],
              },
            },
            summary: "Ghost OS is capturing screenshots for this mission.",
            activeBackend: {
              name: "Ghost OS",
              style: "external_mcp",
              detail: "Ghost OS produced the latest proof.",
              source: "artifact",
            },
            artifacts: [],
            recentArtifacts: [
              {
                id: "artifact-1",
                kind: "screenshot",
                backendStyle: "external_mcp",
                backendName: "Ghost OS",
                sourceToolName: "ghost_screenshot",
                originalType: "ghost_screenshot",
                title: "settings screenshot",
                description: null,
                uri: "/tmp/settings.png",
                storageKind: "file",
                mimeType: "image/png",
                metadata: {},
                createdAt: "2026-03-01T10:05:00Z",
                links: [],
                reviewState: "pending",
                workflowState: "evidence_only",
                reviewNote: null,
              },
            ],
            activity: [
              {
                id: "activity-1",
                at: "2026-03-01T10:05:00Z",
                kind: "artifact_ingested",
                title: "screenshot captured",
                detail: "Ghost OS produced the latest screenshot.",
                artifactId: "artifact-1",
                backendName: "Ghost OS",
                severity: "success",
              },
            ],
            proofCoverage: {
              requiredKinds: ["screenshot"],
              presentKinds: ["screenshot"],
              missingKinds: [],
            },
            usingLocalFallback: false,
          },
        } as any,
      }),
    );

    expect(screen.getByText("Computer Use")).toBeTruthy();
    expect(screen.getByText("Ghost OS is capturing screenshots for this mission.")).toBeTruthy();
    expect(screen.getByText("Proof satisfied: screenshot")).toBeTruthy();
    expect(screen.getByText("screenshot captured")).toBeTruthy();
  });
});
